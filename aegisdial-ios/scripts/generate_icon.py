#!/usr/bin/env python3
"""
Generate the AegisDial iOS app icon set programmatically.

Produces a 1024×1024 master PNG + every iOS size the asset catalog
needs + a Contents.json.

Design:
  - Deep-navy radial background
  - Clean shield silhouette in accent blue with soft outer glow
  - White checkmark centered in the shield
  - Full bleed (no inner rounded-corner — iOS applies the squircle mask)

This is an MVP placeholder. Swap with a designer-made icon before launch.
"""
from __future__ import annotations
import json
import math
import os
from PIL import Image, ImageDraw, ImageFilter

BG_INNER = (36, 48, 82)
BG_MID   = (14, 18, 32)
BG_OUTER = (6, 7, 12)
ACCENT   = (107, 168, 255)
ACCENT_DEEP = (52, 110, 210)
WHITE    = (255, 255, 255)

MASTER_SIZE = 1024


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def radial_gradient(size):
    img = Image.new("RGB", (size, size), BG_OUTER)
    px = img.load()
    cx, cy = size * 0.32, size * 0.22
    max_r = math.hypot(size, size) * 0.9
    for y in range(size):
        for x in range(size):
            r = min(1.0, math.hypot(x - cx, y - cy) / max_r)
            if r < 0.40:
                col = lerp(BG_INNER, BG_MID, r / 0.40)
            else:
                col = lerp(BG_MID, BG_OUTER, (r - 0.40) / 0.60)
            px[x, y] = col
    return img


def shield_points(size, inset=0.22):
    """Heater-shield polygon, vertically symmetric."""
    cx = size / 2
    w = size * (1.0 - inset * 2) * 0.82
    h = size * (1.0 - inset * 2) * 1.00
    top = size * inset
    bot = top + h
    left = cx - w / 2
    right = cx + w / 2
    pts = [(left, top)]
    # Top edge — flat
    pts.append((right, top))
    # Right curve inward to bottom point
    steps = 64
    for i in range(1, steps + 1):
        t = i / steps
        # cubic-ish curve: quadratic bezier (right, top) → ctrl → (cx, bot)
        ctrl_x = right + w * 0.02
        ctrl_y = top + h * 0.55
        x = (1 - t) ** 2 * right + 2 * (1 - t) * t * ctrl_x + t ** 2 * cx
        y = (1 - t) ** 2 * top + 2 * (1 - t) * t * ctrl_y + t ** 2 * bot
        pts.append((x, y))
    # Left curve, mirror
    for i in range(1, steps + 1):
        t = i / steps
        ctrl_x = left - w * 0.02
        ctrl_y = top + h * 0.55
        x = (1 - t) ** 2 * cx + 2 * (1 - t) * t * ctrl_x + t ** 2 * left
        y = (1 - t) ** 2 * bot + 2 * (1 - t) * t * ctrl_y + t ** 2 * top
        pts.append((x, y))
    return pts


def vertical_shield_gradient(size, pts, top_color, bot_color):
    """Draw the shield with a vertical gradient fill."""
    # Render shield mask
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).polygon(pts, fill=255)

    # Full-size vertical gradient
    grad = Image.new("RGB", (size, size), bot_color)
    gpx = grad.load()
    for y in range(size):
        t = y / size
        col = lerp(top_color, bot_color, t)
        for x in range(size):
            gpx[x, y] = col

    # Composite: gradient where mask is opaque
    grad.putalpha(mask)
    return grad


def draw_shield(bg, size):
    pts = shield_points(size)

    # 1. Outer glow
    glow_mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(glow_mask).polygon(pts, fill=255)
    glow_mask = glow_mask.filter(ImageFilter.GaussianBlur(radius=size * 0.045))
    glow_layer = Image.new("RGB", (size, size), ACCENT)
    glow_layer.putalpha(glow_mask.point(lambda p: int(p * 0.55)))
    bg.paste(glow_layer, (0, 0), glow_layer)

    # 2. Shield vertical gradient — lighter top, deeper bottom
    shield_img = vertical_shield_gradient(size, pts, ACCENT, ACCENT_DEEP)
    bg.paste(shield_img, (0, 0), shield_img)

    # 3. Subtle inner top highlight
    highlight = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    hd = ImageDraw.Draw(highlight)
    hd.polygon(pts, fill=(255, 255, 255, 0))
    # Top ~30% of shield gets a white-ish sheen
    mask_top = Image.new("L", (size, size), 0)
    mtd = ImageDraw.Draw(mask_top)
    top_pts = []
    for p in pts:
        if p[1] < size * 0.44:
            top_pts.append(p)
    if len(top_pts) >= 3:
        mtd.polygon(top_pts + [(size / 2, size * 0.44)], fill=40)
        mask_top = mask_top.filter(ImageFilter.GaussianBlur(radius=size * 0.01))
        highlight_rgb = Image.new("RGB", (size, size), WHITE)
        highlight_rgb.putalpha(mask_top)
        bg.paste(highlight_rgb, (0, 0), highlight_rgb)

    # 4. Checkmark
    draw_check(bg, size)


def draw_check(bg, size):
    cx, cy = size / 2, size / 2
    scale = size * 0.24
    stroke = int(size * 0.068)
    r = stroke / 2

    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    # Three anchor points for the check (start, elbow, tip)
    p1 = (cx - scale * 0.95, cy + scale * 0.10)
    p2 = (cx - scale * 0.10, cy + scale * 0.80)
    p3 = (cx + scale * 1.05, cy - scale * 0.70)

    d.line([p1, p2], fill=WHITE, width=stroke)
    d.line([p2, p3], fill=WHITE, width=stroke)
    for pt in (p1, p2, p3):
        d.ellipse([pt[0] - r, pt[1] - r, pt[0] + r, pt[1] + r], fill=WHITE)

    # Soft shadow under the check for contrast
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.line([p1, p2], fill=(0, 0, 0, 55), width=stroke)
    sd.line([p2, p3], fill=(0, 0, 0, 55), width=stroke)
    for pt in (p1, p2, p3):
        sd.ellipse([pt[0] - r, pt[1] - r, pt[0] + r, pt[1] + r], fill=(0, 0, 0, 55))
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=size * 0.01))
    # Offset the shadow 1px down
    bg.paste(shadow, (0, int(size * 0.004)), shadow)
    bg.paste(layer, (0, 0), layer)


def build_master():
    bg = radial_gradient(MASTER_SIZE)
    draw_shield(bg, MASTER_SIZE)
    return bg


ICON_SPECS = [
    ("Icon-20@2x.png",   40,  "iphone",  "20x20",    "2x"),
    ("Icon-20@3x.png",   60,  "iphone",  "20x20",    "3x"),
    ("Icon-29@2x.png",   58,  "iphone",  "29x29",    "2x"),
    ("Icon-29@3x.png",   87,  "iphone",  "29x29",    "3x"),
    ("Icon-40@2x.png",   80,  "iphone",  "40x40",    "2x"),
    ("Icon-40@3x.png",  120,  "iphone",  "40x40",    "3x"),
    ("Icon-60@2x.png",  120,  "iphone",  "60x60",    "2x"),
    ("Icon-60@3x.png",  180,  "iphone",  "60x60",    "3x"),
    ("Icon-20.png",     20,   "ipad",    "20x20",    "1x"),
    ("Icon-20@2x~ipad.png", 40, "ipad",  "20x20",    "2x"),
    ("Icon-29.png",     29,   "ipad",    "29x29",    "1x"),
    ("Icon-29@2x~ipad.png", 58, "ipad",  "29x29",    "2x"),
    ("Icon-40.png",     40,   "ipad",    "40x40",    "1x"),
    ("Icon-40@2x~ipad.png", 80, "ipad",  "40x40",    "2x"),
    ("Icon-76.png",     76,   "ipad",    "76x76",    "1x"),
    ("Icon-76@2x.png",  152,  "ipad",    "76x76",    "2x"),
    ("Icon-83.5@2x.png", 167, "ipad",    "83.5x83.5","2x"),
    ("Icon-1024.png",  1024,  "ios-marketing", "1024x1024", "1x"),
]


def main():
    out = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..",
        "Assets.xcassets", "AppIcon.appiconset",
    )
    os.makedirs(out, exist_ok=True)
    master = build_master()
    for name, px, *_ in ICON_SPECS:
        master.resize((px, px), Image.LANCZOS).save(
            os.path.join(out, name), "PNG", optimize=True,
        )
    contents = {
        "images": [
            {"filename": n, "idiom": i, "scale": s, "size": sz}
            for n, _px, i, sz, s in ICON_SPECS
        ],
        "info": {"author": "xcode", "version": 1},
    }
    with open(os.path.join(out, "Contents.json"), "w") as f:
        json.dump(contents, f, indent=2)
    print(f"wrote {len(ICON_SPECS)} icons + Contents.json")


if __name__ == "__main__":
    main()
