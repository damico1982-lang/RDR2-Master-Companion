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
WATER = (132, 148, 150)
COAST = (58, 78, 84)
ROAD = (112, 84, 58)
RAIL = (72, 56, 42)
BORDER = (74, 56, 40)
INK = (42, 26, 14)
WATER_INK = (32, 62, 70)
COUNTY_INK = (68, 48, 32)

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


def skeletonize(mask):
    image = (mask.astype(np.uint8) * 255)
    skeleton = np.zeros_like(image)
    element = cv2.getStructuringElement(cv2.MORPH_CROSS, (3, 3))
    while cv2.countNonZero(image):
        opened = cv2.morphologyEx(image, cv2.MORPH_OPEN, element)
        skeleton = cv2.bitwise_or(skeleton, cv2.subtract(image, opened))
        image = cv2.erode(image, element)
    return skeleton > 0


def classify_water(image):
    red = image[:, :, 0].astype(np.int16)
    green = image[:, :, 1].astype(np.int16)
    blue = image[:, :, 2].astype(np.int16)
    # Game water is gray-teal: darker than the land and with a smaller red-blue gap.
    raw = (((red - blue) < 42) & (red < 175) & (green < 170)).astype(np.uint8) * 255
    raw = cv2.morphologyEx(raw, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(raw, connectivity=8)
    clean = np.zeros_like(raw)
    for index in range(1, count):
        if int(stats[index, cv2.CC_STAT_AREA]) >= 80:
            clean[labels == index] = 255
    # Wide cores survive erosion. Thin channels do not, so they stay rivers.
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11))
    core = cv2.erode(clean, kernel)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(core, connectivity=8)
    cores = np.zeros_like(core)
    for index in range(1, count):
        if int(stats[index, cv2.CC_STAT_AREA]) >= 800:
            cores[labels == index] = 255
    lakes = cv2.dilate(cores, kernel) & clean
    lakes = cv2.morphologyEx(lakes, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    rivers = clean.copy()
    rivers[lakes > 0] = 0
    count, labels, stats, _ = cv2.connectedComponentsWithStats(rivers, connectivity=8)
    thin = np.zeros_like(rivers)
    for index in range(1, count):
        area = int(stats[index, cv2.CC_STAT_AREA])
        extent = max(int(stats[index, cv2.CC_STAT_WIDTH]), int(stats[index, cv2.CC_STAT_HEIGHT]))
        if area < 160 or extent < 48:
            continue
        thin[labels == index] = 255
    # Centerline, then a 2px stroke. One color, no second outline.
    center = skeletonize(thin > 0)
    # About three pixels at full resolution: a hairline on the phone, one stroke.
    rivers = cv2.dilate(center.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    lakes = smooth_mask(lakes)
    rivers = (rivers > 0) & ~lakes
    return lakes, rivers


def line_masks(image, water):
    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    hat = cv2.morphologyEx(gray, cv2.MORPH_BLACKHAT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)))
    raw = ((hat > 32) & ~water).astype(np.uint8)
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
        if area < 36 or extent < 48:
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
        target = rail if float(hat[raw_here].mean()) > 42 and extent > 160 and thickness < 8 else roads
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
    low = np.percentile(sample, 93)
    high = np.percentile(sample, 99.2)
    lines = (mag > low) & (mag < high) & land
    yy, xx = np.mgrid[0:gray.shape[0], 0:gray.shape[1]]
    return lines & (((xx // 4) + (yy // 6)) % 4 == 0)


def dotted(mask, step=18, radius=6):
    dots = np.zeros(mask.shape, np.uint8)
    ys, xs = np.where(mask)
    if len(xs) == 0:
        return dots.astype(bool)
    cells = {}
    for y, x in zip(ys, xs):
        key = (int(y) // step, int(x) // step)
        bucket = cells.setdefault(key, [0, 0, 0])
        bucket[0] += int(y)
        bucket[1] += int(x)
        bucket[2] += 1
    for total_y, total_x, count in cells.values():
        if count < 2:
            continue
        cv2.circle(dots, (total_x // count, total_y // count), radius, 255, thickness=-1)
    return dots > 0


def keep_long(mask, min_extent):
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    kept = np.zeros(mask.shape, dtype=bool)
    for index in range(1, count):
        extent = max(int(stats[index, cv2.CC_STAT_WIDTH]), int(stats[index, cv2.CC_STAT_HEIGHT]))
        if extent >= min_extent:
            kept[labels == index] = True
    return kept


def stroke(mask, radius=1):
    if not np.any(mask):
        return mask
    center = skeletonize(mask)
    if radius <= 0:
        return center
    kernel = 2 * radius + 1
    return cv2.dilate(center.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel, kernel))).astype(bool)


def paint_base(gray, lakes, rivers, roads, rail, borders, relief):
    canvas = np.empty((HEIGHT, WIDTH, 3), dtype=np.uint8)
    canvas[:] = PAPER
    land = ~lakes
    tone = cv2.GaussianBlur(gray, (0, 0), 13).astype(np.int16)
    delta = np.clip((tone - 158) // 11, -10, 5)
    shaded = np.clip(np.array(PAPER, np.int16) + delta[:, :, None], 0, 255).astype(np.uint8)
    canvas[land] = shaded[land]
    if relief is not None and relief.any():
        shade = np.array([186, 164, 132], dtype=np.uint8)
        canvas[relief & land] = (canvas[relief & land].astype(np.int16) * 4 + shade.astype(np.int16)) // 5
    canvas[lakes] = WATER
    # One thin coast. A second dilated ring is what read as a double outline.
    coast = cv2.dilate(lakes.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))).astype(bool) & ~lakes
    canvas[coast] = COAST
    canvas[rivers & ~lakes] = (108, 128, 132)
    road_ink = stroke(roads & ~lakes, radius=1)
    canvas[road_ink] = ROAD
    yy, xx = np.indices(rail.shape)
    rail_ink = stroke(rail & ~lakes, radius=1)
    dashes = rail_ink & ((((xx + yy) // 6) % 2) == 0)
    canvas[dashes] = RAIL
    canvas[dotted(borders, step=16, radius=4) & ~lakes] = BORDER
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
    sizes = {
        "far": (112, 14, 64, 52, 58),
        "mid": (52, 6, 32, 28, 30),
        "close": (40, 4, 24, 22, 24),
    }
    state_size, state_spacing, county_size, town_size, water_size = sizes[level]
    state_font = ImageFont.truetype(FONT_BOLD, state_size)
    county_font = ImageFont.truetype(FONT_BOLD, county_size)
    town_font = ImageFont.truetype(FONT_BOLD, town_size)
    water_font = ImageFont.truetype(FONT_ITALIC, water_size)
    labels = json.loads(GAZETTEER.read_text())
    for item in labels:
        name = item["name"]
        x = int(item["lng"] * UNIT)
        y = int(-item["lat"] * UNIT)
        if name in STATES:
            width = sum(state_font.getlength(char) + state_spacing for char in name)
            tracked(draw, name, (x - width / 2, y - state_size * 0.7), state_font, INK, state_spacing)
            continue
        if name in WATERS:
            width = sum(water_font.getlength(char) + 2 for char in name)
            tracked(draw, name, (x - width / 2, y), water_font, WATER_INK, 2)
            continue
        if name in MAJOR_TOWNS or name in {"Colter", "Wapiti", "Van Horn Trading Post", "Emerald Ranch", "Lagras"}:
            label = "VAN HORN" if name == "Van Horn Trading Post" else name.upper()
            width = town_font.getlength(label)
            draw.ellipse((x - 3, y - 3, x + 3, y + 3), fill=INK)
            draw.text((x - width / 2, y + 5), label, font=town_font, fill=INK)
            continue
        width = county_font.getlength(name)
        draw.text((x - width / 2, y), name, font=county_font, fill=COUNTY_INK)
    return np.array(image)


def land_bounds(mask):
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    best = 0
    chosen = None
    for index in range(1, count):
        area = int(stats[index, cv2.CC_STAT_AREA])
        if area > best:
            best = area
            chosen = index
    if chosen is None:
        return [-144, 0, 0, 176]
    ys, xs = np.where(labels == chosen)
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
    lakes, rivers = classify_water(image)
    lakes = lakes.astype(bool)
    rivers = rivers.astype(bool)
    # Keep road and rail tracing off the water strokes.
    occupied = lakes | cv2.dilate(rivers.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)
    roads, rail, borders, relief = line_masks(image, occupied)
    print(
        "water", round(float(lakes.mean()), 4),
        "rivers", round(float(rivers.mean()), 4),
        "roads", round(float(roads.mean()), 4),
        "rail", round(float(rail.mean()), 4),
        "borders", round(float(borders.mean()), 4),
        "relief", round(float(relief.mean()), 4),
    )
    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    detail = paint_base(gray, lakes, rivers, roads, rail, borders, relief)
    paper = np.array(PAPER, np.int16)
    delta = np.abs(detail.astype(np.int16) - paper).sum(axis=2)
    bounds = land_bounds(delta > 40)
    print("landBounds", bounds)
    far = detail
    Image.fromarray(far).resize((880, 720), Image.LANCZOS).save("/tmp/rdr2tiles/art-full.jpg", quality=86)
    painted = {"far": far, "mid": detail, "close": detail}
    for level in ("far", "mid", "close"):
        out_name = f"parchment-{level}.jpg"
        encoded = Image.fromarray(painted[level])
        for folder in OUT_DIRS:
            folder.mkdir(parents=True, exist_ok=True)
            encoded.save(folder / out_name, quality=93, optimize=True)
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
