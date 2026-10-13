#!/usr/bin/env python3
"""Draws the app icons (white "SPHR" on the app's green) into public/icons/.

Run by hand only when the icon design changes; the PNG files are committed.
  python3 scripts/make-icons.py
Needs Pillow and the DejaVu Sans Bold font.
"""
from PIL import Image, ImageDraw, ImageFont

GREEN = (31, 111, 80)  # #1f6f50, the theme colour
WHITE = (255, 255, 255)
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def icon(size: int, text_width_ratio: float) -> Image.Image:
    img = Image.new("RGB", (size, size), GREEN)
    draw = ImageDraw.Draw(img)
    target = size * text_width_ratio
    px = 10
    while ImageFont.truetype(FONT, px + 1).getbbox("SPHR")[2] <= target:
        px += 1
    font = ImageFont.truetype(FONT, px)
    l, t, r, b = draw.textbbox((0, 0), "SPHR", font=font)
    draw.text(((size - (r - l)) / 2 - l, (size - (b - t)) / 2 - t), "SPHR", font=font, fill=WHITE)
    return img


# Normal icons fill the square; the maskable icon keeps the letters inside the central 60%
# "safe zone" so a round or rounded-square crop never cuts them.
for name, size, ratio in [
    ("icon-192.png", 192, 0.78),
    ("icon-512.png", 512, 0.78),
    ("icon-maskable-512.png", 512, 0.56),
    ("apple-touch-icon.png", 180, 0.78),
]:
    icon(size, ratio).save(f"public/icons/{name}", optimize=True)
    print("wrote", name)
