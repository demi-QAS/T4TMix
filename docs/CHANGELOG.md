# Changelog




## 0.9.4 — 2026-10-30
- Landing page: new "free beta, powered by community" card linking the mutual aid survey, The People's 990 (thepeoples990.com) and Venmo. The People's 990 link is editable in admin → access gate.
- Replies: signed-in senders now get an in-app alert ("💌 Sam wrote back on …") when they open or come back to T4T Mix, plus the inbox badge. Checks every 90 s while the tab is open.
- Honest reply copy: the sign-in reminder and inbox only promise text alerts when a Twilio sending number (TWILIO_FROM or TWILIO_MESSAGING_SID) is set. Otherwise they say replies land in your inbox.
- Recipient's "reply sent" screen says the reply is waiting in the sender's inbox when the sender has an account.

## 0.9.3 — 2026-10-30
- Friendly sign-in reminder: tapping "Load my playlist" with a link pasted while signed out pops up a note explaining that signing in keeps a copy of every tape you send and lets you get a reply by text. "sign in with my phone" opens sign-in and then keeps loading the playlist; "keep going without signing in" skips it for the rest of the visit. Only shows when phone sign-in is switched on.

## 0.9.2 — 2026-10-30
- Sign-in errors now say what actually went wrong (not-yet-approved texting vs landline/non-mobile vs country vs too many tries) and show the Twilio error code.
- The last Twilio sign-in failure is saved (14 days) and shown in admin → 📱 phone sign-in check, with a link to Twilio's explanation.
- The check now also reports whether the keys on this worker belong to an upgraded (Full) or Trial Twilio account.

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

## 0.9.0 — access-code gate
- New cover page: type an access code on a cassette label → "press play" to unlock (reels spin, the cover slides up; wrong codes shake)
- Two ways in on the cover: the mutual aid survey link and Venmo @Queerasolutions (supports The People's 990)
- `/admin` → access codes: one shared survey code + batches of one-time donor codes; copy, turn off, delete, usage counts
- `?code=XXXX` links pre-fill the code; unlocks saved per device (1 year) and on signed-in accounts
- Sending a tape now requires access when the gate is on; gift + reply links stay open
- Tests: `npm run test:gate` (20 checks)

## 0.9.1 — sign-in troubleshooting
- `/admin` → "phone sign-in check": shows which Twilio secrets reach the app, catches swapped AC/VA SIDs, and asks Twilio whether it accepts the keys (values are never shown)
- Pasted secrets are trimmed (stray spaces/newlines no longer break sign-in)
- Clearer messages when Twilio refuses a number (e.g. trial accounts can only text verified numbers)
- `keep_vars: true` in wrangler.jsonc so deploys don't wipe dashboard variables
