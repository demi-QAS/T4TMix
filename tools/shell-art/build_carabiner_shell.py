"""Carabiner shell built through the shared shape_framework (validates the
framework reproduces the locked v10 carabiner before we reuse it for the
other two shapes)."""
import json
import math
import sys
sys.path.insert(0, '.')
from shape_framework import normalize, build_shell_svg

d = json.load(open('pearlock_contour.json'))
bbox = d['bbox']
x0, y0, w, h = bbox
outer = d['outer']
inner = d['inner']

TARGET_W = 260
PAD = 18
TARGET_H = (TARGET_W - 2 * PAD) * h / w + 2 * PAD

outer_n, scale = normalize(outer, bbox, TARGET_W, TARGET_H, PAD)
inner_n, _ = normalize(inner, bbox, TARGET_W, TARGET_H, PAD)

cx = PAD + 0.6652 * (TARGET_W - 2 * PAD)
cy = PAD + 0.7333 * (TARGET_H - 2 * PAD)
wall_th = 60 * scale

outer_ys = [p[1] for p in outer_n]
top_idx = outer_ys.index(min(outer_ys))
antenna_base = outer_n[top_idx]
ant_bx, ant_by = antenna_base[0] - 6, antenna_base[1] + 4

extra_hardware = f'''
  <g transform="translate({ant_bx:.1f},{ant_by:.1f}) rotate(-18)">
    <rect x="-2.3" y="-58" width="4.6" height="58" rx="2.3" fill="url(#antennaGradC)" stroke="#5f7d88" stroke-width="0.6"/>
    <rect x="-3.1" y="-26" width="6.2" height="7" rx="2" fill="#5f7d88"/>
    <circle cx="0" cy="-58" r="3.4" fill="#eafaff" stroke="#5f7d88" stroke-width="0.8"/>
  </g>
  <defs>
    <linearGradient id="antennaGradC" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#eafaff"/>
      <stop offset="50%" stop-color="#5BCEFA"/>
      <stop offset="100%" stop-color="#7fb3c2"/>
    </linearGradient>
  </defs>
'''

collar = f'''
  <g transform="translate({cx:.1f},{cy:.1f}) rotate(35)" filter="url(#chromeC)">
    <rect x="{-wall_th*0.62:.1f}" y="{-wall_th*1.55:.1f}" width="{wall_th*1.24:.1f}" height="{wall_th*3.1:.1f}" rx="{wall_th*0.6:.1f}"
          fill="url(#collarGradC)" stroke="rgba(43,32,54,0.5)" stroke-width="1"/>
    <rect x="{-wall_th*0.46:.1f}" y="{-wall_th*1.08:.1f}" width="{wall_th*0.92:.1f}" height="{wall_th*2.16:.1f}" rx="{wall_th*0.42:.1f}"
          fill="url(#knurl2C)" opacity="0.92"/>
    <ellipse cx="0" cy="{-wall_th*1.55:.1f}" rx="{wall_th*0.62:.1f}" ry="{wall_th*0.22:.1f}" fill="url(#collarGradC)" stroke="rgba(43,32,54,0.5)" stroke-width="1"/>
    <ellipse cx="0" cy="{wall_th*1.55:.1f}" rx="{wall_th*0.62:.1f}" ry="{wall_th*0.22:.1f}" fill="url(#collarGradC)" stroke="rgba(43,32,54,0.5)" stroke-width="1"/>
    <circle cx="0" cy="{wall_th*1.55:.1f}" r="{wall_th*0.17:.1f}" fill="#eafaff" stroke="rgba(43,32,54,0.5)" stroke-width="0.8"/>
  </g>
'''

svg = build_shell_svg(
    shape_id="C",
    outer_pts_svg=outer_n,
    inner_pts_svg=inner_n,
    target_w=TARGET_W,
    target_h=TARGET_H,
    title_text="a mix for you",
    side_text="SIDE A",
    track_text="1",
    top_margin=46,
    extra_hardware_svg=extra_hardware,
)
# splice the collar in right before closing </svg>
svg = svg.replace("</svg>", collar + "</svg>")

with open("full_recorder_carabiner.svg", "w") as f:
    f.write(svg)
print("wrote full_recorder_carabiner.svg")
