"""
Shared "recorder shell" rendering framework.

This is the LOCKED methodology extracted from the carabiner build
(build_full_recorder_v10.py): given an OUTER silhouette contour and an INNER
aperture contour (both closed point loops in one shared coordinate space),
produce a fully lit, glass-fronted mini cassette-recorder face:
  - metal body (brand-hex anodized gradient + specular chrome lighting)
  - graduated metal->glass seam (3 blurred concentric rings, not a hard edge)
  - black glass label plate inset to the aperture's own shape
  - title / side / track-count text
  - two tape reels sized to the aperture
  - a hand-etched sketch hatch around the reels, auto-rotated + auto-shrunk
    so it always sits fully inside the aperture regardless of shape
  - glass sheen + edge-shadow + antenna/handle-style extra hardware hook

Any new shape just supplies outer_pts / inner_pts (+ optional extra hardware
SVG) and gets the same finished-quality output as the carabiner.
"""
import math
import random
from shapely.geometry import Polygon, LineString, Point


def catmull_rom_to_bezier(points, closed=True):
    n = len(points)
    pts = points[:]

    def get(i):
        return pts[i % n]

    d = f"M {pts[0][0]:.2f},{pts[0][1]:.2f} "
    rng = range(n) if closed else range(n - 1)
    for i in rng:
        p0 = get(i - 1); p1 = get(i); p2 = get(i + 1); p3 = get(i + 2)
        c1x = p1[0] + (p2[0] - p0[0]) / 6.0
        c1y = p1[1] + (p2[1] - p0[1]) / 6.0
        c2x = p2[0] - (p3[0] - p1[0]) / 6.0
        c2y = p2[1] - (p3[1] - p1[1]) / 6.0
        d += f"C {c1x:.2f},{c1y:.2f} {c2x:.2f},{c2y:.2f} {p2[0]:.2f},{p2[1]:.2f} "
    d += "Z"
    return d


def normalize(points, bbox, target_w, target_h, pad):
    x, y, w, h = bbox
    scale = min((target_w - 2 * pad) / w, (target_h - 2 * pad) / h)
    return [((px - x) * scale + pad, (py - y) * scale + pad) for px, py in points], scale


def rounded_gear_hub(cx, cy, r_base, amplitude, lobes=6, n_samples=72):
    pts = []
    for i in range(n_samples):
        theta = (2 * math.pi / n_samples) * i
        r = r_base + amplitude * math.cos(lobes * theta)
        x = cx + r * math.cos(theta - math.pi / 2)
        y = cy + r * math.sin(theta - math.pi / 2)
        pts.append((x, y))
    return catmull_rom_to_bezier(pts, closed=True)


def rounded_rect_points(x, y, w, h, r, n_per_corner=8):
    """Closed clockwise point loop for a rounded rectangle."""
    pts = []
    corners = [
        (x + w - r, y + r, -90, 0),      # top-right
        (x + w - r, y + h - r, 0, 90),   # bottom-right
        (x + r, y + h - r, 90, 180),     # bottom-left
        (x + r, y + r, 180, 270),        # top-left
    ]
    edges = [
        ((x + r, y), (x + w - r, y)),
        ((x + w, y + r), (x + w, y + h - r)),
        ((x + w - r, y + h), (x + r, y + h)),
        ((x, y + h - r), (x, y + r)),
    ]
    seq = [edges[0], corners[0], edges[1], corners[1], edges[2], corners[2], edges[3], corners[3]]
    for item in seq:
        if len(item) == 2:
            p0, p1 = item
            for t in [i / n_per_corner for i in range(n_per_corner)]:
                pts.append((p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t))
        else:
            ccx, ccy, a0, a1 = item
            for t in [i / n_per_corner for i in range(n_per_corner)]:
                ang = math.radians(a0 + (a1 - a0) * t)
                pts.append((ccx + r * math.cos(ang), ccy + r * math.sin(ang)))
    return pts


def heart_points(cx, cy, scale_, n=140, flip_y=True):
    """Classic parametric heart curve, cusp at bottom (screen space, y-down)."""
    pts = []
    for i in range(n):
        t = (2 * math.pi / n) * i
        x = 16 * math.sin(t) ** 3
        y = 13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t)
        if flip_y:
            y = -y
        pts.append((cx + x * scale_, cy + y * scale_))
    return pts


def sketchy_hatch_door(x0, y0, w, h, r, seed=1, wobble=1.3, n=90):
    rnd = random.Random(seed)
    pts = []
    perim_segs = [
        (x0 + r, y0), (x0 + w - r, y0),
    ]
    corners = [
        (x0 + w - r, y0 + r, -90, 0),
        (x0 + w - r, y0 + h - r, 0, 90),
        (x0 + r, y0 + h - r, 90, 180),
        (x0 + r, y0 + r, 180, 270),
    ]
    edges = [
        ((x0 + r, y0), (x0 + w - r, y0)),
        ((x0 + w, y0 + r), (x0 + w, y0 + h - r)),
        ((x0 + w - r, y0 + h), (x0 + r, y0 + h)),
        ((x0, y0 + h - r), (x0, y0 + r)),
    ]
    seq = [edges[0], corners[0], edges[1], corners[1], edges[2], corners[2], edges[3], corners[3]]
    for item in seq:
        if len(item) == 2:
            p0, p1 = item
            for t in [i / 6 for i in range(6)]:
                pts.append((p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t))
        else:
            ccx, ccy, a0, a1 = item
            for t in [i / 6 for i in range(6)]:
                ang = math.radians(a0 + (a1 - a0) * t)
                pts.append((ccx + r * math.cos(ang), ccy + r * math.sin(ang)))
    jittered = []
    for px, py in pts:
        jx = (rnd.random() - 0.5) * wobble
        jy = (rnd.random() - 0.5) * wobble
        jittered.append((px + jx, py + jy))
    return catmull_rom_to_bezier(jittered, closed=True)


def _polygon_long_axis_angle(poly):
    mrr = poly.minimum_rotated_rectangle
    coords = list(mrr.exterior.coords)

    def _seglen(a, b):
        return math.hypot(b[0] - a[0], b[1] - a[1])

    edges = [(coords[i], coords[i + 1]) for i in range(4)]
    edges.sort(key=lambda e: -_seglen(*e))
    (ax, ay), (bx, by) = edges[0]
    raw_ang = math.degrees(math.atan2(by - ay, bx - ax))
    return ((raw_ang + 90) % 180) - 90


def auto_fit_hatch(label_poly, door_x, door_y, door_w, door_h,
                    angle_range=None, shrink_steps=None, preferred_angle=None):
    """Find the rotation angle (within angle_range, degrees, clockwise+) and
    the LARGEST shrink factor (closest to 1.0) such that every corner of the
    rotated box still lands inside label_poly. Among all angles reaching the
    best shrink, prefer the one closest to preferred_angle (auto-derived from
    the label polygon's own long-axis tilt if not given) so the hatch tracks
    the shape's own contour instead of an arbitrary scan-order winner."""
    if shrink_steps is None:
        shrink_steps = [1.0, 0.97, 0.94, 0.91, 0.88, 0.85, 0.82, 0.8, 0.78, 0.75, 0.72, 0.7]
    if preferred_angle is None:
        preferred_angle = _polygon_long_axis_angle(label_poly)
    if angle_range is None:
        angle_range = range(-90, 91, 1)
    cx = door_x + door_w / 2
    cy = door_y + door_h / 2

    def corners_for(angle_deg, shrink):
        hw, hh = door_w / 2 * shrink, door_h / 2 * shrink
        local = [(-hw, -hh), (hw, -hh), (hw, hh), (-hw, hh)]
        theta = math.radians(angle_deg)
        out = []
        for lx, ly in local:
            rx = lx * math.cos(theta) - ly * math.sin(theta) + cx
            ry = lx * math.sin(theta) + ly * math.cos(theta) + cy
            out.append((rx, ry))
        return out

    def all_inside(angle_deg, shrink):
        for rx, ry in corners_for(angle_deg, shrink):
            if not label_poly.contains(Point(rx, ry)):
                return False
        return True

    # For each angle, find the largest shrink that fits (shrink_steps is
    # descending, so the first hit is that angle's best). Then, among ALL
    # angles tied at the best shrink found anywhere, pick the one closest
    # to preferred_angle -- this is what makes the hatch track the shape's
    # own long axis instead of whatever angle the scan reaches first.
    best_shrink = -1
    candidates = []  # (angle, shrink) achieving best_shrink so far
    for ang in angle_range:
        for shrink in shrink_steps:
            if all_inside(ang, shrink):
                if shrink > best_shrink:
                    best_shrink = shrink
                    candidates = [(float(ang), shrink)]
                elif shrink == best_shrink:
                    candidates.append((float(ang), shrink))
                break  # shrink_steps descending -> first hit is best for this angle
    if not candidates:
        return (0.0, shrink_steps[-1])
    best = min(candidates, key=lambda c: abs(c[0] - preferred_angle))
    return best  # (angle_deg, shrink)


class ApertureGeometry:
    """Computes label plate + graduated bezel rings + reel row + auto-fit
    hatch, all directly in SVG coordinate space (no photo-pixel indirection
    needed for procedurally authored shapes)."""

    def __init__(self, inner_pts_svg, inset_units=7.5):
        self.inner_poly = Polygon(inner_pts_svg)
        self.label_poly = self.inner_poly.buffer(-inset_units, join_style=1, resolution=8)
        self.bezel_outer_poly = self.inner_poly.buffer(-inset_units * 0.22, join_style=1, resolution=8)
        self.bezel_mid_poly = self.inner_poly.buffer(-inset_units * 0.55, join_style=1, resolution=8)
        self.bezel_inner_poly = self.inner_poly.buffer(-inset_units * 0.82, join_style=1, resolution=8)

        self.label_path = catmull_rom_to_bezier(list(self.label_poly.exterior.coords)[:-1], True)
        self.bezel_outer_path = catmull_rom_to_bezier(list(self.bezel_outer_poly.exterior.coords)[:-1], True)
        self.bezel_mid_path = catmull_rom_to_bezier(list(self.bezel_mid_poly.exterior.coords)[:-1], True)
        self.bezel_inner_path = catmull_rom_to_bezier(list(self.bezel_inner_poly.exterior.coords)[:-1], True)

        lb = self.label_poly.bounds
        self.lminx, self.lminy, self.lmaxx, self.lmaxy = lb
        self.label_cx = (self.lminx + self.lmaxx) / 2
        self.label_cy = (self.lminy + self.lmaxy) / 2

    def span_at_y(self, y):
        line = LineString([(self.lminx - 2000, y), (self.lmaxx + 2000, y)])
        inter = self.label_poly.intersection(line)
        if inter.is_empty:
            return None
        if inter.geom_type == 'LineString':
            xs = [p[0] for p in inter.coords]
            return min(xs), max(xs)
        if inter.geom_type == 'MultiLineString':
            xs = [p[0] for g in inter.geoms for p in g.coords]
            return min(xs), max(xs)
        return None


SVG_DEFS_TEMPLATE = '''
    <linearGradient id="metalBase{sid}" x1="12%" y1="4%" x2="88%" y2="96%">
      <stop offset="0%" stop-color="#eafaff"/>
      <stop offset="14%" stop-color="{BLUE}"/>
      <stop offset="52%" stop-color="#8fd6e8"/>
      <stop offset="72%" stop-color="{PINK}"/>
      <stop offset="100%" stop-color="#e08aa0"/>
    </linearGradient>
    <linearGradient id="collarGrad{sid}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#eafaff"/>
      <stop offset="30%" stop-color="{BLUE}"/>
      <stop offset="68%" stop-color="#bfe6ee"/>
      <stop offset="100%" stop-color="{PINK}"/>
    </linearGradient>
    <pattern id="knurl2{sid}" width="4" height="4" patternUnits="userSpaceOnUse">
      <line x1="0" y1="0" x2="0" y2="4" stroke="rgba(43,32,54,0.5)" stroke-width="1.1"/>
    </pattern>
    <linearGradient id="seamRing1{sid}" x1="20%" y1="0%" x2="80%" y2="100%">
      <stop offset="0%" stop-color="#fbfeff"/>
      <stop offset="45%" stop-color="{BLUE}" stop-opacity="0.85"/>
      <stop offset="100%" stop-color="#7fb3c2"/>
    </linearGradient>
    <linearGradient id="seamRing2{sid}" x1="20%" y1="0%" x2="80%" y2="100%">
      <stop offset="0%" stop-color="#9fc2cc"/>
      <stop offset="50%" stop-color="#5f7d88"/>
      <stop offset="100%" stop-color="#37454c"/>
    </linearGradient>
    <linearGradient id="seamRing3{sid}" x1="20%" y1="0%" x2="80%" y2="100%">
      <stop offset="0%" stop-color="#37454c"/>
      <stop offset="60%" stop-color="#1c2226"/>
      <stop offset="100%" stop-color="#050308"/>
    </linearGradient>
    <linearGradient id="glassSheen{sid}" x1="10%" y1="0%" x2="60%" y2="100%">
      <stop offset="0%" stop-color="rgba(255,255,255,0.55)"/>
      <stop offset="18%" stop-color="rgba(255,255,255,0.12)"/>
      <stop offset="34%" stop-color="rgba(255,255,255,0)"/>
      <stop offset="100%" stop-color="rgba(255,255,255,0)"/>
    </linearGradient>
    <radialGradient id="glassEdgeShadow{sid}" cx="50%" cy="50%" r="55%">
      <stop offset="68%" stop-color="rgba(0,0,0,0)"/>
      <stop offset="100%" stop-color="rgba(0,0,0,0.6)"/>
    </radialGradient>
    <linearGradient id="glassStreak{sid}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="rgba(255,255,255,0)"/>
      <stop offset="46%" stop-color="rgba(255,255,255,0)"/>
      <stop offset="50%" stop-color="rgba(255,255,255,0.85)"/>
      <stop offset="54%" stop-color="rgba(255,255,255,0)"/>
      <stop offset="100%" stop-color="rgba(255,255,255,0)"/>
    </linearGradient>
    <radialGradient id="aoSpot{sid}" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="rgba(0,0,0,0.4)"/>
      <stop offset="100%" stop-color="rgba(0,0,0,0)"/>
    </radialGradient>
    <radialGradient id="screwGrad{sid}" cx="35%" cy="30%" r="75%">
      <stop offset="0%" stop-color="#f6f9fb"/>
      <stop offset="45%" stop-color="#c3cbcf"/>
      <stop offset="100%" stop-color="#5b6266"/>
    </radialGradient>
    <linearGradient id="anodizeSheen{sid}" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="rgba(255,255,255,0.30)"/>
      <stop offset="45%" stop-color="rgba(91,206,250,0.04)"/>
      <stop offset="100%" stop-color="rgba(245,169,184,0.20)"/>
    </linearGradient>
    <filter id="chrome{sid}" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="3.2" result="blur"/>
      <feSpecularLighting in="blur" surfaceScale="4.5" specularConstant="1.05" specularExponent="14"
                           lighting-color="#ffffff" result="spec">
        <feDistantLight azimuth="235" elevation="58"/>
      </feSpecularLighting>
      <feComposite in="spec" in2="SourceAlpha" operator="in" result="specClip"/>
      <feSpecularLighting in="blur" surfaceScale="4.5" specularConstant="0.4" specularExponent="9"
                           lighting-color="#f3d7de" result="spec2">
        <feDistantLight azimuth="60" elevation="35"/>
      </feSpecularLighting>
      <feComposite in="spec2" in2="SourceAlpha" operator="in" result="spec2Clip"/>
      <feMerge result="specAll">
        <feMergeNode in="spec2Clip"/>
        <feMergeNode in="specClip"/>
      </feMerge>
      <feComposite in="SourceGraphic" in2="specAll" operator="arithmetic" k1="0" k2="1.15" k3="1" k4="0" result="lit"/>
      <feDropShadow in="lit" dx="0" dy="8" stdDeviation="8" flood-color="#000" flood-opacity="0.45"/>
    </filter>
    <filter id="softShadow{sid}" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="2.2"/>
    </filter>
    <filter id="seamBlur{sid}" x="-25%" y="-25%" width="150%" height="150%">
      <feGaussianBlur stdDeviation="1.4"/>
    </filter>
'''


def build_shell_svg(shape_id, outer_pts_svg, inner_pts_svg, target_w, target_h,
                     title_text, side_text, track_text,
                     reel_row_frac=0.50, title_y_frac=0.14, sideband_y_frac=0.225,
                     inset_units=7.5, top_margin=0, extra_hardware_svg="",
                     speaker_svgs="", ink="#2b2036", paper="#fbf6ea",
                     blue="#5BCEFA", pink="#F5A9B8", white="#FFFFFF",
                     reel_r_cap=21, door_pad_top_mult=0.95, door_pad_bot_mult=0.6):
    outer_path = catmull_rom_to_bezier(outer_pts_svg, True)
    inner_path = catmull_rom_to_bezier(inner_pts_svg, True)

    geo = ApertureGeometry(inner_pts_svg, inset_units=inset_units)

    title_y = geo.lminy + title_y_frac * (geo.lmaxy - geo.lminy)
    sideband_y = geo.lminy + sideband_y_frac * (geo.lmaxy - geo.lminy)
    reel_row_y = geo.lminy + reel_row_frac * (geo.lmaxy - geo.lminy)
    span = geo.span_at_y(reel_row_y)
    row_minx, row_maxx = span
    row_w = row_maxx - row_minx
    label_h = geo.lmaxy - geo.lminy
    reel_r = min(row_w * 0.20, label_h * 0.30, reel_r_cap)
    reel1_cx = row_minx + row_w * 0.29
    reel2_cx = row_maxx - row_w * 0.29

    door_pad_x = reel_r * 0.75
    door_pad_top = reel_r * door_pad_top_mult
    door_pad_bot = reel_r * door_pad_bot_mult
    door_x = reel1_cx - reel_r - door_pad_x
    door_y = reel_row_y - reel_r - door_pad_top
    door_w = (reel2_cx + reel_r + door_pad_x) - door_x
    door_h = (reel_row_y + reel_r + door_pad_bot) - door_y

    door_rotate, door_shrink = auto_fit_hatch(geo.label_poly, door_x, door_y, door_w, door_h)
    door_cx = door_x + door_w / 2
    door_cy = door_y + door_h / 2
    door_hw = (door_w / 2) * door_shrink
    door_hh = (door_h / 2) * door_shrink
    door_x2 = door_cx - door_hw
    door_y2 = door_cy - door_hh
    door_w2 = door_hw * 2
    door_h2 = door_hh * 2
    door_r2 = min(14, door_h2 * 0.22)
    door_path_a = sketchy_hatch_door(door_x2, door_y2, door_w2, door_h2, door_r2, seed=7, wobble=1.3)
    door_path_b = sketchy_hatch_door(door_x2, door_y2, door_w2, door_h2, door_r2, seed=19, wobble=1.6)

    defs = SVG_DEFS_TEMPLATE.format(sid=shape_id, BLUE=blue, PINK=pink)

    full_h = target_h + top_margin
    svg = f'''<svg viewBox="0 {-top_margin:.0f} {target_w:.0f} {full_h:.0f}" xmlns="http://www.w3.org/2000/svg" width="{target_w:.0f}" height="{full_h:.0f}">
  <defs>{defs}
    <clipPath id="apertureClip{shape_id}"><path d="{inner_path}"/></clipPath>
    <clipPath id="labelClip{shape_id}"><path d="{geo.label_path}"/></clipPath>
    <clipPath id="outerClip{shape_id}"><path d="{outer_path}"/></clipPath>
  </defs>

  {extra_hardware_svg}

  <g filter="url(#chrome{shape_id})">
    <path d="{outer_path} {inner_path}" fill="url(#metalBase{shape_id})" fill-rule="evenodd" stroke="rgba(43,32,54,0.5)" stroke-width="1.2"/>
  </g>

  <g clip-path="url(#outerClip{shape_id})">
    <path d="{outer_path} {inner_path}" fill="url(#anodizeSheen{shape_id})" fill-rule="evenodd" opacity="0.5"/>
  </g>

  {speaker_svgs}

  <g clip-path="url(#apertureClip{shape_id})">
    <rect x="0" y="0" width="{target_w}" height="{target_h}" fill="{paper}"/>
  </g>

  <g filter="url(#seamBlur{shape_id})">
    <path d="{inner_path} {geo.bezel_outer_path}" fill-rule="evenodd" fill="url(#seamRing1{shape_id})"/>
    <path d="{geo.bezel_outer_path} {geo.bezel_mid_path}" fill-rule="evenodd" fill="url(#seamRing2{shape_id})"/>
    <path d="{geo.bezel_mid_path} {geo.bezel_inner_path}" fill-rule="evenodd" fill="url(#seamRing3{shape_id})"/>
  </g>
  <path d="{inner_path}" fill="none" stroke="rgba(255,255,255,0.35)" stroke-width="0.8"/>

  <g clip-path="url(#labelClip{shape_id})">
    <path d="{geo.label_path}" fill="#050308"/>

    <rect x="{geo.lminx-4:.1f}" y="{title_y-13:.1f}" width="{geo.lmaxx-geo.lminx+8:.1f}" height="4.5" fill="{blue}"/>
    <rect x="{geo.lminx-4:.1f}" y="{title_y-8:.1f}" width="{geo.lmaxx-geo.lminx+8:.1f}" height="4.5" fill="{pink}"/>
    <rect x="{geo.lminx-4:.1f}" y="{title_y-3:.1f}" width="{geo.lmaxx-geo.lminx+8:.1f}" height="3.5" fill="{white}"/>

    <text class="rec-title-text" x="{geo.label_cx:.1f}" y="{title_y+15:.1f}" font-family="'T4TKalam', cursive" font-size="12"
          text-anchor="middle" fill="{paper}">{title_text}</text>

    <text class="rec-side-text" x="{geo.lminx+6:.1f}" y="{sideband_y+8:.1f}" font-family="'Segoe UI', sans-serif" font-size="7.5" font-weight="700"
          fill="{blue}" letter-spacing="1">{side_text}</text>
    <rect x="{geo.lmaxx-24:.1f}" y="{sideband_y-2:.1f}" width="16" height="14" rx="3" fill="{paper}"/>
    <text class="rec-track-text" x="{geo.lmaxx-16:.1f}" y="{sideband_y+9:.1f}" font-family="sans-serif" font-size="9" font-weight="700"
          text-anchor="middle" fill="{ink}">{track_text}</text>

    <g transform="rotate({door_rotate:.1f} {door_cx:.1f} {door_cy:.1f})">
      <path d="{door_path_a}" fill="none" stroke="rgba(251,246,234,0.5)" stroke-width="0.8" stroke-dasharray="3 2"/>
      <path d="{door_path_b}" fill="none" stroke="rgba(0,0,0,0.35)" stroke-width="0.6" stroke-dasharray="2 3"/>
      <circle cx="{door_x2+4:.1f}" cy="{door_y2+4:.1f}" r="1.1" fill="rgba(251,246,234,0.55)"/>
      <circle cx="{door_x2+door_w2-4:.1f}" cy="{door_y2+4:.1f}" r="1.1" fill="rgba(251,246,234,0.55)"/>
    </g>

    <line x1="{reel1_cx+reel_r*0.95:.1f}" y1="{reel_row_y:.1f}" x2="{reel2_cx-reel_r*0.95:.1f}" y2="{reel_row_y:.1f}"
          stroke="#050308" stroke-width="1.4" stroke-dasharray="1 2.4" opacity="0.6"/>

    <ellipse cx="{reel1_cx:.1f}" cy="{reel_row_y+reel_r*0.55:.1f}" rx="{reel_r*1.15:.1f}" ry="{reel_r*0.4:.1f}" fill="url(#aoSpot{shape_id})" filter="url(#softShadow{shape_id})"/>
    <ellipse cx="{reel2_cx:.1f}" cy="{reel_row_y+reel_r*0.55:.1f}" rx="{reel_r*1.15:.1f}" ry="{reel_r*0.4:.1f}" fill="url(#aoSpot{shape_id})" filter="url(#softShadow{shape_id})"/>

    <circle cx="{reel1_cx:.1f}" cy="{reel_row_y:.1f}" r="{reel_r:.1f}" fill="{paper}" stroke="#050308" stroke-width="4"/>
    <circle cx="{reel1_cx:.1f}" cy="{reel_row_y:.1f}" r="{reel_r*0.9:.1f}" fill="none" stroke="rgba(0,0,0,0.18)" stroke-width="1.4"/>
    <path d="{rounded_gear_hub(reel1_cx, reel_row_y, reel_r*0.42, reel_r*0.16, lobes=6)}" fill="none" stroke="#050308" stroke-width="2.6"/>
    <circle cx="{reel1_cx:.1f}" cy="{reel_row_y:.1f}" r="{reel_r*0.14:.1f}" fill="url(#screwGrad{shape_id})" stroke="#050308" stroke-width="0.6"/>
    <line x1="{reel1_cx-reel_r*0.09:.1f}" y1="{reel_row_y:.1f}" x2="{reel1_cx+reel_r*0.09:.1f}" y2="{reel_row_y:.1f}" stroke="#2b2036" stroke-width="0.6"/>
    <circle cx="{reel1_cx-reel_r*0.32:.1f}" cy="{reel_row_y-reel_r*0.38:.1f}" r="{reel_r*0.22:.1f}" fill="rgba(255,255,255,0.5)"/>

    <circle cx="{reel2_cx:.1f}" cy="{reel_row_y:.1f}" r="{reel_r:.1f}" fill="{paper}" stroke="#050308" stroke-width="4"/>
    <circle cx="{reel2_cx:.1f}" cy="{reel_row_y:.1f}" r="{reel_r*0.9:.1f}" fill="none" stroke="rgba(0,0,0,0.18)" stroke-width="1.4"/>
    <path d="{rounded_gear_hub(reel2_cx, reel_row_y, reel_r*0.42, reel_r*0.16, lobes=6)}" fill="none" stroke="#050308" stroke-width="2.6"/>
    <circle cx="{reel2_cx:.1f}" cy="{reel_row_y:.1f}" r="{reel_r*0.14:.1f}" fill="url(#screwGrad{shape_id})" stroke="#050308" stroke-width="0.6"/>
    <line x1="{reel2_cx-reel_r*0.09:.1f}" y1="{reel_row_y:.1f}" x2="{reel2_cx+reel_r*0.09:.1f}" y2="{reel_row_y:.1f}" stroke="#2b2036" stroke-width="0.6"/>
    <circle cx="{reel2_cx-reel_r*0.32:.1f}" cy="{reel_row_y-reel_r*0.38:.1f}" r="{reel_r*0.22:.1f}" fill="rgba(255,255,255,0.5)"/>

    <path d="{geo.label_path}" fill="url(#glassStreak{shape_id})" opacity="0.5"/>
    <path d="{geo.label_path}" fill="url(#glassSheen{shape_id})"/>
  </g>

  <g clip-path="url(#labelClip{shape_id})">
    <path d="{geo.label_path}" fill="url(#glassEdgeShadow{shape_id})"/>
  </g>
  <path d="{geo.label_path}" fill="none" stroke="rgba(255,255,255,0.28)" stroke-width="0.8"/>

  <circle cx="{geo.lminx+7:.1f}" cy="{geo.lminy+7:.1f}" r="2.6" fill="url(#screwGrad{shape_id})" stroke="rgba(43,32,54,0.6)" stroke-width="0.6"/>
  <line x1="{geo.lminx+5.3:.1f}" y1="{geo.lminy+7:.1f}" x2="{geo.lminx+8.7:.1f}" y2="{geo.lminy+7:.1f}" stroke="#2b2036" stroke-width="0.5"/>
  <circle cx="{geo.lmaxx-7:.1f}" cy="{geo.lmaxy-7:.1f}" r="2.6" fill="url(#screwGrad{shape_id})" stroke="rgba(43,32,54,0.6)" stroke-width="0.6"/>
  <line x1="{geo.lmaxx-8.7:.1f}" y1="{geo.lmaxy-7:.1f}" x2="{geo.lmaxx-5.3:.1f}" y2="{geo.lmaxy-7:.1f}" stroke="#2b2036" stroke-width="0.5"/>
</svg>'''
    return svg
