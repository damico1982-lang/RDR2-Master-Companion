// Least-squares affine from story-mode world meters onto the traced sheet,
// plus a local correction so the twelve town labels stay on their ink.
// World axes: +X east, +Y north. Sheet axes: percent of the 3888×2944 view,
// +X east, +Y south.

export const CONTROL_TOWNS = [
  { name: "Valentine", gameX: -304.469, gameY: 791.214, x: 57.099, y: 33.967 },
  { name: "Saint Denis", gameX: 2725.438, gameY: -1275.145, x: 85.391, y: 63.179 },
  { name: "Blackwater", gameX: -787.838, gameY: -1304.097, x: 43.210, y: 67.255 },
  { name: "Strawberry", gameX: -1789.022, gameY: -372.705, x: 39.609, y: 53.668 },
  { name: "Rhodes", gameX: 1333.953, gameY: -1330.913, x: 73.560, y: 52.310 },
  { name: "Annesburg", gameX: 2939.742, gameY: 1296.912, x: 81.790, y: 22.418 },
  { name: "Van Horn", gameX: 2892.098, gameY: 624.166, x: 87.963, y: 33.288 },
  { name: "Armadillo", gameX: -3705.773, gameY: -2609.780, x: 29.835, y: 78.125 },
  { name: "Tumbleweed", gameX: -5510.076, gameY: -2935.326, x: 10.802, y: 80.842 },
  { name: "Colter", gameX: -1354, gameY: 2434, x: 55.041, y: 13.587 },
  { name: "Emerald Ranch", gameX: 1447.692, gameY: 370.863, x: 71.502, y: 41.440 },
  { name: "Lagras", gameX: 2145, gameY: -608, x: 77.675, y: 50.951 }
];

function solve(rows, width) {
  const ata = Array.from({ length: width }, () => Array(width).fill(0));
  const atb = Array(width).fill(0);
  for (const row of rows) {
    const v = row.slice(0, width);
    const target = row[width];
    for (let i = 0; i < width; i += 1) {
      atb[i] += v[i] * target;
      for (let j = 0; j < width; j += 1) ata[i][j] += v[i] * v[j];
    }
  }
  const matrix = ata.map((row, index) => [...row, atb[index]]);
  for (let col = 0; col < width; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < width; row += 1) {
      if (Math.abs(matrix[row][col]) > Math.abs(matrix[pivot][col])) pivot = row;
    }
    [matrix[col], matrix[pivot]] = [matrix[pivot], matrix[col]];
    const divisor = matrix[col][col] || 1e-12;
    for (let c = col; c <= width; c += 1) matrix[col][c] /= divisor;
    for (let row = 0; row < width; row += 1) {
      if (row === col) continue;
      const factor = matrix[row][col];
      for (let c = col; c <= width; c += 1) matrix[row][c] -= factor * matrix[col][c];
    }
  }
  return matrix.map(row => row[width]);
}

const affineX = solve(CONTROL_TOWNS.map(town => [town.gameX, town.gameY, 1, town.x]), 3);
const affineY = solve(CONTROL_TOWNS.map(town => [town.gameX, town.gameY, 1, town.y]), 3);

function affine(gameX, gameY) {
  return [
    affineX[0] * gameX + affineX[1] * gameY + affineX[2],
    affineY[0] * gameX + affineY[1] * gameY + affineY[2]
  ];
}

const residuals = CONTROL_TOWNS.map(town => {
  const [x, y] = affine(town.gameX, town.gameY);
  return { ...town, dx: town.x - x, dy: town.y - y, affineX: x, affineY: y };
});

export function affineResiduals() {
  return residuals.map(town => ({
    name: town.name,
    gameX: town.gameX,
    gameY: town.gameY,
    sheetX: Number(town.affineX.toFixed(2)),
    sheetY: Number(town.affineY.toFixed(2)),
    labelX: town.x,
    labelY: town.y,
    error: Number(Math.hypot(town.dx, town.dy).toFixed(3))
  }));
}

export function project(gameX, gameY) {
  const [x, y] = affine(gameX, gameY);
  const ranked = residuals.map(town => ({
    ...town,
    distance: Math.hypot(town.gameX - gameX, town.gameY - gameY)
  })).sort((a, b) => a.distance - b.distance);
  if (ranked[0].distance < 1) return { x: ranked[0].x, y: ranked[0].y };
  const nearest = ranked.slice(0, 4);
  let weight = 0;
  let dx = 0;
  let dy = 0;
  for (const town of nearest) {
    const w = 1 / (town.distance * town.distance);
    weight += w;
    dx += w * town.dx;
    dy += w * town.dy;
  }
  return { x: x + dx / weight, y: y + dy / weight };
}

export function sheetPoint(gameX, gameY) {
  const point = project(gameX, gameY);
  return { x: Number(point.x.toFixed(2)), y: Number(point.y.toFixed(2)) };
}

// Jean Ropke leaflet overlay: lat = 0.01552*gameY - 63.6, lng = 0.01552*gameX + 111.29.
// Checked against Gaptooth Breach (leaflet center vs the femga mine interior).
export function gameFromLeaflet(lat, lng) {
  return {
    gameX: (lng - 111.29) / 0.01552,
    gameY: (lat + 63.6) / 0.01552
  };
}

export const COUNTIES = {
  "Grizzlies West": [[30, 6], [63, 6], [63, 21.2], [50, 28], [32, 28], [28, 16]],
  "Grizzlies East": [[62.5, 8], [78, 8], [78, 21.6], [62.5, 21.6]],
  "Cumberland Forest": [[49.6, 22], [76, 22], [76, 33], [55, 33.6], [49.6, 40], [47, 32]],
  Heartlands: [[54.8, 32.8], [76, 28], [76, 49.3], [54, 52], [50, 44], [54.8, 36]],
  "Roanoke Ridge": [[78.2, 8], [97, 8], [97, 43], [78.2, 43]],
  "Bluewater Marsh": [[76.2, 43], [97, 43], [96, 50.15], [76.2, 50.15]],
  "Scarlett Meadows": [[50, 50.2], [76.1, 47.2], [76.1, 68], [58, 71], [48, 58]],
  "Bayou Nwa": [[76.6, 50.4], [97, 50.4], [97, 75], [76.6, 73]],
  "Big Valley": [[24, 36.5], [51, 36.2], [51, 56.8], [34, 57], [22, 48]],
  "Tall Trees": [[14, 57.5], [40, 57.5], [38, 72.2], [14, 70]],
  "Great Plains": [[38, 58], [66, 55], [64, 74], [36, 74]],
  "Hennigan's Stead": [[32.4, 72.4], [52, 70], [50, 83.7], [32.4, 83.7]],
  "Cholla Springs": [[15.8, 71], [32.2, 71], [32.2, 83.7], [14, 85]],
  "Rio Bravo": [[16.4, 84.4], [50, 84.4], [44, 97], [14, 97]],
  "Gaptooth Ridge": [[2, 68], [15.6, 70], [15, 89], [2, 92]]
};

function edgeNear(polygon, x, y) {
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const length = dx * dx + dy * dy || 1;
    let t = ((x - start[0]) * dx + (y - start[1]) * dy) / length;
    t = Math.max(0, Math.min(1, t));
    if (Math.hypot(start[0] + t * dx - x, start[1] + t * dy - y) < 0.18) return true;
  }
  return false;
}

export function pointInPolygon(x, y, polygon) {
  if (edgeNear(polygon, x, y)) return true;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i][0];
    const yi = polygon[i][1];
    const xj = polygon[j][0];
    const yj = polygon[j][1];
    const intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

export function countiesAt(x, y) {
  return Object.entries(COUNTIES).filter(([, polygon]) => pointInPolygon(x, y, polygon)).map(([name]) => name);
}

export function inCounty(x, y, county) {
  const polygon = COUNTIES[county];
  return Boolean(polygon) && pointInPolygon(x, y, polygon);
}
