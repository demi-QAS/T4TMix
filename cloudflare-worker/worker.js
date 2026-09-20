/**
 * T4T Mix — Spotify Metadata Worker
 * -----------------------------------
 * Legit, sanctioned way to pull real track titles/artists/preview audio
 * for ANY public Spotify playlist, using Spotify's official Web API
 * (Client Credentials flow — no user login needed, just an app registration).
 *
 * SETUP:
 * 1. Go to https://developer.spotify.com/dashboard, log in with any Spotify account (free).
 * 2. Click "Create app". Name it anything (e.g. "T4T Mix"). Redirect URI can be anything
 *    like https://t4tmix.com/callback — we don't use login, so it's never actually hit.
 * 3. Copy the Client ID and Client Secret it gives you.
 * 4. Deploy this file as a Cloudflare Worker (Workers & Pages -> Create -> paste this code).
 * 5. In the Worker's Settings -> Variables, add two SECRET environment variables:
 *      SPOTIFY_CLIENT_ID     = <your client id>
 *      SPOTIFY_CLIENT_SECRET = <your client secret>
 * 6. Deploy. You'll get a URL like https://t4tmix-spotify.<you>.workers.dev
 * 7. Call it like:
 *      GET https://t4tmix-spotify.<you>.workers.dev/api/playlist?url=<spotify playlist URL>
 *    Returns JSON: { name, subtitle, coverArt, tracks: [{ title, artist, duration_ms, preview_url }] }
 *
 * No audio is ever downloaded or stored by this Worker — it only fetches metadata
 * (titles/artists/cover art/30s preview URLs) that Spotify's own API returns for
 * public playlists. Playback should still happen via Spotify's official embed player
 * or by pointing an <audio> tag straight at the preview_url Spotify itself provides.
 */

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API_BASE = "https://api.spotify.com/v1";

// Simple in-memory token cache (resets on cold start — fine for this volume)
let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken(env) {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt) return cachedToken;

  const creds = btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!resp.ok) {
    throw new Error(`Spotify auth failed: ${resp.status} ${await resp.text()}`);
  }

  const data = await resp.json();
  cachedToken = data.access_token;
  tokenExpiresAt = now + (data.expires_in - 60) * 1000; // refresh 60s early
  return cachedToken;
}

function extractPlaylistId(url) {
  // Handles open.spotify.com/playlist/<id>?... and bare IDs
  const match = url.match(/playlist\/([a-zA-Z0-9]+)/);
  if (match) return match[1];
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

async function handlePlaylistRequest(request, env) {
  const url = new URL(request.url);
  const playlistUrl = url.searchParams.get("url");
  if (!playlistUrl) {
    return new Response(JSON.stringify({ error: "Missing ?url= parameter" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }

  const playlistId = extractPlaylistId(playlistUrl);
  if (!playlistId) {
    return new Response(JSON.stringify({ error: "Could not parse a playlist ID from that URL" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }

  try {
    const token = await getAccessToken(env);

    // Fetch playlist metadata (name, cover, owner)
    const metaResp = await fetch(
      `${API_BASE}/playlists/${playlistId}?fields=name,description,owner.display_name,images`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!metaResp.ok) {
      return new Response(JSON.stringify({ error: `Spotify API error: ${metaResp.status}` }), {
        status: metaResp.status,
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      });
    }
    const meta = await metaResp.json();

    // Fetch tracks (paginate if needed — most mixtapes are well under 100 tracks)
    let tracks = [];
    let nextUrl = `${API_BASE}/playlists/${playlistId}/tracks?fields=items(track(name,duration_ms,preview_url,artists(name))),next&limit=100`;
    while (nextUrl) {
      const tracksResp = await fetch(nextUrl, { headers: { Authorization: `Bearer ${token}` } });
      if (!tracksResp.ok) break;
      const tracksData = await tracksResp.json();
      const items = tracksData.items || [];
      tracks = tracks.concat(
        items
          .filter((item) => item.track)
          .map((item) => ({
            title: item.track.name,
            artist: (item.track.artists || []).map((a) => a.name).join(", "),
            duration_ms: item.track.duration_ms,
            preview_url: item.track.preview_url, // official 30s preview, or null if unavailable
          }))
      );
      nextUrl = tracksData.next || null;
    }

    const result = {
      name: meta.name,
      subtitle: meta.owner ? meta.owner.display_name : "",
      coverArt: meta.images && meta.images.length ? meta.images[0].url : null,
      tracks,
    };

    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300", ...corsHeaders() },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === "/api/playlist") {
      return handlePlaylistRequest(request, env);
    }

    return new Response("T4T Mix Spotify Worker — try /api/playlist?url=<spotify playlist url>", {
      headers: corsHeaders(),
    });
  },
};
