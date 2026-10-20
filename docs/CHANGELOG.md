# Changelog

## 0.6.0 — 2026-10-20 (cleanup)
- **One Worker** (`src/index.js`) replaces `cloudflare-worker/` and `recipient-worker/`, serving the app and API from the same origin.
- **Sending works:** the Send screen saves the tape and the QR code / link now points to the recipient page (it used to encode the source playlist URL).
- **Real playlists:** the app calls the bridge, so tracks come from Spotify or YouTube instead of the hardcoded sample list. This includes the Spotify February 2026 API workaround.
- **Security:** sender email and replies are private; only one reply per tape; replies are readable only with the owner token; upload size and type limits; served file types are fixed by the Worker; path-traversal protection; rate limits.
- **Recipient page:** shows the tape title, skin, stickers, shell art, cover photo, embed mode and the font; the music bar is docked at the bottom of the screen.
- **Fixes:** the Side B "can't tap songs" bug; voice memos and photos survive a reload; Safari recording format.
- **Size:** `style.css` went from 1.2 MB to 36 KB (fonts moved to `public/fonts/`); duplicate root art files removed; hardcoded analytics beacon removed.
- **Docs:** README, DEPLOY, PEOPLES990, REVIEW; old notes moved to `docs/history/`.
