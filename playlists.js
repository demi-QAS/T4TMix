// T4T Mix — playlists: Spotify, YouTube, SoundCloud + song matching (v0.8)
import { j, err, str, rateLimited, JSON_HEADERS, getConfig } from "./lib.js";

// ---------- link parsing ----------
export function spotifyPlaylistId(input) {
  const m = String(input).match(/playlist[/:]([a-zA-Z0-9]{22})/);
  if (m) return m[1];
  return /^[a-zA-Z0-9]{22}$/.test(String(input).trim()) ? String(input).trim() : null;
}
export function youtubeListId(input) {
  const m = String(input).match(/[?&]list=([a-zA-Z0-9_-]{10,64})/);
  return m ? m[1] : null;
}
// soundcloud.com/<user>/sets/<set>  (also on.soundcloud.com short links, m.soundcloud.com)
export function soundcloudSetUrl(input) {
  const s = String(input).trim();
  const m = s.match(/^https?:\/\/(?:www\.|m\.)?soundcloud\.com\/([a-z0-9_-]+)\/sets\/([a-z0-9_-]+)/i);
  if (m) return `https://soundcloud.com/${m[1]}/sets/${m[2]}`;
  if (/^https?:\/\/on\.soundcloud\.com\/[a-zA-Z0-9]+$/.test(s)) return s;
  return null;
}

// ---------- Spotify ----------
// Reality check (Spotify, Feb 2026 dev-mode changes): Client Credentials can still
// read playlist *metadata*, but /playlists/{id}/items only returns contents for
// playlists the app user owns. Order: official API → public embed page → samples.
let spotifyToken = null, spotifyTokenExp = 0;
async function getSpotifyToken(env) {
  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) return null;
  if (spotifyToken && Date.now() < spotifyTokenExp) return spotifyToken;
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      authorization: "Basic " + btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) return null;
  const d = await r.json();
  spotifyToken = d.access_token;
  spotifyTokenExp = Date.now() + (d.expires_in - 60) * 1000;
  return spotifyToken;
}
async function spotifyViaApi(id, env) {
  const token = await getSpotifyToken(env);
  if (!token) return null;
  const h = { authorization: `Bearer ${token}` };
  const meta = await fetch(`https://api.spotify.com/v1/playlists/${id}?fields=name,owner.display_name,images`, { headers: h });
  if (!meta.ok) return null;
  const m = await meta.json();
  const tracks = [];
  let next = `https://api.spotify.com/v1/playlists/${id}/items?limit=50`;
  while (next && tracks.length < 200) {
    const r = await fetch(next, { headers: h });
    if (!r.ok) break;
    const d = await r.json();
    for (const it of d.items || []) {
      const t = it.item || it.track;
      if (!t || !t.name) continue;
      tracks.push({ title: t.name, artist: (t.artists || []).map((a) => a.name).join(", "), durationMs: t.duration_ms || null, spotifyId: t.id || null, previewUrl: t.preview_url || null });
    }
    next = d.next || null;
  }
  if (!tracks.length) return { title: m.name || "", tracks: [], partial: true };
  return { title: m.name || "", tracks, via: "spotify-api" };
}
async function spotifyViaEmbed(id) {
  const r = await fetch(`https://open.spotify.com/embed/playlist/${id}`, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; T4TMix/0.8; +https://t4tmix.com)" },
  });
  if (!r.ok) return null;
  const html = await r.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    const ent = JSON.parse(m[1]).props.pageProps.state.data.entity;
    const tracks = (ent.trackList || []).map((t) => ({
      title: t.title, artist: (t.subtitle || "").replace(/\u00a0/g, " "), durationMs: t.duration || null,
      spotifyId: ((t.uri || "").match(/^spotify:track:([a-zA-Z0-9]{22})$/) || [])[1] || null,
      previewUrl: (t.audioPreview && t.audioPreview.url) || null,
    }));
    return { title: ent.name || ent.title || "", tracks, via: "spotify-embed" };
  } catch { return null; }
}

// ---------- YouTube ----------
async function youtubePlaylist(listId, env) {
  if (!env.YOUTUBE_API_KEY) return { title: "", tracks: [], via: "none", needsKey: true };
  const key = encodeURIComponent(env.YOUTUBE_API_KEY);
  const meta = await fetch(`https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=${listId}&key=${key}`);
  const md = meta.ok ? await meta.json() : {};
  const title = md.items && md.items[0] ? md.items[0].snippet.title : "";
  const tracks = [];
  let page = "";
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${listId}&key=${key}${page ? `&pageToken=${page}` : ""}`);
    if (!r.ok) break;
    const d = await r.json();
    for (const it of d.items || []) {
      const s = it.snippet || {};
      if (!s.resourceId || !s.resourceId.videoId || s.title === "Private video" || s.title === "Deleted video") continue;
      tracks.push({ title: s.title, artist: (s.videoOwnerChannelTitle || "").replace(/ - Topic$/, ""), ytVideoId: s.resourceId.videoId });
    }
    if (!d.nextPageToken) break;
    page = d.nextPageToken;
  }
  return { title, tracks, via: "youtube-api" };
}

// ---------- SoundCloud ----------
// No API key needed: the public set page carries the track list (full details for
// the first few, ids for the rest) and SoundCloud's public oEmbed fills in titles.
// Songs play on YouTube by default (matched like Spotify songs) and on SoundCloud's
// own widget when the listener picks the SoundCloud lane.
function cleanScTitle(title, artist) {
  let t = String(title || "").trim();
  // "Artist - Song" uploads: drop the artist prefix when it matches the uploader
  const dash = t.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dash && artist && dash[1].toLowerCase().includes(String(artist).toLowerCase().slice(0, 6))) t = dash[2];
  return t.replace(/\s*\[(free download|out now|premiere)[^\]]*\]\s*/ig, " ").trim();
}
async function scOembed(trackId) {
  const r = await fetch(`https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(`https://api.soundcloud.com/tracks/${trackId}`)}`);
  if (!r.ok) return null;
  const d = await r.json().catch(() => null);
  if (!d || !d.title) return null;
  const artist = d.author_name || "";
  let title = d.title;
  if (artist && title.endsWith(` by ${artist}`)) title = title.slice(0, -(` by ${artist}`).length);
  return { title, artist };
}
export async function soundcloudPlaylist(url) {
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; T4TMix/0.8; +https://t4tmix.com)" }, redirect: "follow" });
  if (!r.ok) return null;
  const html = await r.text();
  const m = html.match(/window\.__sc_hydration\s*=\s*(\[[\s\S]*?\]);\s*<\/script>/);
  if (!m) return null;
  let pl = null;
  try { pl = (JSON.parse(m[1]).find((x) => x.hydratable === "playlist") || {}).data; } catch { return null; }
  if (!pl || !Array.isArray(pl.tracks)) return null;
  const tracks = pl.tracks.slice(0, 100).map((t) => ({
    scId: t.id ? String(t.id) : null,
    title: t.title ? cleanScTitle(t.title, t.user && t.user.username) : "",
    artist: (t.publisher_metadata && t.publisher_metadata.artist) || (t.user && t.user.username) || "",
    durationMs: t.duration || null,
  })).filter((t) => t.scId);
  // fill the ids-only tracks through oEmbed, 6 at a time, max 60 lookups
  const missing = tracks.filter((t) => !t.title).slice(0, 60);
  for (let i = 0; i < missing.length; i += 6) {
    const got = await Promise.all(missing.slice(i, i + 6).map((t) => scOembed(t.scId).catch(() => null)));
    got.forEach((g, k) => { if (g) { missing[i + k].title = cleanScTitle(g.title, g.artist); missing[i + k].artist = g.artist; } });
  }
  const ready = tracks.filter((t) => t.title);
  return { title: pl.title || "", tracks: ready, via: "soundcloud-page", setUrl: pl.permalink_url || url };
}

// ---------- matching a song to YouTube / SoundCloud ----------
// search.list costs 100 of the 10,000 daily YouTube quota units, so results are kept
// in KV for 30 days (misses for 1 day) and shared by every tape that uses the song.
export const matchKey = (provider, title, artist) =>
  `${provider === "soundcloud" ? "sc" : "yt"}:${`${title}|${artist}`.toLowerCase().slice(0, 300)}`;

export async function resolveYouTubeId(title, artist, env) {
  if (!env.YOUTUBE_API_KEY || !title) return null;
  const key = matchKey("youtube", title, artist);
  const pinned = await env.TAPES.get(`pin:${key}`); // admin override
  if (pinned) return pinned;
  const hit = await env.TAPES.get(key);
  if (hit !== null) return hit || null;
  const q = encodeURIComponent(`${title} ${artist} audio`.trim());
  const r = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=1&videoEmbeddable=true&videoCategoryId=10&q=${q}&key=${encodeURIComponent(env.YOUTUBE_API_KEY)}`);
  if (!r.ok) return null; // quota used up etc. — don't remember failures
  const d = await r.json();
  const vid = d.items && d.items[0] && d.items[0].id ? d.items[0].id.videoId || "" : "";
  await env.TAPES.put(key, vid, { expirationTtl: vid ? 60 * 60 * 24 * 30 : 60 * 60 * 24 });
  return vid || null;
}

// SoundCloud search needs official app credentials (Artist Pro). Optional.
let scToken = null, scTokenExp = 0;
async function getScToken(env) {
  if (!env.SOUNDCLOUD_CLIENT_ID || !env.SOUNDCLOUD_CLIENT_SECRET) return null;
  if (scToken && Date.now() < scTokenExp) return scToken;
  const r = await fetch("https://secure.soundcloud.com/oauth/token", {
    method: "POST",
    headers: { authorization: "Basic " + btoa(`${env.SOUNDCLOUD_CLIENT_ID}:${env.SOUNDCLOUD_CLIENT_SECRET}`), "content-type": "application/x-www-form-urlencoded", accept: "application/json; charset=utf-8" },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) return null;
  const d = await r.json();
  scToken = d.access_token; scTokenExp = Date.now() + ((d.expires_in || 3600) - 60) * 1000;
  return scToken;
}
export async function resolveSoundCloudId(title, artist, env) {
  if (!title) return null;
  const key = matchKey("soundcloud", title, artist);
  const pinned = await env.TAPES.get(`pin:${key}`);
  if (pinned) return pinned;
  const hit = await env.TAPES.get(key);
  if (hit !== null) return hit || null;
  const token = await getScToken(env);
  if (!token) return null;
  const r = await fetch(`https://api.soundcloud.com/tracks?q=${encodeURIComponent(`${title} ${artist}`.trim())}&limit=1&access=playable`, { headers: { authorization: `OAuth ${token}`, accept: "application/json; charset=utf-8" } });
  if (!r.ok) return null;
  const d = await r.json().catch(() => []);
  const list = Array.isArray(d) ? d : d.collection || [];
  const id = list[0] && list[0].id ? String(list[0].id) : "";
  await env.TAPES.put(key, id, { expirationTtl: id ? 60 * 60 * 24 * 30 : 60 * 60 * 24 });
  return id || null;
}

export async function handleMatch(req, env) {
  if (await rateLimited(req, env, "match", 120, 600)) return err("slow down a little 💌", 429);
  const sp = new URL(req.url).searchParams;
  const title = str(sp.get("title"), 160), artist = str(sp.get("artist"), 160);
  const provider = sp.get("provider") === "soundcloud" ? "soundcloud" : "youtube";
  if (!title) return err("title is required");
  if (provider === "soundcloud") {
    const id = await resolveSoundCloudId(title, artist, env).catch(() => null);
    return j({ ok: true, provider, scId: id, reason: id ? undefined : (env.SOUNDCLOUD_CLIENT_ID ? "no-match" : "soundcloud-search-off") }, 200, { "cache-control": "public, max-age=3600" });
  }
  if (!env.YOUTUBE_API_KEY) return j({ ok: true, provider, videoId: null, reason: "youtube-off" });
  const videoId = await resolveYouTubeId(title, artist, env).catch(() => null);
  return j({ ok: true, provider, videoId }, 200, { "cache-control": "public, max-age=3600" });
}

export async function handlePlaylist(req, env, { bridge }) {
  const u = new URL(req.url).searchParams.get("url") || "";
  if (await rateLimited(req, env, "playlist", 30, 600)) return err("slow down a little 💌", 429);

  const ytList = youtubeListId(u);
  if (ytList) {
    const d = await youtubePlaylist(ytList, env);
    return j({ ok: true, source: "youtube", id: ytList, ...d });
  }
  const scUrl = soundcloudSetUrl(u);
  if (scUrl) {
    const cacheReq = new Request(`https://cache.t4tmix.internal/sc/${encodeURIComponent(scUrl)}`);
    const cached = await caches.default.match(cacheReq).catch(() => null);
    if (cached) return new Response(cached.body, { headers: JSON_HEADERS });
    const d = await soundcloudPlaylist(scUrl).catch(() => null);
    if (!d || !d.tracks.length) return err("couldn't read that SoundCloud playlist — is it public?", 404);
    const body = JSON.stringify({ ok: true, source: "soundcloud", id: d.setUrl, ...d });
    await caches.default.put(cacheReq, new Response(body, { headers: { "cache-control": "max-age=600" } })).catch(() => {});
    return new Response(body, { headers: JSON_HEADERS });
  }
  const id = spotifyPlaylistId(u);
  if (!id) return err("that doesn't look like a Spotify, YouTube or SoundCloud playlist link");

  const cacheReq = new Request(`https://cache.t4tmix.internal/pl/${id}/${bridge ? "b" : "p"}`);
  const cached = await caches.default.match(cacheReq).catch(() => null);
  if (cached) return new Response(cached.body, { headers: JSON_HEADERS });

  let d = (await spotifyViaApi(id, env).catch(() => null));
  if (!d || !d.tracks.length) d = (await spotifyViaEmbed(id).catch(() => null)) || d;
  if (!d || !d.tracks.length) return err("couldn't read that playlist — is it public?", 404);

  if (bridge && env.YOUTUBE_API_KEY) {
    const list = d.tracks.slice(0, 10); // legacy route; songs now match lazily via /api/match
    for (let i = 0; i < list.length; i += 5) {
      const ids = await Promise.all(list.slice(i, i + 5).map((t) => resolveYouTubeId(t.title, t.artist, env).catch(() => null)));
      ids.forEach((v, k) => { list[i + k].ytVideoId = v; });
    }
  }
  const body = JSON.stringify({ ok: true, source: "spotify", id, ...d, bridged: !!(bridge && env.YOUTUBE_API_KEY) });
  await caches.default.put(cacheReq, new Response(body, { headers: { "cache-control": "max-age=600" } })).catch(() => {});
  return new Response(body, { headers: JSON_HEADERS });
}

export { getConfig };
