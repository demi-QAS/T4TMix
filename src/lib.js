// T4T Mix — shared helpers (v0.8)
export const ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // no 0/O/1/l/o confusion
export const TOKEN_ALPHABET = ID_ALPHABET + "ABCDEFGHJKLMNPQRSTUVWXYZ";
export const SKINS = ["trans", "lesbian", "bi", "nb", "pride"];
export const SHELLS = ["boombox", "carabiner", "heart"];
export const SCENES = ["desk", "nightstand", "car"];
export const MEMO_POSITIONS = ["intro", "outro", "over-ad"];
export const INKS = ["midnight", "berry", "ocean", "forest", "plum"];
export const PAPERS = ["cream", "kraft", "grid", "blush"];
export const LANES = ["youtube", "soundcloud", "spotify", "preview"];

export function randomString(len, alphabet) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
}
export const shortId = (len = 10) => randomString(len, ID_ALPHABET);
export const newToken = () => randomString(32, TOKEN_ALPHABET);

export async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
export const j = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { ...JSON_HEADERS, ...extra } });
export const err = (msg, status = 400, extra = {}) => j({ ok: false, error: msg, ...extra }, status);

export const str = (v, max) => String(v ?? "").trim().slice(0, max);
export const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
export const num = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
export const ttlSeconds = (env) => 60 * 60 * 24 * Number(env.TAPE_TTL_DAYS || 180);
// Sortable "newest first" key part: 13-digit reverse timestamp.
export const revTs = (ms = Date.now()) => String(9999999999999 - ms).padStart(13, "0");
export const tsFromRev = (r) => 9999999999999 - Number(r);

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export async function readJson(req, max = 16384) {
  const ct = req.headers.get("content-type") || "";
  if (!ct.includes("application/json")) throw new Error("expected application/json");
  const raw = await req.text();
  if (raw.length > max) throw new Error("request too large");
  return JSON.parse(raw || "{}");
}

// ---------- rate limiting ----------
// Preferred: Workers Rate Limiting bindings (RL_STRICT / RL_LOOSE in wrangler.jsonc).
// Fallback: the edge cache — NOTE: Cloudflare only guarantees the Cache API on custom
// domains, so on *.workers.dev this fallback may let everything through.
export async function rateLimited(req, env, bucket, limit, windowSec, keyExtra = "") {
  // stress tests on YOUR machine only: header must equal ADMIN_TOKEN and host must be localhost
  const host = new URL(req.url).hostname;
  if ((host === "localhost" || host === "127.0.0.1") && env.ADMIN_TOKEN && req.headers.get("x-t4t-stress") === env.ADMIN_TOKEN) return false;
  const ip = req.headers.get("cf-connecting-ip") || "local";
  const key = `${bucket}:${ip}${keyExtra ? ":" + keyExtra : ""}`;
  const binding = limit <= 20 ? env.RL_STRICT : env.RL_LOOSE;
  if (binding && typeof binding.limit === "function") {
    try { const { success } = await binding.limit({ key }); if (!success) return true; } catch { /* fall through */ }
  }
  try {
    const slot = Math.floor(Date.now() / 1000 / windowSec);
    const ck = new Request(`https://rl.t4tmix.internal/${encodeURIComponent(key)}/${slot}`);
    const cache = caches.default;
    const hit = await cache.match(ck);
    const count = hit ? Number(await hit.text()) : 0;
    if (count >= limit) return true;
    await cache.put(ck, new Response(String(count + 1), { headers: { "cache-control": `max-age=${windowSec}` } }));
  } catch { /* no cache available */ }
  return false;
}

// ---------- runtime config (editable from /admin, stored in KV "cfg") ----------
export const DEFAULT_CONFIG = {
  maintenance: false,          // true = banner + no new tapes / replies
  banner: "",                  // short message shown on every page ("" = none)
  newTapes: true,              // allow sending new tapes
  replies: true,               // allow write-backs
  login: true,                 // show phone sign-in (only works if SMS is configured)
  feedback: true,              // show the feedback form
  donationUrl: "",             // e.g. a Ko-fi / Cash App / Stripe link ("" hides the button)
  donationLabel: "chip in for the tapes",
  sampleFallback: true,        // use sample songs when a playlist can't be read
  lanes: { youtube: true, soundcloud: true, spotify: true, preview: true },
  defaultLane: "youtube",
  maxMemoSeconds: 20,
  // ---- access-code gate (free beta) ----
  gate: true,                  // true = senders need an access code; gift + reply links always open
  surveyUrl: "https://bit.ly/nonprofit-tax-survey",
  p990Url: "https://thepeoples990.com",
  venmo: "Queerasolutions",    // Venmo handle, no @
  gateSurveyNote: "finish it and your code is on the thank-you page.",
  gateDonateNote: "any amount. put your phone or email in the note and we'll send your code.",
};
let cfgCache = null, cfgAt = 0;
export async function getConfig(env, fresh = false) {
  if (!fresh && cfgCache && Date.now() - cfgAt < 30000) return cfgCache;
  let saved = {};
  try { saved = JSON.parse((await env.TAPES.get("cfg")) || "{}"); } catch { saved = {}; }
  cfgCache = mergeConfig(DEFAULT_CONFIG, saved);
  cfgAt = Date.now();
  return cfgCache;
}
export function mergeConfig(base, patch) {
  const out = { ...base, lanes: { ...base.lanes } };
  if (!patch || typeof patch !== "object") return out;
  for (const k of ["maintenance", "newTapes", "replies", "login", "feedback", "sampleFallback", "gate"])
    if (typeof patch[k] === "boolean") out[k] = patch[k];
  if (typeof patch.banner === "string") out.banner = str(patch.banner, 280);
  if (typeof patch.donationLabel === "string") out.donationLabel = str(patch.donationLabel, 60) || base.donationLabel;
  if (typeof patch.donationUrl === "string") {
    const u = str(patch.donationUrl, 300);
    out.donationUrl = /^https:\/\/[^\s"'<>]+$/.test(u) ? u : "";
  }
  if (typeof patch.p990Url === "string") {
    const u = str(patch.p990Url, 300);
    out.p990Url = /^https:\/\/[^\s"'<>]+$/.test(u) ? u : "";
  }
  if (typeof patch.surveyUrl === "string") {
    const u = str(patch.surveyUrl, 300);
    out.surveyUrl = /^https:\/\/[^\s"'<>]+$/.test(u) ? u : "";
  }
  if (typeof patch.venmo === "string") out.venmo = str(patch.venmo, 40).replace(/^@/, "").replace(/[^A-Za-z0-9_-]/g, "");
  if (typeof patch.gateSurveyNote === "string") out.gateSurveyNote = str(patch.gateSurveyNote, 160);
  if (typeof patch.gateDonateNote === "string") out.gateDonateNote = str(patch.gateDonateNote, 160);
  if (patch.lanes && typeof patch.lanes === "object")
    for (const l of LANES) if (typeof patch.lanes[l] === "boolean") out.lanes[l] = patch.lanes[l];
  if (LANES.includes(patch.defaultLane)) out.defaultLane = patch.defaultLane;
  if (patch.maxMemoSeconds !== undefined) out.maxMemoSeconds = num(patch.maxMemoSeconds, 5, 60, base.maxMemoSeconds);
  if (!Object.values(out.lanes).some(Boolean)) out.lanes.youtube = true; // never switch every lane off
  if (!out.lanes[out.defaultLane]) out.defaultLane = LANES.find((l) => out.lanes[l]);
  return out;
}
export async function saveConfig(env, patch) {
  const current = await getConfig(env, true);
  const next = mergeConfig(current, patch);
  await env.TAPES.put("cfg", JSON.stringify(next));
  cfgCache = next; cfgAt = Date.now();
  return next;
}
export const smsReady = (env) => !!(String(env.TWILIO_ACCOUNT_SID || "").trim() && String(env.TWILIO_AUTH_TOKEN || "").trim() && String(env.TWILIO_VERIFY_SID || "").trim()) || !!env.DEV_OTP;
export function publicConfig(cfg, env) {
  return {
    maintenance: cfg.maintenance, banner: cfg.banner,
    newTapes: cfg.newTapes && !cfg.maintenance, replies: cfg.replies && !cfg.maintenance,
    login: cfg.login && smsReady(env), feedback: cfg.feedback,
    donationUrl: cfg.donationUrl, donationLabel: cfg.donationLabel,
    sampleFallback: cfg.sampleFallback, lanes: cfg.lanes, defaultLane: cfg.defaultLane,
    maxMemoSeconds: cfg.maxMemoSeconds,
    soundcloudSearch: !!(env.SOUNDCLOUD_CLIENT_ID && env.SOUNDCLOUD_CLIENT_SECRET),
    gate: cfg.gate, surveyUrl: cfg.surveyUrl, venmo: cfg.venmo, p990Url: cfg.p990Url,
    smsReplies: !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && (env.TWILIO_FROM || env.TWILIO_MESSAGING_SID)),
    gateSurveyNote: cfg.gateSurveyNote, gateDonateNote: cfg.gateDonateNote,
  };
}
