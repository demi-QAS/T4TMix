// T4T Mix — one Worker for everything (v0.6, 2026-10-20)
// ---------------------------------------------------------------------------
// Replaces the old two-Worker split (cloudflare-worker/ + recipient-worker/).
//
//   GET  /api/health                 → { ok, features } (deploy smoke test)
//   GET  /api/playlist?url=          → playlist title + tracks (Spotify or YouTube)
//   GET  /api/bridge?url=            → same, plus a ytVideoId per Spotify track
//   POST /api/tape                   → multipart: tape JSON + memo/photo files
//                                      → { id, url, embedUrl, ownerToken }
//   GET  /api/tape/:id               → PUBLIC view (no email, no replies, no tokens)
//   GET  /api/tape/:id/replies       → sender only (x-owner-token header)
//   POST /api/tape/:id/reply         → recipient's ONE reply (text or voice)
//   GET  /api/media/:id/:file        → memo / photo / reply audio from R2
//   GET  /t/:id                      → recipient page (full screen)
//   GET  /embed/:id                  → recipient page, frameable by EMBED_ORIGINS
//   everything else                  → static front-end in ./public
//
// Secrets (all optional — the app degrades gracefully without them):
//   SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET  official Spotify Web API
//   YOUTUBE_API_KEY                            YouTube titles + Spotify→YouTube bridge

// ---------- helpers ----------
const ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // no 0/O/1/l/o confusion
const TOKEN_ALPHABET = ID_ALPHABET + "ABCDEFGHJKLMNPQRSTUVWXYZ";
const SKINS = ["trans", "lesbian", "bi", "nb", "pride"];
const SHELLS = ["boombox", "carabiner", "heart"];
const SCENES = ["desk", "nightstand", "car"];
const MEMO_POSITIONS = ["intro", "outro", "over-ad"];

function randomString(len, alphabet) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}
const shortId = (len = 10) => randomString(len, ID_ALPHABET);
const newToken = () => randomString(32, TOKEN_ALPHABET);

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const j = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { ...JSON_HEADERS, ...extra } });
const err = (msg, status = 400) => j({ ok: false, error: msg }, status);

const str = (v, max) => String(v ?? "").trim().slice(0, max);
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
const num = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const ttlSeconds = (env) => 60 * 60 * 24 * Number(env.TAPE_TTL_DAYS || 180);

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Very small per-IP rate limit using the edge cache (best-effort, per colo).
// Good enough to stop a script from filling KV/R2; not a security boundary.
async function rateLimited(req, bucket, limit, windowSec) {
  const ip = req.headers.get("cf-connecting-ip") || "local";
  const slot = Math.floor(Date.now() / 1000 / windowSec);
  const key = new Request(`https://rl.t4tmix.internal/${bucket}/${ip}/${slot}`);
  const cache = caches.default;
  const hit = await cache.match(key);
  const count = hit ? Number(await hit.text()) : 0;
  if (count >= limit) return true;
  await cache.put(key, new Response(String(count + 1), {
    headers: { "cache-control": `max-age=${windowSec}` },
  }));
  return false;
}

// ---------- playlists: Spotify + YouTube ----------
// Reality check (Spotify, Feb 2026 dev-mode changes): Client Credentials can still
// read playlist *metadata*, but GET /playlists/{id}/items only returns contents for
// playlists the app user owns/collaborates on. So for "paste any public playlist"
// the official API alone can't list tracks. Order of attempts:
//   1. official Web API (/items)            — works for playlists you own
//   2. public embed page (unofficial)        — works for any public playlist, may break
//   3. caller falls back to sample tracks    — app still usable
function spotifyPlaylistId(input) {
  const m = String(input).match(/playlist[/:]([a-zA-Z0-9]{22})/);
  if (m) return m[1];
  return /^[a-zA-Z0-9]{22}$/.test(String(input).trim()) ? String(input).trim() : null;
}
function youtubeListId(input) {
  const m = String(input).match(/[?&]list=([a-zA-Z0-9_-]{10,64})/);
  return m ? m[1] : null;
}

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
      const t = it.item || it.track; // Feb 2026 renamed track → item
      if (!t || !t.name) continue;
      tracks.push({ title: t.name, artist: (t.artists || []).map((a) => a.name).join(", "), durationMs: t.duration_ms || null });
    }
    next = d.next || null;
  }
  if (!tracks.length) return { title: m.name || "", tracks: [], partial: true };
  return { title: m.name || "", tracks, via: "spotify-api" };
}

async function spotifyViaEmbed(id) {
  const r = await fetch(`https://open.spotify.com/embed/playlist/${id}`, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; T4TMix/0.6; +https://t4tmix.com)" },
  });
  if (!r.ok) return null;
  const html = await r.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    const ent = JSON.parse(m[1]).props.pageProps.state.data.entity;
    const tracks = (ent.trackList || []).map((t) => ({
      title: t.title, artist: t.subtitle || "", durationMs: t.duration || null,
      previewUrl: (t.audioPreview && t.audioPreview.url) || null,
    }));
    return { title: ent.name || ent.title || "", tracks, via: "spotify-embed" };
  } catch { return null; }
}

async function youtubePlaylist(listId, env) {
  if (!env.YOUTUBE_API_KEY) return { title: "", tracks: [], via: "none", needsKey: true };
  const key = encodeURIComponent(env.YOUTUBE_API_KEY);
  const meta = await fetch(`https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=${listId}&key=${key}`);
  const md = meta.ok ? await meta.json() : {};
  const title = md.items && md.items[0] ? md.items[0].snippet.title : "";
  const tracks = [];
  let page = "";
  for (let i = 0; i < 4; i++) { // up to 200 items, 1 quota unit per call
    const r = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${listId}&key=${key}${page ? `&pageToken=${page}` : ""}`);
    if (!r.ok) break;
    const d = await r.json();
    for (const it of d.items || []) {
      const s = it.snippet || {};
      if (!s.resourceId || !s.resourceId.videoId || s.title === "Private video" || s.title === "Deleted video") continue;
      tracks.push({
        title: s.title,
        artist: (s.videoOwnerChannelTitle || "").replace(/ - Topic$/, ""),
        ytVideoId: s.resourceId.videoId,
      });
    }
    if (!d.nextPageToken) break;
    page = d.nextPageToken;
  }
  return { title, tracks, via: "youtube-api" };
}

async function resolveYouTubeId(title, artist, env) {
  if (!env.YOUTUBE_API_KEY) return null;
  const cacheReq = new Request(`https://cache.t4tmix.internal/yt/${encodeURIComponent(`${title}|${artist}`.toLowerCase())}`);
  const hit = await caches.default.match(cacheReq);
  if (hit) return (await hit.text()) || null;
  const q = encodeURIComponent(`${title} ${artist}`);
  const r = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=1&videoEmbeddable=true&q=${q}&key=${encodeURIComponent(env.YOUTUBE_API_KEY)}`);
  if (!r.ok) return null; // quota exhausted etc. — don't cache failures
  const d = await r.json();
  const vid = d.items && d.items[0] && d.items[0].id ? d.items[0].id.videoId : "";
  await caches.default.put(cacheReq, new Response(vid || "", { headers: { "cache-control": "max-age=2592000" } }));
  return vid || null;
}

async function handlePlaylist(req, env, { bridge }) {
  const u = new URL(req.url).searchParams.get("url") || "";
  if (await rateLimited(req, "playlist", 30, 600)) return err("slow down a little 💌", 429);

  const ytList = youtubeListId(u);
  if (ytList) {
    const d = await youtubePlaylist(ytList, env);
    return j({ ok: true, source: "youtube", id: ytList, ...d });
  }
  const id = spotifyPlaylistId(u);
  if (!id) return err("that doesn't look like a Spotify or YouTube playlist link");

  // Cache the resolved playlist for 10 minutes so re-loads are instant.
  const cacheReq = new Request(`https://cache.t4tmix.internal/pl/${id}/${bridge ? "b" : "p"}`);
  const cached = await caches.default.match(cacheReq);
  if (cached) return new Response(cached.body, { headers: JSON_HEADERS });

  let d = (await spotifyViaApi(id, env).catch(() => null));
  if (!d || !d.tracks.length) d = (await spotifyViaEmbed(id).catch(() => null)) || d;
  if (!d || !d.tracks.length) return err("couldn't read that playlist — is it public?", 404);

  if (bridge && env.YOUTUBE_API_KEY) {
    const cap = Number(env.MAX_BRIDGE_TRACKS || 50); // ~100 quota units per fresh track
    const list = d.tracks.slice(0, cap);
    for (let i = 0; i < list.length; i += 5) {
      const ids = await Promise.all(list.slice(i, i + 5).map((t) => resolveYouTubeId(t.title, t.artist, env).catch(() => null)));
      ids.forEach((v, k) => { list[i + k].ytVideoId = v; });
    }
  }
  const body = JSON.stringify({ ok: true, source: "spotify", id, ...d, bridged: !!(bridge && env.YOUTUBE_API_KEY) });
  await caches.default.put(cacheReq, new Response(body, { headers: { "cache-control": "max-age=600" } }));
  return new Response(body, { headers: JSON_HEADERS });
}

// ---------- tapes ----------
// POST /api/tape is multipart/form-data:
//   tape         JSON string (see sanitizeTape for the accepted shape)
//   memo_<i>     optional audio blob for track i (≤ MAX_MEMO_BYTES)
//   cover        optional label photo (≤ MAX_PHOTO_BYTES)
//   shellPhoto   optional photo wrapped on the player
//   windowPhoto  optional photo in the player window
// Media lives in R2 under "<tapeId>/<file>"; the tape JSON only stores file names.
const MEDIA_FILE = /^(memo-\d{1,3}\.(webm|ogg|mp4|m4a)|(cover|shell|window)\.(jpg|png|webp|gif)|reply\.(webm|ogg|mp4|m4a))$/;
const AUDIO_EXT = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "mp4", "audio/x-m4a": "m4a", "audio/aac": "m4a" };
const IMAGE_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

function sanitizeSticker(s) {
  return {
    emoji: str(s && s.emoji, 16),
    x: num(s && s.x, 0, 100, 50), y: num(s && s.y, 0, 100, 50),
    size: num(s && s.size, 16, 160, 44), rotation: num(s && s.rotation, -180, 180, 0),
  };
}
function sanitizeTape(b) {
  const pl = b.playlist || {};
  const source = oneOf(pl.source, ["spotify", "youtube"], null);
  const idOk = source === "spotify" ? /^[a-zA-Z0-9]{22}$/.test(pl.id || "") : /^[a-zA-Z0-9_-]{10,64}$/.test(pl.id || "");
  return {
    senderName: str(b.senderName, 40),
    recipientName: str(b.recipientName, 40),
    tapeTitle: str(b.tapeTitle, 60) || "a mix for you",
    engraving: str(b.engraving, 40),
    letter: str(b.letter, 4000),
    contentType: "playlist",
    playlist: source && idOk ? { source, id: pl.id, title: str(pl.title, 120) } : null,
    tracks: (Array.isArray(b.tracks) ? b.tracks : []).slice(0, 200).map((t) => ({
      original: str(t.original, 160), display: str(t.display || t.original, 160),
      artist: str(t.artist, 160), note: str(t.note, 600),
      memoPosition: oneOf(t.memoPosition, MEMO_POSITIONS, "intro"),
      ytVideoId: /^[a-zA-Z0-9_-]{11}$/.test(t.ytVideoId || "") ? t.ytVideoId : null,
    })),
    stickersFront: (Array.isArray(b.stickersFront) ? b.stickersFront : []).slice(0, 40).map(sanitizeSticker),
    stickersShell: (Array.isArray(b.stickersShell) ? b.stickersShell : []).slice(0, 40).map(sanitizeSticker),
    skin: oneOf(b.skin, SKINS, "trans"),
    shell: oneOf(b.shell, SHELLS, "boombox"),
    wrapStyle: oneOf(b.wrapStyle, ["fullbody", "framed", "both"], "fullbody"),
    scene: oneOf(b.scene, SCENES, "desk"),
  };
}

async function putFile(env, id, name, file, maxBytes) {
  if (!file || typeof file === "string") return null;
  if (file.size > maxBytes) throw new Error(`${name} is too big`);
  const key = `${id}/${name}`;
  await env.MEDIA.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
  return name;
}

async function saveTape(req, env) {
  if (await rateLimited(req, "save", 20, 3600)) return err("that's a lot of tapes — try again in a bit", 429);
  const ct = req.headers.get("content-type") || "";
  if (!ct.startsWith("multipart/form-data")) return err("expected multipart/form-data", 415);
  const len = Number(req.headers.get("content-length") || 0);
  if (len > 25 * 1024 * 1024) return err("tape too large", 413);

  const form = await req.formData();
  const raw = String(form.get("tape") || "");
  if (raw.length > Number(env.MAX_TAPE_BYTES || 65536)) return err("tape too large", 413);
  let body;
  try { body = JSON.parse(raw); } catch { return err("invalid tape json"); }

  const tape = sanitizeTape(body);
  if (!tape.tracks.length && !tape.letter) return err("add a song or a letter first");

  const id = shortId(10);
  const ownerToken = newToken();
  const memoMax = Number(env.MAX_MEMO_BYTES || 1048576);
  const photoMax = Number(env.MAX_PHOTO_BYTES || 2097152);
  try {
    for (let i = 0; i < tape.tracks.length; i++) {
      const f = form.get(`memo_${i}`);
      if (!f || typeof f === "string") continue;
      const ext = AUDIO_EXT[(f.type || "").split(";")[0]];
      if (!ext) continue;
      tape.tracks[i].memo = await putFile(env, id, `memo-${i}.${ext}`, f, memoMax);
    }
    for (const [field, base] of [["cover", "cover"], ["shellPhoto", "shell"], ["windowPhoto", "window"]]) {
      const f = form.get(field);
      if (!f || typeof f === "string") continue;
      const ext = IMAGE_EXT[f.type];
      if (!ext) continue;
      tape[`${base}Photo`] = await putFile(env, id, `${base}.${ext}`, f, photoMax);
    }
  } catch (e) {
    return err(e.message || "upload failed", 413);
  }

  const record = {
    id, v: 2, createdAt: new Date().toISOString(),
    ownerHash: await sha256(ownerToken),
    senderEmail: str(body.senderEmail, 120), // private — never returned publicly
    ...tape,
    reply: null,
  };
  await env.TAPES.put(`tape:${id}`, JSON.stringify(record), { expirationTtl: ttlSeconds(env) });
  const origin = env.APP_ORIGIN || new URL(req.url).origin;
  return j({ ok: true, id, ownerToken, url: `${origin}/t/${id}`, embedUrl: `${origin}/embed/${id}` }, 201);
}

async function loadTape(env, id) {
  const raw = await env.TAPES.get(`tape:${id}`);
  return raw ? JSON.parse(raw) : null;
}
function publicView(t) {
  const { ownerHash, senderEmail, reply, ...rest } = t;
  return { ...rest, hasReply: !!reply };
}

async function getReplies(req, env, id) {
  const t = await loadTape(env, id);
  if (!t) return err("tape not found", 404);
  const token = req.headers.get("x-owner-token") || "";
  if (!token || !safeEqual(await sha256(token), t.ownerHash)) return err("not your tape", 403);
  return j({ ok: true, reply: t.reply });
}

async function postReply(req, env, id, ctx) {
  if (await rateLimited(req, "reply", 10, 3600)) return err("slow down a little 💌", 429);
  const t = await loadTape(env, id);
  if (!t) return err("tape not found", 404);
  if (t.reply) return err("this tape already has its reply 💌", 409);
  const ct = req.headers.get("content-type") || "";
  if (!ct.startsWith("multipart/form-data")) return err("expected multipart/form-data", 415);
  const form = await req.formData();
  const kind = String(form.get("kind") || "");
  const reply = { at: new Date().toISOString(), from: str(form.get("from"), 40) };
  if (kind === "text") {
    reply.type = "text";
    reply.text = str(form.get("text"), 500);
    if (!reply.text) return err("empty reply");
  } else if (kind === "voice") {
    const f = form.get("audio");
    const ext = f && typeof f !== "string" ? AUDIO_EXT[(f.type || "").split(";")[0]] : null;
    if (!ext) return err("missing audio");
    try { reply.audio = await putFile(env, id, `reply.${ext}`, f, Number(env.MAX_MEMO_BYTES || 1048576)); }
    catch (e) { return err(e.message, 413); }
    reply.type = "audio";
  } else return err("unknown reply kind");

  t.reply = reply;
  await env.TAPES.put(`tape:${id}`, JSON.stringify(t), { expirationTtl: ttlSeconds(env) });
  if (env.SEND_EMAIL && t.senderEmail) ctx.waitUntil(sendReplyEmail(env, t, reply).catch((e) => console.error("email failed", e)));
  return j({ ok: true });
}

async function sendReplyEmail(env, t, reply) {
  const { EmailMessage } = await import("cloudflare:email");
  const { createMimeMessage } = await import("mimetext");
  const host = new URL(env.APP_ORIGIN).hostname;
  const msg = createMimeMessage();
  msg.setSender({ name: "T4T Mix", addr: `no-reply@${host}` });
  msg.setRecipient(t.senderEmail);
  msg.setSubject(`💌 ${t.recipientName || "someone"} wrote back about "${t.tapeTitle}"`);
  const link = `${env.APP_ORIGIN}/t/${t.id}`;
  msg.addMessage({
    contentType: "text/plain",
    data: reply.type === "text"
      ? `they said:\n\n${reply.text}\n\n— open your tape: ${link}`
      : `they left you a voice memo. open the T4T Mix app on the device you sent from to listen.\n\n${link}`,
  });
  await env.SEND_EMAIL.send(new EmailMessage(`no-reply@${host}`, t.senderEmail, msg.asRaw()));
}

async function getMedia(req, env, id, file) {
  if (!MEDIA_FILE.test(file)) return new Response("not found", { status: 404 });
  if (file.startsWith("reply.")) {
    // reply audio is sender-only
    const t = await loadTape(env, id);
    const token = new URL(req.url).searchParams.get("owner") || req.headers.get("x-owner-token") || "";
    if (!t || !token || !safeEqual(await sha256(token), t.ownerHash)) return new Response("forbidden", { status: 403 });
  }
  const range = req.headers.get("range");
  const obj = await env.MEDIA.get(`${id}/${file}`, range ? { range: req.headers } : undefined);
  if (!obj) return new Response("not found", { status: 404 });
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set("accept-ranges", "bytes");
  h.set("cache-control", file.startsWith("reply.") ? "private, no-store" : "public, max-age=86400");
  h.set("x-content-type-options", "nosniff");
  if (range && obj.range) {
    const { offset = 0, length = obj.size - offset } = obj.range;
    h.set("content-range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    h.set("content-length", String(length));
    return new Response(obj.body, { status: 206, headers: h });
  }
  return new Response(obj.body, { headers: h });
}

// ---------- recipient page (/t/:id and /embed/:id) ----------
async function renderRecipient(req, env, id, { embed }) {
  const t = await loadTape(env, id);
  if (!t) return new Response(notFoundPage(), { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
  const shell = await env.ASSETS.fetch(new Request(new URL("/recipient.html", req.url)));
  if (!shell.ok) return new Response("recipient page missing", { status: 500 });
  let html = await shell.text();

  const title = t.senderName ? `a mixtape from ${escapeHtml(t.senderName)}` : "a T4T Mix for you";
  const desc = escapeHtml(t.recipientName ? `for ${t.recipientName} — tap to unwrap and press play.` : "tap to unwrap and press play.");
  const origin = env.APP_ORIGIN || new URL(req.url).origin;
  const og =
    `<meta property="og:title" content="${title}">\n` +
    `<meta property="og:description" content="${desc}">\n` +
    `<meta property="og:type" content="website">\n` +
    `<meta property="og:site_name" content="T4T Mix">\n` +
    `<meta property="og:image" content="${origin}/assets/full_recorder_${t.shell}.png">\n` +
    `<meta name="robots" content="noindex">\n`;
  html = html
    .replace('"__TAPE_ID__"', JSON.stringify(id))
    .replace('"__EMBED__"', embed ? "true" : "false")
    .replace("</head>", og + "</head>")
    .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`);

  const ancestors = embed ? `'self' ${env.EMBED_ORIGINS || ""}`.trim() : "'self'";
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `frame-ancestors ${ancestors}`,
      "referrer-policy": "strict-origin-when-cross-origin",
      "x-content-type-options": "nosniff",
    },
  });
}

function notFoundPage() {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>T4T Mix</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#1b0f24;color:#fbf6ea;font:16px system-ui;text-align:center">
<div><div style="font-size:48px">📼</div><p>this mixtape isn't here anymore.<br>tapes keep for about six months.</p>
<p><a style="color:#f5a9b8" href="/">make your own →</a></p></div></body>`;
}

// ---------- router ----------
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    const M = req.method;
    let m;
    try {
      if (p === "/api/health")
        return j({ ok: true, version: "0.6.0", features: {
          storage: !!(env.TAPES && env.MEDIA),
          spotifyApi: !!(env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET),
          youtube: !!env.YOUTUBE_API_KEY,
          replyEmail: !!env.SEND_EMAIL,
        } });
      if (p === "/api/playlist" && M === "GET") return handlePlaylist(req, env, { bridge: false });
      if (p === "/api/bridge" && M === "GET") return handlePlaylist(req, env, { bridge: true });
      if (p === "/api/tape" && M === "POST") return saveTape(req, env);
      if ((m = p.match(/^\/api\/tape\/([a-z2-9]{6,16})$/)) && M === "GET") {
        const t = await loadTape(env, m[1]);
        return t ? j(publicView(t), 200, { "cache-control": "public, max-age=30" }) : err("tape not found", 404);
      }
      if ((m = p.match(/^\/api\/tape\/([a-z2-9]{6,16})\/replies$/)) && M === "GET") return getReplies(req, env, m[1]);
      if ((m = p.match(/^\/api\/tape\/([a-z2-9]{6,16})\/reply$/)) && M === "POST") return postReply(req, env, m[1], ctx);
      if ((m = p.match(/^\/api\/media\/([a-z2-9]{6,16})\/([a-z0-9.-]{3,24})$/)) && M === "GET") return getMedia(req, env, m[1], m[2]);
      if ((m = p.match(/^\/t\/([a-z2-9]{6,16})\/?$/))) return renderRecipient(req, env, m[1], { embed: false });
      if ((m = p.match(/^\/embed\/([a-z2-9]{6,16})\/?$/))) return renderRecipient(req, env, m[1], { embed: true });
      if (p.startsWith("/api/")) return err("not found", 404);
    } catch (e) {
      console.error(e);
      return err("something went sideways — try again", 500);
    }
    return env.ASSETS.fetch(req);
  },
};
