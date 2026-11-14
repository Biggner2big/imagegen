"""Generates assets/icons/app.ico (and a PNG preview) for Gemini Bulk Image Studio.

Run with:
  python tools/make_icon.py
"""
from PIL import Image, ImageDraw, ImageFilter
import math
import os

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "icons")
SIZE = 1024  # supersampled master, downscaled later


def rounded_rect_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def four_point_star(cx, cy, outer, inner, points=4, rotation=-math.pi / 2):
    vertices = []
    for i in range(points * 2):
        angle = rotation + i * math.pi / points
        radius = outer if i % 2 == 0 else inner
        vertices.append((cx + radius * math.cos(angle), cy + radius * math.sin(angle)))
    return vertices


def build_icon():
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Dark rounded background with a subtle vertical gradient.
    bg = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    bg_draw = ImageDraw.Draw(bg)
    top = (26, 29, 40)
    bottom = (15, 17, 23)
    for y in range(SIZE):
        t = y / (SIZE - 1)
        color = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,)
        bg_draw.line([(0, y), (SIZE, y)], fill=color)
    mask = rounded_rect_mask(SIZE, int(SIZE * 0.22))
    img.paste(bg, (0, 0), mask)

    # Border highlight.
    border = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    border_draw = ImageDraw.Draw(border)
    border_draw.rounded_rectangle(
        [int(SIZE * 0.012), int(SIZE * 0.012), int(SIZE * 0.988), int(SIZE * 0.988)],
        radius=int(SIZE * 0.21),
        outline=(63, 70, 90, 255),
        width=max(1, int(SIZE * 0.012)),
    )
    img = Image.alpha_composite(img, border)

    # Glow behind the spark.
    glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    cx, cy = SIZE * 0.5, SIZE * 0.46
    glow_draw.ellipse(
        [cx - SIZE * 0.30, cy - SIZE * 0.30, cx + SIZE * 0.30, cy + SIZE * 0.30],
        fill=(124, 92, 255, 120),
    )
    glow = glow.filter(ImageFilter.GaussianBlur(SIZE * 0.10))
    img = Image.alpha_composite(img, glow)

    # Purple four-point spark (Gemini style).
    spark = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    spark_draw = ImageDraw.Draw(spark)
    spark_draw.polygon(four_point_star(cx, cy, SIZE * 0.34, SIZE * 0.105), fill=(124, 92, 255, 255))
    spark = spark.filter(ImageFilter.GaussianBlur(SIZE * 0.004))
    img = Image.alpha_composite(img, spark)

    # Inner bright spark.
    inner = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    inner_draw = ImageDraw.Draw(inner)
    inner_draw.polygon(four_point_star(cx, cy, SIZE * 0.20, SIZE * 0.055), fill=(196, 181, 255, 255))
    img = Image.alpha_composite(img, inner)

    # Three "batch" dots under the spark, suggesting a queue.
    dots = ImageDraw.Draw(img)
    dot_y = SIZE * 0.82
    for index, dx in enumerate((-SIZE * 0.13, 0, SIZE * 0.13)):
        r = SIZE * 0.028
        alpha = 255 if index == 0 else 140
        dots.ellipse(
            [cx + dx - r, dot_y - r, cx + dx + r, dot_y + r],
            fill=(54, 201, 143, alpha) if index == 0 else (232, 234, 240, alpha),
        )

    # Circular crop again to keep clean rounded corners.
    final = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    final.paste(img, (0, 0), rounded_rect_mask(SIZE, int(SIZE * 0.22)))
    return final


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    master = build_icon()
    ico_path = os.path.join(OUT_DIR, "app.ico")
    png_path = os.path.join(OUT_DIR, "app.png")
    sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]
    master.save(ico_path, format="ICO", sizes=sizes)
    master.resize((256, 256), Image.LANCZOS).save(png_path, format="PNG")
    print("wrote", ico_path, os.path.getsize(ico_path), "bytes")
    print("wrote", png_path, os.path.getsize(png_path), "bytes")


if __name__ == "__main__":
    main()
