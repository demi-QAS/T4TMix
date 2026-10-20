// Smoke test against a running Worker:  npm run dev  (then)  npm test
// Or against prod:  BASE=https://t4tmix.queeraccountingsolutions.workers.dev npm test
const BASE = process.env.BASE || "http://localhost:8787";
let fails = 0;
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) fails++; };

const health = await fetch(`${BASE}/api/health`);
ok(health.status === 200, "GET /api/health is 200");

const tape = { tapeTitle: "smoke test", recipientName: "Tester", senderName: "Bot",
  senderEmail: "private@example.com", tracks: [{ title: "Song", artist: "Artist" }] };
const fd = new FormData();
fd.set("tape", JSON.stringify(tape));
const made = await fetch(`${BASE}/api/tape`, { method: "POST", body: fd });
ok(made.status === 200 || made.status === 201, "POST /api/tape creates a tape");
const { id, ownerToken } = await made.json();
ok(/^[a-z2-9]{6,16}$/.test(id || ""), "tape id looks right");

const pub = await (await fetch(`${BASE}/api/tape/${id}`)).json();
const leaked = JSON.stringify(pub);
ok(!leaked.includes("private@example.com"), "public view hides sender email");
ok(!("ownerHash" in pub) && !("reply" in pub), "public view hides owner hash and reply");

const rf = new FormData(); rf.set("kind", "text"); rf.set("text", "thank you");
const r1 = await fetch(`${BASE}/api/tape/${id}/reply`, { method: "POST", body: rf });
ok(r1.ok, "first reply accepted");
const rf2 = new FormData(); rf2.set("kind", "text"); rf2.set("text", "again");
const r2 = await fetch(`${BASE}/api/tape/${id}/reply`, { method: "POST", body: rf2 });
ok(!r2.ok, "second reply rejected");

const anon = await fetch(`${BASE}/api/tape/${id}/replies`);
ok(anon.status === 401 || anon.status === 403, "replies need the owner token");
const mine = await fetch(`${BASE}/api/tape/${id}/replies`, { headers: { "x-owner-token": ownerToken } });
ok(mine.ok, "owner can read replies");

const trav = await fetch(`${BASE}/api/media/${id}/..%2F..%2Fsecret`);
ok(trav.status === 404, "media path traversal blocked");

const emb = await fetch(`${BASE}/embed/${id}`);
ok((emb.headers.get("content-security-policy") || "").includes("frame-ancestors"), "embed sends frame-ancestors CSP");

console.log(fails ? `\n${fails} check(s) failed` : "\nAll checks passed");
process.exit(fails ? 1 : 0);
