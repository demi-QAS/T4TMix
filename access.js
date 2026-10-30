// T4T Mix — access-code gate for the free beta (v0.9)
// ---------------------------------------------------------------------------
// Two kinds of code, both made in /admin:
//   • shared  — ONE code for everyone who finishes the mutual aid survey. Put it on the
//               survey's thank-you page. Unlimited uses unless you set a cap.
//   • single  — one per donor (or a small batch). Usually 1 use each. Send it after a Venmo.
// Typing a good code returns an "access pass" (a long random token). The browser keeps the
// pass; KV keeps only its hash. Signed-in people get access saved on their account too.
// Turning a code off only stops NEW unlocks — people already in stay in.
// Gift links (/t/…) and reply links (/r/…) never need a code.
import { j, err, str, sha256, newToken, randomString, readJson, rateLimited, revTs, getConfig } from "./lib.js";
import { getUser, bump } from "./auth.js";

const PASS_DAYS = 365;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
export const normCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 32);
const isLocal = (req) => ["localhost", "127.0.0.1"].includes(new URL(req.url).hostname);

// Does this request have access? (true when the gate is off)
export async function hasAccess(req, env, cfg) {
  cfg = cfg || (await getConfig(env));
  if (!cfg.gate) return true;
  if (isLocal(req) && env.ADMIN_TOKEN && req.headers.get("x-t4t-stress") === env.ADMIN_TOKEN) return true;
  const pass = req.headers.get("x-t4t-pass") || "";
  if (/^[A-Za-z0-9]{32,80}$/.test(pass)) {
    const rec = await env.TAPES.get(`pass:${await sha256(pass)}`);
    if (rec) return true;
  }
  const user = await getUser(req, env);
  return !!(user && user.access);
}
export const gateError = () => err("you'll need an access code first — fill out the survey or chip in on Venmo", 402, { gate: true });

async function grantUser(env, user, codeKey) {
  if (!user || user.access) return;
  user.access = { code: codeKey, at: new Date().toISOString() };
  await env.TAPES.put(`user:${user.id}`, JSON.stringify(user));
}

// POST /api/access  { code }  → { pass }
export async function redeem(req, env) {
  if (await rateLimited(req, env, "access", 10, 600)) return err("too many tries — take a breath and try again in a few minutes", 429);
  let body; try { body = await readJson(req); } catch (e) { return err(e.message); }
  const key = normCode(body.code);
  if (key.length < 4) return err("type the code you got");
  const raw = await env.TAPES.get(`code:${key}`);
  const code = raw ? JSON.parse(raw) : null;
  if (!code || code.off) return err("hmm, that code didn't work — check the spelling?", 404);
  if (code.max && code.uses >= code.max) return err("that code has already been used — reach out and we'll sort you out", 410);
  code.uses = (code.uses || 0) + 1;
  code.lastAt = new Date().toISOString();
  await env.TAPES.put(`code:${key}`, JSON.stringify(code)); // KV isn't atomic: a 1-use code hit twice in the same second can slip — fine for a beta
  const pass = newToken() + newToken();
  await env.TAPES.put(`pass:${await sha256(pass)}`, JSON.stringify({ code: key, at: code.lastAt }), { expirationTtl: PASS_DAYS * 86400 });
  await grantUser(env, await getUser(req, env), key);
  await bump(env, "unlocks");
  return j({ ok: true, pass, kind: code.kind });
}

// GET /api/access  → { access } (cheap check the app runs on load)
export async function accessStatus(req, env) {
  const cfg = await getConfig(env);
  const ok = await hasAccess(req, env, cfg);
  // signed in with a valid pass but no account flag yet → save it on the account
  if (ok && cfg.gate) {
    const user = await getUser(req, env);
    if (user && !user.access && req.headers.get("x-t4t-pass")) await grantUser(env, user, "pass");
  }
  return j({ ok: true, gate: cfg.gate, access: ok });
}

// ---------- admin ----------
export async function adminCodes(req, env, path) {
  const M = req.method;
  if (path === "codes" && M === "GET") {
    const items = [];
    let cursor;
    do {
      const l = await env.TAPES.list({ prefix: "code:", cursor, limit: 1000 });
      const vals = await Promise.all(l.keys.map((k) => env.TAPES.get(k.name)));
      vals.forEach((v) => { if (v) items.push(JSON.parse(v)); });
      cursor = l.list_complete ? null : l.cursor;
    } while (cursor && items.length < 3000);
    items.sort((a, b) => (a.kind === b.kind ? (b.createdAt || "").localeCompare(a.createdAt || "") : a.kind === "shared" ? -1 : 1));
    return j({ ok: true, items });
  }
  if (path === "codes" && M === "POST") {
    let body; try { body = await readJson(req); } catch (e) { return err(e.message); }
    const kind = body.kind === "shared" ? "shared" : "single";
    const label = str(body.label, 80);
    const max = Math.max(0, Math.min(10000, Number(body.max ?? (kind === "shared" ? 0 : 1)) || 0));
    const count = kind === "shared" ? 1 : Math.max(1, Math.min(50, Number(body.count) || 1));
    const made = [];
    for (let i = 0; i < count; i++) {
      let display = kind === "shared" && body.code ? String(body.code).toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 24) : `MIX-${randomString(6, CODE_ALPHABET)}`;
      const key = normCode(display);
      if (key.length < 4) return err("make the code at least 4 letters or numbers");
      if (await env.TAPES.get(`code:${key}`)) { if (kind === "shared") return err("that code already exists"); i--; continue; }
      const rec = { code: display, key, kind, label, max, uses: 0, off: false, createdAt: new Date().toISOString() };
      await env.TAPES.put(`code:${key}`, JSON.stringify(rec));
      made.push(rec);
    }
    return j({ ok: true, made });
  }
  let m;
  if ((m = path.match(/^codes\/([A-Z0-9]{4,32})$/))) {
    const raw = await env.TAPES.get(`code:${m[1]}`);
    if (!raw) return err("no such code", 404);
    const rec = JSON.parse(raw);
    if (M === "PATCH") {
      let body; try { body = await readJson(req); } catch (e) { return err(e.message); }
      if (typeof body.off === "boolean") rec.off = body.off;
      if (typeof body.label === "string") rec.label = str(body.label, 80);
      if (body.max !== undefined) rec.max = Math.max(0, Math.min(10000, Number(body.max) || 0));
      await env.TAPES.put(`code:${m[1]}`, JSON.stringify(rec));
      return j({ ok: true, item: rec });
    }
    if (M === "DELETE") { await env.TAPES.delete(`code:${m[1]}`); return j({ ok: true }); }
  }
  return null;
}
