/**
 * T4T Mix — Spotify → YouTube Bridge Worker (v2)
 * -----------------------------------------------
 * Same as v1 (public playlist metadata via Spotify Client Credentials),
 * PLUS the YouTube bridge: for each track, we search YouTube Data API
 * for the best matching video ID and return it. The T4T Mix front-end
 * then plays those YouTube video IDs through the IFrame Player API.
 *
 * SETUP (v2 additions):
 * 1. Get a YouTube Data API key: https://console.cloud.google.com/apis/library/youtube.googleapis.com
 *    (Enable the API → Credentials → Create API key → restrict to "YouTube Data API v3")
 * 2. In the Worker's Settings → Variables, add a THIRD secret env var:
 *      YOUTUBE_API_KEY = <your api key>
 * 3. Deploy. New endpoint:
 *      GET https://<worker>.workers.dev/api/bridge?url=<spotify playlist URL>
 *    Returns: { name, subtitle, coverArt, tracks: [{ title, artist, duration_ms, ytVideoId }] }
 *
 * The old /api/playlist endpoint is preserved as-is for backwards compat.
 *
 * QUOTA NOTES:
 *   - YouTube Data API free tier: 10,000 units/day.
 *   - search.list = 100 units per call → ~100 track lookups/day free.
 *   - This Worker caches (title|artist) → ytVideoId in the CACHES API for 30 days,
 *     so a viral playlist doesn't burn quota on repeat resolves. Cold new tracks
 *     are the only ones that hit the API.
 */

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API_BASE = "https://api.spotify.com/v1";
const YT_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search";

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken(env) {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt) return cachedToken;
  const creds = btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!resp.ok) throw new Error(`Spotify auth failed: ${resp.status}`);
  const data = await resp.json();
  cachedToken = data.access_token;
  tokenExpiresAt = now + (data.expires_in - 60) * 1000;
  return cachedToken;
}

function extractPlaylistId(url) {
  const m = url.match(/playlist\/([a-zA-Z0-9]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9]{22}$/.test(url.trim())) return url.trim();
  return null;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

async function fetchSpotifyTracks(playlistId, env) {
  const token = await getAccessToken(env);
  const metaResp = await fetch(
    `${API_BASE}/playlists/${playlistId}?fields=name,description,owner.display_name,images`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!metaResp.ok) throw new Error(`Spotify API error: ${metaResp.status}`);
  const meta = await metaResp.json();

  let tracks = [];
  let nextUrl = `${API_BASE}/playlists/${playlistId}/tracks?fields=items(track(name,duration_ms,preview_url,artists(name))),next&limit=100`;
  while (nextUrl) {
    const tr = await fetch(nextUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!tr.ok) break;
    const td = await tr.json();
    const items = td.items || [];
    tracks = tracks.concat(
      items.filter((it) => it.track).map((it) => ({
        title: it.track.name,
        artist: (it.track.artists || []).map((a) => a.name).join(", "),
        duration_ms: it.track.duration_ms,
        preview_url: it.track.preview_url,
      }))
    );
    nextUrl = td.next || null;
  }

  return {
    name: meta.name,
    subtitle: meta.owner ? meta.owner.display_name : "",
    coverArt: meta.images && meta.images.length ? meta.images[0].url : null,
    tracks,
  };
}

// -------- YouTube bridge --------

async function resolveYouTubeId(title, artist, env, cache) {
  const cacheKey = `yt:${title}|${artist}`.toLowerCase();
  // Try CF cache first (30d TTL)
  const cacheReq = new Request(`https://cache.t4tmix.local/${encodeURIComponent(cacheKey)}`);
  if (cache) {
    const hit = await cache.match(cacheReq);
    if (hit) return await hit.text();
  }
  // Miss → search YouTube
  const q = encodeURIComponent(`${title} ${artist}`);
  const searchUrl = `${YT_SEARCH_URL}?part=snippet&type=video&maxResults=1&videoEmbeddable=true&q=${q}&key=${env.YOUTUBE_API_KEY}`;
  const resp = await fetch(searchUrl);
  if (!resp.ok) return null;
  const data = await resp.json();
  const item = (data.items || [])[0];
  const vid = item && item.id ? item.id.videoId : null;
  if (vid && cache) {
    await cache.put(cacheReq, new Response(vid, { headers: { "Cache-Control": "public, max-age=2592000" } }));
  }
  return vid;
}

async function handleBridgeRequest(request, env, ctx) {
  const url = new URL(request.url);
  const playlistUrl = url.searchParams.get("url");
  if (!playlistUrl) {
    return new Response(JSON.stringify({ error: "Missing ?url= parameter" }), {
      status: 400, headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }
  const playlistId = extractPlaylistId(playlistUrl);
  if (!playlistId) {
    return new Response(JSON.stringify({ error: "Could not parse playlist ID" }), {
      status: 400, headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }
  if (!env.YOUTUBE_API_KEY) {
    return new Response(JSON.stringify({ error: "YOUTUBE_API_KEY not configured — set it in Worker Variables" }), {
      status: 500, headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }

  try {
    const spotifyData = await fetchSpotifyTracks(playlistId, env);
    const cache = caches.default;
    // Resolve YT IDs in parallel (with a small concurrency cap so we don't slam the API)
    const CONCURRENCY = 5;
    const resolved = [];
    for (let i = 0; i < spotifyData.tracks.length; i += CONCURRENCY) {
      const batch = spotifyData.tracks.slice(i, i + CONCURRENCY);
      const ids = await Promise.all(
        batch.map((t) => resolveYouTubeId(t.title, t.artist, env, cache).catch(() => null))
      );
      batch.forEach((t, j) => resolved.push({ ...t, ytVideoId: ids[j] }));
    }
    return new Response(JSON.stringify({ ...spotifyData, tracks: resolved }), {
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300", ...corsHeaders() },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }
}

// Old endpoint kept for backwards compat
async function handlePlaylistRequest(request, env) {
  const url = new URL(request.url);
  const playlistUrl = url.searchParams.get("url");
  if (!playlistUrl) {
    return new Response(JSON.stringify({ error: "Missing ?url= parameter" }), {
      status: 400, headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }
  const playlistId = extractPlaylistId(playlistUrl);
  if (!playlistId) {
    return new Response(JSON.stringify({ error: "Could not parse playlist ID" }), {
      status: 400, headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }
  try {
    const data = await fetchSpotifyTracks(playlistId, env);
    return new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300", ...corsHeaders() },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });
    if (url.pathname === "/api/playlist") return handlePlaylistRequest(request, env);
    if (url.pathname === "/api/bridge")  return handleBridgeRequest(request, env, ctx);
    return new Response("T4T Mix Worker v2 — /api/playlist for metadata only, /api/bridge for Spotify→YouTube resolved", {
      headers: corsHeaders(),
    });
  },
};
// v4.1 build - 2026-09-20T18:05:10Z
