# T4T Mix 📼

**Mixtapes, minus the necklace.** Build a digital mixtape from a Spotify or YouTube playlist, wrap it, add voice memos, stickers and a letter, then send it as a link or QR code. The person you send it to unwraps it, listens, and can write back once.

A Queer Accounting Solutions creation.

## What's in here (v0.6)

| Path | What it is |
|---|---|
| `public/` | The sender app (`index.html`, `app.js`, `style.css`) and the recipient page (`recipient.*`), plus fonts, art and the vendored QR library |
| `src/index.js` | One Cloudflare Worker: playlist bridge, saving tapes, media, replies, and the `/t/:id` and `/embed/:id` pages |
| `wrangler.jsonc` | Worker config: KV `TAPES`, R2 `MEDIA`, vars |
| `tests/smoke.mjs` | API smoke test (`npm test`) |
| `docs/` | `DEPLOY.md`, `PEOPLES990.md`, `REVIEW.md`, `CHANGELOG.md`, and `history/` (older patch notes) |
| `tools/shell-art/` | Scripts that generate the shell artwork |

## Run it locally

```bash
npm install
cp .dev.vars.example .dev.vars   # add API keys (optional; the app falls back without them)
npm run dev                      # http://localhost:8787
npm test                         # in a second terminal
```

## Deploy

Read [`docs/DEPLOY.md`](docs/DEPLOY.md). Short version: `npx wrangler deploy`, then set the three secrets.

## Routes

| Route | Purpose |
|---|---|
| `GET /` | Sender app |
| `GET /api/health` | Status and which features are switched on |
| `GET /api/playlist?url=` / `/api/bridge` | Pull tracks from Spotify or YouTube, and match Spotify tracks to YouTube |
| `POST /api/tape` | Save a tape (multipart). Returns `id`, `ownerToken`, `url`, `embedUrl` |
| `GET /api/tape/:id` | Public tape view (no email, no reply contents) |
| `POST /api/tape/:id/reply` | The one reply the recipient can send |
| `GET /api/tape/:id/replies` | Sender only (`x-owner-token` header) |
| `GET /api/media/:id/:file` | Voice memos and photos from R2 |
| `GET /t/:id` | Recipient page |
| `GET /embed/:id` | Iframe player (only allowed on sites in `EMBED_ORIGINS`) |
