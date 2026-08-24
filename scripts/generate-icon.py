#!/usr/bin/env python3
"""
Redraws media/icon.png, the tile the Marketplace shows next to the extension.

The mark is the same stepped foundation as media/icon.svg — three solid tiers
narrowing as they rise — but here it sits in white on IronBase's brand gradient
rather than in the activity bar's monochrome.

Three things about it are deliberate, because the first version got all three
wrong and the tile looked like a placeholder next to real listings:

The mark fills four fifths of the tile. At 0.62 it left a band of flat colour
on every edge, and the Marketplace renders this at about 42px in a list — at
that size a small mark inside a large empty square reads as a mistake.

The tiers barely taper. A steep pyramid is mostly empty in its top two corners
whatever size you draw it, and no amount of scaling fixes that; widening the
upper tiers keeps the stepped-foundation silhouette while giving the corners
something to hold.

The ground has depth. A diagonal three-stop ramp with a soft highlight near the
top-left corner, and the mark lifted off it on a shadow. A flat two-colour ramp
behind a flat mark is the difference between an app icon and a coloured square.

Everything is drawn at 4x and downsampled, which is where the antialiasing comes
from; PIL's rounded_rectangle has none of its own.

    python3 scripts/generate-icon.py
"""

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SIZE = 256
SS = 4  # supersample factor
CANVAS = SIZE * SS

# The brand ramp — graphite into a technical sky blue, the same three stops the
# sign-in hero's tile interpolates between. Dark end first: the gradient runs
# top-left to bottom-right, so the light end lands under the widest tier.
STOPS = ["#111c2e", "#0f5e9c", "#31a8f0"]
MARK = (255, 255, 255)

# The mark in the 24-unit space of media/icon.svg: three solid tiers. Keeping
# the two files in the same coordinate system means the silhouette can be
# changed once and copied across — webview/brand.ts draws it a third time.
#   x, y, w, h, radius
LAYERS = [
    (7.0, 4.0, 10.0, 3.9, 1.5),
    (5.0, 10.2, 14.0, 3.9, 1.6),
    (3.5, 16.4, 17.0, 4.2, 1.8),
]

# How much of the tile the mark covers edge to edge. Tuned by eye against
# the rounded corners: much past this the widest tier crowds them, and much
# under it the tile goes back to reading as mostly empty colour.
FILL = 0.78

# How far the mark floats above the ground, and how soft its shadow is, in
# 24-unit-space pixels before supersampling.
SHADOW_DROP = 10
SHADOW_BLUR = 9
SHADOW_ALPHA = 95

# Strength of the light near the top-left corner, 0 for a flat ramp.
HIGHLIGHT = 0.22

# Corner radius as a fraction of the edge. Roughly the proportion a platform
# app icon uses, and the corners are cut to transparency rather than filled with
# a guessed background — the Marketplace shows this tile on white and VS Code
# shows it on near-black, and only one of those could have been guessed right.
CORNER = 0.2235


def _rgb(value: str) -> tuple[int, int, int]:
    value = value.lstrip("#")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))


def ground(grid: int = 160) -> Image.Image:
    """
    The gradient behind the mark.

    Computed small and scaled up rather than per-pixel at full size: a gradient
    is smooth by definition, so the interpolation costs nothing visually and
    saves a million-iteration loop.
    """
    yy, xx = np.mgrid[0:grid, 0:grid].astype(np.float32) / (grid - 1)
    # Top-left to bottom-right, the same direction the CSS `135deg` runs.
    ramp = np.clip((xx * 0.62 + yy * 0.88) / 1.5, 0, 1)

    colours = np.array([_rgb(stop) for stop in STOPS], dtype=np.float32)
    positions = np.linspace(0, 1, len(colours))
    out = np.stack(
        [np.interp(ramp, positions, colours[:, channel]) for channel in range(3)],
        axis=-1,
    )

    radius = np.sqrt((xx - 0.18) ** 2 + (yy - 0.12) ** 2)
    lift = np.clip(1 - radius / 0.95, 0, 1) ** 2.1
    out += (255 - out) * (lift * HIGHLIGHT)[..., None]

    small = Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGB")
    return small.resize((CANVAS, CANVAS), Image.LANCZOS)


def rounded_alpha() -> Image.Image:
    """The tile's own silhouette, so its corners come out transparent."""
    mask = Image.new("L", (CANVAS, CANVAS), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, CANVAS - 1, CANVAS - 1), radius=CORNER * CANVAS, fill=255
    )
    return mask


def main() -> None:
    left = min(x for x, *_ in LAYERS)
    right = max(x + w for x, _, w, *_ in LAYERS)
    top = min(y for _, y, *_ in LAYERS)
    bottom = max(y + h for _, y, _, h, _ in LAYERS)

    scale = (CANVAS * FILL) / (right - left)
    offset_x = (CANVAS - (right - left) * scale) / 2
    # Centred on the mark's own bounds, which are not symmetric in the 24 box.
    offset_y = (CANVAS - (bottom - top) * scale) / 2

    def ax(v: float) -> float:
        return offset_x + (v - left) * scale

    def ay(v: float) -> float:
        return offset_y + (v - top) * scale

    boxes = [
        ((ax(x), ay(y), ax(x + w), ay(y + h)), radius * scale)
        for x, y, w, h, radius in LAYERS
    ]

    image = ground()

    drop = SHADOW_DROP * SS
    mask = Image.new("L", (CANVAS, CANVAS), 0)
    pen = ImageDraw.Draw(mask)
    for (x0, y0, x1, y1), radius in boxes:
        pen.rounded_rectangle((x0, y0 + drop, x1, y1 + drop), radius=radius, fill=SHADOW_ALPHA)
    mask = mask.filter(ImageFilter.GaussianBlur(SHADOW_BLUR * SS))
    image = Image.composite(Image.new("RGB", (CANVAS, CANVAS), (0, 0, 0)), image, mask)

    pen = ImageDraw.Draw(image)
    for box, radius in boxes:
        pen.rounded_rectangle(box, radius=radius, fill=MARK)

    tile = image.convert("RGBA")
    tile.putalpha(rounded_alpha())
    tile.resize((SIZE, SIZE), Image.LANCZOS).save("media/icon.png")
    print(f"Wrote media/icon.png at {SIZE}x{SIZE}.")


if __name__ == "__main__":
    main()
