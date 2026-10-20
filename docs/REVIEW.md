# Code review — October 2026

What was wrong in `main`, and what was done about it.

| # | Problem | Impact | Status |
|---|---|---|---|
| 1 | Neither Worker was ever deployed; `WORKER_URL = ""` | Every playlist showed the hardcoded sample tracks ("Jack O'Lantern - Goodbye Playlist") | Fixed: one Worker, same origin |
| 2 | Bridge used Spotify's removed `/playlists/{id}/tracks` | Would have failed even after deploying | Fixed: `/items`, then embed-page fallback, then sample tracks |
| 3 | Patch 03 (send flow) was never applied | QR code pointed at the playlist, not the gift | Fixed |
| 4 | Reply token never checked; `GET /api/tape` exposed the sender's email and replies | Privacy leak | Fixed |
| 5 | Memo uploads had no auth, size or type limits, and accepted any content-type | Stored-XSS and storage abuse risk | Fixed |
| 6 | `"draft"` id failed the id regex; `APP_ORIGIN` pointed to an unregistered domain | Broken links | Fixed |
| 7 | Recipient page ignored title, skin, stickers and shell art | Gift didn't look like what was made | Fixed |
| 8 | `.sticker-layer { pointer-events:auto }` from the v4 patch | Side B songs couldn't be tapped after the flip | Fixed |
| 9 | `blob:` voice-memo URLs and data-URL photos saved to localStorage | Memos lost on reload; risk of hitting the storage limit and losing everything | Fixed |
| 10 | Fonts base64-embedded in a 1.2 MB CSS file; duplicate art files in the root | Slow load, confusing repo | Fixed |

## Still open
- Recipient Play/Next buttons don't control the Spotify or YouTube iframe players (those players have their own controls).
- The freemium counter and Stripe aren't wired up.
- Not yet tested on real Cloudflare (KV/R2 creation, secrets). Run `npm test` against prod after deploying.
- The Spotify embed fallback is unofficial and could break.
