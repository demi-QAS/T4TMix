# T4T Mix v0.8 — free beta launch checklist

## Secrets (`npx wrangler secret put <NAME>`)
| Secret | Required? | What it does |
|---|---|---|
| `ADMIN_TOKEN` | **Yes** (16+ chars) | Unlocks `/admin` |
| `PHONE_PEPPER` | **Yes** for login | Hashes phone numbers so KV never stores them in plain text |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SID` | For phone login | Text login codes (Twilio Verify, about $0.05 per login) |
| `TWILIO_FROM` or `TWILIO_MESSAGING_SID` | Optional | "You got a reply" texts. Needs A2P 10DLC or toll-free verification |
| `YOUTUBE_API_KEY` | Recommended | Matches songs to YouTube (100 of the 10k daily units per search; results cached 30 days) |
| `SOUNDCLOUD_CLIENT_ID` / `_SECRET` | Optional | Search fallback. SoundCloud set import works without keys |

Without Twilio the site still works, but the sign-in button stays hidden.

## Deploy
```
npm run check && npm test
npx wrangler deploy
```

## Admin console (`/admin`)
Maintenance mode and banner, feature switches, music-lane toggles, donation link (hidden until you add one), 14-day stats, feedback, a fix for wrong song matches (pin a YouTube/SoundCloud ID), tape view/delete, and user ban/sign-out.

## Known risks
- KV free tier allows about 1,000 writes a day. Each tape, reply and stat costs writes. Move to Workers Paid ($5/mo) if the beta takes off.
- The YouTube quota allows about 100 new song searches a day before the cache warms up.
- The Cache API is only guaranteed on a custom domain, so rate limiting uses `ratelimits` bindings instead.
- Not yet tested on real devices: iOS autoplay and webm voice memos on older iPhones.
- Voice memos live only in the browser until the tape is sent (lost if you reload).

## Access-code gate (v0.9): survey or Venmo gets you in
The site opens on a cover page. To make tapes, people type an access code. **Gift links (`/t/…`) and reply links (`/r/…`) never need a code**, so anyone you send a tape to can open it and write back.

**Setup (5 minutes, in `/admin` → "access codes"):**
1. **Survey code.** Make one shared code (e.g. `MUTUALAID`). Paste it on your survey's **thank-you / confirmation page**: "Thanks! Your T4T Mix code is MUTUALAID. Go to t4tmix…/?code=MUTUALAID". The `?code=` link fills the code in for them. A shared code has unlimited uses unless you turn it off.
2. **Donor codes.** Make a batch of one-time codes (e.g. 10, note "venmo — Nov"). When a Venmo comes in, text or email one code to the donor. Each code works once.
3. **Edit the cover page text** (survey link, Venmo handle, notes) in the same panel. "Preview ↗" opens the live cover.

**Good to know**
- If the survey code leaks, turn it off and make a new one. **People already in stay in.** Only new unlocks need the new code.
- Unlocking is saved on the device for a year. Signed-in people also get it saved to their account, so it works on any phone.
- Turning "require an access code" off opens the site to everyone instantly.
- Honest limits: anyone holding the survey code can get in without taking the survey (it's an honor-system gate, not proof). One-time codes are the strict option.
- "Codes used" appears in the 14-day stats.
