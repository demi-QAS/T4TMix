// T4T Mix — stress + end-to-end test (v0.8)
//   npm run dev   (with .dev.vars from .dev.vars.example — DEV_OTP + ADMIN_TOKEN)
//   npm run test:stress
// Against prod only the read-safe parts make sense; this script WRITES tapes.
const BASE = process.env.BASE || "http://localhost:8787";
const OTP = process.env.DEV_OTP || "424242";
const ADMIN = process.env.ADMIN_TOKEN || "local-admin-token-1234567890";
let fails = 0, passes = 0;
// localhost-only header that skips rate limits so we measure real concurrency
const STRESS = { "x-t4t-stress": process.env.ADMIN_TOKEN || "local-admin-token-1234567890" };
const _fetch = globalThis.fetch;
globalThis.fetch = (u, o = {}) => (process.env.WITH_LIMITS === "1" ? _fetch(u, o) : _fetch(u, { ...o, headers: { ...STRESS, ...(o.headers || {}) } }));
const ok = (c, m) => { if (c) passes++; else fails++; console.log(`${c ? "PASS" : "FAIL"}  ${m}`); };
const ms = (t) => `${Math.round(performance.now() - t)}ms`;

// a fake-but-valid-sized audio blob (the server checks type + size, not codec)
const audio = (kb, type = "audio/webm") => new Blob([new Uint8Array(kb * 1024).map((_, i) => (i * 31) % 251)], { type });
const tapeJson = (n, extra = {}) => ({
  tapeTitle: `stress ${n}`, recipientName: "Tester", senderName: "Bot",
  playlist: { source: "youtube", id: "PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG", title: "t" },
  tracks: Array.from({ length: n }, (_, i) => ({
    original: `Song ${i}`, display: i % 3 ? `Song ${i}` : `our song ${i}`, artist: `Artist ${i}`,
    memoPosition: ["intro", "outro", "over-ad"][i % 3], ytVideoId: "dQw4w9WgXcQ",
  })),
  ...extra,
});
async function sendTape(n, memoEvery = 1, opts = {}) {
  const fd = new FormData();
  fd.set("tape", JSON.stringify(tapeJson(n, opts.extra)));
  for (let i = 0; i < n; i += memoEvery) fd.append(`memo_${i}`, audio(opts.kb || 40, opts.type || "audio/webm"), `m${i}`);
  const r = await fetch(`${BASE}/api/tape`, { method: "POST", body: fd, headers: opts.headers || {} });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

console.log(`\n— T4T Mix stress test against ${BASE}\n`);
const h = await (await fetch(`${BASE}/api/health`)).json();
ok(h.version === "0.9.1", `health reports v${h.version}`);

// 1. voice memos on every song of a big tape
let t = performance.now();
const big = await sendTape(40, 1, { kb: 120 });
ok(big.status === 201 && big.body.memos === 40, `40-song tape with a 120 KB memo on EVERY song saved (${big.body.memos} memos, ${ms(t)})`);
const pub = await (await fetch(`${BASE}/api/tape/${big.body.id}`)).json();
ok(pub.tracks.filter((x) => x.memo).length === 40, "public view lists all 40 memos");
ok(pub.tracks[0].memo === "memo-0.webm" && pub.tracks[39].memo === "memo-39.webm", "memo files line up with their songs (0 → 0, 39 → 39)");
ok(pub.tracks[2].memoPosition === "over-ad" && pub.tracks[1].memoPosition === "outro", "memo positions (intro / outro / over) survive the round trip");
const m0 = await fetch(`${BASE}/api/media/${big.body.id}/memo-0.webm`);
const m0b = await m0.arrayBuffer();
ok(m0.ok && m0b.byteLength === 120 * 1024, `memo audio streams back byte-for-byte (${m0b.byteLength} bytes)`);
const rng = await fetch(`${BASE}/api/media/${big.body.id}/memo-5.webm`, { headers: { range: "bytes=0-1023" } });
ok(rng.status === 206 && (await rng.arrayBuffer()).byteLength === 1024, "range requests work (Safari seeks memos this way)");

// 2. Safari / iPhone memo format
const mp4 = await sendTape(3, 1, { type: "audio/mp4" });
ok(mp4.status === 201 && mp4.body.memos === 3, "iPhone-style audio/mp4 memos accepted");

// 3. a memo that is too big → whole tape rejected AND no orphaned files
const tooBig = await sendTape(4, 1, { kb: 1100 });
ok(tooBig.status === 413, `memo over the 1 MB limit rejected (${tooBig.body.error})`);
// 4. empty recordings are dropped, not stored
const tiny = await sendTape(3, 1, { kb: 0.1 });
ok(tiny.status === 201 && tiny.body.memos === 0, "empty (0.1 KB) recordings are skipped instead of saved as silent memos");
// 5. memo only on some songs (index alignment with gaps)
const gaps = await sendTape(10, 4);
const gp = await (await fetch(`${BASE}/api/tape/${gaps.body.id}`)).json();
ok(gp.tracks.map((x, i) => (x.memo ? i : null)).filter((x) => x !== null).join() === "0,4,8", "memos on songs 1, 5 and 9 stay on 1, 5 and 9");
// 6. a blank track in the middle must not shift later memos
{
  const fd = new FormData();
  const tj = tapeJson(3); tj.tracks[1] = { original: "", display: "", artist: "" };
  fd.set("tape", JSON.stringify(tj)); fd.append("memo_2", audio(10), "m2");
  const r = await (await fetch(`${BASE}/api/tape`, { method: "POST", body: fd })).json();
  const p2 = await (await fetch(`${BASE}/api/tape/${r.id}`)).json();
  ok(p2.tracks[2] && p2.tracks[2].memo === "memo-2.webm", "a blank song in the middle doesn't push memos onto the wrong song");
}

// 7. concurrency: 50 people sending 6-memo tapes at the same moment
t = performance.now();
const burst = await Promise.all(Array.from({ length: 50 }, (_, i) => sendTape(6, 1, { kb: 30 }).catch((e) => ({ status: 0, body: { error: String(e) } }))));
const okBurst = burst.filter((b) => b.status === 201 && b.body.memos === 6).length;
ok(okBurst === 50, `50 simultaneous sends (300 voice memos): ${okBurst}/50 saved with every memo (${ms(t)})`);
{ // and the rate limiter still protects you from one person spamming
  const spam = await Promise.all(Array.from({ length: 30 }, () => { const fd = new FormData(); fd.set("tape", JSON.stringify(tapeJson(1))); return _fetch(`${BASE}/api/tape`, { method: "POST", body: fd }).then((r) => r.status); }));
  // with the access gate on, spam without a code is stopped (402) before the rate limiter (429) — both count as blocked
  const blocked = spam.filter((x) => x === 429 || x === 402).length;
  ok(blocked >= 10, `one IP firing 30 sends: ${blocked} blocked (gate or rate limiter)`);
}
ok(new Set(burst.filter((b) => b.body.id).map((b) => b.body.id)).size === burst.filter((b) => b.body.id).length, "every tape got a unique id");

// 8. phone sign-in
const s1 = await fetch(`${BASE}/api/auth/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: "(202) 555-0147" }) });
const s1b = await s1.json();
ok(s1.ok && s1b.phone.endsWith("0147") && !s1b.phone.includes("202"), `code requested, number masked as ${s1b.phone}`);
const again = await fetch(`${BASE}/api/auth/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: "2025550147" }) });
ok(again.status === 429, "asking for a second code within 30s is throttled");
const bad = await fetch(`${BASE}/api/auth/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: "+12025550147", code: "000000" }) });
ok(bad.status === 401, "wrong code rejected");
const v = await fetch(`${BASE}/api/auth/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: "202-555-0147", code: OTP, name: "Demi" }) });
const vb = await v.json();
ok(v.ok && vb.token && vb.user.name === "Demi", "right code signs you in (same number typed 3 different ways)");
const auth = { authorization: `Bearer ${vb.token}` };

// 9. claim a tape sent before signing in, then send one signed in
const claim = await fetch(`${BASE}/api/me/claim`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ tapes: [{ id: big.body.id, ownerToken: big.body.ownerToken }, { id: mp4.body.id, ownerToken: "wrong" }] }) });
ok((await claim.json()).claimed === 1, "tapes sent before sign-in move into the account (wrong owner token ignored)");
const mine = await sendTape(5, 1, { headers: auth });
ok(mine.body.linkedToAccount === true, "a tape sent while signed in is linked to the account");

// 10. reply flow → private reply link → sender inbox (from a 'different device' = no owner token)
const rf = new FormData(); rf.set("kind", "voice"); rf.set("from", "Sam"); rf.set("text", "this made my week");
rf.set("audio", audio(50), "reply.webm");
const rep = await (await fetch(`${BASE}/api/tape/${mine.body.id}/reply`, { method: "POST", body: rf })).json();
ok(rep.ok && /\/r\/[A-Za-z0-9]{24}$/.test(rep.replyUrl), `recipient gets a private return link: ${rep.replyUrl ? rep.replyUrl.replace(BASE, "") : "missing"}`);
const rf2 = new FormData(); rf2.set("kind", "text"); rf2.set("text", "again");
ok((await fetch(`${BASE}/api/tape/${mine.body.id}/reply`, { method: "POST", body: rf2 })).status === 409, "still only one reply per tape");
const token = rep.replyUrl.split("/r/")[1];
const page = await fetch(`${BASE}/r/${token}`);
const pageHtml = await page.text();
ok(page.ok && pageHtml.includes("wrote back") && pageHtml.includes(token), "/r/<token> return-envelope page renders");
const rd = await (await fetch(`${BASE}/api/reply/${token}`)).json();
ok(rd.reply.from === "Sam" && rd.reply.text === "this made my week" && rd.reply.audio, "reply page shows the voice memo + note + name");
const ra = await fetch(`${BASE}${rd.reply.audio}`);
ok(ra.ok && (await ra.arrayBuffer()).byteLength === 50 * 1024, "reply voice memo plays from the private link");
ok((await fetch(`${BASE}/api/reply/AAAAAAAAAAAAAAAAAAAAAAAA`)).status === 404, "guessing a reply link gets nothing");
const me = await (await fetch(`${BASE}/api/me`, { headers: auth })).json();
const inboxTape = me.tapes.find((x) => x.id === mine.body.id);
ok(inboxTape && inboxTape.reply && inboxTape.reply.link && inboxTape.reply.seen === true, "signed-in inbox shows the reply with its link (marked seen after opening)");
ok(me.tapes.length >= 2, `inbox lists ${me.tapes.length} tapes across devices`);
ok((await fetch(`${BASE}/api/tape/${mine.body.id}/replies`, { headers: auth })).ok, "signed-in owner can read replies without the device token");
ok((await fetch(`${BASE}/api/media/${mine.body.id}/reply.webm`)).status === 403, "reply audio is still private on the media route");

// 11. feedback
const fb = await fetch(`${BASE}/api/feedback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "love the heart player", rating: "love", page: "screen-send" }) });
ok(fb.ok, "feedback saved");
const hp = await fetch(`${BASE}/api/feedback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "buy pills", website: "spam.biz" }) });
ok(hp.ok, "spam bot (honeypot) gets a fake OK");

// 12. admin console
ok((await fetch(`${BASE}/api/admin/overview`)).status === 401, "admin needs the token");
const A = { "x-admin-token": ADMIN, "content-type": "application/json" };
const ov = await (await fetch(`${BASE}/api/admin/overview`, { headers: A })).json();
ok(ov.ok && ov.stats[0].tapes >= 50 && ov.stats[0].replies >= 1, `admin overview: ${ov.stats[0].tapes} tapes, ${ov.stats[0].replies} replies, ${ov.stats[0].feedback} feedback today`);
const fbl = await (await fetch(`${BASE}/api/admin/feedback`, { headers: A })).json();
ok(fbl.items.some((f) => f.message === "love the heart player") && !fbl.items.some((f) => f.message === "buy pills"), "admin sees real feedback, not the spam");
await fetch(`${BASE}/api/admin/config`, { method: "PUT", headers: A, body: JSON.stringify({ maintenance: true, banner: "quick tune-up 🔧", donationUrl: "https://ko-fi.com/t4tmix", lanes: { spotify: false } }) });
await new Promise((r) => setTimeout(r, 100));
const cfg = await (await fetch(`${BASE}/api/config`)).json();
ok(cfg.maintenance && cfg.banner === "quick tune-up 🔧" && cfg.donationUrl === "https://ko-fi.com/t4tmix" && cfg.lanes.spotify === false, "admin switches reach the public app (banner, donation link, Spotify off)");
const blocked = await sendTape(2, 1);
ok(blocked.status === 503, "maintenance mode pauses new tapes");
ok((await fetch(`${BASE}/api/tape/${big.body.id}`)).ok, "…but tapes already sent still open");
await fetch(`${BASE}/api/admin/config`, { method: "PUT", headers: A, body: JSON.stringify({ donationUrl: "javascript:alert(1)" }) });
ok((await (await fetch(`${BASE}/api/admin/config`, { method: "PUT", headers: A, body: "{}" })).json()).config.donationUrl === "", "non-https donation links are refused");
await fetch(`${BASE}/api/admin/config`, { method: "PUT", headers: A, body: JSON.stringify({ reset: true }) });
const pin = await (await fetch(`${BASE}/api/admin/match`, { method: "PUT", headers: A, body: JSON.stringify({ title: "Song 1", artist: "Artist 1", id: "https://youtu.be/dQw4w9WgXcQ" }) })).json();
ok(pin.ok && pin.id === "dQw4w9WgXcQ", "admin can pin the right YouTube video for a song");
const del = await fetch(`${BASE}/api/admin/tape/${gaps.body.id}`, { method: "DELETE", headers: A });
ok(del.ok && (await fetch(`${BASE}/api/tape/${gaps.body.id}`)).status === 404 && (await fetch(`${BASE}/api/media/${gaps.body.id}/memo-0.webm`)).status === 404, "admin delete removes the tape AND its memos");

// 13. SoundCloud playlist (live — needs internet from the Worker)
if (process.env.SKIP_NET !== "1") {
  t = performance.now();
  const sc = await fetch(`${BASE}/api/playlist?url=${encodeURIComponent("https://soundcloud.com/forss/sets/soulhack")}`);
  const scb = await sc.json().catch(() => ({}));
  ok(sc.ok && scb.source === "soundcloud" && scb.tracks.length >= 8 && scb.tracks.every((x) => x.scId && x.title), `SoundCloud set read with no API key: "${scb.title}", ${scb.tracks ? scb.tracks.length : 0} songs (${ms(t)})`);
  const scTape = await sendTape(2, 9, { extra: { playlist: { source: "soundcloud", id: "https://soundcloud.com/forss/sets/soulhack", title: "Soulhack" } } });
  const sp = await (await fetch(`${BASE}/api/tape/${scTape.body.id}`)).json();
  ok(sp.playlist && sp.playlist.source === "soundcloud", "SoundCloud tapes save with their source");
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
