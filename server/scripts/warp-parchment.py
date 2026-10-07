#!/usr/bin/env python3
"""Fit the traced parchment into the Jean Ropke CRS.Simple frame and write three label levels."""
import json
import math
import os
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path("/workspace")
SVG = ROOT / "server/public/frontier-map.svg"
OUT_DIRS = [
    ROOT / "server/public/content",
    ROOT / "android-native/app/src/main/assets/web/content",
]
LIB = ROOT / "server/lib"
TILE = "https://s.rsg.sc/sc/images/games/RDR2/map/game/3/{x}/{y}.jpg"
SRC_W, SRC_H = 1944, 1472
DST_W, DST_H = 1760, 1440  # 10 px per map unit
UNIT = DST_W / 176

TOWNS = [
    ("Colter", 2140, 400, -25.9919, 91.0348),
    ("Wapiti", 2720, 640, -29.7933, 118.8076),
    ("Valentine", 2220, 1000, -53.602, 108.3971),
    ("Emerald Ranch", 2780, 1220, -56.8038, 134.8028),
    ("Strawberry", 1540, 1580, -70.03, 84.3196),
    ("Blackwater", 1680, 1980, -82.9581, 99.7447),
    ("Rhodes", 2860, 1540, -83.6534, 130.6434),
    ("Saint Denis", 3320, 1860, -86.3787, 152.6896),
    ("Annesburg", 3180, 660, -43.4814, 156.745),
    ("Van Horn", 3420, 980, -53.7409, 156.3243),
    ("Lagras", 3020, 1500, -72.6373, 143.8494),
    ("Armadillo", 1160, 2300, -104.3897, 53.4547),
    ("Tumbleweed", 420, 2380, -109.3272, 26.8317),
]

WATER = [
    ("Flat Iron Lake", 2620, 1760),
    ("San Luis River", 980, 2580),
    ("Lannahechee River", 3620, 1520),
]


def strip_group(text, class_name):
    token = f'<g class="{class_name}"'
    start = text.find(token)
    if start < 0:
        return text
    i = start
    depth = 0
    while i < len(text):
        if text.startswith("<g", i):
            depth += 1
            i = text.find(">", i) + 1
            continue
        if text.startswith("</g>", i):
            depth -= 1
            i += 4
            if depth == 0:
                return text[:start] + text[i:]
            continue
        i += 1
    raise RuntimeError(f"unclosed {class_name}")


def render_svg(svg_text, dest):
    raw = Path("/tmp/mapfit/sheet.svg")
    raw.write_text(svg_text)
    os.system(f"rsvg-convert -w {SRC_W} -h {SRC_H} -o {dest} {raw}")


def solve_affine(src, dst):
    # src Nx2, dst Nx2. dst = [src_x, src_y, 1] @ M
    rows = np.concatenate([src, np.ones((len(src), 1))], axis=1)
    mx, *_ = np.linalg.lstsq(rows, dst[:, 0], rcond=None)
    my, *_ = np.linalg.lstsq(rows, dst[:, 1], rcond=None)
    return np.stack([mx, my], axis=1)


def apply_affine(mat, pts):
    rows = np.concatenate([pts, np.ones((len(pts), 1))], axis=1)
    return rows @ mat


def tps_fit(controls, values):
    n = len(controls)
    diff = controls[:, None, :] - controls[None, :, :]
    r = np.sqrt((diff ** 2).sum(axis=2))
    k = r ** 2 * np.log(np.maximum(r, 1e-12))
    np.fill_diagonal(k, 0)
    k += np.eye(n) * 1e-4
    p = np.concatenate([np.ones((n, 1)), controls], axis=1)
    system = np.zeros((n + 3, n + 3))
    system[:n, :n] = k
    system[:n, n:] = p
    system[n:, :n] = p.T
    rhs = np.zeros((n + 3, values.shape[1]))
    rhs[:n] = values
    weights = np.linalg.solve(system, rhs)
    return weights


def tps_apply(weights, controls, query):
    n = len(controls)
    w = weights[:n]
    a = weights[n:]
    out = np.empty((len(query), weights.shape[1]))
    chunk = 80000
    for start in range(0, len(query), chunk):
        q = query[start:start + chunk]
        diff = q[:, None, :] - controls[None, :, :]
        r = np.sqrt((diff ** 2).sum(axis=2))
        u = r ** 2 * np.log(np.maximum(r, 1e-12))
        base = a[0] + q[:, 0:1] * a[1] + q[:, 1:2] * a[2]
        out[start:start + chunk] = base + u @ w
    return out


def svg_px(x, y):
    return np.array([x * SRC_W / 3888, y * SRC_H / 2944])


def download_game():
    dest = Path("/tmp/mapfit/game-z3.jpg")
    if dest.exists() and dest.stat().st_size > 100000:
        return np.array(Image.open(dest).convert("RGB"))
    tiles_x, tiles_y = 6, 5  # 1408x1152 at 8 px/unit, tiles of 256
    cache = Path("/tmp/mapfit/z3")
    cache.mkdir(parents=True, exist_ok=True)

    def fetch(xy):
        x, y = xy
        path = cache / f"{x}_{y}.jpg"
        if not path.exists() or path.stat().st_size < 200:
            url = TILE.format(x=x, y=y)
            urllib.request.urlretrieve(url, path)
        return x, y, Image.open(path).convert("RGB")

    canvas = Image.new("RGB", (tiles_x * 256, tiles_y * 256), (210, 184, 149))
    coords = [(x, y) for x in range(tiles_x) for y in range(tiles_y)]
    with ThreadPoolExecutor(max_workers=8) as pool:
        for x, y, tile in pool.map(fetch, coords):
            canvas.paste(tile, (x * 256, y * 256))
    # Crop to the 176 x 144 frame (8 px/unit).
    frame = canvas.crop((0, 0, 1408, 1152))
    frame.save(dest, quality=85)
    return np.array(frame)


def land_mask_from_parchment(image):
    # Paper is about (210, 184, 149). The land fill is a few steps darker.
    red = image[:, :, 0].astype(np.int16)
    return red < 207


def game_land_mask(image):
    red = image[:, :, 0].astype(np.int16)
    # Open water and the sheet margin share one pale paper color (red about 211).
    # Traced land is a few steps darker. Dark lakes fall below 168.
    return (red >= 168) & (red <= 209)


def ray_points(mask, scale):
    """Coastline samples in map units, walking from the town centroid."""
    height, width = mask.shape
    ys, xs = np.nonzero(mask)
    if len(xs) < 100:
        return []
    # Use the geographic center of the frame, not the pixel centroid, so rays cover the sheet.
    origin = np.array([88.0, -72.0])  # lng, lat
    found = []
    for step in range(18):
        angle = step * math.tau / 18
        direction = np.array([math.cos(angle), math.sin(angle)])
        hit = None
        for distance in np.linspace(8, 120, 80):
            point = origin + direction * distance
            px = int(point[0] * scale)
            py = int(-point[1] * scale)
            if px < 0 or py < 0 or px >= width or py >= height:
                break
            if mask[py, px]:
                hit = point
            elif hit is not None:
                break
        if hit is not None:
            found.append(hit)
    return found


def nearest_source(samples, target):
    if not len(samples):
        return None
    delta = samples - target
    index = int(np.argmin((delta ** 2).sum(axis=1)))
    if np.hypot(*(samples[index] - target)) > 12:
        return None
    return samples[index]


def main():
    Path("/tmp/mapfit").mkdir(exist_ok=True)
    svg = SVG.read_text().replace("MAPID", "m0")
    far = strip_group(strip_group(svg, "layer-close"), "layer-mid")
    mid = strip_group(svg, "layer-close")
    render_svg(far, "/tmp/mapfit/src-far.png")
    render_svg(mid, "/tmp/mapfit/src-mid.png")
    render_svg(svg, "/tmp/mapfit/src-close.png")

    src_far = np.array(Image.open("/tmp/mapfit/src-far.png").convert("RGB"))
    parchment_land = land_mask_from_parchment(src_far)
    print("parchment land fraction", float(parchment_land.mean()))

    town_src = np.array([svg_px(x, y) for _, x, y, _, _ in TOWNS])
    town_dst = np.array([[lng, lat] for _, _, _, lat, lng in TOWNS])
    affine = solve_affine(town_src, town_dst)
    predicted = apply_affine(affine, town_src)
    affine_error = np.hypot(predicted[:, 0] - town_dst[:, 0], predicted[:, 1] - town_dst[:, 1])
    diagonal = math.hypot(176, 144)

    # Inverse affine: lat/lng -> source pixel, for sampling the parchment mask in map space.
    inverse = solve_affine(town_dst, town_src)
    game = download_game()
    game_land = game_land_mask(game)
    print("game land fraction", float(game_land.mean()), "shape", game.shape)
    usable_masks = 0.2 < float(parchment_land.mean()) < 0.85 and 0.2 < float(game_land.mean()) < 0.85
    if not usable_masks:
        print("skipping coastline controls; a mask does not separate land from paper")

    # Project parchment land into an 8 px/unit mask via the affine so rays can be compared.
    gh, gw = game_land.shape
    yy, xx = np.mgrid[0:gh:2, 0:gw:2]
    lng = xx / 8
    lat = -yy / 8
    query = np.stack([lng.ravel(), lat.ravel()], axis=1)
    source = apply_affine(inverse, query)
    sx = np.clip(source[:, 0].astype(int), 0, SRC_W - 1)
    sy = np.clip(source[:, 1].astype(int), 0, SRC_H - 1)
    inside = (source[:, 0] >= 0) & (source[:, 0] < SRC_W) & (source[:, 1] >= 0) & (source[:, 1] < SRC_H)
    projected = np.zeros(query.shape[0], dtype=bool)
    projected[inside] = parchment_land[sy[inside], sx[inside]]
    projected = projected.reshape(yy.shape)

    game_small = game_land[::2, ::2]
    game_rays = ray_points(game_small, 4)
    sheet_rays = ray_points(projected, 4)
    extras = []
    if not usable_masks:
        game_rays = []
    for point in game_rays:
        match = nearest_source(np.array(sheet_rays), point)
        if match is None:
            continue
        pixel = apply_affine(inverse, match.reshape(1, 2))[0]
        if pixel[0] < 0 or pixel[1] < 0 or pixel[0] >= SRC_W or pixel[1] >= SRC_H:
            continue
        extras.append((point, pixel, float(np.hypot(*(match - point)))))

    # Water-label controls: the label's affine position, kept only when that neighborhood is water on the game tiles.
    water_rows = []
    for name, x, y in WATER:
        pixel = svg_px(x, y)
        lng, lat = apply_affine(affine, pixel.reshape(1, 2))[0]
        px = int(lng * 8)
        py = int(-lat * 8)
        window = game[max(0, py - 24):py + 24, max(0, px - 24):px + 24]
        if window.size and (window[:, :, 0] < 165).mean() > 0.15:
            water_rows.append((name, pixel, np.array([lng, lat])))

    control_dst = [town_dst]
    control_src = [town_src]
    coast_report = []
    for point, pixel, error in extras:
        control_dst.append(point.reshape(1, 2))
        control_src.append(pixel.reshape(1, 2))
        coast_report.append({"lng": round(float(point[0]), 3), "lat": round(float(point[1]), 3), "affineError": round(error, 3)})
    water_report = []
    for name, pixel, point in water_rows:
        control_dst.append(point.reshape(1, 2))
        control_src.append(pixel.reshape(1, 2))
        water_report.append({"name": name, "lng": round(float(point[0]), 3), "lat": round(float(point[1]), 3)})

    controls = np.concatenate(control_dst, axis=0)
    values = np.concatenate(control_src, axis=0)
    weights = tps_fit(controls, values)
    back = tps_apply(weights, controls, town_dst)
    town_fit = np.hypot(back[:, 0] - town_src[:, 0], back[:, 1] - town_src[:, 1])
    print("affine rms", float(np.sqrt((affine_error ** 2).mean())), "max", float(affine_error.max()))
    print("tps town pixel rms", float(np.sqrt((town_fit ** 2).mean())), "controls", len(controls))

    if float(town_fit.max()) > 1.5:
        print("coast and water controls disturbed the towns; refitting towns only")
        controls = town_dst
        values = town_src
        weights = tps_fit(controls, values)
        coast_report = []
        water_report = []
        back = tps_apply(weights, controls, town_dst)
        town_fit = np.hypot(back[:, 0] - town_src[:, 0], back[:, 1] - town_src[:, 1])

    # Forward TPS for gazetteer labels: source pixel -> lng/lat.
    forward = tps_fit(town_src, town_dst)
    labels = []
    import re
    for match in re.finditer(r'<text class="([^"]+)"[^>]*x="([\d.]+)" y="([\d.]+)"[^>]*>([^<]+)</text>', svg):
        kind, x, y, name = match.groups()
        if kind not in {"region-label", "county-label", "town-label", "water-label"}:
            continue
        pixel = svg_px(float(x), float(y)).reshape(1, 2)
        lng, lat = tps_apply(forward, town_src, pixel)[0]
        labels.append({"name": name.strip(), "kind": kind, "lat": round(float(lat), 4), "lng": round(float(lng), 4)})

    paper = np.array([210, 184, 149], dtype=np.uint8)
    yy, xx = np.mgrid[0:DST_H, 0:DST_W]
    query = np.stack([(xx.ravel() + 0.5) / UNIT, -((yy.ravel() + 0.5) / UNIT)], axis=1)
    sampled = tps_apply(weights, controls, query)
    sx = sampled[:, 0]
    sy = sampled[:, 1]
    valid = (sx >= 0) & (sy >= 0) & (sx < SRC_W - 1) & (sy < SRC_H - 1)

    def warp(path, out_name):
        image = np.array(Image.open(path).convert("RGB"))
        x0 = np.floor(sx).astype(int)
        y0 = np.floor(sy).astype(int)
        x1 = np.clip(x0 + 1, 0, SRC_W - 1)
        y1 = np.clip(y0 + 1, 0, SRC_H - 1)
        x0c = np.clip(x0, 0, SRC_W - 1)
        y0c = np.clip(y0, 0, SRC_H - 1)
        tx = (sx - x0).reshape(-1, 1)
        ty = (sy - y0).reshape(-1, 1)
        c00 = image[y0c, x0c].astype(np.float32)
        c10 = image[y0c, x1].astype(np.float32)
        c01 = image[y1, x0c].astype(np.float32)
        c11 = image[y1, x1].astype(np.float32)
        mixed = c00 * (1 - tx) * (1 - ty) + c10 * tx * (1 - ty) + c01 * (1 - tx) * ty + c11 * tx * ty
        mixed[~valid] = paper
        canvas = mixed.reshape(DST_H, DST_W, 3).astype(np.uint8)
        for folder in OUT_DIRS:
            folder.mkdir(parents=True, exist_ok=True)
            Image.fromarray(canvas).save(folder / out_name, optimize=True)
        print(out_name, "bytes", (OUT_DIRS[0] / out_name).stat().st_size)

    warp("/tmp/mapfit/src-far.png", "parchment-far.png")
    warp("/tmp/mapfit/src-mid.png", "parchment-mid.png")
    warp("/tmp/mapfit/src-close.png", "parchment-close.png")

    # Where each town label lands, in map units, versus the fast-travel point. TPS is exact at controls.
    report = {
        "frame": "Jean Ropke CRS.Simple lat -144..0, lng 0..176",
        "image": {"width": DST_W, "height": DST_H, "pixelsPerUnit": UNIT},
        "affineRms": round(float(np.sqrt((affine_error ** 2).mean())), 4),
        "affineMax": round(float(affine_error.max()), 4),
        "diagonal": round(diagonal, 4),
        "towns": [
            {
                "name": TOWNS[i][0],
                "svg": [TOWNS[i][1], TOWNS[i][2]],
                "lat": TOWNS[i][3],
                "lng": TOWNS[i][4],
                "affineError": round(float(affine_error[i]), 4),
                "affineShareOfDiagonal": round(float(affine_error[i] / diagonal), 4),
                "tpsPixelError": round(float(town_fit[i]), 4),
            }
            for i in range(len(TOWNS))
        ],
        "coast": coast_report,
        "water": water_report,
        "controlCount": int(len(controls)),
        "tpsTownPixelRms": round(float(np.sqrt((town_fit ** 2).mean())), 4),
    }
    LIB.mkdir(parents=True, exist_ok=True)
    (LIB / "parchment-fit.json").write_text(json.dumps(report, indent=2) + "\n")
    gazetteer = [{"name": item["name"], "lat": item["lat"], "lng": item["lng"]} for item in labels]
    for folder in OUT_DIRS:
        (folder / "gazetteer.json").write_text(json.dumps(gazetteer, indent=2) + "\n")
    preview = Image.open(OUT_DIRS[0] / "parchment-close.png").convert("RGB").resize((1408, 1152))
    game_img = Image.fromarray(game).convert("RGB")
    blend = Image.blend(game_img, preview, 0.45)
    blend.save("/tmp/mapfit/overlay.jpg", quality=80)
    print("wrote fit", report["affineRms"], "controls", report["controlCount"], "coast", len(coast_report), "water", len(water_report))


if __name__ == "__main__":
    main()
