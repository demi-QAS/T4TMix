# Deploying T4T Mix

This replaces the old two-Worker setup (`cloudflare-worker/` and `recipient-worker/`). Neither of those Workers was ever deployed. Only the static front end was live, so the app was always showing the sample tracks.

## 1. Before you start
- Wrangler **4.45 or newer** (`npm install` handles this). It creates KV and R2 for you on the first deploy.
- **R2** has to be switched on for the account (Cloudflare dashboard → R2). Cloudflare may ask for a payment method even though the free tier covers this.
- Keep `"name": "t4tmix"` in `wrangler.jsonc`. That name matches the Worker that's already connected to GitHub.

## 2. Deploy
```bash
npm install
npx wrangler deploy
```
On the first run, wrangler creates the `TAPES` namespace and the `t4tmix-media` bucket and prints their ids. Paste the KV `id` into `wrangler.jsonc` so later deploys reuse the same namespace.

If you deploy by pushing to GitHub (Workers Builds), push the branch and use build command `npm install` and deploy command `npx wrangler deploy`.

## 3. Secrets (optional; each one turns a feature on)
```bash
npx wrangler secret put YOUTUBE_API_KEY        # read YouTube playlists + match Spotify songs to YouTube
npx wrangler secret put SPOTIFY_CLIENT_ID
npx wrangler secret put SPOTIFY_CLIENT_SECRET
```
After that, `GET /api/health` shows which features are on.

### About Spotify
Spotify's February 2026 changes for apps in development mode removed `GET /playlists/{id}/tracks`. The replacement, `/items`, only returns tracks for playlists the app owner owns or collaborates on, and the app owner needs Premium. So the Worker does this:
1. Tries the official API first.
2. Falls back to reading Spotify's public embed page. This is unofficial: it can break without warning and is a grey area under Spotify's terms. Fine for a beta, but don't build the business on it.
3. Falls back to the sample tracks.

The app always plays music through Spotify's or YouTube's own players. It never hosts audio.

## 4. Custom domain (later)
Once `t4tmix.com` is on Cloudflare, attach it to the Worker (Workers → t4tmix → Domains). Then set `APP_ORIGIN` to `https://t4tmix.com` in `wrangler.jsonc` and redeploy. QR codes and links use `APP_ORIGIN`.

## 5. Reply-by-email (optional)
1. Turn on Email Routing for the domain and verify the address that should receive the emails.
2. In `wrangler.jsonc`, uncomment the `send_email` block and list that address.
3. Redeploy.

Replies are always saved either way, and the sender sees them in the app under **sent tapes**.

## 6. Check it
```bash
BASE=https://t4tmix.queeraccountingsolutions.workers.dev npm test
```
