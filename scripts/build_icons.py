"""Generate the small EdgeSync PWA icon set procedurally.

Kept as a script instead of committed PNGs so the icon can be re-generated
on resize without bloating git. Run via `python scripts/build_icons.py`.
"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
SIZES = [
    (192, "icon-192.png"),
    (512, "icon-512.png"),
    (180, "apple-touch-icon.png"),
    (32, "favicon-32.png"),
]

BG = (15, 23, 42)
EDGE = (37, 99, 235)
FG = (255, 255, 255)


def draw(size: int) -> Image.Image:
    img = Image.new("RGB", (size, size), BG)
    d = ImageDraw.Draw(img)
    pad = int(size * 0.12)
    bar_w = max(2, size // 96)
    # outer rounded-edge frame
    d.rounded_rectangle(
        (pad, pad, size - pad, size - pad),
        radius=size // 6,
        outline=EDGE,
        width=bar_w,
    )
    # Simple "E" mark in the center
    cx = size // 2
    cy = size // 2
    span = size // 3
    bar = max(2, size // 28)
    # vertical stem
    d.rectangle((cx - span // 2 - bar, cy - span // 2, cx - span // 2 + bar, cy + span // 2), fill=FG)
    # top arm
    d.rectangle((cx - span // 2, cy - span // 2, cx + span // 2 + bar, cy - span // 2 + bar), fill=FG)
    # middle arm (slightly shorter for the "E" cut)
    d.rectangle((cx - span // 2, cy - bar // 2, cx + span // 2 - size // 12, cy + bar), fill=FG)
    # bottom arm
    d.rectangle((cx - span // 2, cy + span // 2 - bar, cx + span // 2 + bar, cy + span // 2), fill=FG)
    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for size, name in SIZES:
        draw(size).save(OUT / name, optimize=True)
    print(f"wrote {len(SIZES)} icons to {OUT}")


if __name__ == "__main__":
    main()
