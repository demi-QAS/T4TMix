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
