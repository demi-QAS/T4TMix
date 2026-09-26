[README.md](https://github.com/user-attachments/files/32675836/README.md)
# T4T Mix — Recipient / Reply Worker (v0.1 scaffold)

The backend the sender-side app has been missing. This is the Worker that:

1. Accepts a serialized "tape" (playlist + memos + letter + stickers + skin +
   shell + scene) from the sender, stores it in Cloudflare KV, and hands back a
   short shareable URL: `https://t4tmix.com/t/abc123xy`.
2. Renders the recipient page at `/t/:id` — a minimal HTML shell with OG-tags
   for pretty previews in Signal / iMessage / IG DMs, plus the recipient JS
   bundle that hydrates the decorated cassette in the tiltable parallax scene.
3. Accepts ONE reply per tape (voice memo or text) using a per-tape reply token,
   stores audio in R2, and (TODO) emails the sender via Cloudflare Email
   Routing.
4. Serves the static front-end (index.html, app.js, style.css, shell SVGs,
   Kalam fonts, and the new `recipient.js` / `recipient.css`) via the ASSETS
   binding — one Worker, one deploy, no CORS gymnastics.

## What's here

```
recipient-worker/
├── src/
│   └── index.js         # the Worker itself — routing, KV, R2, HTML shell
├── public/              # NOT INCLUDED YET — you copy your current front-end here,
│                        #   then add recipient.js + recipient.css when we build them
├── wrangler.jsonc       # Worker config; bindings for KV (TAPES) + R2 (MEMOS)
├── package.json
└── README.md            # this file
```

## Where this fits in the roadmap

This is **Step 5 (build the recipient page) + Step 5.5 (reply loop) + Step 5.6 (podcast variant)**
from the diagnostic doc, scaffolded end-to-end. What's DONE here:

- ✅ Worker routes (save tape, fetch tape, save reply, upload memo, fetch memo, render recipient page)
- ✅ KV + R2 bindings in wrangler.jsonc
- ✅ Full recipient shell — HTML + tactile parallax CSS + player/reply JS
- ✅ Unveiling → letter → tape flow with tilt/touch parallax on 3 scenes
- ✅ Reply token security model (one reply per tape, sender keeps token, recipient never sees it)
- ✅ Reply modal — voice (20s cap via MediaRecorder) + text tabs, one-shot
- ✅ Podcast-variant support in the schema (`contentType: "audio"` + `audioUrl`)
- ✅ Scene support in the schema (`scene: "desk" | "nightstand" | "car"`)
- ✅ Cloudflare Email Routing binding wired for sender reply notifications

What's NEXT (see patch 03-sender-integration.patch.md):

- 🟡 Sender-side `app.js` needs to POST to `/api/tape` at Send (currently just QRs the source playlist)
- 🟡 Per-track memo upload to `/api/tape/:id/memo` BEFORE tape save (so the tape JSON references the R2 keys)
- 🟡 Local storage of `replyToken` so the sender can poll `/api/tape/:id` for `replies[]`

## First-deploy recipe (~10 minutes, on your Cloudflare account)

```bash
# From the recipient-worker/ directory
npm install
npx wrangler login

# 1. Create the KV namespace, copy the returned id into wrangler.jsonc
npm run kv:create

# 2. Create the R2 bucket
npm run r2:create

# 3. Copy your current T4T Mix front-end into public/
#    (index.html, app.js, style.css, style_v4_patch.css, qrcode_lib2.js,
#     Kalam-*.ttf, full_recorder_*.svg/.png, assets/, etc.)
mkdir -p public
cp -r ../T4TMix/index.html ../T4TMix/app.js ../T4TMix/*.css ../T4TMix/*.js public/
cp -r ../T4TMix/Kalam-*.ttf ../T4TMix/full_recorder_*.* public/

# 4. Deploy
npm run deploy

# 5. Point your custom domain at the Worker via Cloudflare dashboard:
#    Workers & Pages → t4tmix-recipient → Settings → Domains & Routes
#    Add: t4tmix.com/*   (once you register the .com)
```

## Test the API locally before deploying

```bash
npm run dev                    # runs at http://127.0.0.1:8787

# Save a tape
curl -X POST http://127.0.0.1:8787/api/tape \
  -H "content-type: application/json" \
  -d '{"senderName":"Demi","tracks":[{"original":"Song A","display":"Song A","artist":"Artist"}],"letter":"hi","skin":"trans","shell":"boombox","scene":"desk","playlist":{"source":"spotify","id":"7ldeWYMpsY7YxGPYDSmW9p"}}'
# → { "ok": true, "id": "abc123xy", "replyToken": "...", "url": "https://t4tmix.com/t/abc123xy" }

# Fetch it
curl http://127.0.0.1:8787/api/tape/abc123xy

# Open the recipient shell
open http://127.0.0.1:8787/t/abc123xy
```

## Enabling Email Routing (one-time, per your Cloudflare zone)

The reply loop stores every reply in KV/R2 unconditionally — the sender can
always see them by opening the tape page again. Email notification is the
*nice-to-have* layer on top and requires Cloudflare Email Routing:

1. **Enable Email Routing** — Cloudflare dashboard → your zone (the one hosting
   `APP_ORIGIN`) → **Email → Email Routing** → click **Enable Email Routing**.
   It walks you through the MX records; auto-configures for zones on Cloudflare DNS.
2. **Add each sender's address as a Destination**. In Email Routing → **Destination
   addresses**, click **Add destination address**, enter the sender's email
   (e.g. `demi@queeraccountingsolutions.com`). Cloudflare mails them a
   verification link — one-time per address.
3. **List those verified addresses in `wrangler.jsonc`**:
   ```jsonc
   "send_email": [{
     "name": "SEND_EMAIL",
     "allowed_destination_addresses": [
       "demi@queeraccountingsolutions.com",
       "another-sender@example.com"
     ]
   }]
   ```
4. **Install `mimetext`** (already in `package.json`): `npm install`
5. **Redeploy**: `npm run deploy`

**Anti-abuse note:** Cloudflare's `send_email` binding only sends to addresses
you've verified. This is intentional — it prevents a compromised Worker from
being turned into spam infrastructure. For T4T Mix's threat model (small user
base of people who know each other), the flow is: the sender enters their email
when they build a tape → the app asks them to verify it once via Cloudflare's
one-tap email → after that, every reply on any of their tapes emails them
automatically.

**If Email Routing isn't set up**, replies still work — they're stored and
visible when the sender polls `/api/tape/:id` (the sender-side envelope-icon
polls every ~2 min while the tab is open). Email is opt-in polish, not a
dependency.

## The data model (single source of truth)

```jsonc
{
  "id": "abc123xy",
  "v": 1,
  "createdAt": "2026-09-25T21:00:00.000Z",
  "replyToken": "…",       // sender-only; never sent to recipient
  "replyTokenUsed": false,

  "senderName": "Demi",
  "senderEmail": "demi@queeraccountingsolutions.com",  // optional; needed for reply email notifications
  "recipientName": "Sam",  // shown on the wrapping ("for Sam")

  "contentType": "playlist",   // or "audio" for the podcast variant
  "playlist": {
    "source": "spotify",       // or "youtube"
    "id": "7ldeWYMpsY7YxGPYDSmW9p",
    "title": "Jack O'Lantern"
  },
  "audioUrl": null,            // set when contentType === "audio"

  "tracks": [
    {
      "original": "Song A",
      "display": "our summer 2020 song",
      "artist": "Artist",
      "note": "this played on the drive back",
      "memoKey": "memo/abc123xy/xyz.webm",
      "memoPosition": "intro"   // "intro" | "outro" | "over-ad"
    }
  ],

  "letter": "to you, with love —",
  "stickersFront": [{ "emoji": "🏳️‍⚧️", "x": 0.3, "y": 0.4, "scale": 1.1, "rot": 8 }],
  "stickersShell": [],
  "coverPhotoKey": null,       // optional R2 key for label photo

  "skin": "trans",             // trans | lesbian | bi | nb | pride
  "shell": "boombox",          // boombox | carabiner | heart
  "scene": "desk",             // desk | nightstand | car

  "replies": [
    { "at": "2026-09-25T22:00:00.000Z", "type": "audio", "audioKey": "reply/abc123xy/xyz.webm" }
  ]
}
```
