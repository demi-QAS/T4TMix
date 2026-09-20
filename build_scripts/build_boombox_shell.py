"""Boombox shell built through the shared shape_framework, same premise as
the locked carabiner: rounded-rect body silhouette (outer), inset window
aperture (inner) that gets the full glass/reel/hatch treatment, plus
speaker_svgs (two speaker cones) and extra_hardware_svg (chrome carry handle)."""
import math
import sys
sys.path.insert(0, '.')
from shape_framework import rounded_rect_points, build_shell_svg

TARGET_W = 300
BODY_H = 210
TOP_MARGIN = 60  # room for the handle arc that sticks up above the body

# --- outer body: rounded rectangle ---
outer_n = rounded_rect_points(x=8, y=8, w=TARGET_W - 16, h=BODY_H - 16, r=30, n_per_corner=10)

# --- inner aperture: centered window, leaving room for speakers L/R ---
win_w, win_h = 148, 118
win_x = (TARGET_W - win_w) / 2
win_y = (BODY_H - win_h) / 2
inner_n = rounded_rect_points(x=win_x, y=win_y, w=win_w, h=win_h, r=12, n_per_corner=8)

# --- speakers (drawn on metal, left/right of window, before aperture fill) ---
spk_r = 34
spk_cy = BODY_H / 2
spk_lx = 48
spk_rx = TARGET_W - 48


def speaker_svg(cx, cy, r, uid):
    holes = []
    n_ring = 3
    for ring in range(n_ring):
        rr = r * (0.32 + ring * 0.24)
        count = 6 + ring * 6
        for i in range(count):
            a = (2 * math.pi / count) * i + ring * 0.3
            hx = cx + rr * math.cos(a)
            hy = cy + rr * math.sin(a)
            holes.append(f'<circle cx="{hx:.1f}" cy="{hy:.1f}" r="2.1" fill="#3a2e48" opacity="0.85"/>')
    holes_svg = "\n      ".join(holes)
    return f'''
  <defs>
    <radialGradient id="spkBody{uid}" cx="42%" cy="38%" r="70%">
      <stop offset="0%" stop-color="#4a3c5c"/>
      <stop offset="55%" stop-color="#2b2036"/>
      <stop offset="100%" stop-color="#150f1c"/>
    </radialGradient>
  </defs>
  <circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r:.1f}" fill="url(#spkBody{uid})" stroke="rgba(255,255,255,0.35)" stroke-width="2.4"/>
  <circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r*0.90:.1f}" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="1"/>
  {holes_svg}
  <circle cx="{cx - r*0.28:.1f}" cy="{cy - r*0.32:.1f}" r="{r*0.22:.1f}" fill="rgba(255,255,255,0.16)"/>
'''


speaker_svgs = speaker_svg(spk_lx, spk_cy, spk_r, "L") + speaker_svg(spk_rx, spk_cy, spk_r, "R")

# --- extra hardware: chrome carry-handle arc over the top ---
hx0, hy0 = 62, 8
hx1, hy1 = TARGET_W / 2, -46
hx2, hy2 = TARGET_W - 62, 8
extra_hardware = f'''
  <defs>
    <linearGradient id="handleGradB" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#7fb3c2"/>
      <stop offset="18%" stop-color="#eafaff"/>
      <stop offset="50%" stop-color="#5BCEFA"/>
      <stop offset="82%" stop-color="#eafaff"/>
      <stop offset="100%" stop-color="#7fb3c2"/>
    </linearGradient>
  </defs>
  <path d="M {hx0},{hy0} Q {hx1},{hy1} {hx2},{hy2}"
        fill="none" stroke="url(#handleGradB)" stroke-width="11" stroke-linecap="round"/>
  <path d="M {hx0},{hy0} Q {hx1},{hy1} {hx2},{hy2}"
        fill="none" stroke="rgba(43,32,54,0.45)" stroke-width="11.8" stroke-linecap="round" opacity="0.4"/>
  <circle cx="{hx0:.1f}" cy="{hy0+4:.1f}" r="6.5" fill="#8fa0a8" stroke="rgba(43,32,54,0.5)" stroke-width="1"/>
  <circle cx="{hx2:.1f}" cy="{hy0+4:.1f}" r="6.5" fill="#8fa0a8" stroke="rgba(43,32,54,0.5)" stroke-width="1"/>
'''

svg = build_shell_svg(
    shape_id="B",
    outer_pts_svg=outer_n,
    inner_pts_svg=inner_n,
    target_w=TARGET_W,
    target_h=BODY_H,
    title_text="a mix for you",
    side_text="SIDE A",
    track_text="1",
    top_margin=TOP_MARGIN,
    extra_hardware_svg=extra_hardware,
    speaker_svgs=speaker_svgs,
    inset_units=6.0,
    reel_r_cap=19,
    title_y_frac=0.15,
    sideband_y_frac=0.34,
    reel_row_frac=0.68,
    door_pad_top_mult=0.0,
    door_pad_bot_mult=0.3,
)

with open("full_recorder_boombox.svg", "w") as f:
    f.write(svg)
print("wrote full_recorder_boombox.svg")
