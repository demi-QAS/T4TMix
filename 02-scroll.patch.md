# Patch B — Fix Side-B tracklist scrolling

## The bug
On mobile Safari, you can't scroll past the visible tracks in the Side B list. The tracklist container (`.back-label`) has `overflow-y:auto` with a fixed 210px height. This lives INSIDE `.cassette-back`, which has `transform: rotateY(180deg)`. Safari's touch-scroll handler drops the gesture when the scrolling container sits inside a 3D-transformed parent — a well-known iOS bug.

## The fix
Move the scrollable container OUT of the 3D transform. We keep the flip animation on the OUTER shell but scroll the INNER tracklist independently by giving it its own transform-safe context. Two changes: one in `style.css`, one in the flip logic.

## CSS change

In `style.css`, replace the `.back-label` and `.back-tracklist` rules (~lines 177–178) with:

```css
/* v5 scroll fix: give the back-label its own compositor layer + explicit touch
   handling so iOS Safari doesn't drop the gesture inside the rotateY parent. */
.back-label {
  position: relative;
  background: var(--label-paper, #fbf6ea);
  border: 1px solid rgba(0,0,0,0.08);
  border-radius: 6px;
  height: 210px;
  margin-top: 2px;
  padding: 22px 12px 10px;
  box-shadow: inset 0 1px 3px rgba(0,0,0,0.08);
  overflow-y: auto;
  overflow-x: hidden;
  -webkit-overflow-scrolling: touch;
  overscroll-behavior: contain;
  /* NEW — force independent compositor layer so touch-scroll survives the 3D parent */
  transform: translateZ(0);
  will-change: scroll-position;
  /* NEW — belt + suspenders: explicit touch-action */
  touch-action: pan-y;
  -webkit-user-select: none;
  user-select: none;
}

.back-tracklist {
  font-family: 'T4TKalam', cursive;
  font-size: 14.5px;
  line-height: 1.6;
  color: #2b2036;
  /* NEW — give the list room to scroll if it exceeds the label height */
  min-height: 100%;
  padding-bottom: 8px;
}
```

## Optional JS belt-and-suspenders

If the CSS alone doesn't fully unstick it on older iPhones, add this to `app.js` right after `renderBackTracklist()`:

```javascript
// v5 scroll unlock — some iOS Safari versions need an explicit touchstart to
// arm the scroll surface inside a 3D-transformed parent
(function armBackScroll(){
  const wrap = el("back-label") || document.querySelector(".back-label");
  if (!wrap || wrap.__armed) return;
  wrap.__armed = true;
  wrap.addEventListener("touchstart", () => {}, { passive: true });
})();
```

Call `armBackScroll()` once inside your existing DOMContentLoaded/init handler (wherever `renderBackTracklist()` first runs is fine — put it right after).

## After deploy — smoke test

1. Load a playlist with 12+ tracks.
2. Flip to Side B.
3. Swipe up on the tracklist — should scroll smoothly with momentum.
4. Tap a row while scrolling ends — should still open the modal (Patch A).
5. Rotate the phone or resize the window — should still scroll.
