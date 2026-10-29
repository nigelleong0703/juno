#!/usr/bin/env python3
"""Generate files/wallpaper.png: a calm light gradient from the VISUAL.md tokens
(background #fafafa/#fcfcfc, accent #1084fe at very low strength). No text, no logo."""
import os
import numpy as np
from PIL import Image

W, H = 1920, 1200
BG = np.array([0xFA, 0xFA, 0xFA], float)
ACCENT = np.array([0x10, 0x84, 0xFE], float)
y, x = np.mgrid[0:H, 0:W].astype(float)
x /= W
y /= H
img = np.tile(BG, (H, W, 1))


def glow(cx, cy, rx, ry, strength):
    d = np.sqrt(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2)
    return (np.clip(1 - d, 0, 1) ** 2 * strength)[..., None]


# Two soft accent washes (top-right, bottom-left) over the near-white base.
for cx, cy, rx, ry, s in ((0.85, 0.05, 0.75, 0.9, 0.16), (0.1, 1.0, 0.8, 0.8, 0.11)):
    a = glow(cx, cy, rx, ry, s)
    img = img * (1 - a) + ACCENT * a
rng = np.random.default_rng(7)
img += rng.uniform(-0.6, 0.6, (H, W, 1))  # dither: no banding
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "files", "wallpaper.png")
Image.fromarray(np.clip(img.round(), 0, 255).astype("uint8")).save(out, optimize=True)
print(out, os.path.getsize(out))
