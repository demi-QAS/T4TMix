# Patch 03 — Sender-side integration (`app.js` + `index.html`)

Wires the existing T4T Mix sender flow to the new recipient Worker. After this
patch, tapping **Send** on a finished tape:

1. Uploads any per-track voice memos to `POST /api/tape/:id/memo` and swaps the
   blob URLs for R2 keys.
2. POSTs the full tape JSON to `POST /api/tape`.
3. Gets back `{id, replyToken, url}`.
4. Encodes that recipient URL into the QR (not the source Spotify/YT link).
5. Stashes `replyToken` in `localStorage` so this device's envelope-icon can
   poll `/api/tape/:id` for `replies[]`.

Apply order: patch 01 → 02 → 03. Nothing here conflicts with 01/02.

## What changes in your existing repo

- `app.js` — replace the `Send` handler (currently only builds a QR of the
  playlist URL) with a real POST-to-Worker flow. Add a memo-upload helper and
  a reply-poll helper.
- `index.html` — add a `<input type="email">` in the send drawer so the sender
  can (optionally) get emailed on replies, and add an envelope-icon slot in the
  header that lights up when a reply arrives.
- `style.css` — one small block for the envelope-icon states (dot + glow).

Nothing in the deck picker, sticker layer, letter editor, tape flip, or the
memo recorder itself changes. Those keep working exactly as before — this
patch only fixes what happens when the user presses **Send**.
## 1. Add a config block at the top of `app.js`

Right after the existing `"use strict";` (or wherever your top-level constants
live), add:

```js
// --- T4T Mix backend config -----------------------------------------------
// After you deploy the recipient-worker to your Cloudflare account, put its
// URL here. When the sender + recipient are served from the SAME Worker
// (recommended), you can leave this as "" and everything works with same-origin
// fetches.
const T4T_API_BASE = ""; // e.g. "https://t4tmix.queeraccountingsolutions.workers.dev"

// localStorage keys
const LS_REPLY_TOKENS = "t4tmix.replyTokens.v1"; // { [tapeId]: replyToken }
const LS_SENDER_EMAIL = "t4tmix.senderEmail.v1";
const LS_SENDER_NAME  = "t4tmix.senderName.v1";
```
## 2. Memo upload helper

Voice memos are currently held as blob URLs in the sender's browser (from
`MediaRecorder`). Before we can save the tape JSON, each memo blob needs to be
uploaded to R2 so the tape JSON can reference an `R2 key` (small string)
instead of a blob URL (which dies with the tab).

Add this helper anywhere in `app.js` (near the other network calls, or at the
end of the file just above the DOMContentLoaded wiring):

```js
async function uploadMemoBlob(blob, draftId = "draft") {
  // Uploads a single Blob to POST /api/tape/:id/memo (or /draft if we don't
  // have the tape id yet). Returns { key } — save that in your track record.
  const r = await fetch(`${T4T_API_BASE}/api/tape/${draftId}/memo`, {
    method: "POST",
    headers: { "content-type": blob.type || "audio/webm" },
    body: blob,
  });
  if (!r.ok) throw new Error("memo upload failed");
  return r.json(); // { ok, key, url }
}

async function uploadAllPendingMemos(tracks) {
  // Walk the sender's in-memory tracks. Any track that has a local blob but no
  // memoKey yet gets uploaded and its memoKey filled in. Mutates in place.
  for (const tr of tracks) {
    if (tr.memoBlob && !tr.memoKey) {
      const { key } = await uploadMemoBlob(tr.memoBlob);
      tr.memoKey = key;
      delete tr.memoBlob;         // don't ship the blob in the tape JSON
      delete tr.memoBlobUrl;      // and don't ship the (dead) blob URL either
    }
  }
}
```

**Where these fields come from:** your existing memo recorder should already
be attaching the recorded Blob to the track record — if you're currently
storing it as `tr.memoBlobUrl = URL.createObjectURL(blob)`, also stash the
raw blob as `tr.memoBlob = blob`. That one-liner is the only change needed in
the recorder path.
## 3. Replace the Send handler

Find your current Send handler in `app.js` — the one that (right now) grabs
the playlist URL and hands it to `qrcode_lib2.js`. Replace it with:

```js
async function handleSend() {
  const btn = document.getElementById("btnSend");
  const origLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "sending…";

  try {
    // 1. Build the tape from current UI state. Adapt these getters to your
    //    existing state model (whatever you already use for the deck/letter).
    const tape = {
      senderName:     document.getElementById("senderName")?.value?.trim() || "",
      senderEmail:    document.getElementById("senderEmail")?.value?.trim() || "",
      recipientName:  document.getElementById("recipientName")?.value?.trim() || "",
      contentType:    state.contentType || "playlist",
      playlist:       state.playlist || null,       // {source, id, title}
      audioUrl:       state.audioUrl || null,       // podcast variant only
      tracks:         state.tracks || [],           // your existing track array
      letter:         document.getElementById("letterText")?.value || "",
      stickersFront:  state.stickersFront || [],
      stickersShell:  state.stickersShell || [],
      coverPhotoKey:  state.coverPhotoKey || null,
      skin:           state.skin  || "trans",
      shell:          state.shell || "boombox",
      scene:          state.scene || "desk",
    };

    // 2. Upload any pending memo blobs, swapping to R2 keys in place.
    await uploadAllPendingMemos(tape.tracks);

    // 3. Save the tape.
    const r = await fetch(`${T4T_API_BASE}/api/tape`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(tape),
    });
    if (!r.ok) throw new Error(await r.text());
    const { id, replyToken, url } = await r.json();

    // 4. Remember the reply token locally so THIS device can poll for replies.
    const tokens = JSON.parse(localStorage.getItem(LS_REPLY_TOKENS) || "{}");
    tokens[id] = replyToken;
    localStorage.setItem(LS_REPLY_TOKENS, JSON.stringify(tokens));
    if (tape.senderName)  localStorage.setItem(LS_SENDER_NAME, tape.senderName);
    if (tape.senderEmail) localStorage.setItem(LS_SENDER_EMAIL, tape.senderEmail);

    // 5. Show the shareable QR — of the RECIPIENT url, not the source playlist.
    showShareSheet({ url, id });

    // 6. Kick off the reply polling for this device.
    startReplyPolling(id);

  } catch (err) {
    console.error(err);
    alert("couldn't send the tape. try again in a moment.");
  } finally {
    btn.disabled = false;
    btn.textContent = origLabel;
  }
}
```

Rewire your existing button:

```js
document.getElementById("btnSend").addEventListener("click", handleSend);
```
## 4. The share sheet (QR + copy link + native share)

Your current QR code is generated by `qrcode_lib2.js` — keep using it, just
feed it the recipient URL. If you don't already have a share sheet, this drop-in
works:

```js
function showShareSheet({ url, id }) {
  const sheet = document.getElementById("shareSheet") || makeShareSheet();
  sheet.querySelector(".share-url").textContent = url;
  sheet.querySelector(".share-url").href = url;
  const qrHost = sheet.querySelector(".share-qr");
  qrHost.innerHTML = "";
  new QRCode(qrHost, { text: url, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.M });

  sheet.querySelector(".share-copy").onclick = async () => {
    try { await navigator.clipboard.writeText(url); toast("link copied"); } catch {}
  };
  sheet.querySelector(".share-native").onclick = async () => {
    if (navigator.share) {
      try { await navigator.share({ title: "a T4T Mix for you", url }); } catch {}
    }
  };
  sheet.classList.add("open");
}
```

The QR now takes the recipient to your tactile mixtape page, not to Spotify.
That is the *entire* difference the user sees at Send.
## 5. Reply polling (envelope icon in the header)

Every ~2 minutes (only while the tab is active), poll every tape this device
knows about. If any of them now has a reply, light up the envelope.

```js
const REPLY_POLL_MS = 2 * 60 * 1000;
let replyPollTimer = null;
const seenReplies = new Set(); // keys like `${tapeId}:${replyAt}`

function startReplyPolling(justSentId) {
  if (justSentId) queueOne(justSentId);
  if (replyPollTimer) return;
  replyPollTimer = setInterval(pollAllReplies, REPLY_POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") pollAllReplies();
  });
  pollAllReplies();
}

async function pollAllReplies() {
  const tokens = JSON.parse(localStorage.getItem(LS_REPLY_TOKENS) || "{}");
  const ids = Object.keys(tokens);
  if (!ids.length) return;
  const results = await Promise.allSettled(ids.map(queueOne));
  updateEnvelopeBadge();
  return results;
}

async function queueOne(id) {
  try {
    const r = await fetch(`${T4T_API_BASE}/api/tape/${id}`);
    if (!r.ok) return;
    const tape = await r.json();
    for (const rep of (tape.replies || [])) {
      const k = `${id}:${rep.at}`;
      if (!seenReplies.has(k)) {
        seenReplies.add(k);
        notifyReply(id, rep);
      }
    }
  } catch {}
}

function notifyReply(id, rep) {
  // Persist "unseen" state so the badge survives a reload
  const unseen = JSON.parse(localStorage.getItem("t4tmix.unseen") || "[]");
  unseen.push({ id, at: rep.at });
  localStorage.setItem("t4tmix.unseen", JSON.stringify(unseen));
}

function updateEnvelopeBadge() {
  const unseen = JSON.parse(localStorage.getItem("t4tmix.unseen") || "[]");
  const env = document.getElementById("headerEnvelope");
  if (!env) return;
  env.classList.toggle("has-reply", unseen.length > 0);
  env.dataset.count = unseen.length || "";
}
```

Wire it on load:

```js
document.addEventListener("DOMContentLoaded", () => {
  startReplyPolling();
  document.getElementById("headerEnvelope")?.addEventListener("click", openReplyInbox);
});

function openReplyInbox() {
  // Simplest UX: show the list of tape ids with replies, tapping opens the
  // recipient page (which also shows the sender their own reply thread).
  const unseen = JSON.parse(localStorage.getItem("t4tmix.unseen") || "[]");
  if (!unseen.length) return alert("no new replies yet.");
  const latest = unseen[unseen.length - 1];
  // Clear the badge
  localStorage.setItem("t4tmix.unseen", "[]");
  updateEnvelopeBadge();
  // Open the recipient page in a new tab — sender sees the same world +
  // the reply thread pinned to the bottom of the letter.
  window.open(`${T4T_API_BASE}/t/${latest.id}#replies`, "_blank");
}
```

The header envelope icon markup (drop this into `index.html` near your logo):

```html
<button id="headerEnvelope" class="header-envelope" aria-label="reply inbox">
  ✉︎<span class="badge"></span>
</button>
```

And the two-line CSS for `style.css`:

```css
.header-envelope { position: relative; font-size: 20px; padding: 8px; }
.header-envelope .badge { display: none; position: absolute; top: 2px; right: 2px;
  width: 8px; height: 8px; border-radius: 50%; background: var(--hot, #e63a7a); }
.header-envelope.has-reply { animation: envPulse 2s ease-in-out infinite; }
.header-envelope.has-reply .badge { display: block; }
@keyframes envPulse {
  0%,100% { transform: scale(1); }
  50%     { transform: scale(1.12); }
}
```
## 6. Sender email field (optional, but recommended)

Add this to the send drawer in `index.html`, right above the Send button:

```html
<label class="send-field">
  <span>your email (optional)</span>
  <input type="email" id="senderEmail" placeholder="you@you.com"
         autocomplete="email" inputmode="email" />
  <small>we'll email you if they write back. verified once via Cloudflare.</small>
</label>
```

Pre-fill it from localStorage on load:

```js
const savedEmail = localStorage.getItem(LS_SENDER_EMAIL);
if (savedEmail) document.getElementById("senderEmail").value = savedEmail;
```

**One-time verification:** Cloudflare Email Routing requires each destination
address to be verified once. On first send, after the tape saves, show the
sender a tiny modal:

> we sent a verification link to `you@you.com` — tap it once and every reply
> to any of your tapes will land in your inbox.

Then log the address in your Cloudflare Email Routing dashboard so the Worker's
`send_email` binding is allowed to reach them. (This is one manual add per
sender for now — automate it later via the Cloudflare API if traffic warrants.)
## 7. Podcast variant (`contentType: "audio"`) — how to trigger it

Everything above works for playlists (`contentType: "playlist"`). For the
podcast / audio-drop variant, set `state.contentType = "audio"` and provide a
public `state.audioUrl` (an mp3/m4a URL — YouTube episode audio, an Anchor
enclosure, whatever). No other change; the tape still gets tracks (chapter
markers) + memos + a letter + parallax scene. The recipient JS routes on
`contentType` and uses an `<audio>` element instead of an embedded playlist.

For a bulk send-to-many variant later (the $10 tier), you'd batch-POST N tapes
with the same content but different `recipientName` — no schema change needed.
## 8. Test checklist (before you deploy)

Local (with `npm run dev` in `recipient-worker/`):

- [ ] Load the sender at `http://127.0.0.1:8787/` — the existing UI renders.
- [ ] Build a tape with 3 tracks, 1 memo, 1 sticker, a letter.
- [ ] Press Send → console shows a POST to `/api/tape` returning `{ok, id, url}`.
- [ ] QR now encodes `http://127.0.0.1:8787/t/<id>`, not the Spotify URL.
- [ ] Open the recipient URL on your phone (same Wi-Fi, or use `wrangler dev --remote`).
- [ ] Unveiling wrapper animates open on tap.
- [ ] Letter modal opens if you wrote one.
- [ ] Tape rotates in the scene when you tilt (or drag on desktop).
- [ ] Flipping the tape shows the tracklist (Patch 02 already fixed the scroll).
- [ ] Tapping a memo sticky plays the audio.
- [ ] Envelope icon opens the reply modal; recording works; sending shows success.
- [ ] Back on sender: envelope in header lights up within ~2 min (or on tab focus).

Production:

- [ ] `wrangler deploy` succeeds.
- [ ] `/t/<id>` renders on the deployed domain.
- [ ] Email Routing set up (per README) + verified destination address.
- [ ] Send a real tape to yourself, reply from your phone → email arrives.

---

## What this patch does NOT do

- Sender-side "premium Spotify SDK" toggle for ad-free playback in the
  recipient's browser (still requires the recipient to be logged into Spotify
  Premium in-browser — deferred to a future patch; the honesty note in the
  diagnostic doc covers this).
- Stripe checkout for the $2 / $10 tiers (unchanged — plug into `handleSend`
  before the actual POST, or gate it at the "download the mixtape" step).
- Recipient-side "save this tape to my brain" — the tape is stored in the
  sender's Worker KV; if the recipient wants a durable copy, they screenshot
  or the sender can extend TTL past 180 days.

None of these block the v5 build; they're future work.

