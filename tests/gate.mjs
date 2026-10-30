// access-code gate tests — run against `wrangler dev` with ADMIN_TOKEN set
const BASE = process.env.BASE || "http://localhost:8787";
const ADMIN = { "x-admin-token": process.env.ADMIN_TOKEN || "local-admin-token-1234567890", "content-type": "application/json" };
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✓", m); } else { fail++; console.log("  ✗", m); } };
const tape = () => { const fd = new FormData(); fd.set("tape", JSON.stringify({ senderName: "Demi", recipientName: "Sam", tracks: [{ title: "City Ports", artist: "Forss" }] })); return fd; };
const json = (r) => r.json().catch(() => ({}));

await fetch(`${BASE}/api/admin/config`, { method: "PUT", headers: ADMIN, body: JSON.stringify({ gate: true }) });
const cfg = await json(await fetch(`${BASE}/api/config`));
ok(cfg.gate === true && cfg.surveyUrl && cfg.venmo === "Queerasolutions", "config exposes gate, survey link and Venmo");

let r = await fetch(`${BASE}/api/tape`, { method: "POST", body: tape() });
let d = await json(r);
ok(r.status === 402 && d.gate === true, "sending without a code is blocked (402)");

const st = await json(await fetch(`${BASE}/api/access`));
ok(st.access === false, "access check says no for a stranger");

r = await fetch(`${BASE}/api/access`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "NOPE-1234" }) });
ok(r.status === 404, "a wrong code is refused");

const sharedName = "MUTUALAID" + Math.floor(Math.random() * 1e6);
d = await json(await fetch(`${BASE}/api/admin/codes`, { method: "POST", headers: ADMIN, body: JSON.stringify({ kind: "shared", code: sharedName }) }));
ok(d.ok && d.made[0].kind === "shared" && d.made[0].max === 0, "admin makes a shared survey code (unlimited)");
d = await json(await fetch(`${BASE}/api/admin/codes`, { method: "POST", headers: ADMIN, body: JSON.stringify({ kind: "single", count: 3, label: "venmo test" }) }));
ok(d.ok && d.made.length === 3 && d.made.every((c) => /^MIX-[A-Z2-9]{6}$/.test(c.code) && c.max === 1), "admin makes 3 one-time donor codes");
const singles = d.made.map((c) => c.code);

// shared code: lowercase + spaces still work, many people can use it
const passes = [];
for (let i = 0; i < 3; i++) {
  r = await fetch(`${BASE}/api/access`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "10.0.0." + i }, body: JSON.stringify({ code: " " + sharedName.toLowerCase() + " " }) });
  d = await json(r); if (d.pass) passes.push(d.pass);
}
ok(passes.length === 3, "the survey code works for several people (and ignores case/spaces)");

r = await fetch(`${BASE}/api/tape`, { method: "POST", body: tape(), headers: { "x-t4t-pass": passes[0] } });
d = await json(r);
ok(r.status === 201 && d.id, "with a pass, the tape sends");
const tid = d.id;

ok((await json(await fetch(`${BASE}/api/access`, { headers: { "x-t4t-pass": passes[1] } }))).access === true, "access check says yes with a pass");
ok((await fetch(`${BASE}/api/tape`, { method: "POST", body: tape(), headers: { "x-t4t-pass": "x".repeat(64) } })).status === 402, "a made-up pass is refused");

// recipients never need a code
ok((await fetch(`${BASE}/api/tape/${tid}`)).status === 200, "gift link data opens without a code");
ok((await fetch(`${BASE}/t/${tid}`)).status === 200, "gift page opens without a code");
const fdr = new FormData(); fdr.set("kind", "text"); fdr.set("text", "loved it"); fdr.set("from", "Sam");
r = await fetch(`${BASE}/api/tape/${tid}/reply`, { method: "POST", body: fdr }); d = await json(r);
ok(r.ok && d.replyUrl, "recipient can write back without a code");

// one-time code works once
r = await fetch(`${BASE}/api/access`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: singles[0] }) });
ok(r.ok, "a donor code works the first time");
r = await fetch(`${BASE}/api/access`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: singles[0] }) });
ok(r.status === 410, "the same donor code is refused the second time");

// turning a code off
const key = singles[1].replace(/[^A-Z0-9]/g, "");
await fetch(`${BASE}/api/admin/codes/${key}`, { method: "PATCH", headers: ADMIN, body: JSON.stringify({ off: true }) });
r = await fetch(`${BASE}/api/access`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: singles[1] }) });
ok(r.status === 404, "a turned-off code stops working");
ok((await fetch(`${BASE}/api/tape`, { method: "POST", body: tape(), headers: { "x-t4t-pass": passes[2] } })).status === 201, "people already in stay in after a code changes");

const list = await json(await fetch(`${BASE}/api/admin/codes`, { headers: ADMIN }));
const sh = list.items.find((c) => c.key === sharedName);
ok(sh && sh.uses === 3, "admin list counts uses (survey code: 3)");
ok((await fetch(`${BASE}/api/admin/codes`, { headers: { "x-admin-token": "wrong-token-wrong-token" } })).status === 401, "codes are admin-only");

// gate off = open
await fetch(`${BASE}/api/admin/config`, { method: "PUT", headers: ADMIN, body: JSON.stringify({ gate: false }) });
await new Promise((res) => setTimeout(res, 300));
r = await fetch(`${BASE}/api/tape`, { method: "POST", body: tape() });
ok(r.status === 201 || r.status === 503, "with the gate switched off, anyone can send");
await fetch(`${BASE}/api/admin/config`, { method: "PUT", headers: ADMIN, body: JSON.stringify({ gate: true }) });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
