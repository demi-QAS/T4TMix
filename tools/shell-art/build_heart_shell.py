"""Heart shell built through the shared shape_framework, same premise as the
locked carabiner + boombox: parametric heart silhouette (outer), inset heart
aperture (inner, smaller + nudged up so the label plate sits in the wide
upper-lobe belly rather than pinching into the bottom cusp), plus
speaker_svgs (two small speakers tucked in the upper lobes) and
extra_hardware_svg (a tiny bow charm at the top cleft + stitched-seam etch).

Uses the SAME normalize()-with-PAD pattern as the carabiner/pearlock build so
both outer and inner contours are fit into the canvas from one shared bbox —
this is what was missing before and caused the heart to overflow its frame."""
import math
import sys
sys.path.insert(0, '.')
from shape_framework import heart_points, normalize, build_shell_svg

TARGET_W = 260
PAD = 18
TOP_MARGIN = 40  # room for the bow charm poking above the cleft

# Build both contours in one shared "raw" design space first (arbitrary
# units), THEN normalize them together using the outer contour's bbox -
# exactly like build_carabiner_shell.py does with pearlock_contour.json.
raw_cx, raw_cy = 0, 0
outer_raw = heart_points(raw_cx, raw_cy, 100.0, n=160)
inner_raw = heart_points(raw_cx, raw_cy - 14, 62.0, n=160)  # nudged up, smaller

xs = [p[0] for p in outer_raw]
ys = [p[1] for p in outer_raw]
bbox = (min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys))
_, _, w, h = bbox

TARGET_H = (TARGET_W - 2 * PAD) * h / w + 2 * PAD

outer_n, scale = normalize(outer_raw, bbox, TARGET_W, TARGET_H, PAD)
inner_n, _ = normalize(inner_raw, bbox, TARGET_W, TARGET_H, PAD)

cx = TARGET_W / 2
top_y = min(p[1] for p in outer_n)          # topmost pixel of the two lobes
cleft_y = min(p[1] for p in outer_n if abs(p[0] - cx) < TARGET_W * 0.06)  # notch dip between lobes

# --- speakers tucked into the two upper lobes, above the aperture ---
lobe_pts = sorted(outer_n, key=lambda p: p[1])[:12]
left_lobe = min(lobe_pts, key=lambda p: p[0])
right_lobe = max(lobe_pts, key=lambda p: p[0])
spk_r = max(11.0, (right_lobe[0] - left_lobe[0]) * 0.045)
spk_cy = top_y + (cleft_y - top_y) * 0.55 + 6
spk_lx = cx - (cx - left_lobe[0]) * 0.55
spk_rx = cx + (right_lobe[0] - cx) * 0.55


def speaker_svg(ccx, ccy, r, uid):
    holes = []
    for ring in range(2):
        rr = r * (0.35 + ring * 0.32)
        count = 6 + ring * 6
        for i in range(count):
            a = (2 * math.pi / count) * i + ring * 0.3
            hx = ccx + rr * math.cos(a)
            hy = ccy + rr * math.sin(a)
            holes.append(f'<circle cx="{hx:.1f}" cy="{hy:.1f}" r="1.0" fill="#3a2e48" opacity="0.85"/>')
    holes_svg = "\n      ".join(holes)
    return f'''
  <defs>
    <radialGradient id="spkBody{uid}" cx="42%" cy="38%" r="70%">
      <stop offset="0%" stop-color="#4a3c5c"/>
      <stop offset="55%" stop-color="#2b2036"/>
      <stop offset="100%" stop-color="#150f1c"/>
    </radialGradient>
  </defs>
  <circle cx="{ccx:.1f}" cy="{ccy:.1f}" r="{r:.1f}" fill="url(#spkBody{uid})" stroke="rgba(255,255,255,0.35)" stroke-width="1.4"/>
  {holes_svg}
  <circle cx="{ccx - r*0.28:.1f}" cy="{ccy - r*0.32:.1f}" r="{r*0.22:.1f}" fill="rgba(255,255,255,0.18)"/>
'''


speaker_svgs = speaker_svg(spk_lx, spk_cy, spk_r, "HL") + speaker_svg(spk_rx, spk_cy, spk_r, "HR")

# --- extra hardware: tiny bow charm nestled right in the top cleft, plus a
# hand-stitched dashed seam tracing partway down the outer edge for that
# hand-crafted, non-sticker feel. ---
bow_y = cleft_y - 6
extra_hardware = f'''
  <defs>
    <linearGradient id="bowGradH" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#eafaff"/>
      <stop offset="45%" stop-color="#5BCEFA"/>
      <stop offset="100%" stop-color="#F5A9B8"/>
    </linearGradient>
  </defs>
  <g transform="translate({cx:.1f},{bow_y:.1f})">
    <path d="M -12,-5 C -18,-10 -18,4 -12,3 C -7,1 -3,-2 0,0 C 3,-2 7,1 12,3 C 18,4 18,-10 12,-5 C 6,-8 3,-3 0,-1 C -3,-3 -6,-8 -12,-5 Z"
          fill="url(#bowGradH)" stroke="rgba(43,32,54,0.5)" stroke-width="0.8"/>
    <circle cx="0" cy="-1" r="2.8" fill="#eafaff" stroke="rgba(43,32,54,0.5)" stroke-width="0.7"/>
  </g>
  <path d="M {left_lobe[0]+ (cx-left_lobe[0])*0.35:.1f},{top_y + (max(p[1] for p in outer_n)-top_y)*0.30:.1f} Q {cx:.1f},{max(p[1] for p in outer_n)*0.72:.1f} {cx:.1f},{max(p[1] for p in outer_n)-4:.1f}"
        fill="none" stroke="rgba(251,246,234,0.55)" stroke-width="1.1" stroke-dasharray="3 3"/>
'''

svg = build_shell_svg(
    shape_id="H",
    outer_pts_svg=outer_n,
    inner_pts_svg=inner_n,
    target_w=TARGET_W,
    target_h=TARGET_H,
    title_text="a mix for you",
    side_text="SIDE A",
    track_text="1",
    top_margin=TOP_MARGIN,
    extra_hardware_svg=extra_hardware,
    speaker_svgs=speaker_svgs,
    inset_units=5.5,
    reel_r_cap=15,
    title_y_frac=0.18,
    sideband_y_frac=0.38,
    reel_row_frac=0.62,
)

with open("full_recorder_heart.svg", "w") as f:
    f.write(svg)
print("wrote full_recorder_heart.svg  TARGET_H=%.1f" % TARGET_H)
