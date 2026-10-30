// T4T Mix — admin console API (v0.8)
// Every route needs header  x-admin-token: <ADMIN_TOKEN secret>.
// Set it once:  npx wrangler secret put ADMIN_TOKEN   (use a long random string)
import { j, err, str, sha256, safeEqual, readJson, rateLimited, getConfig, saveConfig, DEFAULT_CONFIG, tsFromRev, smsReady } from "./lib.js";
import { matchKey } from "./playlists.js";
import { maskPhone } from "./auth.js";

async function isAdmin(req, env) {
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 16) return false;
  const got = req.headers.get("x-admin-token") || "";
  return safeEqual(await sha256(got), await sha256(env.ADMIN_TOKEN));
}

async function listPrefix(env, prefix, cursor, limit = 50) {
  const r = await env.TAPES.list({ prefix, cursor: cursor || undefined, limit });
  return { keys: r.keys, cursor: r.list_complete ? null : r.cursor };
}

async function stats(env, days = 14) {
  const out = [];
  const keys = ["tapes", "replies", "feedback", "signups", "logins", "plays"];
  for (let d = 0; d < days; d++) {
    const day = new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
    const row = { day };
    await Promise.all(keys.map(async (k) => {
      const l = await env.TAPES.list({ prefix: `ev:${day}:${k}:`, limit: 1000 });
      row[k] = l.keys.length; // shows 1000 max per day — a good problem to have
    }));
    out.push(row);
  }
  return out;
}

async function deleteTape(env, id) {
  const raw = await env.TAPES.get(`tape:${id}`);
  if (!raw) return false;
  const t = JSON.parse(raw);
  // media
  let cursor;
  do {
    const l = await env.MEDIA.list({ prefix: `${id}/`, cursor });
    if (l.objects.length) await env.MEDIA.delete(l.objects.map((o) => o.key));
    cursor = l.truncated ? l.cursor : undefined;
  } while (cursor);
  if (t.reply && t.reply.viewToken) await env.TAPES.delete(`rtok:${t.reply.viewToken}`);
  await env.TAPES.delete(`tape:${id}`);
  return true;
}

export async function handleAdmin(req, env, path) {
  if (!env.ADMIN_TOKEN) return err("admin is off — set the ADMIN_TOKEN secret first", 503);
  if (!(await isAdmin(req, env))) {
    await rateLimited(req, env, "admin-fail", 10, 600);
    return err("wrong admin token", 401);
  }
  const M = req.method;
  const url = new URL(req.url);
  let m;

  if (path === "overview" && M === "GET") {
    const cfg = await getConfig(env, true);
    return j({ ok: true, config: cfg, defaults: DEFAULT_CONFIG, stats: await stats(env), features: {
      storage: !!(env.TAPES && env.MEDIA), youtube: !!env.YOUTUBE_API_KEY,
      spotifyApi: !!(env.SPOTIFY_CLIENT_ID && env.SPOTIFY_CLIENT_SECRET),
      soundcloudSearch: !!(env.SOUNDCLOUD_CLIENT_ID && env.SOUNDCLOUD_CLIENT_SECRET),
      smsLogin: smsReady(env), smsReplies: !!(env.TWILIO_FROM || env.TWILIO_MESSAGING_SID),
      replyEmail: !!env.SEND_EMAIL, rateLimitBindings: !!(env.RL_STRICT && env.RL_LOOSE),
    } });
  }
  if (path === "config" && (M === "PUT" || M === "POST")) {
    let body; try { body = await readJson(req); } catch (e) { return err(e.message); }
    if (body.reset === true) { await env.TAPES.put("cfg", "{}"); return j({ ok: true, config: await getConfig(env, true) }); }
    return j({ ok: true, config: await saveConfig(env, body) });
  }

  // ---- tapes ----
  if (path === "tapes" && M === "GET") {
    const q = str(url.searchParams.get("q"), 40).toLowerCase();
    if (q && /^[a-z2-9]{6,16}$/.test(q)) {
      const raw = await env.TAPES.get(`tape:${q}`);
      return j({ ok: true, items: raw ? [summ(JSON.parse(raw))] : [], cursor: null });
    }
    const { keys, cursor } = await listPrefix(env, "idx:tape:", url.searchParams.get("cursor"));
    const items = keys.map((k) => {
      const [, , rev, id] = k.name.split(":");
      return { id, at: new Date(tsFromRev(rev)).toISOString(), ...(k.metadata || {}) };
    });
    return j({ ok: true, items, cursor });
  }
  if ((m = path.match(/^tape\/([a-z2-9]{6,16})$/))) {
    if (M === "GET") {
      const raw = await env.TAPES.get(`tape:${m[1]}`);
      if (!raw) return err("tape not found", 404);
      const t = JSON.parse(raw);
      const { ownerHash, ...rest } = t;
      return j({ ok: true, tape: { ...rest, senderEmail: t.senderEmail ? "(set)" : "" } });
    }
    if (M === "DELETE") return (await deleteTape(env, m[1])) ? j({ ok: true }) : err("tape not found", 404);
  }
  if ((m = path.match(/^tape\/([a-z2-9]{6,16})\/clear-reply$/)) && M === "POST") {
    const raw = await env.TAPES.get(`tape:${m[1]}`);
    if (!raw) return err("tape not found", 404);
    const t = JSON.parse(raw);
    if (t.reply && t.reply.audio) await env.MEDIA.delete(`${t.id}/${t.reply.audio}`);
    if (t.reply && t.reply.viewToken) await env.TAPES.delete(`rtok:${t.reply.viewToken}`);
    t.reply = null;
    await env.TAPES.put(`tape:${t.id}`, JSON.stringify(t), { expirationTtl: Math.max(120, Math.floor((Date.parse(t.createdAt) + Number(env.TAPE_TTL_DAYS || 180) * 864e5 - Date.now()) / 1000)) });
    return j({ ok: true });
  }

  // ---- feedback ----
  if (path === "feedback" && M === "GET") {
    const { keys, cursor } = await listPrefix(env, "fb:", url.searchParams.get("cursor"));
    const items = await Promise.all(keys.map(async (k) => ({ key: k.name, ...(JSON.parse((await env.TAPES.get(k.name)) || "{}")) })));
    return j({ ok: true, items, cursor });
  }
  if (path === "feedback" && M === "DELETE") {
    const key = url.searchParams.get("key") || "";
    if (!/^fb:\d{13}:[a-z2-9]{6,12}$/.test(key)) return err("bad key");
    await env.TAPES.delete(key);
    return j({ ok: true });
  }

  // ---- users ----
  if (path === "users" && M === "GET") {
    const { keys, cursor } = await listPrefix(env, "idx:user:", url.searchParams.get("cursor"));
    const items = await Promise.all(keys.map(async (k) => {
      const uid = k.name.split(":").pop();
      const u = JSON.parse((await env.TAPES.get(`user:${uid}`)) || "null");
      return u ? { id: u.id, name: u.name, phone: maskPhone(u.phone), createdAt: u.createdAt, banned: !!u.banned } : { id: uid, gone: true };
    }));
    return j({ ok: true, items, cursor });
  }
  if ((m = path.match(/^user\/(u[a-z2-9]{11})\/(ban|unban|logout)$/)) && M === "POST") {
    const u = JSON.parse((await env.TAPES.get(`user:${m[1]}`)) || "null");
    if (!u) return err("user not found", 404);
    if (m[2] === "ban") u.banned = true;
    if (m[2] === "unban") u.banned = false;
    u.sv = (u.sv || 1) + 1; // every action signs them out everywhere
    await env.TAPES.put(`user:${u.id}`, JSON.stringify(u));
    return j({ ok: true });
  }

  // ---- song matches: fix a wrong YouTube / SoundCloud match for EVERY tape ----
  if (path === "match" && (M === "PUT" || M === "POST" || M === "DELETE")) {
    let body; try { body = await readJson(req); } catch (e) { return err(e.message); }
    const provider = body.provider === "soundcloud" ? "soundcloud" : "youtube";
    const title = str(body.title, 160), artist = str(body.artist, 160);
    if (!title) return err("title is required");
    const key = matchKey(provider, title, artist);
    if (M === "DELETE") { await env.TAPES.delete(`pin:${key}`); await env.TAPES.delete(key); return j({ ok: true, cleared: key }); }
    let id = str(body.id, 200);
    if (provider === "youtube") {
      const mm = id.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/);
      if (mm) id = mm[1];
      if (!/^[a-zA-Z0-9_-]{11}$/.test(id)) return err("paste a YouTube link or 11-character video id");
    } else if (!/^\d{3,15}$/.test(id)) return err("paste the numeric SoundCloud track id");
    await env.TAPES.put(`pin:${key}`, id);
    return j({ ok: true, pinned: key, id });
  }

  return err("unknown admin route", 404);
}

function summ(t) {
  return { id: t.id, at: t.createdAt, t: t.tapeTitle, to: t.recipientName, from: t.senderName, n: (t.tracks || []).length, r: !!t.reply, u: t.ownerUid || "" };
}
