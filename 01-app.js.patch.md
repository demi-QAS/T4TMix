# Patch A — Fix rename / note modal not opening

## The bug
Row title was an `<input>` (edits inline). Tapping the row focuses the input; the only path to the rename+note+voice modal is the tiny ✏️ icon at the far right end of the row, which is easy to miss on a phone screen. On a fresh tape every icon is faint, so it reads as "edit title," not "open panel."

## The fix
Replace the inline input with a static title. Make the whole row tap-to-open the voice/note modal (which already has the rename field, note field, memo position, and record button all working). Keeps every interaction in ONE place — one tap opens the whole per-track panel.

## Where
In `app.js`, replace the entire `renderBackTracklist()` function (currently ~lines 196–230) with the version below.

## Code — paste this over the existing function

```javascript
// ---------- BACK TRACKLIST (Side B) ----------
// v5 fix: the whole row taps into the voice/note modal (which owns rename +
// note + memo + record). No inline input — that was eating the tap on mobile.
function renderBackTracklist(){
  const wrap = el("back-tracklist");
  wrap.innerHTML = "";
  state.tracks.forEach((t, i) => {
    const row = document.createElement("div");
    const isNowPlaying = state.isPlaying && i === state.currentTrackIndex;
    row.className = "btk-row" + (isNowPlaying ? " now-playing" : "");
    const hasMemo = !!(t.voiceMemoUrl || t.note);
    const icon = t.voiceMemoUrl ? "🎙️" : (t.note ? "📝" : "＋");
    const renamed = t.display && t.display !== t.original;
    row.innerHTML = `
      <div class="btk-row-main">
        <span class="btk-num">${i+1}.</span>
        <span class="btk-title">${escapeHtml(t.display)}</span>
        <span class="btk-artist"> — ${escapeHtml(t.artist)}</span>
        <span class="btk-memo-dot ${hasMemo ? 'has-memo' : ''}" title="add a note or voice memo">${icon}</span>
      </div>
      ${renamed ? `<div class="btk-original-preview">originally: ${escapeHtml(t.original)}</div>` : ""}
      ${t.note ? `<div class="btk-note-preview">📝 &ldquo;${escapeHtml(t.note)}&rdquo;</div>` : ""}
    `;
    // Whole row → modal (mobile-friendly hit target)
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      openVoiceModal(i);
    });
    wrap.appendChild(row);
    if (isNowPlaying){ row.scrollIntoView({ block:"nearest", behavior:"smooth" }); }
  });
}
```

## Also — tiny CSS bump so the row FEELS tappable

In `style.css`, find the `.back-tracklist .btk-row` rule (~line 179) and add these two properties:

```css
.back-tracklist .btk-row {
  padding: 8px 6px;               /* was 3px 0 — bigger touch target */
  border-radius: 8px;
  transition: background .2s ease;
  cursor: pointer;                /* NEW — signals tappable */
  min-height: 40px;               /* NEW — iOS accessibility min */
}
.back-tracklist .btk-row:active {
  background: rgba(255,182,193,0.25);  /* NEW — tap feedback */
}
```

## After deploy — smoke test

1. Load a playlist.
2. Flip to Side B.
3. Tap ANYWHERE on a track row — modal should open.
4. Rename the track, hit "save to this track" — the row should re-render with the new title + an "originally: ..." line underneath.
5. Add a note or record a voice memo — icon should switch to 📝 or 🎙️ and glow (has-memo class).
