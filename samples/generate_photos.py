#!/usr/bin/env python3
"""
Generate SYNTHETIC overhead "tray photos" for the scan eval, until real photos exist.

    pip install pillow
    python samples/generate_photos.py

Writes samples/photos/synthetic/:
  all_correct.jpg     3 x Product A
  one_missing.jpg     2 x Product A
  swapped.jpg         2 x Product A + 1 x Product B
  label_covered.jpg   3 bags, one label covered by a sticky note

These are drawings, not photos: they test the prompt and pipeline, not real-world
lighting or camera angles. Real tray photos go in samples/photos/ (see expected.json).
"""
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = Path(__file__).parent / "photos" / "synthetic"
W, H = 1600, 1200

KRAFT = (176, 132, 88)
KRAFT_DARK = (140, 100, 62)
LABEL = (250, 247, 240)
INK = (30, 30, 34)
ACCENT_A = (160, 60, 40)   # Product A label stripe
ACCENT_B = (40, 90, 150)   # Product B label stripe


def font(size: int, bold: bool = False):
    names = ["arialbd.ttf", "Arial Bold.ttf", "DejaVuSans-Bold.ttf"] if bold else ["arial.ttf", "Arial.ttf", "DejaVuSans.ttf"]
    for name in names:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default(size)


def background(rng: random.Random) -> Image.Image:
    img = Image.new("RGB", (W, H), (120, 84, 56))
    d = ImageDraw.Draw(img)
    for y in range(0, H, 6):  # wood grain
        shade = rng.randint(-10, 10)
        d.line((0, y, W, y + rng.randint(-3, 3)), fill=(120 + shade, 84 + shade, 56 + shade), width=6)
    # the receiving tray, with a marked outline
    d.rounded_rectangle((110, 90, W - 110, H - 90), radius=30, fill=(205, 208, 212), outline=(150, 154, 160), width=10)
    d.rounded_rectangle((150, 130, W - 150, H - 130), radius=20, outline=(240, 180, 40), width=4)
    d.text((170, 142), "RECEIVING TRAY", font=font(26, True), fill=(120, 124, 130))
    return img


def bag(product: str, covered: bool = False) -> Image.Image:
    """One coffee bag seen from above, as an RGBA sprite."""
    bw, bh = 330, 460
    img = Image.new("RGBA", (bw, bh), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((10, 30, bw - 10, bh - 10), radius=26, fill=KRAFT)
    d.rectangle((10, 30, bw - 10, 70), fill=KRAFT_DARK)  # folded top
    for x in range(30, bw - 20, 22):
        d.line((x, 34, x, 66), fill=(120, 86, 52), width=2)

    accent = ACCENT_A if product == "A" else ACCENT_B
    lx0, ly0, lx1, ly1 = 40, 130, bw - 40, 400
    d.rectangle((lx0, ly0, lx1, ly1), fill=LABEL)
    d.rectangle((lx0, ly0, lx1, ly0 + 26), fill=accent)
    d.text((bw / 2, ly0 + 70), f"PRODUCT {product}", font=font(40, True), fill=INK, anchor="mm")
    d.text((bw / 2, ly0 + 120), "Coffee beans", font=font(26), fill=INK, anchor="mm")
    d.text((bw / 2, ly0 + 158), "500 g", font=font(34, True), fill=INK, anchor="mm")
    d.text((bw / 2, ly0 + 215), "Tostadores del Norte", font=font(18), fill=(90, 90, 96), anchor="mm")

    if covered:
        # A sticky note slapped over the label: nothing on it is readable.
        d.rectangle((lx0 - 12, ly0 - 12, lx1 + 12, ly1 + 12), fill=(250, 214, 70))
        d.line((lx0 + 10, ly1 - 30, lx1 - 30, ly1 - 20), fill=(210, 176, 40), width=3)
    return img


def scene(name: str, bags: list[tuple[str, bool]], seed: int):
    rng = random.Random(seed)
    img = background(rng)
    slots = [(300, 600), (800, 600), (1300, 600)]
    for (product, covered), (cx, cy) in zip(bags, slots):
        sprite = bag(product, covered).rotate(rng.uniform(-8, 8), expand=True, resample=Image.BICUBIC)
        shadow = Image.new("RGBA", sprite.size, (0, 0, 0, 0))
        shadow.paste((0, 0, 0, 90), mask=sprite.split()[3])
        shadow = shadow.filter(ImageFilter.GaussianBlur(10))
        x = int(cx - sprite.width / 2 + rng.randint(-20, 20))
        y = int(cy - sprite.height / 2 + rng.randint(-15, 15))
        img.paste(shadow, (x + 12, y + 14), shadow)
        img.paste(sprite, (x, y), sprite)
    # light camera softness and sensor noise so it isn't pixel-perfect
    img = img.filter(ImageFilter.GaussianBlur(0.8))
    noise = Image.effect_noise((W, H), 12).convert("RGB")
    img = Image.blend(img, noise, 0.04)
    d = ImageDraw.Draw(img)
    d.text((W - 30, H - 40), "SYNTHETIC TEST IMAGE", font=font(22, True), fill=(235, 235, 235), anchor="ra")
    img.save(OUT / f"{name}.jpg", quality=88)
    print(f"wrote samples/photos/synthetic/{name}.jpg")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    scene("all_correct", [("A", False), ("A", False), ("A", False)], seed=1)
    scene("one_missing", [("A", False), ("A", False)], seed=2)
    scene("swapped", [("A", False), ("B", False), ("A", False)], seed=3)
    scene("label_covered", [("A", False), ("A", True), ("A", False)], seed=4)


if __name__ == "__main__":
    main()
