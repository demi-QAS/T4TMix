# T4T Mix — GitHub-ready build (2026-09-20)

This zip is the **full, working front-end** with the real cassette-shell art
wired in — no more flat CSS boxes or emoji placeholders (📻🧗💗).

## What's inside
- `index.html` — the single canonical page (loads `style.css` + `app.js`)
- `app.js` — full app logic, including `shellInnerMarkup()` which now renders
  the real `assets/full_recorder_{shape}.svg` art with the live tape title
  and two spinning reels overlaid in the correct spot on each shell
- `style.css` — all styling, incl. the `.shell-art-*` overlay rules with the
  exact px geometry computed per shape (see comment block above
  `.shell-art-stage`)
- `assets/` — the locked SVG + PNG art for all three shells (boombox,
  carabiner, heart): metal body, anodized sheen, 3-ring glass seam, hand
  hatch-etch, baked "SIDE A" + track chip. The editable title text was
  intentionally removed from the SVGs (it used to double up / ghost behind
  the live title overlay) — the live `.shell-art-overlay-title` div renders
  it now.
- `build_scripts/` — the Python generators (`shape_framework.py` +
  `build_{boombox,carabiner,heart}_shell.py`) that produced the SVG/PNG art,
  plus `pearlock_contour.json`. Keep these if you want to regenerate or tweak
  the shell art later (needs `shapely` + `cairosvg`).
- `Kalam-Bold.ttf` / `Kalam-Regular.ttf` — the handwriting font
- `qrcode_lib2.js` — QR code generation for the send screen
- `cloudflare-worker/worker.js` — the backend worker (Spotify/YouTube
  playlist fetch proxy). Not deployed yet — see below.

## How to drop this into GitHub
1. Create your new branch off `main`.
2. Delete (or `git rm`) the old duplicate front-end files at repo root:
   `index.html`, `app.js`, `style.css` (the old one), and if present
   `index3.html`, `app3.js`, `style3.css`, `style3_body.css` — those were the
   earlier, now-obsolete duplicate builds.
3. Copy every file/folder from this zip into the repo root, preserving the
   folder structure (`assets/`, `build_scripts/`, `cloudflare-worker/`).
4. Commit and push the branch, then open your PR / merge as usual.

## What's verified working (checked in a real headless-browser run)
- All three shells (boombox, carabiner, heart) render the actual SVG art,
  not CSS/emoji placeholders
- Editing the tape title updates the live overlay text on the shell
- Switching pride skins (trans/lesbian/bi/nb/pride) recolors the shell
  gradient via CSS custom properties
- Pressing play spins both reel overlays on the currently selected shell
- Switching between all three shells loads their art with zero console
  errors

## What's still open (flagged honestly, not swept under the rug)
- **Cloudflare deploy**: `cloudflare-worker/worker.js` exists but has not
  been deployed — deploying requires your Cloudflare account credentials
  (`wrangler login` + `wrangler deploy`), which I don't have access to from
  here. You'll need to run that deploy step yourself, or tell me your
  Cloudflare API token/account setup and I can walk you through it.
- **`auto_fit_hatch()` rotation bug**: the hand-etched hatch pattern in
  `shape_framework.py` doesn't yet bias its rotation search to each shape's
  natural long axis, so on some shapes the etch marks can drift close to
  "SIDE A" / speaker frames / the heart's frame cusp. Cosmetic, not
  functional — worth a follow-up pass on `shape_framework.py`.
- **Optional heart antenna**: mentioned as a nice-to-have, not added yet.
- **Per-track audio memo + mixtape persistence** (client/backend): not
  started — this needs the Cloudflare Worker backend deployed first, plus a
  storage layer (KV/D1) for saved memos and mixtapes.
