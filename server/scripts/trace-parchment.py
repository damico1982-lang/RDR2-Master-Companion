#!/usr/bin/env python3
"""Draw the field map in the RDOMap frame.

Zoom-4 game tiles are a tracing reference only. The files under content/ are
our own parchment: filled water, stroked coast, roads, rail, and dotted
borders. No tile pixels are copied into the output.
"""
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path("/workspace")
OUT_DIRS = [
    ROOT / "server/public/content",
    ROOT / "android-native/app/src/main/assets/web/content",
]
GAZETTEER = ROOT / "server/public/content/gazetteer.json"
UNIT = 10  # pixels per map unit; the frame is 176 wide by 144 tall
WIDTH = 176 * UNIT
HEIGHT = 144 * UNIT
PAPER = (214, 190, 156)
WATER = (118, 136, 140)
COAST = (62, 84, 90)
ROAD = (126, 96, 68)
RAIL = (78, 62, 48)
BORDER = (108, 86, 62)
INK = (92, 64, 44)
WATER_INK = (58, 86, 94)

STATES = {"AMBARINO", "NEW HANOVER", "WEST ELIZABETH", "LEMOYNE", "NEW AUSTIN"}
WATERS = {"Flat Iron Lake", "San Luis River", "Lannahechee River"}
MAJOR_TOWNS = {
    "Valentine", "Blackwater", "Saint Denis", "Rhodes", "Strawberry",
    "Armadillo", "Tumbleweed", "Annesburg",
}
FONT = "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf"
FONT_ITALIC = "/usr/share/fonts/truetype/liberation/LiberationSerif-Italic.ttf"


def load_composite():
    root = Path("/tmp/rdr2tiles/4")
    canvas = np.zeros((9 * 256, 11 * 256, 3), dtype=np.uint8)
    for x in range(11):
        for y in range(9):
            tile = np.array(Image.open(root / str(x) / f"{y}.jpg").convert("RGB"))
            canvas[y * 256:(y + 1) * 256, x * 256:(x + 1) * 256] = tile
    return cv2.resize(canvas, (WIDTH, HEIGHT), interpolation=cv2.INTER_AREA)


def smooth_mask(mask):
    contours, hier = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_TC89_L1)
    out = np.zeros(mask.shape, np.uint8)
    if hier is None:
        return mask
    external = []
    holes = []
    for index, contour in enumerate(contours):
        if cv2.contourArea(contour) < 24:
            continue
        approx = cv2.approxPolyDP(contour, 1.4, True)
        if hier[0][index][3] >= 0:
            holes.append(approx)
        else:
            external.append(approx)
    cv2.drawContours(out, external, -1, 255, thickness=-1)
    cv2.drawContours(out, holes, -1, 0, thickness=-1)
    return out > 0


def water_mask(image):
    red = image[:, :, 0].astype(np.int16)
    blue = image[:, :, 2].astype(np.int16)
    raw = ((red - blue) < 46).astype(np.uint8) * 255
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    raw = cv2.morphologyEx(raw, cv2.MORPH_OPEN, kernel)
    raw = cv2.morphologyEx(raw, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(raw, connectivity=8)
    kept = np.zeros_like(raw)
    for index in range(1, count):
        if stats[index, cv2.CC_STAT_AREA] >= 40:
            kept[labels == index] = 255
    return smooth_mask(kept)


def line_masks(image, water):
    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    hat = cv2.morphologyEx(gray, cv2.MORPH_BLACKHAT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)))
    raw = ((hat > 20) & ~water).astype(np.uint8)
    # Drop specks, then bridge tiny gaps along a road without welding a word into a blob.
    count, labels, stats, _ = cv2.connectedComponentsWithStats(raw, connectivity=8)
    speck = raw.copy()
    for index in range(1, count):
        if stats[index, cv2.CC_STAT_AREA] < 4:
            speck[labels == index] = 0
    horizontal = cv2.morphologyEx(speck, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (7, 1)))
    vertical = cv2.morphologyEx(speck, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (1, 7)))
    joined = cv2.bitwise_or(horizontal, vertical)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(joined, connectivity=8)
    roads = np.zeros_like(raw)
    rail = np.zeros_like(raw)
    for index in range(1, count):
        area = int(stats[index, cv2.CC_STAT_AREA])
        width = int(stats[index, cv2.CC_STAT_WIDTH])
        height = int(stats[index, cv2.CC_STAT_HEIGHT])
        extent = max(width, height)
        if area < 24 or extent < 28:
            continue
        component = labels == index
        raw_here = component & (speck > 0)
        if not raw_here.any():
            continue
        fill = area / float(width * height)
        thickness = area / float(extent)
        # Letters and hill stamps are short and thick. Roads run.
        if extent < 90 and (fill > 0.42 or thickness > 9):
            continue
        if thickness > 16 and extent < 220:
            continue
        target = rail if float(hat[raw_here].mean()) > 34 and extent > 80 else roads
        target[raw_here] = 1
    remain = (speck > 0) & (roads == 0) & (rail == 0)
    border_join = cv2.dilate(remain.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(border_join, connectivity=8)
    borders = np.zeros_like(raw)
    for index in range(1, count):
        width = int(stats[index, cv2.CC_STAT_WIDTH])
        height = int(stats[index, cv2.CC_STAT_HEIGHT])
        extent = max(width, height)
        if extent < 90:
            continue
        component = labels == index
        density = float(remain[component].mean()) if component.any() else 1
        if density > 0.22:
            continue
        borders[component & remain] = 1
    relief = terrain(gray, ~water)
    return roads.astype(bool), rail.astype(bool), borders.astype(bool), relief


def terrain(gray, land):
    smooth = cv2.GaussianBlur(gray, (0, 0), 7)
    gx = cv2.Sobel(smooth, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(smooth, cv2.CV_32F, 0, 1, ksize=3)
    mag = cv2.magnitude(gx, gy)
    sample = mag[land]
    if sample.size == 0:
        return np.zeros(gray.shape, dtype=bool)
    low = np.percentile(sample, 90)
    high = np.percentile(sample, 98)
    lines = (mag > low) & (mag < high) & land
    yy, xx = np.mgrid[0:gray.shape[0], 0:gray.shape[1]]
    return lines & ((xx + yy) % 4 == 0)


def dotted(mask, step=6):
    dots = np.zeros_like(mask, dtype=bool)
    ys, xs = np.where(mask)
    if len(xs) == 0:
        return dots
    cells = {}
    for y, x in zip(ys, xs):
        key = (int(y) // step, int(x) // step)
        cells.setdefault(key, []).append((int(y), int(x)))
    for points in cells.values():
        if len(points) < 2:
            continue
        y = int(round(sum(point[0] for point in points) / len(points)))
        x = int(round(sum(point[1] for point in points) / len(points)))
        dots[y, x] = True
    return cv2.dilate(dots.astype(np.uint8), np.ones((2, 2), np.uint8)) > 0


def paint_base(water, roads, rail, borders, relief):
    canvas = np.empty((HEIGHT, WIDTH, 3), dtype=np.uint8)
    canvas[:] = PAPER
    shade = np.array([186, 164, 132], dtype=np.uint8)
    canvas[relief] = (canvas[relief].astype(np.int16) * 3 + shade.astype(np.int16)) // 4
    canvas[water] = WATER
    coast = cv2.dilate(water.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool) & ~water
    canvas[coast] = COAST
    canvas[cv2.dilate(roads.astype(np.uint8), np.ones((2, 2), np.uint8)).astype(bool) & ~water] = ROAD
    rail_line = cv2.dilate(rail.astype(np.uint8), np.ones((2, 2), np.uint8)).astype(bool) & ~water
    canvas[rail_line] = RAIL
    # Cross-ties, so a rail line is not just another road.
    tie = np.zeros(rail.shape, dtype=bool)
    ys, xs = np.where(rail)
    for y, x in zip(ys[::8], xs[::8]):
        tie[max(0, y - 2):y + 3, x] = True
        tie[y, max(0, x - 2):x + 3] = True
    canvas[tie & ~water] = RAIL
    canvas[dotted(borders) & ~water] = BORDER
    return canvas


def tracked(draw, text, xy, font, fill, spacing):
    x, y = xy
    for char in text:
        draw.text((x, y), char, font=font, fill=fill)
        x += font.getlength(char) + spacing
    return x


def draw_labels(canvas, level):
    image = Image.fromarray(canvas)
    draw = ImageDraw.Draw(image)
    state_size = 46 if level == "far" else 40
    state_font = ImageFont.truetype(FONT_BOLD, state_size)
    county_font = ImageFont.truetype(FONT, 18 if level == "close" else 16)
    town_font = ImageFont.truetype(FONT_BOLD, 15 if level == "far" else 18)
    water_font = ImageFont.truetype(FONT_ITALIC, 22 if level == "far" else 20)
    labels = json.loads(GAZETTEER.read_text())
    for item in labels:
        name = item["name"]
        x = int(item["lng"] * UNIT)
        y = int(-item["lat"] * UNIT)
        if name in STATES:
            spacing = 5
            width = sum(state_font.getlength(char) + spacing for char in name)
            tracked(draw, name, (x - width / 2, y - state_size * 0.55), state_font, INK, spacing)
            continue
        if name in WATERS:
            width = water_font.getlength(name)
            tracked(draw, name, (x - width / 2, y), water_font, WATER_INK, 1.5)
            continue
        if name in MAJOR_TOWNS or name in {"Colter", "Wapiti", "Van Horn Trading Post", "Emerald Ranch", "Lagras"}:
            if level == "far" and name not in MAJOR_TOWNS:
                continue
            label = "VAN HORN" if name == "Van Horn Trading Post" else name.upper()
            width = town_font.getlength(label)
            draw.ellipse((x - 2, y - 2, x + 2, y + 2), fill=INK)
            draw.text((x - width / 2, y + 4), label, font=town_font, fill=INK)
            continue
        if level == "far":
            continue
        width = county_font.getlength(name)
        draw.text((x - width / 2, y), name, font=county_font, fill=(118, 92, 64))
    return np.array(image)


def land_bounds(water, roads, rail):
    content = water | roads | rail
    near = cv2.dilate(content.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11)))
    ys, xs = np.where(near > 0)
    if len(xs) == 0:
        return [-144, 0, 0, 176]
    pad = 8
    x0 = max(0, int(xs.min()) - pad)
    x1 = min(WIDTH - 1, int(xs.max()) + pad)
    y0 = max(0, int(ys.min()) - pad)
    y1 = min(HEIGHT - 1, int(ys.max()) + pad)
    south = -y1 / UNIT
    north = -y0 / UNIT
    west = x0 / UNIT
    east = x1 / UNIT
    return [round(south, 3), round(west, 3), round(north, 3), round(east, 3)]


def main():
    image = load_composite()
    water = water_mask(image)
    roads, rail, borders, relief = line_masks(image, water)
    print(
        "water", round(float(water.mean()), 4),
        "roads", round(float(roads.mean()), 4),
        "rail", round(float(rail.mean()), 4),
        "borders", round(float(borders.mean()), 4),
        "relief", round(float(relief.mean()), 4),
    )
    bounds = land_bounds(water, roads, rail)
    print("landBounds", bounds)
    base = paint_base(water, roads, rail, borders, relief)
    Image.fromarray(base).resize((880, 720), Image.LANCZOS).save("/tmp/rdr2tiles/art-full.jpg", quality=86)
    Image.fromarray(base[500:680, 1000:1320]).save("/tmp/rdr2tiles/art-val.jpg", quality=90)
    for level in ("far", "mid", "close"):
        painted = draw_labels(base, level)
        out_name = f"parchment-{level}.jpg"
        encoded = Image.fromarray(painted)
        for folder in OUT_DIRS:
            folder.mkdir(parents=True, exist_ok=True)
            encoded.save(folder / out_name, quality=84, optimize=True)
            old = folder / f"parchment-{level}.png"
            if old.exists():
                old.unlink()
        print(out_name, (OUT_DIRS[0] / out_name).stat().st_size)
    payload = json.dumps({
        "south": bounds[0], "west": bounds[1], "north": bounds[2], "east": bounds[3]
    }, indent=2) + "\n"
    (ROOT / "server/lib/land-bounds.json").write_text(payload)
    for folder in OUT_DIRS:
        (folder / "land-bounds.json").write_text(payload)


if __name__ == "__main__":
    main()
