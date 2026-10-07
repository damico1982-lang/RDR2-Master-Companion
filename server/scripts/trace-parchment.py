#!/usr/bin/env python3
"""Draw the field map in the RDOMap frame.

Zoom-4 game tiles are a tracing reference only. The parchment JPEG is a text-free
land wash. Water, coast, roads, rail, rivers, and borders are vectors in
map-lines.json. No tile pixels are copied into the output.
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


def line_masks(image, water, text):
    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    hat = cv2.morphologyEx(gray, cv2.MORPH_BLACKHAT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)))
    raw = ((hat > 32) & ~water & ~text).astype(np.uint8)
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


def paint_land(gray, text):
    """Smooth land wash only. Water and strokes are vectors, so max zoom stays crisp."""
    cleaned = gray
    if text is not None and np.any(text):
        cleaned = cv2.inpaint(gray, text.astype(np.uint8), 4, cv2.INPAINT_TELEA)
    tone = cv2.GaussianBlur(cleaned, (0, 0), 16).astype(np.int16)
    delta = np.clip((tone - 158) // 11, -10, 5)
    shaded = np.clip(np.array(PAPER, np.int16) + delta[:, :, None], 0, 255).astype(np.uint8)
    return np.ascontiguousarray(shaded)


def _glyph_boxes(mask, min_height, max_height, max_width, min_fill):
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    glyphs = []
    for index in range(1, count):
        x, y, width, height, area = [int(value) for value in stats[index]]
        if height < min_height or height > max_height or width < 2 or width > max_width:
            continue
        if area < 8 or area > 700:
            continue
        fill = area / float(width * height)
        if fill < min_fill or width > height * 2.4:
            continue
        glyphs.append((x, y, width, height, index))
    return labels, glyphs


def _cluster_words(glyphs, max_gap, max_baseline, min_count, max_count):
    glyphs = sorted(glyphs, key=lambda glyph: (glyph[1] + glyph[3] / 2.0, glyph[0]))
    used = [False] * len(glyphs)
    groups = []
    for index, glyph in enumerate(glyphs):
        if used[index]:
            continue
        group = [index]
        used[index] = True
        changed = True
        while changed:
            changed = False
            for other_index, other in enumerate(glyphs):
                if used[other_index]:
                    continue
                for member in group:
                    current = glyphs[member]
                    baseline = abs((current[1] + current[3] / 2.0) - (other[1] + other[3] / 2.0))
                    if baseline > max_baseline:
                        continue
                    if abs(current[3] - other[3]) > max(3, 0.65 * max(current[3], other[3])):
                        continue
                    if current[0] + current[2] < other[0]:
                        gap = other[0] - (current[0] + current[2])
                    elif other[0] + other[2] < current[0]:
                        gap = current[0] - (other[0] + other[2])
                    else:
                        gap = 0
                    if gap <= max_gap:
                        used[other_index] = True
                        group.append(other_index)
                        changed = True
                        break
        if min_count <= len(group) <= max_count:
            groups.append(group)
    return glyphs, groups


def find_text_mask(gray):
    """Letter rows traced from the reference map. These are not our overlay labels."""
    hat = cv2.morphologyEx(gray, cv2.MORPH_BLACKHAT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
    raw = (hat > 20).astype(np.uint8)
    labels, glyphs = _glyph_boxes(raw, 4, 16, 18, 0.45)
    ordered, groups = _cluster_words(glyphs, max_gap=9, max_baseline=3.5, min_count=4, max_count=14)
    mask = np.zeros(gray.shape, np.uint8)
    words = 0
    for group in groups:
        xs = [ordered[index][0] for index in group]
        ys = [ordered[index][1] for index in group]
        xe = [ordered[index][0] + ordered[index][2] for index in group]
        ye = [ordered[index][1] + ordered[index][3] for index in group]
        width = max(xe) - min(xs)
        height = max(ye) - min(ys)
        if width < 22 or height > 18 or width < height * 2.5:
            continue
        for index in group:
            mask[labels == ordered[index][4]] = 255
        words += 1
    # Taller, more widely spaced names (states and counties) that the town pass misses.
    wide = cv2.morphologyEx(gray, cv2.MORPH_BLACKHAT, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15)))
    wide_raw = (wide > 16).astype(np.uint8)
    wide_labels, wide_glyphs = _glyph_boxes(wide_raw, 6, 30, 28, 0.32)
    wide_ordered, wide_groups = _cluster_words(wide_glyphs, max_gap=16, max_baseline=5, min_count=4, max_count=12)
    for group in wide_groups:
        xs = [wide_ordered[index][0] for index in group]
        ys = [wide_ordered[index][1] for index in group]
        xe = [wide_ordered[index][0] + wide_ordered[index][2] for index in group]
        ye = [wide_ordered[index][1] + wide_ordered[index][3] for index in group]
        width = max(xe) - min(xs)
        height = max(ye) - min(ys)
        if width < 36 or width > 200 or height > 34 or width < height * 2.2:
            continue
        for index in group:
            mask[wide_labels == wide_ordered[index][4]] = 255
        words += 1
    labels_json = json.loads(GAZETTEER.read_text())
    for item in labels_json:
        name = item["name"]
        cx = int(item["lng"] * UNIT)
        cy = int(-item["lat"] * UNIT)
        if name in STATES:
            rx, ry = 110, 28
        elif name in WATERS:
            rx, ry = 90, 18
        elif name in MAJOR_TOWNS or name in {"Colter", "Wapiti", "Van Horn Trading Post", "Emerald Ranch", "Lagras"}:
            rx, ry = 78, 18
        else:
            rx, ry = 72, 18
        x0, x1 = max(0, cx - rx), min(WIDTH, cx + rx)
        y0, y1 = max(0, cy - ry), min(HEIGHT, cy + ry)
        window = raw[y0:y1, x0:x1]
        if window.size == 0:
            continue
        count, local_labels, stats, _ = cv2.connectedComponentsWithStats(window, connectivity=8)
        hits = []
        for index in range(1, count):
            x, y, width, height, area = [int(value) for value in stats[index]]
            if height < 4 or height > 24 or width < 2 or width > 22 or area < 8:
                continue
            if area / float(width * height) < 0.35 or width > height * 2.6:
                continue
            hits.append(index)
        if len(hits) < 3:
            continue
        for index in hits:
            mask[y0:y1, x0:x1][local_labels == index] = 255
        words += 1
    mask = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
    print("text words", words, "px", int(mask.sum() // 255))
    return mask > 0


def to_lng_lat(x, y):
    return [round(float(x) / UNIT, 2), round(float(-y) / UNIT, 2)]


def zhang_suen(mask):
    image = np.pad((mask > 0).astype(np.uint8), 1)
    for _ in range(24):
        changed = False
        for step in (0, 1):
            p2 = image[:-2, 1:-1]
            p3 = image[:-2, 2:]
            p4 = image[1:-1, 2:]
            p5 = image[2:, 2:]
            p6 = image[2:, 1:-1]
            p7 = image[2:, :-2]
            p8 = image[1:-1, :-2]
            p9 = image[:-2, :-2]
            center = image[1:-1, 1:-1]
            neighbors = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9
            sequence = (p2, p3, p4, p5, p6, p7, p8, p9, p2)
            transitions = np.zeros(center.shape, np.uint8)
            for index in range(8):
                transitions += ((sequence[index] == 0) & (sequence[index + 1] == 1)).astype(np.uint8)
            remove = (center == 1) & (neighbors >= 2) & (neighbors <= 6) & (transitions == 1)
            if step == 0:
                remove &= (p2 * p4 * p6 == 0) & (p4 * p6 * p8 == 0)
            else:
                remove &= (p2 * p4 * p8 == 0) & (p2 * p6 * p8 == 0)
            if not np.any(remove):
                continue
            changed = True
            image[1:-1, 1:-1][remove] = 0
        if not changed:
            break
    return image[1:-1, 1:-1].astype(bool)


def road_ribbon(mask):
    """The painted hairline, without the thick blobs that are hill stamps."""
    tube = stroke(mask, radius=1).astype(np.uint8)
    core = cv2.erode(tube, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    fat = cv2.dilate(core, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)))
    tube[fat > 0] = 0
    return tube > 0


def trace_paths(mask, epsilon, min_pixels):
    """Follow each stroke through junctions so a road stays one crisp polyline."""
    skeleton = zhang_suen(mask)
    ys, xs = np.where(skeleton)
    if xs.size == 0:
        return []
    points = set(zip(ys.tolist(), xs.tolist()))
    offsets = ((-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1))
    neighbors_of = {point: [] for point in points}
    for y, x in points:
        for dy, dx in offsets:
            other = (y + dy, x + dx)
            if other in points:
                neighbors_of[(y, x)].append(other)

    def edge(a, b):
        return (a, b) if a < b else (b, a)

    unused = set()
    for point, neighbors in neighbors_of.items():
        for other in neighbors:
            unused.add(edge(point, other))

    def turn_cost(previous, current, nxt):
        incoming = (current[1] - previous[1], current[0] - previous[0])
        outgoing = (nxt[1] - current[1], nxt[0] - current[0])
        return -(incoming[0] * outgoing[0] + incoming[1] * outgoing[1])

    def walk(start, nxt):
        path = [start, nxt]
        unused.discard(edge(start, nxt))
        previous, current = start, nxt
        for _ in range(250000):
            choices = [point for point in neighbors_of[current] if edge(current, point) in unused]
            if not choices:
                break
            choices.sort(key=lambda point: turn_cost(previous, current, point))
            following = choices[0]
            # A sharp fork starts a new stroke. A bend in a single road does not.
            if turn_cost(previous, current, following) > 0 and len(neighbors_of[current]) > 2:
                break
            unused.discard(edge(current, following))
            path.append(following)
            previous, current = current, following
        return path

    raw_paths = []
    for point, neighbors in neighbors_of.items():
        if len(neighbors) != 1:
            continue
        for other in neighbors:
            if edge(point, other) in unused:
                raw_paths.append(walk(point, other))
    while unused:
        start, nxt = next(iter(unused))
        raw_paths.append(walk(start, nxt))

    simplified = []
    for path in raw_paths:
        if len(path) < min_pixels:
            continue
        contour = np.array([[[x, y]] for y, x in path], dtype=np.float32)
        approx = cv2.approxPolyDP(contour, epsilon, False).reshape(-1, 2)
        line = []
        for x, y in approx:
            point = to_lng_lat(x, y)
            if not line or line[-1] != point:
                line.append(point)
        if len(line) >= 2:
            simplified.append(line)
    return simplified


def lake_rings(lakes):
    contours, hierarchy = cv2.findContours(lakes.astype(np.uint8) * 255, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_TC89_L1)
    if hierarchy is None:
        return []
    children = {}
    tops = []
    for index, contour in enumerate(contours):
        if cv2.contourArea(contour) < 80:
            continue
        parent = int(hierarchy[0][index][3])
        if parent >= 0:
            children.setdefault(parent, []).append(index)
        else:
            tops.append(index)

    def ring(index):
        approx = cv2.approxPolyDP(contours[index], 0.45, True).reshape(-1, 2)
        points = []
        for x, y in approx:
            point = to_lng_lat(x, y)
            if not points or points[-1] != point:
                points.append(point)
        if len(points) >= 3 and points[0] != points[-1]:
            points.append(points[0])
        return points

    polygons = []
    for index in tops:
        rings = [ring(index)]
        rings.extend(ring(child) for child in children.get(index, []))
        rings = [item for item in rings if len(item) >= 4]
        if rings:
            polygons.append(rings)
    return polygons


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


def drop_letterforms(mask):
    """Short, wide, solid blobs are baked town names, not roads."""
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    kept = np.zeros(mask.shape, dtype=bool)
    for index in range(1, count):
        _x, _y, width, height, area = [int(value) for value in stats[index]]
        fill = area / float(max(width * height, 1))
        if height <= 18 and width >= 16 and width > height * 2.3 and fill > 0.32:
            continue
        kept[labels == index] = True
    return kept


def load_reference():
    """1.7.3 parchment, used only to recover the stroke network the raster already showed."""
    path = Path("/tmp/frontier-parchment-173.jpg")
    if not path.exists():
        import subprocess
        path.write_bytes(subprocess.check_output(
            ["git", "show", "cc055f8:server/public/content/parchment-close.jpg"],
            cwd=ROOT,
        ))
    image = np.array(Image.open(path).convert("RGB"))
    if image.shape[0] != HEIGHT or image.shape[1] != WIDTH:
        raise SystemExit(f"reference parchment is {image.shape}")
    return image


def reference_strokes(reference, text):
    """Centerlines of the 1.7.3 roads, rivers, rail, and dotted borders, without letterforms."""
    image = reference.astype(np.int16)
    blocked = cv2.dilate(text.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))).astype(bool)

    def near(target, tol):
        return np.abs(image - np.array(target, np.int16)).sum(axis=2) <= tol

    water = near(WATER, 26)
    blocked = blocked | cv2.dilate(water.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
    roads = drop_letterforms(near(ROAD, 32) & ~blocked)
    rivers = drop_letterforms(near((108, 128, 132), 34) & ~blocked)
    dark = (
        (image[:, :, 0] < 100) & (image[:, :, 1] < 84) & (image[:, :, 2] < 68) & (image[:, :, 0] > 45) & ~blocked
    )
    count, labels, stats, _ = cv2.connectedComponentsWithStats(dark.astype(np.uint8), connectivity=8)
    dots = np.zeros(dark.shape, np.uint8)
    dashes = np.zeros(dark.shape, np.uint8)
    for index in range(1, count):
        _x, _y, width, height, area = [int(value) for value in stats[index]]
        extent = max(width, height)
        fill = area / float(max(width * height, 1))
        aspect = width / max(height, 1)
        if 10 <= area <= 160 and extent <= 18 and fill > 0.28 and 0.35 <= aspect <= 2.6:
            dots[labels == index] = 255
        elif area >= 8 and extent >= 8:
            dashes[labels == index] = 255
    borders = cv2.morphologyEx(dots, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (19, 19))) > 0
    rail = cv2.morphologyEx(dashes, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))) > 0
    rail &= ~borders
    print(
        "ref roads", int(roads.sum()),
        "rivers", int(rivers.sum()),
        "rail", int(rail.sum()),
        "borders", int(borders.sum()),
    )
    return roads, rivers, rail, borders


def raster_lines(lines, key, thickness=1):
    canvas = np.zeros((HEIGHT, WIDTH), np.uint8)
    polys = []
    for line in lines.get(key) or []:
        if len(line) < 2:
            continue
        polys.append(np.array([[[int(round(lng * UNIT)), int(round(-lat * UNIT))]] for lng, lat in line], np.int32))
    if polys:
        cv2.polylines(canvas, polys, False, 255, thickness, cv2.LINE_AA)
    return canvas > 0


def nearest_ink(mask, x, y):
    ys, xs = np.where(mask)
    if xs.size == 0:
        return None
    distance = (xs.astype(np.int32) - x) ** 2 + (ys.astype(np.int32) - y) ** 2
    index = int(np.argmin(distance))
    return int(xs[index]), int(ys[index]), round(float(np.sqrt(distance[index])) / UNIT, 2)


def window_counts(masks, cx, cy, width, height):
    x0 = max(0, int(cx - width / 2))
    y0 = max(0, int(cy - height / 2))
    x1 = min(WIDTH, x0 + width)
    y1 = min(HEIGHT, y0 + height)
    return {key: int(mask[y0:y1, x0:x1].sum()) for key, mask in masks.items()}


def main():
    image = load_composite()
    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    text = find_text_mask(gray)
    lakes, _rivers = classify_water(image)
    lakes = lakes.astype(bool)
    print("water", round(float(lakes.mean()), 4))
    detail = paint_land(gray, text)
    # The 1.7.3 silhouette. A smooth wash must not shrink the cover-zoom frame.
    bounds = [-139.4, 3.8, -16.4, 172.7]
    print("landBounds", bounds)
    Image.fromarray(detail).resize((880, 720), Image.LANCZOS).save("/tmp/rdr2tiles/art-full.jpg", quality=86)
    roads, rivers, rail, borders = reference_strokes(load_reference(), text)
    lines = {
        "lakes": lake_rings(lakes),
        "rivers": trace_paths(rivers, epsilon=0.5, min_pixels=4),
        "roads": trace_paths(roads, epsilon=0.5, min_pixels=4),
        "rail": trace_paths(rail & ~lakes, epsilon=0.65, min_pixels=6),
        "borders": trace_paths(borders & ~lakes, epsilon=0.8, min_pixels=8),
    }
    masks = {key: raster_lines(lines, key) for key in ("roads", "rivers", "rail", "borders")}
    for label, point in (("valentine", (1084, 536)), ("strawberry", (843, 700))):
        print(label, {key: nearest_ink(mask, point[0], point[1]) for key, mask in masks.items()})
    print("mid valentine", window_counts(masks, 1084, 536, 314, 494))
    print("mid lemoyne", window_counts(masks, 1232, 792, 314, 494))
    print("max road", window_counts(masks, 1094, 522, 28, 42))
    print("max town", window_counts(masks, 1084, 536, 28, 42))
    print("max strawberry", window_counts(masks, 843, 700, 28, 42))
    if window_counts(masks, 1084, 536, 314, 494)["roads"] < 40:
        raise SystemExit("valentine mid view has no roads")
    if window_counts(masks, 1084, 536, 314, 494)["rivers"] < 20:
        raise SystemExit("valentine mid view has no rivers")
    if window_counts(masks, 1084, 536, 314, 494)["borders"] < 8:
        raise SystemExit("valentine mid view has no borders")
    preview = detail.copy()
    for rings in lines["lakes"]:
        outer = np.array([[[int(round(lng * UNIT)), int(round(-lat * UNIT))]] for lng, lat in rings[0]], np.int32)
        cv2.fillPoly(preview, [outer], WATER)
        cv2.polylines(preview, [outer], True, COAST, 2, cv2.LINE_AA)
    preview[raster_lines(lines, "rivers", 2)] = (108, 128, 132)
    preview[raster_lines(lines, "borders", 2)] = BORDER
    preview[raster_lines(lines, "roads", 2)] = ROAD
    preview[raster_lines(lines, "rail", 2)] = RAIL
    Image.fromarray(preview).save("/tmp/rdr2tiles/vectors-preview.jpg", quality=80)
    for key, value in lines.items():
        points = sum(len(part) if key != "lakes" else sum(len(ring) for ring in part) for part in value)
        print(key, len(value), "points", points)
    encoded_lines = json.dumps(lines, separators=(",", ":"))
    print("map-lines bytes", len(encoded_lines))
    for level in ("far", "mid", "close"):
        out_name = f"parchment-{level}.jpg"
        encoded = Image.fromarray(detail)
        for folder in OUT_DIRS:
            folder.mkdir(parents=True, exist_ok=True)
            encoded.save(folder / out_name, quality=86, optimize=True)
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
        (folder / "map-lines.json").write_text(encoded_lines)


if __name__ == "__main__":
    main()
