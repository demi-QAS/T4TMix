# Changelog

## 0.7.0 — 2026-10-20 (it actually plays)
- **Music plays on the recipient page.** The Play button used to only animate; the bottom YouTube bar was 80px tall (YouTube requires at least 200×200) and played its own list, so the song didn't match the label. New `public/player.js` drives every song from our buttons (play, pause, next, previous, tap a song, auto-advance).
- **Three ways to listen,** switchable on the page: Spotify (full songs when signed in, otherwise 30-second previews), YouTube (full songs, may show an ad; the player is visible at 200px), and previews. Voice memos play before (intro / over the ad) or after (outro) their song.
- **YouTube matching on demand:** `/api/match` looks up one song at a time and caches the result, instead of 50 lookups when the page loads (that used up about half the daily YouTube quota per playlist).
- **Gift unwrap redone:** a box in the tape's colours, ribbon and bow, a "for ___" tag; it wiggles, the lid pops and the tape rises out with spinning reels, then the letter opens.
- **Recipient page:** one clean column, with the tape, what's playing, the controls, the deck, the letter / write-back buttons, and the full song list. The docked bar and the motion prompt are gone.
- **Stickers removed** (sender and recipient). You can now pick the tape colour, **pen colour** (midnight, berry, ocean, forest, plum) and **label paper** (cream, kraft, grid, blush).
- **Song names have room:** Side B and the flip are replaced by a full-width J-card list where long titles and artists wrap instead of being cut off.
- The sender's player uses the same deck (the hidden 1×1 YouTube player was against YouTube's rules). The shell photo, window photo and wrap style are gone (the recipient never saw them).

## 0.6.0 — 2026-10-20 (cleanup)
- **One Worker** (`src/index.js`) replaces `cloudflare-worker/` and `recipient-worker/`, serving the app and API from the same origin.
- **Sending works:** the Send screen saves the tape and the QR code / link now points to the recipient page (it used to encode the source playlist URL).
- **Real playlists:** the app calls the bridge, so tracks come from Spotify or YouTube instead of the hardcoded sample list. This includes the Spotify February 2026 API workaround.
- **Security:** sender email and replies are private; only one reply per tape; replies are readable only with the owner token; upload size and type limits; served file types are fixed by the Worker; path-traversal protection; rate limits.
- **Recipient page:** shows the tape title, skin, stickers, shell art, cover photo, embed mode and the font; the music bar is docked at the bottom of the screen.
- **Fixes:** the Side B "can't tap songs" bug; voice memos and photos survive a reload; Safari recording format.
- **Size:** `style.css` went from 1.2 MB to 36 KB (fonts moved to `public/fonts/`); duplicate root art files removed; hardcoded analytics beacon removed.
- **Docs:** README, DEPLOY, PEOPLES990, REVIEW; old notes moved to `docs/history/`.
