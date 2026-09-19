 🎧 T4T Mix

**mixtapes, minus the necklace.**

T4T Mix is a browser-based digital mixtape creator built for the T4T (Trans for Trans) and broader queer community. Paste a Spotify playlist link, dress it up with pride-flag skins and stickers, drop a voice memo or written anecdote on any track, and send the whole feeling to someone as a QR code or one-tap share — no jargon, no gatekeeping, just good taste.

Created under the [Queer Accounting Solutions](https://queeraccountingsolutions.com/) umbrella.

---

## ✨ Features (Phase 1 — this build)

| Feature | Status |
|---|---|
| Paste a Spotify playlist link → real embedded player | ✅ Working (uses Spotify's public oEmbed + iframe embed, no API key needed) |
| YouTube Music link input | 🔲 UI stub only — "coming soon," not functional yet |
| Interactive 3D cassette (CSS 3D transforms) | ✅ Play spins the reels, Eject pops the flap, Rewind/FF give a playful wobble, hover tilts it |
| Pride flag skins | ✅ Trans (default), Lesbian, Bi, Nonbinary, Pride — recolors cassette + QR border |
| Per-track notes | ✅ Tap any track → type an anecdote |
| Per-track voice memos | ✅ Real browser mic recording via `MediaRecorder` API, capped at 20s, with playback preview before saving |
| Sticker decorating | ✅ Drag-and-drop (desktop) / tap-to-place (mobile) pride flags + doodles onto the tape label |
| Photo upload | ✅ Upload a personal photo onto the tape label |
| Editable tape title | ✅ Live-updates the label and the QR caption |
| QR code generation | ✅ Fully client-side, no external network call, styled to match the chosen skin |
| Native share | ✅ Uses the Web Share API (one-tap to Instagram/Messages/etc. on supporting devices), with a copy-link fallback |
| Freemium badge | 🔲 Visual placeholder only ("2 free, then $2") — no real payment wired up |

### Explicitly out of scope for Phase 1
Real YouTube Music API integration, SoundCloud-style timestamped comments, real Stripe/payment processing, and backend persistence (saved mixtapes across sessions/devices) are all Phase 2. This build is entirely client-side with no server or database.

---

## 📁 File structure

```
t4tmix/
├── index.html              # Markup — three "screens" (hero, builder, send) + note modal
├── style.css                # All styling, incl. pride-flag color variables & 3D cassette transforms
├── app.js                   # All interactivity — playlist loading, cassette controls, stickers,
│                             #   voice recording, QR generation, share/copy
└── t4tmix_standalone.html   # Same app, but with style.css + app.js + the QR library all inlined
                              #   into a single file — zero external dependencies, zero external
                              #   <script>/<link> tags. Useful for quick sharing/testing, but for
                              #   real deployment prefer the 3-file version above (easier to edit).
```

**Note on the QR library:** the QR code generator (`qrcodejs`) is loaded from a CDN in `index.html`'s original dev version, but is **fully inlined** in `t4tmix_standalone.html`. If you deploy the 3-file version and see the QR step silently fail, check that your hosting environment doesn't block external CDN scripts via Content-Security-Policy — if it does, either allow `cdn.jsdelivr.net` in your CSP, or copy the inlined QR library code out of `t4tmix_standalone.html`'s `<script>` block into a local `qrcode.js` file and reference that instead.

---

## 🚀 Deployment

This is a fully static site — no build step, no server, no database. Any static host works.

### Option A — GitHub Pages (recommended, free, ties into your existing GitHub)
1. Create a new repository (keep it separate from unrelated projects like `ThePeoples990`).
2. Upload `index.html`, `style.css`, and `app.js` to the repo root.
3. Go to **Settings → Pages → Source**, select your default branch (`main`), save.
4. GitHub will give you a live URL like `https://<your-username>.github.io/<repo-name>/` within a minute or two.
5. Once you own **t4tmix.com**, add it as a custom domain under the same Pages settings (GitHub walks you through the DNS records — usually a `CNAME` record pointing at `<your-username>.github.io`).

### Option B — Cloudflare Pages (also free, arguably easier for drag-and-drop)
1. In the Cloudflare dashboard, create a new **Pages** project.
2. Either connect your GitHub repo (auto-deploys on every push) or directly drag-and-drop `index.html`, `style.css`, and `app.js`.
3. Cloudflare deploys instantly to a `*.pages.dev` URL.
4. Add **t4tmix.com** as a custom domain under the project's settings once you own it.

### Option C — Cloudflare Worker
Workers are meant for request-handling logic, not static file hosting — for a pure static site like this, **Pages is the better fit** (Option B). If you specifically want a Worker, you'd need to serve the contents of `t4tmix_standalone.html` as a string response from a `fetch` handler, e.g.:
```js
export default {
  async fetch(request) {
    return new Response(HTML_STRING, { headers: { "content-type": "text/html" } });
  }
}
```
...where `HTML_STRING` is the full text of `t4tmix_standalone.html`. This works but is more fiddly to update than Pages.

---

## 🌐 Domain

`t4tmix.com` was unregistered as of last check — grab it via Namecheap, Porkbun, or GoDaddy. `.com` is the recommended TLD here over `.io`: it's cheaper annually, nobody has to specify "dot io" out loud, and it matches the warm/personal tone of the product better than a techy-startup-coded `.io`.

---

## 🔧 Local development

No build tools needed. To preview locally:
```bash
# from the project folder
python3 -m http.server 8080
# then open http://localhost:8080/index.html in your browser
```
Opening `index.html` directly via `file://` mostly works too, but the microphone (`getUserMedia`) and clipboard APIs require a "secure context" — on real deployments this just means HTTPS, which GitHub Pages and Cloudflare Pages provide automatically for free.

---

## ⚠️ Known limitations / things to know

- **Spotify tracklist**: the actual track names/artists inside the embedded Spotify player aren't readable by outside JavaScript (Spotify's iframe is cross-origin, by design, for content protection). The tap-to-annotate track list below the embed is a manually editable numbered list (tap a track name to rename it) rather than an auto-pulled list — the embed above it shows the real art, real audio, and real track names visually, just not programmatically.
- **No data persistence**: everything (notes, voice memos, stickers, chosen skin) lives only in the browser tab's memory for that session. Refreshing the page or closing the tab loses your edits. Phase 2 would add a backend (e.g. Supabase) to actually save and re-open mixtapes.
- **Voice memos aren't uploaded anywhere**: they're stored as a temporary in-browser blob URL. If you want the recipient to actually hear it, Phase 2 needs real storage + a way to bundle that into what gets shared (right now, only the Spotify link itself is shared/QR-coded — the note text and voice memo are for the *sender's* creative process, not yet transmitted to the recipient).
- **Web Share API support** varies by browser — it works great on most mobile browsers (Safari iOS, Chrome Android) but isn't available on most desktop browsers, where the app automatically falls back to a copy-link button instead.

---

## 🗺️ Roadmap (Phase 2 ideas)

- Real YouTube Music playlist import as a second source
- Backend persistence (Supabase) so mixtapes can be saved, reopened, and edited later
- Actually bundling voice memos + notes into what gets sent to the recipient (not just the bare Spotify link)
- Stripe Payment Links for the real "$2 after your first 2 free" unlock
- SoundCloud-style timestamped comments per track
- PWA packaging ("Add to Home Screen") so it feels like a real app on the recipient's phone

---

Built with love (and a healthy amount of debugging) for anyone who wants to send a playlist and have it actually feel like something. 💌
