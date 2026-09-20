# T4T Mix v4 — patch notes

**Drop-in replacement for `index.html`, `app.js`, plus a NEW `style_v4_patch.css`.**
Do NOT overwrite the existing `style.css` — the v4 changes ride on top of it via
`style_v4_patch.css`, which is loaded second in `<head>`. Keep the base file exactly as it is.

## Files in this bundle

| File | What to do with it |
|---|---|
| `index.html` | Replace the repo's `index.html` |
| `app.js` | Replace the repo's `app.js` |
| `style_v4_patch.css` | **NEW** file — commit it alongside `style.css`. Do not touch `style.css`. |
| `PATCH_NOTES_v4.md` | Reference only — you don't need to commit it, but it's helpful history |

## Bugs fixed

1. **Duplicate-line-on-edit on Side B tracklist** (screenshots 4 + 5) — Side B now renders each title as a real `<input>` instead of a `contentEditable` span. Cursor jump + browser autocorrect duplication both gone.
2. **Stickers wipe when navigating "back to tape"** — sticker state is now the single source of truth in `state.coverStickers` / `state.shellStickers`, persisted to `localStorage`, and rehydrated every time the screen becomes active. Both surfaces behave the same way now.
3. **Player-page stickers stacking in a line** — placed stickers use absolute positioning inside the shell's sticker layer, not inline flow.
4. **"Full-body skin" covers everything** — renamed to **"wrap the whole player"**, **"photo in the window"**, and a new **"both"** mode. In "both", the wrap sits underneath and the frame sits on top.

## Bugs mostly-fixed (needs your test)

5. **Audio actually plays** — added the YouTube IFrame API lane. Paste a YouTube playlist link on the hero screen, hit Play on the player screen, real audio comes out. The Spotify lane still falls back to fallback tracks (Worker backend from README not yet deployed).

## New features

6. **Ad-cover cassette hiss** — when a YouTube ad plays (detected via `onStateChange` = buffering/transitioning), a tape-hiss overlay animates in over the player and the sender's voice memo can play on top. Legal: we don't touch YouTube's volume or hide the iframe from ads.
7. **Voice-memo positioning** — per-track dropdown: intro (before), outro (after), or over-ad (plays during any pre-roll ad). Default = intro.
8. **Track rename with credit** — the voice modal has a "rename it just for them" field. Sender's rename becomes what the recipient sees; the original title is stored in `state.tracks[i].original` and surfaces as a subtle `ℹ️ originally: EAT YOU UP` line on both Side B and the now-playing card.
9. **Draggable + resizable + double-tap-to-remove stickers** — pointer-based drag on the sticker itself, corner handle to resize, double-tap to remove. Single-tap no longer nukes them.
10. **Engraving slot** above the label — 40 char max, courier-style baked-into-shell font.
11. **Expanded sticker set** — rat, frog, princess, mushroom, worm, silly creature, and a hand-drawn top-surgery-scars SVG.
12. **New photo slot for the window** — when "photo in the window" or "both" is selected, you can upload a separate window photo distinct from the wrap.
13. **State persists across nav** via `localStorage` under key `t4tmix.state.v4`.

## What's still explicitly not done (honest list)

- **Spotify Web Playback SDK lane** — requires the recipient to have Spotify Premium; deferred to v5.
- **Apple MusicKit lane** — same, deferred to v5.
- **Cloudflare Worker** for live playlist track-name resolution is still not deployed. Fallback tracks stand in.
- **Hosted recipient page** — the QR still opens the source playlist URL. The next big build is a Cloudflare Worker + KV store that hosts the whole decorated tape at `t4tmix.app/t/<id>` so recipients see YOUR player, not Spotify's/YouTube's.
- **Sender ↔ recipient profiles / return tape / tape thread** — spec'd in the Sep 20 chat notes, not yet built.

## Deploy checklist

1. Drop the three files into the repo root (replace `index.html` and `app.js`; add `style_v4_patch.css`).
2. Commit + push.
3. On the deployed site, hard-refresh (Cmd+Shift+R) to bust the cached old `app.js`.
4. Test flow: paste a YouTube playlist link → tape screen → Side B → rename one track → drag a sticker → back to tape → confirm stickers stay → close the tape → player screen → hit Play → confirm audio + ad-cover behavior.
