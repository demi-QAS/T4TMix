// T4T Mix — phone-number sign-in (v0.8)
// ---------------------------------------------------------------------------
// One-time codes go through Twilio Verify (no phone number to buy, no 10DLC
// paperwork for the codes themselves). Sessions are random tokens; only their
// SHA-256 is stored in KV. Phone numbers are stored hashed for lookup
// (HMAC with PHONE_PEPPER) plus once in the user record so we can text you
// when a reply arrives.
//
// KV layout
//   user:<uid>                 { id, phone, name, createdAt, sv, banned, notify }
//   phone:<phoneHash>          uid
//   sess:<tokenHash>           { uid, sv, exp }            (TTL = SESSION_DAYS)
//   otp:<phoneHash>            { tries, sentAt }           (TTL 10 min, throttling)
//   utape:<uid>:<revTs>:<id>   { id, title, to, at }       (index of a user's tapes)
//
// Local dev: set DEV_OTP=123456 in .dev.vars — honoured ONLY on localhost.
import { j, err, str, sha256, newToken, shortId, readJson, rateLimited, revTs, getConfig, smsReady } from "./lib.js";

const SESSION_DAYS = 90;

export function normalizePhone(input, defaultCountry = "1") {
  let s = String(input || "").trim();
  if (!s) return null;
  const plus = s.startsWith("+");
  s = s.replace(/[^\d]/g, "");
  if (!plus) {
    if (s.length === 10) s = defaultCountry + s;           // 2025550123 -> 12025550123
    else if (s.length === 11 && s.startsWith("1")) { /* already US */ }
    else return null;
  }
  if (s.length < 8 || s.length > 15) return null;
  return "+" + s;
}
export const maskPhone = (p) => (p ? p.slice(0, -4).replace(/\d/g, "•") + p.slice(-4) : "");

async function phoneHash(env, phone) {
  return sha256(`${env.PHONE_PEPPER || "t4tmix-dev-pepper"}|${phone}`);
}
function isLocal(req) {
  const h = new URL(req.url).hostname;
  return h === "localhost" || h === "127.0.0.1";
}

const tv = (v) => String(v || "").trim(); // pasted secrets often carry a stray space or newline
async function twilio(env, path, form) {
  const r = await fetch(`https://verify.twilio.com/v2/Services/${tv(env.TWILIO_VERIFY_SID)}/${path}`, {
    method: "POST",
    headers: {
      authorization: "Basic " + btoa(`${tv(env.TWILIO_ACCOUNT_SID)}:${tv(env.TWILIO_AUTH_TOKEN)}`),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form).toString(),
  });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data: d };
}

// POST /api/auth/start  { phone }
export async function authStart(req, env) {
  const cfg = await getConfig(env);
  if (!cfg.login) return err("sign-in is paused right now", 503);
  const devMode = env.DEV_OTP && isLocal(req);
  if (!devMode && !(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_VERIFY_SID))
    return err("phone sign-in isn't switched on yet", 503);
  if (await rateLimited(req, env, "otp-ip", 8, 3600)) return err("too many codes — try again in a bit", 429);
  let body; try { body = await readJson(req); } catch (e) { return err(e.message); }
  const phone = normalizePhone(body.phone);
  if (!phone) return err("that doesn't look like a phone number — include the country code if you're outside the US");
  const ph = await phoneHash(env, phone);
  const prev = JSON.parse((await env.TAPES.get(`otp:${ph}`)) || "null");
  if (prev && Date.now() - prev.sentAt < 30000) return err("a code is on its way — give it 30 seconds", 429);
  if (prev && prev.sends >= 5) return err("too many codes for this number — try again later", 429);

  if (!devMode) {
    const r = await twilio(env, "Verifications", { To: phone, Channel: "sms" });
    if (!r.ok) {
      console.error("twilio start", r.status, r.data && r.data.code, r.data && r.data.message);
      const c = r.data && r.data.code;
      // 21608 / 21614 / 60205: trial accounts can only text verified numbers, or the number can't get SMS
      if (c === 21608 || c === 60205 || /unverified|trial/i.test((r.data && r.data.message) || ""))
        return err("this number can't get texts from us yet — T4T Mix is still in its trial setup. try again soon 💛", 400);
      if (r.status === 401 || r.status === 404) return err("sign-in is having a hiccup on our end — try again later", 502);
      return err(r.status === 400 ? "we couldn't text that number — double-check it?" : "couldn't send a code right now", r.status === 400 ? 400 : 502);
    }
  }
  await env.TAPES.put(`otp:${ph}`, JSON.stringify({ sentAt: Date.now(), sends: (prev ? prev.sends : 0) + 1, tries: 0 }), { expirationTtl: 600 });
  return j({ ok: true, phone: maskPhone(phone), dev: !!devMode });
}

// POST /api/auth/verify  { phone, code, name? }
export async function authVerify(req, env) {
  if (await rateLimited(req, env, "otp-check", 20, 3600)) return err("too many tries — wait a bit", 429);
  let body; try { body = await readJson(req); } catch (e) { return err(e.message); }
  const phone = normalizePhone(body.phone);
  const code = str(body.code, 10).replace(/\D/g, "");
  if (!phone || code.length < 4) return err("enter the code we texted you");
  const ph = await phoneHash(env, phone);
  const otp = JSON.parse((await env.TAPES.get(`otp:${ph}`)) || "null");
  if (!otp) return err("that code expired — ask for a new one", 400);
  if (otp.tries >= 5) return err("too many wrong codes — ask for a new one", 429);

  const devMode = env.DEV_OTP && isLocal(req);
  let approved = false;
  if (devMode) approved = code === String(env.DEV_OTP);
  else {
    const r = await twilio(env, "VerificationCheck", { To: phone, Code: code });
    approved = r.ok && r.data && r.data.status === "approved";
  }
  if (!approved) {
    otp.tries++;
    await env.TAPES.put(`otp:${ph}`, JSON.stringify(otp), { expirationTtl: 600 });
    return err("that code didn't match", 401);
  }
  await env.TAPES.delete(`otp:${ph}`);

  let uid = await env.TAPES.get(`phone:${ph}`);
  let user = uid ? JSON.parse((await env.TAPES.get(`user:${uid}`)) || "null") : null;
  let isNew = false;
  if (!user) {
    uid = "u" + shortId(11);
    user = { id: uid, phone, name: str(body.name, 40), createdAt: new Date().toISOString(), sv: 1, banned: false, notify: true };
    await env.TAPES.put(`user:${uid}`, JSON.stringify(user));
    await env.TAPES.put(`phone:${ph}`, uid);
    await env.TAPES.put(`idx:user:${revTs()}:${uid}`, "");
    isNew = true;
    await bump(env, "signups");
  }
  if (user.banned) return err("this account is paused — reach out if that's a mistake", 403);
  const token = newToken() + newToken();
  await env.TAPES.put(`sess:${await sha256(token)}`, JSON.stringify({ uid, sv: user.sv, exp: Date.now() + SESSION_DAYS * 864e5 }),
    { expirationTtl: SESSION_DAYS * 86400 });
  await bump(env, "logins");
  return j({ ok: true, token, isNew, user: publicUser(user) });
}

export function publicUser(u) {
  return { id: u.id, name: u.name || "", phone: maskPhone(u.phone), notify: u.notify !== false, createdAt: u.createdAt, access: !!u.access };
}

// Resolve the session from "authorization: Bearer <token>" (or null).
export async function getUser(req, env) {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+([A-Za-z0-9]{40,80})$/);
  if (!m) return null;
  const sess = JSON.parse((await env.TAPES.get(`sess:${await sha256(m[1])}`)) || "null");
  if (!sess || sess.exp < Date.now()) return null;
  const user = JSON.parse((await env.TAPES.get(`user:${sess.uid}`)) || "null");
  if (!user || user.banned || user.sv !== sess.sv) return null;
  return user;
}

export async function authLogout(req, env) {
  const h = req.headers.get("authorization") || "";
  const m = h.match(/^Bearer\s+([A-Za-z0-9]{40,80})$/);
  if (m) await env.TAPES.delete(`sess:${await sha256(m[1])}`);
  return j({ ok: true });
}

// GET /api/me  → user + their tapes (newest first) with reply status
export async function getMe(req, env) {
  const user = await getUser(req, env);
  if (!user) return err("not signed in", 401);
  const list = await env.TAPES.list({ prefix: `utape:${user.id}:`, limit: 100 });
  const tapes = [];
  await Promise.all(list.keys.map(async (k, i) => {
    const id = k.name.split(":").pop();
    const raw = await env.TAPES.get(`tape:${id}`);
    if (!raw) { tapes[i] = { id, gone: true }; return; }
    const t = JSON.parse(raw);
    tapes[i] = {
      id, title: t.tapeTitle, to: t.recipientName, at: t.createdAt,
      url: `${env.APP_ORIGIN || new URL(req.url).origin}/t/${id}`,
      reply: t.reply ? { type: t.reply.type, text: t.reply.type === "text" ? t.reply.text : "", from: t.reply.from, at: t.reply.at,
        seen: !!t.reply.seenAt, link: t.reply.viewToken ? `${env.APP_ORIGIN || new URL(req.url).origin}/r/${t.reply.viewToken}` : null } : null,
    };
  }));
  const clean = tapes.filter(Boolean);
  return j({ ok: true, user: publicUser(user), tapes: clean, unread: clean.filter((t) => t.reply && !t.reply.seen).length });
}

// PATCH /api/me  { name?, notify? }
export async function patchMe(req, env) {
  const user = await getUser(req, env);
  if (!user) return err("not signed in", 401);
  let body; try { body = await readJson(req); } catch (e) { return err(e.message); }
  if (typeof body.name === "string") user.name = str(body.name, 40);
  if (typeof body.notify === "boolean") user.notify = body.notify;
  await env.TAPES.put(`user:${user.id}`, JSON.stringify(user));
  return j({ ok: true, user: publicUser(user) });
}

// POST /api/me/claim  { tapes: [{ id, ownerToken }] } — attach tapes sent before signing in
export async function claimTapes(req, env) {
  const user = await getUser(req, env);
  if (!user) return err("not signed in", 401);
  let body; try { body = await readJson(req, 32768); } catch (e) { return err(e.message); }
  const items = (Array.isArray(body.tapes) ? body.tapes : []).slice(0, 50);
  let claimed = 0;
  for (const it of items) {
    if (!/^[a-z2-9]{6,16}$/.test(it.id || "") || typeof it.ownerToken !== "string") continue;
    const raw = await env.TAPES.get(`tape:${it.id}`);
    if (!raw) continue;
    const t = JSON.parse(raw);
    if (t.ownerHash !== (await sha256(it.ownerToken))) continue;
    if (t.ownerUid && t.ownerUid !== user.id) continue;
    if (!t.ownerUid) {
      t.ownerUid = user.id;
      await env.TAPES.put(`tape:${t.id}`, JSON.stringify(t), { expirationTtl: ttlLeft(t, env) });
      await env.TAPES.put(`utape:${user.id}:${revTs(Date.parse(t.createdAt))}:${t.id}`, "", { expirationTtl: ttlLeft(t, env) });
    }
    claimed++;
  }
  return j({ ok: true, claimed });
}

export function ttlLeft(t, env) {
  const days = Number(env.TAPE_TTL_DAYS || 180);
  const left = Math.floor((Date.parse(t.createdAt) + days * 864e5 - Date.now()) / 1000);
  return Math.max(120, left);
}

// Daily counters for the admin console. One tiny KV key per event (no read-modify-write),
// so 50 people sending at the same second can't overwrite each other's count.
export async function bump(env, what) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    await env.TAPES.put(`ev:${day}:${what}:${shortId(8)}`, "", { expirationTtl: 86400 * 120 });
  } catch { /* stats are best-effort */ }
}

// Text the sender when a reply lands (needs a Twilio sending number or Messaging Service).
export async function textReply(env, user, tape, link) {
  if (!user || !user.phone || user.notify === false) return false;
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !(env.TWILIO_FROM || env.TWILIO_MESSAGING_SID)) return false;
  const who = tape.reply && tape.reply.from ? tape.reply.from : (tape.recipientName || "someone");
  const body = `T4T Mix: ${who} wrote back about "${tape.tapeTitle}" 💌 open it: ${link}  (reply STOP to opt out)`;
  const form = { To: user.phone, Body: body };
  if (env.TWILIO_MESSAGING_SID) form.MessagingServiceSid = env.TWILIO_MESSAGING_SID; else form.From = env.TWILIO_FROM;
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: { authorization: "Basic " + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  if (!r.ok) console.error("twilio sms", r.status, await r.text().catch(() => ""));
  return r.ok;
}

export { smsReady };
