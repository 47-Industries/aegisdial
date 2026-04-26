"""Generate a 1024x1024 placeholder app icon for AegisDial.

Replace this with the final designed icon (Fiverr) before App Store submission;
the design here is the same shield mark used in-app via CustomPainter.
"""
from PIL import Image, ImageDraw, ImageFilter
from pathlib import Path
import math

S = 1024
out = Path(__file__).resolve().parent.parent / "assets" / "icon" / "icon.png"
out.parent.mkdir(parents=True, exist_ok=True)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


# Background — deep black with subtle radial gradient
img = Image.new("RGB", (S, S), (0, 0, 0))
px = img.load()
for y in range(S):
    for x in range(S):
        d = math.hypot(x - S / 2, y - S / 2) / (S / 2)
        d = min(1.0, d)
        px[x, y] = lerp((10, 18, 26), (0, 0, 0), d)

# Shield path
TURQUOISE = (0, 229, 209)
BLUE = (45, 124, 255)


def shield_pts(scale=0.78, cy_offset=0.04):
    cx, cy = S / 2, S / 2 + S * cy_offset
    w = S * scale
    h = S * scale * 1.05
    return [
        (cx, cy - h / 2),
        (cx + w / 2, cy - h / 2 + h * 0.18),
        (cx + w / 2, cy + h * 0.05),
        (cx + w / 2 * 0.85, cy + h * 0.30),
        (cx, cy + h / 2),
        (cx - w / 2 * 0.85, cy + h * 0.30),
        (cx - w / 2, cy + h * 0.05),
        (cx - w / 2, cy - h / 2 + h * 0.18),
    ]


# Glow halo (drawn larger + blurred)
glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
glow_d = ImageDraw.Draw(glow)
glow_pts = shield_pts(scale=0.84)
for radius in range(40, 0, -6):
    alpha = max(0, 80 - radius)
    glow_d.polygon(glow_pts, fill=(0, 229, 209, alpha))
glow = glow.filter(ImageFilter.GaussianBlur(radius=22))
img.paste(glow, (0, 0), glow)

# Shield fill — gradient from upper-left to lower-right
shield = Image.new("RGBA", (S, S), (0, 0, 0, 0))
sd = ImageDraw.Draw(shield)
sd.polygon(shield_pts(0.78), fill=(15, 27, 38, 255))
img.paste(shield, (0, 0), shield)

# Outline gradient via stacked thin strokes
outline = Image.new("RGBA", (S, S), (0, 0, 0, 0))
od = ImageDraw.Draw(outline)
od.polygon(shield_pts(0.78), outline=TURQUOISE, width=10)
img.paste(outline, (0, 0), outline)

# Inner shield outline (turquoise dimmer)
inner = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ind = ImageDraw.Draw(inner)
ind.polygon(shield_pts(0.62, cy_offset=0.06), outline=(0, 229, 209, 160), width=4)
img.paste(inner, (0, 0), inner)

# Center dot + ring
draw = ImageDraw.Draw(img)
cx, cy = S / 2, S / 2 + S * 0.10
draw.ellipse([cx - 36, cy - 36, cx + 36, cy + 36], fill=(0, 229, 209))
draw.ellipse([cx - 100, cy - 100, cx + 100, cy + 100], outline=(0, 229, 209), width=6)
draw.ellipse([cx - 160, cy - 160, cx + 160, cy + 160], outline=(0, 229, 209, 120), width=3)

img.save(out, format="PNG", optimize=True)
print(f"wrote {out} ({out.stat().st_size // 1024} KB)")
