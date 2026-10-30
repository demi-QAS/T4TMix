// T4T Mix — one Worker for everything (v0.8, 2026-10-30)
// ---------------------------------------------------------------------------
//   GET  /api/health                 → { ok, features }
//   GET  /api/config                 → public switches (banner, lanes, donation link…)
//   GET  /api/playlist?url=          → playlist title + tracks (Spotify, YouTube or SoundCloud)
//   GET  /api/match?title=&artist=&provider=youtube|soundcloud
//   POST /api/tape                   → multipart: tape JSON + memo/photo files
//   GET  /api/tape/:id               → PUBLIC view
//   GET  /api/tape/:id/replies       → sender only (x-owner-token or signed-in owner)
//   POST /api/tape/:id/reply         → recipient's ONE reply → { replyUrl }
//   GET  /api/reply/:token           → the reply, for whoever holds the private reply link
//   GET  /api/reply/:token/audio     → reply voice memo
//   GET/POST /api/access             → access-code gate (check / redeem a code → pass)
//   POST /api/feedback               → feedback form
//   POST /api/auth/start | /api/auth/verify | /api/auth/logout   phone sign-in
//   GET/PATCH /api/me, POST /api/me/claim
//   *    /api/admin/*                → admin console API (x-admin-token)
//   GET  /t/:id  /embed/:id          → recipient page
//   GET  /r/:token                   → "they wrote back" page (the return envelope)
//   GET  /admin                      → admin console (static, token-gated API)
import {
  shortId, newToken, sha256, safeEqual, j, err, str, oneOf, ttlSeconds, revTs, escapeHtml, rateLimited,
  getConfig, publicConfig, SKINS, SHELLS, SCENES, MEMO_POSITIONS, INKS, PAPERS, readJson, smsReady,
} from "./lib.js";
import { handlePlaylist, handleMatch } from "./playlists.js";
import { authStart, authVerify, authLogout, getMe, patchMe, claimTapes, getUser, bump, textReply, ttlLeft } from "./auth.js";
import { handleAdmin } from "./admin.js";
import { hasAccess, gateError, redeem, accessStatus } from "./access.js";

const VERSION = "0.9.1";

// ---------- tapes ----------
const MEDIA_FILE = /^(memo-\d{1,3}\.(webm|ogg|mp4|m4a)|(cover|shell|window)\.(jpg|png|webp|gif)|reply\.(webm|ogg|mp4|m4a))$/;
const AUDIO_EXT = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "mp4", "audio/x-m4a": "m4a", "audio/aac": "m4a" };
const IMAGE_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

function sanitizeTape(b) {
  const pl = b.playlist || {};
  const source = oneOf(pl.source, ["spotify", "youtube", "soundcloud"], null);
  const idOk = source === "spotify" ? /^[a-zA-Z0-9]{22}$/.test(pl.id || "")
    : source === "youtube" ? /^[a-zA-Z0-9_-]{10,64}$/.test(pl.id || "")
    : source === "soundcloud" ? /^https:\/\/(on\.)?soundcloud\.com\/[a-zA-Z0-9_\-/]{3,160}$/.test(pl.id || "") : false;
  return {
    senderName: str(b.senderName, 40),
    recipientName: str(b.recipientName, 40),
    tapeTitle: str(b.tapeTitle, 60) || "a mix for you",
    engraving: str(b.engraving, 40),
    letter: str(b.letter, 4000),
    contentType: "playlist",
    playlist: source && idOk ? { source, id: pl.id, title: str(pl.title, 120) } : null,
    tracks: (Array.isArray(b.tracks) ? b.tracks : []).slice(0, 200).map((t) => ({
      original: str(t.original || t.title, 160), display: str(t.display || t.original || t.title, 160),
      artist: str(t.artist, 160), note: str(t.note, 600),
      memoPosition: oneOf(t.memoPosition, MEMO_POSITIONS, "intro"),
      ytVideoId: /^[a-zA-Z0-9_-]{11}$/.test(t.ytVideoId || "") ? t.ytVideoId : null,
      spotifyId: /^[a-zA-Z0-9]{22}$/.test(t.spotifyId || "") ? t.spotifyId : null,
      scId: /^\d{3,15}$/.test(String(t.scId || "")) ? String(t.scId) : null,
      previewUrl: /^https:\/\/p\.scdn\.co\/mp3-preview\/[a-f0-9]{20,64}$/.test(t.previewUrl || "") ? t.previewUrl : null,
    })), // never filter here: memo_<i> files are matched to tracks by position
    ink: oneOf(b.ink, INKS, "midnight"),
    paper: oneOf(b.paper, PAPERS, "cream"),
    skin: oneOf(b.skin, SKINS, "trans"),
    shell: oneOf(b.shell, SHELLS, "boombox"),
    scene: oneOf(b.scene, SCENES, "desk"),
  };
}

async function putFile(env, id, name, file, maxBytes) {
  if (!file || typeof file === "string") return null;
  if (file.size > maxBytes) throw new Error(`${name.split(".")[0].replace(/-\d+$/, "")} is too big`);
  if (file.size < 200) return null; // empty / broken recording
  await env.MEDIA.put(`${id}/${name}`, file.stream(), { httpMetadata: { contentType: file.type.split(";")[0] } });
  return name;
}

async function saveTape(req, env) {
  const cfg = await getConfig(env);
  if (cfg.maintenance || !cfg.newTapes) return err(cfg.banner || "sending is paused for a moment — try again soon", 503);
  if (!(await hasAccess(req, env, cfg))) return gateError();
  if (await rateLimited(req, env, "save", 20, 3600)) return err("that's a lot of tapes — try again in a bit", 429);
  const ct = req.headers.get("content-type") || "";
  if (!ct.startsWith("multipart/form-data")) return err("expected multipart/form-data", 415);
  const len = Number(req.headers.get("content-length") || 0);
  if (len > 40 * 1024 * 1024) return err("tape too large", 413);

  const form = await req.formData();
  const raw = String(form.get("tape") || "");
  if (raw.length > Number(env.MAX_TAPE_BYTES || 65536)) return err("tape too large", 413);
  let body;
  try { body = JSON.parse(raw); } catch { return err("invalid tape json"); }

  const tape = sanitizeTape(body);
  if (!tape.tracks.length && !tape.letter) return err("add a song or a letter first");
  const user = await getUser(req, env);

  const id = shortId(10);
  const ownerToken = newToken();
  const memoMax = Number(env.MAX_MEMO_BYTES || 1048576);
  const photoMax = Number(env.MAX_PHOTO_BYTES || 2097152);
  const uploaded = [];
  try {
    for (let i = 0; i < tape.tracks.length; i++) {
      const f = form.get(`memo_${i}`);
      if (!f || typeof f === "string") continue;
      const ext = AUDIO_EXT[(f.type || "").split(";")[0]];
      if (!ext) continue;
      const name = await putFile(env, id, `memo-${i}.${ext}`, f, memoMax);
      if (name) { tape.tracks[i].memo = name; uploaded.push(name); }
    }
    for (const [field, base] of [["cover", "cover"]]) {
      const f = form.get(field);
      if (!f || typeof f === "string") continue;
      const ext = IMAGE_EXT[(f.type || "").split(";")[0]];
      if (!ext) continue;
      const name = await putFile(env, id, `${base}.${ext}`, f, photoMax);
      if (name) { tape[`${base}Photo`] = name; uploaded.push(name); }
    }
  } catch (e) {
    // don't leave half a tape's media behind in R2
    if (uploaded.length) await env.MEDIA.delete(uploaded.map((n) => `${id}/${n}`)).catch(() => {});
    return err(e.message || "upload failed", 413);
  }

  const record = {
    id, v: 3, createdAt: new Date().toISOString(),
    ownerHash: await sha256(ownerToken),
    ownerUid: user ? user.id : null,
    senderEmail: str(body.senderEmail, 120),
    ...tape,
    reply: null,
  };
  const ttl = ttlSeconds(env);
  await env.TAPES.put(`tape:${id}`, JSON.stringify(record), { expirationTtl: ttl });
  await env.TAPES.put(`idx:tape:${revTs()}:${id}`, "", { expirationTtl: ttl, metadata: {
    t: record.tapeTitle.slice(0, 40), to: record.recipientName.slice(0, 20), n: record.tracks.length,
    m: record.tracks.filter((x) => x.memo).length, u: user ? user.id : "" } });
  if (user) await env.TAPES.put(`utape:${user.id}:${revTs()}:${id}`, "", { expirationTtl: ttl });
  await bump(env, "tapes");
  const origin = env.APP_ORIGIN || new URL(req.url).origin;
  return j({ ok: true, id, ownerToken, url: `${origin}/t/${id}`, embedUrl: `${origin}/embed/${id}`, linkedToAccount: !!user,
    memos: record.tracks.filter((x) => x.memo).length }, 201);
}

async function loadTape(env, id) {
  const raw = await env.TAPES.get(`tape:${id}`);
  return raw ? JSON.parse(raw) : null;
}
function publicView(t) {
  const { ownerHash, ownerUid, senderEmail, reply, ...rest } = t;
  return { ...rest, hasReply: !!reply };
}
async function isOwner(req, env, t) {
  const token = req.headers.get("x-owner-token") || new URL(req.url).searchParams.get("owner") || "";
  if (token && safeEqual(await sha256(token), t.ownerHash)) return true;
  if (t.ownerUid) { const u = await getUser(req, env); if (u && u.id === t.ownerUid) return true; }
  return false;
}

async function getReplies(req, env, id) {
  const t = await loadTape(env, id);
  if (!t) return err("tape not found", 404);
  if (!(await isOwner(req, env, t))) return err("not your tape", 403);
  const origin = env.APP_ORIGIN || new URL(req.url).origin;
  const reply = t.reply ? { ...t.reply, link: t.reply.viewToken ? `${origin}/r/${t.reply.viewToken}` : null } : null;
  return j({ ok: true, reply });
}

async function postReply(req, env, id, ctx) {
  const cfg = await getConfig(env);
  if (cfg.maintenance || !cfg.replies) return err(cfg.banner || "replies are paused for a moment — try again soon", 503);
  if (await rateLimited(req, env, "reply", 10, 3600)) return err("slow down a little 💌", 429);
  const t = await loadTape(env, id);
  if (!t) return err("tape not found", 404);
  if (t.reply) return err("this tape already has its reply 💌", 409);
  const ct = req.headers.get("content-type") || "";
  if (!ct.startsWith("multipart/form-data")) return err("expected multipart/form-data", 415);
  const form = await req.formData();
  const kind = String(form.get("kind") || "");
  const reply = { at: new Date().toISOString(), from: str(form.get("from"), 40), viewToken: newToken().slice(0, 24) };
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
    if (!reply.audio) return err("that recording came out empty — try again");
    reply.type = "audio";
    const note = str(form.get("text"), 500);
    if (note) reply.text = note;
  } else return err("unknown reply kind");

  // re-check right before writing: two replies racing for the same tape
  const fresh = await loadTape(env, id);
  if (fresh && fresh.reply) return err("this tape already has its reply 💌", 409);
  t.reply = reply;
  await env.TAPES.put(`tape:${id}`, JSON.stringify(t), { expirationTtl: ttlLeft(t, env) });
  await env.TAPES.put(`rtok:${reply.viewToken}`, id, { expirationTtl: ttlLeft(t, env) });
  await bump(env, "replies");

  const origin = env.APP_ORIGIN || new URL(req.url).origin;
  const replyUrl = `${origin}/r/${reply.viewToken}`;
  let texted = false;
  if (t.ownerUid) {
    const owner = JSON.parse((await env.TAPES.get(`user:${t.ownerUid}`)) || "null");
    if (owner) ctx.waitUntil(textReply(env, owner, t, replyUrl).catch((e) => console.error("sms failed", e)));
    texted = !!(owner && owner.notify !== false && (env.TWILIO_FROM || env.TWILIO_MESSAGING_SID));
  }
  if (env.SEND_EMAIL && t.senderEmail) ctx.waitUntil(sendReplyEmail(env, t, replyUrl).catch((e) => console.error("email failed", e)));
  return j({ ok: true, replyUrl, senderNotified: texted || !!(env.SEND_EMAIL && t.senderEmail), senderName: t.senderName || "" });
}

async function sendReplyEmail(env, t, replyUrl) {
  const { EmailMessage } = await import("cloudflare:email");
  const { createMimeMessage } = await import("mimetext");
  const host = new URL(env.APP_ORIGIN).hostname;
  const msg = createMimeMessage();
  msg.setSender({ name: "T4T Mix", addr: `no-reply@${host}` });
  msg.setRecipient(t.senderEmail);
  msg.setSubject(`💌 ${t.reply.from || t.recipientName || "someone"} wrote back about "${t.tapeTitle}"`);
  msg.addMessage({ contentType: "text/plain", data: `they wrote back to your mixtape.\n\nopen it here: ${replyUrl}\n\n— T4T Mix` });
  await env.SEND_EMAIL.send(new EmailMessage(`no-reply@${host}`, t.senderEmail, msg.asRaw()));
}

// ---------- the return envelope (/r/:token) ----------
async function tapeByReplyToken(env, token) {
  if (!/^[A-Za-z0-9]{24}$/.test(token)) return null;
  const id = await env.TAPES.get(`rtok:${token}`);
  if (!id) return null;
  const t = await loadTape(env, id);
  if (!t || !t.reply || t.reply.viewToken !== token) return null;
  return t;
}
async function getReplyByToken(req, env, token, ctx) {
  const t = await tapeByReplyToken(env, token);
  if (!t) return err("this reply isn't here anymore", 404);
  if (!t.reply.seenAt) {
    t.reply.seenAt = new Date().toISOString();
    ctx.waitUntil(env.TAPES.put(`tape:${t.id}`, JSON.stringify(t), { expirationTtl: ttlLeft(t, env) }));
  }
  const origin = env.APP_ORIGIN || new URL(req.url).origin;
  return j({ ok: true, reply: { type: t.reply.type, text: t.reply.text || "", from: t.reply.from || t.recipientName || "", at: t.reply.at,
    audio: t.reply.audio ? `/api/reply/${token}/audio` : null },
    tape: { id: t.id, title: t.tapeTitle, to: t.recipientName, from: t.senderName, skin: t.skin, ink: t.ink, paper: t.paper, shell: t.shell,
      url: `${origin}/t/${t.id}`, tracks: (t.tracks || []).length } });
}

async function streamMedia(req, env, key, isPrivate) {
  const range = req.headers.get("range");
  const obj = await env.MEDIA.get(key, range ? { range: req.headers } : undefined);
  if (!obj) return new Response("not found", { status: 404 });
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set("accept-ranges", "bytes");
  h.set("cache-control", isPrivate ? "private, no-store" : "public, max-age=86400");
  h.set("x-content-type-options", "nosniff");
  if (range && obj.range) {
    const { offset = 0, length = obj.size - offset } = obj.range;
    h.set("content-range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
    h.set("content-length", String(length));
    return new Response(obj.body, { status: 206, headers: h });
  }
  h.set("content-length", String(obj.size));
  return new Response(obj.body, { headers: h });
}
async function getMedia(req, env, id, file) {
  if (!MEDIA_FILE.test(file)) return new Response("not found", { status: 404 });
  if (file.startsWith("reply.")) {
    const t = await loadTape(env, id);
    if (!t || !(await isOwner(req, env, t))) return new Response("forbidden", { status: 403 });
  }
  return streamMedia(req, env, `${id}/${file}`, file.startsWith("reply."));
}

// ---------- feedback ----------
async function postFeedback(req, env) {
  const cfg = await getConfig(env);
  if (!cfg.feedback) return err("feedback is closed right now", 503);
  if (await rateLimited(req, env, "feedback", 6, 3600)) return err("thank you! that's plenty for now 💌", 429);
  let body; try { body = await readJson(req); } catch (e) { return err(e.message); }
  const message = str(body.message, 2000);
  if (message.length < 2) return err("say a little something first");
  if (str(body.website, 100)) return j({ ok: true }); // honeypot
  const user = await getUser(req, env);
  const rec = {
    at: new Date().toISOString(), message,
    rating: ["love", "like", "meh", "broken"].includes(body.rating) ? body.rating : "",
    contact: str(body.contact, 120), page: str(body.page, 40), uid: user ? user.id : "",
    ua: str(req.headers.get("user-agent"), 160),
  };
  await env.TAPES.put(`fb:${revTs()}:${shortId(8)}`, JSON.stringify(rec), { expirationTtl: 86400 * 365 });
  await bump(env, "feedback");
  return j({ ok: true });
}

// ---------- HTML pages that need the Worker ----------
const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
  "referrer-policy": "strict-origin-when-cross-origin", "x-content-type-options": "nosniff",
};
async function renderRecipient(req, env, id, { embed }) {
  const t = await loadTape(env, id);
  if (!t) return new Response(notFoundPage("this mixtape isn't here anymore.<br>tapes keep for about six months."), { status: 404, headers: PAGE_HEADERS });
  const shell = await env.ASSETS.fetch(new Request(new URL("/recipient.html", req.url)));
  if (!shell.ok) return new Response("recipient page missing", { status: 500 });
  let html = await shell.text();
  const title = t.senderName ? `a mixtape from ${escapeHtml(t.senderName)}` : "a T4T Mix for you";
  const desc = escapeHtml(t.recipientName ? `for ${t.recipientName} — tap to unwrap and press play.` : "tap to unwrap and press play.");
  const origin = env.APP_ORIGIN || new URL(req.url).origin;
  const og =
    `<meta property="og:title" content="${title}">\n<meta property="og:description" content="${desc}">\n` +
    `<meta property="og:type" content="website">\n<meta property="og:site_name" content="T4T Mix">\n` +
    `<meta property="og:image" content="${origin}/assets/full_recorder_${t.shell}.png">\n<meta name="robots" content="noindex">\n`;
  html = html
    .replace('"__TAPE_ID__"', JSON.stringify(id))
    .replace('"__EMBED__"', embed ? "true" : "false")
    .replace("</head>", og + "</head>")
    .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`);
  const ancestors = embed ? `'self' ${env.EMBED_ORIGINS || ""}`.trim() : "'self'";
  return new Response(html, { headers: { ...PAGE_HEADERS, "content-security-policy": `frame-ancestors ${ancestors}` } });
}
async function renderReplyPage(req, env, token) {
  const t = await tapeByReplyToken(env, token);
  if (!t) return new Response(notFoundPage("this reply isn't here anymore."), { status: 404, headers: PAGE_HEADERS });
  const shell = await env.ASSETS.fetch(new Request(new URL("/reply.html", req.url)));
  if (!shell.ok) return new Response("reply page missing", { status: 500 });
  let html = await shell.text();
  const who = escapeHtml(t.reply.from || t.recipientName || "someone");
  const origin = env.APP_ORIGIN || new URL(req.url).origin;
  const og = `<meta property="og:title" content="💌 ${who} wrote back">\n<meta property="og:description" content="about your mixtape “${escapeHtml(t.tapeTitle)}” — tap to open.">\n` +
    `<meta property="og:image" content="${origin}/assets/full_recorder_${t.shell}.png">\n<meta name="robots" content="noindex">\n`;
  html = html.replace('"__REPLY_TOKEN__"', JSON.stringify(token)).replace("</head>", og + "</head>");
  return new Response(html, { headers: { ...PAGE_HEADERS, "content-security-policy": "frame-ancestors 'self'" } });
}
function notFoundPage(msg) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>T4T Mix</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#1b0f24;color:#fbf6ea;font:16px system-ui;text-align:center">
<div><div style="font-size:48px">📼</div><p>${msg}</p>
<p><a style="color:#f5a9b8" href="/">make your own →</a></p></div></body>`;
}

// ---------- router ----------
async function route(req, env, ctx) {
  const url = new URL(req.url);
  const p = url.pathname;
  const M = req.method;
  let m;
  if (p === "/api/health") {
    return j({ ok: true, version: VERSION, features: {
      storage: !!(env.TAPES && env.MEDIA),
      spotifyApi: !!(env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET),
      youtube: !!env.YOUTUBE_API_KEY,
      soundcloudSearch: !!(env.SOUNDCLOUD_CLIENT_ID && env.SOUNDCLOUD_CLIENT_SECRET),
      phoneLogin: smsReady(env),
      replyEmail: !!env.SEND_EMAIL,
      admin: !!env.ADMIN_TOKEN,
      accessGate: true,
    } });
  }
  if (p === "/api/config" && M === "GET") return j({ ok: true, ...publicConfig(await getConfig(env), env) }, 200, { "cache-control": "public, max-age=30" });
  if (p === "/api/playlist" && M === "GET") return handlePlaylist(req, env, { bridge: false });
  if (p === "/api/bridge" && M === "GET") return handlePlaylist(req, env, { bridge: true });
  if (p === "/api/match" && M === "GET") return handleMatch(req, env);
  if (p === "/api/tape" && M === "POST") return saveTape(req, env);
  if ((m = p.match(/^\/api\/tape\/([a-z2-9]{6,16})$/)) && M === "GET") {
    const t = await loadTape(env, m[1]);
    return t ? j(publicView(t), 200, { "cache-control": "public, max-age=30" }) : err("tape not found", 404);
  }
  if ((m = p.match(/^\/api\/tape\/([a-z2-9]{6,16})\/replies$/)) && M === "GET") return getReplies(req, env, m[1]);
  if ((m = p.match(/^\/api\/tape\/([a-z2-9]{6,16})\/reply$/)) && M === "POST") return postReply(req, env, m[1], ctx);
  if ((m = p.match(/^\/api\/reply\/([A-Za-z0-9]{24})$/)) && M === "GET") return getReplyByToken(req, env, m[1], ctx);
  if ((m = p.match(/^\/api\/reply\/([A-Za-z0-9]{24})\/audio$/)) && M === "GET") {
    const t = await tapeByReplyToken(env, m[1]);
    if (!t || !t.reply.audio) return new Response("not found", { status: 404 });
    return streamMedia(req, env, `${t.id}/${t.reply.audio}`, true);
  }
  if ((m = p.match(/^\/api\/media\/([a-z2-9]{6,16})\/([a-z0-9.-]{3,24})$/)) && M === "GET") return getMedia(req, env, m[1], m[2]);
  if (p === "/api/access" && M === "POST") return redeem(req, env);
  if (p === "/api/access" && M === "GET") return accessStatus(req, env);
  if (p === "/api/feedback" && M === "POST") return postFeedback(req, env);
  if (p === "/api/auth/start" && M === "POST") return authStart(req, env);
  if (p === "/api/auth/verify" && M === "POST") return authVerify(req, env);
  if (p === "/api/auth/logout" && M === "POST") return authLogout(req, env);
  if (p === "/api/me" && M === "GET") return getMe(req, env);
  if (p === "/api/me" && M === "PATCH") return patchMe(req, env);
  if (p === "/api/me/claim" && M === "POST") return claimTapes(req, env);
  if (p.startsWith("/api/admin/")) return handleAdmin(req, env, p.slice("/api/admin/".length));
  if ((m = p.match(/^\/t\/([a-z2-9]{6,16})\/?$/))) return renderRecipient(req, env, m[1], { embed: false });
  if ((m = p.match(/^\/embed\/([a-z2-9]{6,16})\/?$/))) return renderRecipient(req, env, m[1], { embed: true });
  if ((m = p.match(/^\/r\/([A-Za-z0-9]{24})\/?$/))) return renderReplyPage(req, env, m[1]);
  if (p === "/admin" || p === "/admin/") {
    const r = await env.ASSETS.fetch(new Request(new URL("/admin.html", req.url)));
    return new Response(r.body, { status: r.status, headers: { ...PAGE_HEADERS, "x-robots-tag": "noindex", "content-security-policy": "frame-ancestors 'none'" } });
  }
  if (p.startsWith("/api/")) return err("not found", 404);
  return null;
}

export default {
  async fetch(req, env, ctx) {
    try {
      const r = await route(req, env, ctx);
      if (r) return r;
    } catch (e) {
      console.error(e);
      return err("something went sideways — try again", 500);
    }
    return env.ASSETS.fetch(req);
  },
};
