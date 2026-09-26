// T4T Mix — Recipient / Reply Worker (v0.1 scaffold)
// -----------------------------------------------------
// One Worker, three responsibilities:
//   1. POST /api/tape         — sender saves a tape, gets back {id, replyToken}
//   2. GET  /api/tape/:id     — recipient/sender fetches tape state (JSON)
//   3. GET  /t/:id            — recipient's SHAREABLE page (HTML shell + hydration)
//   4. POST /api/tape/:id/reply — recipient sends ONE reply (audio or text)
//   5. POST /api/tape/:id/memo — sender uploads a per-track voice memo to R2
//   6. GET  /api/memo/:key    — signed audio fetch (byte-range)
//
// Everything else falls through to the static front-end via env.ASSETS.

const ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // no 0/O/1/l/o confusion
const TOKEN_ALPHABET = ID_ALPHABET + ID_ALPHABET.toUpperCase();

function shortId(len = 8) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += ID_ALPHABET[b % ID_ALPHABET.length];
  return s;
}
function replyToken(len = 24) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length];
  return s;
}

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};
const j = (o, status = 200) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });
const err = (msg, status = 400) => j({ ok: false, error: msg }, status);

// ---------- ROUTES ----------

async function saveTape(req, env) {
  const raw = await req.text();
  if (raw.length > Number(env.MAX_TAPE_BYTES || 51200))
    return err("tape too large", 413);
  let body;
  try { body = JSON.parse(raw); } catch { return err("invalid json"); }
  if (!body || !body.tracks || !Array.isArray(body.tracks))
    return err("missing tracks");

  const id = shortId(8);
  const token = replyToken(24);
  const tape = {
    id,
    v: 1,
    createdAt: new Date().toISOString(),
    replyToken: token,        // sender keeps this; recipient never sees it
    replyTokenUsed: false,    // flipped true on first reply
    // Sender-authored content
    senderName: body.senderName || "",
    senderEmail: body.senderEmail || "", // for reply email routing; optional
    recipientName: body.recipientName || "",
    contentType: body.contentType || "playlist", // "playlist" | "audio" (podcast variant)
    playlist: body.playlist || null,             // {source:"spotify"|"youtube", id, title}
    audioUrl: body.audioUrl || null,             // for podcast variant
    tracks: body.tracks,                          // [{original, display, artist, note, memoKey, memoPosition}]
    letter: body.letter || "",
    stickersFront: body.stickersFront || [],
    stickersShell: body.stickersShell || [],
    skin: body.skin || "trans",
    shell: body.shell || "boombox",
    scene: body.scene || "desk",                  // NEW — parallax scene pick
    coverPhotoKey: body.coverPhotoKey || null,
    // Reply thread (max 1 for v0.1)
    replies: [],
  };
  await env.TAPES.put(`tape:${id}`, JSON.stringify(tape), {
    expirationTtl: 60 * 60 * 24 * Number(env.TAPE_TTL_DAYS || 180),
  });
  return j({ ok: true, id, replyToken: token, url: `${env.APP_ORIGIN}/t/${id}` });
}

async function getTape(env, id, { includeToken = false } = {}) {
  const raw = await env.TAPES.get(`tape:${id}`);
  if (!raw) return null;
  const tape = JSON.parse(raw);
  if (!includeToken) delete tape.replyToken;
  return tape;
}

async function fetchTape(env, id) {
  const tape = await getTape(env, id);
  if (!tape) return err("tape not found", 404);
  // Return the tape at the root — the recipient client reads t.tracks / t.scene
  // directly. `ok:true` is implicit via 200.
  return j(tape);
}

async function postReply(req, env, id) {
  const tape = await getTape(env, id, { includeToken: true });
  if (!tape) return err("tape not found", 404);
  if (tape.replyTokenUsed) return err("reply already used", 409);

  const ct = req.headers.get("content-type") || "";
  let reply = { at: new Date().toISOString() };

  // The recipient client posts FormData with a `kind` field ("voice"|"text").
  // Also accept raw JSON / raw audio for API clients.
  if (ct.startsWith("multipart/form-data")) {
    const form = await req.formData();
    const kind = String(form.get("kind") || "");
    if (kind === "text") {
      const text = String(form.get("text") || "").trim();
      if (!text) return err("empty reply");
      reply.type = "text";
      reply.text = text.slice(0, 500);
    } else if (kind === "voice") {
      const file = form.get("audio");
      if (!file || typeof file === "string") return err("missing audio");
      const key = `reply/${id}/${shortId(12)}.webm`;
      await env.MEMOS.put(key, file.stream(), {
        httpMetadata: { contentType: file.type || "audio/webm" },
      });
      reply.type = "audio";
      reply.audioKey = key;
    } else {
      return err("unknown reply kind");
    }
  } else if (ct.startsWith("application/json")) {
    const body = await req.json().catch(() => null);
    if (!body || !body.text) return err("empty reply");
    reply.type = "text";
    reply.text = String(body.text).slice(0, 500);
    reply.from = String(body.from || "").slice(0, 40);
  } else if (ct.startsWith("audio/") || ct.startsWith("application/octet-stream")) {
    const key = `reply/${id}/${shortId(12)}.webm`;
    await env.MEMOS.put(key, req.body, { httpMetadata: { contentType: ct } });
    reply.type = "audio";
    reply.audioKey = key;
  } else {
    return err("unsupported reply content-type", 415);
  }

  tape.replies.push(reply);
  tape.replyTokenUsed = true;
  await env.TAPES.put(`tape:${id}`, JSON.stringify(tape), {
    expirationTtl: 60 * 60 * 24 * Number(env.TAPE_TTL_DAYS || 180),
  });

  // Notify sender via Cloudflare Email Routing (optional; only if bound).
  // Requires:
  //   1. Email Routing enabled on the zone hosting APP_ORIGIN
  //   2. A verified destination address (the sender's email)
  //   3. `send_email` binding in wrangler.jsonc with allowed_destination_addresses
  //   4. `tape.senderEmail` captured at save time (sender-side patch does this)
  if (env.SEND_EMAIL && tape.senderEmail) {
    try {
      await sendReplyEmail(env, tape, reply);
    } catch (e) {
      console.error("email send failed", e);
      // Non-fatal: reply is already stored and visible when sender polls.
    }
  }

  return j({ ok: true });
}

async function sendReplyEmail(env, tape, reply) {
  // Lazy-import to keep cold-start light for tapes without email.
  const { EmailMessage } = await import("cloudflare:email");
  const { createMimeMessage } = await import("mimetext");

  const msg = createMimeMessage();
  msg.setSender({ name: "T4T Mix", addr: `no-reply@${new URL(env.APP_ORIGIN).hostname}` });
  msg.setRecipient(tape.senderEmail);
  msg.setSubject(`💌 ${tape.recipientName || "someone"} wrote back`);

  const listenLink = `${env.APP_ORIGIN}/t/${tape.id}#replies`;
  const bodyLines = reply.type === "text"
    ? [`they said:`, ``, reply.text, ``, `— open the tape: ${listenLink}`]
    : [`they left a voice memo.`, ``, `open the tape to listen: ${listenLink}`];

  msg.addMessage({ contentType: "text/plain", data: bodyLines.join("\n") });

  const message = new EmailMessage(
    `no-reply@${new URL(env.APP_ORIGIN).hostname}`,
    tape.senderEmail,
    msg.asRaw()
  );
  await env.SEND_EMAIL.send(message);
}

async function uploadMemo(req, env, id) {
  // Sender uploads a per-track voice memo BEFORE the tape is saved. Returns a key
  // the sender then embeds in the tape JSON.
  const key = `memo/${id || "draft"}/${shortId(12)}.webm`;
  const ct = req.headers.get("content-type") || "audio/webm";
  await env.MEMOS.put(key, req.body, { httpMetadata: { contentType: ct } });
  return j({ ok: true, key, url: `/api/memo/${encodeURIComponent(key)}` });
}

async function fetchMemo(env, key) {
  const obj = await env.MEMOS.get(key, {
    range: undefined, // TODO: honor Range: header for scrubbable audio
  });
  if (!obj) return new Response("not found", { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  return new Response(obj.body, { headers });
}

// ---------- RECIPIENT HTML SHELL ----------
// Server-renders a minimal shell (title, OG tags for Signal/iMessage previews)
// then hydrates from /api/tape/:id on the client. The heavy player + parallax
// scene JS lives in the static front-end and is served by env.ASSETS.

async function renderRecipient(env, id) {
  const tape = await getTape(env, id);
  if (!tape) {
    return new Response("this mixtape isn't here anymore 💌", { status: 404 });
  }
  // Fetch the full recipient shell from static assets, inject TAPE_ID + OG tags.
  const shellReq = new Request(new URL("/recipient.html", "http://internal"));
  const shellRes = await env.ASSETS.fetch(shellReq);
  if (!shellRes.ok) {
    return new Response("recipient shell missing", { status: 500 });
  }
  let html = await shellRes.text();

  const title = tape.senderName
    ? `a mixtape from ${escape(tape.senderName)}`
    : "a T4T Mix for you";
  const desc = tape.letter
    ? escape(tape.letter.slice(0, 140))
    : "tap to unwrap and press play.";
  const ogTags =
    `<meta property="og:title" content="${title}">\n` +
    `<meta property="og:description" content="${desc}">\n` +
    `<meta property="og:type" content="music.playlist">\n` +
    `<meta property="og:site_name" content="T4T Mix">\n` +
    `<meta name="twitter:card" content="summary_large_image">\n`;

  html = html
    .replace('"__TAPE_ID__"', JSON.stringify(id))
    .replace("</head>", ogTags + "</head>")
    .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`);

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function escape(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------- MAIN ROUTER ----------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    // API
    if (pathname === "/api/tape" && req.method === "POST")
      return saveTape(req, env);

    let m;
    if ((m = pathname.match(/^\/api\/tape\/([a-z0-9]{6,32})$/i)) && req.method === "GET")
      return fetchTape(env, m[1]);
    if ((m = pathname.match(/^\/api\/tape\/([a-z0-9]{6,32})\/reply$/i)) && req.method === "POST")
      return postReply(req, env, m[1]);
    if ((m = pathname.match(/^\/api\/tape\/([a-z0-9]{6,32})\/memo$/i)) && req.method === "POST")
      return uploadMemo(req, env, m[1]);
    if ((m = pathname.match(/^\/api\/memo\/(.+)$/i)) && req.method === "GET")
      return fetchMemo(env, decodeURIComponent(m[1]));

    // Recipient page
    if ((m = pathname.match(/^\/t\/([a-z0-9]{6,32})$/i)))
      return renderRecipient(env, m[1]);

    // Static assets (front-end)
    return env.ASSETS.fetch(req);
  },
};
