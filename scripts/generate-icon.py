#!/usr/bin/env python3
"""
Redraws media/icon.png, the tile the Marketplace shows next to the extension.

The mark is the same stepped foundation as media/icon.svg — three solid tiers
narrowing as they rise — but here it sits in white on IronBase's brand gradient
rather than in the activity bar's monochrome. The tile bleeds to every edge and
the mark fills roughly two thirds of it, so it still reads at the ~42px the
Marketplace actually renders it at.

Everything is drawn at 4x and downsampled, which is where the antialiasing
comes from; PIL's rounded_rectangle has none of its own.

    python3 scripts/generate-icon.py
"""

from PIL import Image, ImageDraw

SIZE = 256
SS = 4  # supersample factor
CANVAS = SIZE * SS

# The brand gradient — indigo to violet, the same pair the sign-in hero uses.
# A full-bleed gradient tile reads as a product's app icon next to other
# listings, where a flat dark square reads as a placeholder.
BRAND_TOP = (123, 108, 255)      # --brand-1  #7b6cff
BRAND_BOTTOM = (193, 92, 255)    # --brand-2  #c15cff
MARK = (255, 255, 255)

# The mark in the 24-unit space of media/icon.svg: three solid tiers. Keeping
# the two files in the same coordinate system means the silhouette can be
# changed once and copied across.
#   x, y, w, h, radius
LAYERS = [
    (8.5, 4.0, 7.0, 3.6, 1.3),
    (6.0, 10.0, 12.0, 3.6, 1.3),
    (3.5, 16.0, 17.0, 4.0, 1.5),
]

MARK_MIN = 3.5
MARK_MAX = 20.5
MARK_SPAN = MARK_MAX - MARK_MIN

# How much of the tile the mark covers edge to edge. Kept a touch tighter than a
# monochrome mark would be, because a white mark on a saturated ground already
# carries plenty of presence.
FILL = 0.62


def main() -> None:
    scale = (CANVAS * FILL) / MARK_SPAN
    offset_x = (CANVAS - MARK_SPAN * scale) / 2
    # The mark's own vertical span (4.0 to 20.0) is not symmetric in the 24 box,
    # so it is centred on its own bounds rather than the grid's.
    mark_v_min, mark_v_max = 4.0, 20.0
    offset_y = (CANVAS - (mark_v_max - mark_v_min) * scale) / 2

    def ax(v: float) -> float:
        return offset_x + (v - MARK_MIN) * scale

    def ay(v: float) -> float:
        return offset_y + (v - mark_v_min) * scale

    image = Image.new("RGB", (CANVAS, CANVAS), BRAND_BOTTOM)
    draw = ImageDraw.Draw(image)

    # A diagonal-ish vertical gradient. Top-left indigo, bottom violet, which is
    # the same direction the CSS `linear-gradient(135deg, …)` runs.
    for y in range(CANVAS):
        t = y / (CANVAS - 1)
        draw.line(
            [(0, y), (CANVAS, y)],
            fill=tuple(
                round(top + (bottom - top) * t)
                for top, bottom in zip(BRAND_TOP, BRAND_BOTTOM)
            ),
        )

    for x, y, w, h, radius in LAYERS:
        draw.rounded_rectangle(
            (ax(x), ay(y), ax(x + w), ay(y + h)),
            radius=radius * scale,
            fill=MARK,
        )

    image.resize((SIZE, SIZE), Image.LANCZOS).save("media/icon.png")
    print(f"Wrote media/icon.png at {SIZE}x{SIZE}.")


if __name__ == "__main__":
    main()
