import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { sheetPoint, countiesAt } from "../lib/map-calibration.mjs";
import { COORDINATES, TEXT_PATCHES } from "../lib/map-placements.mjs";
import { NEW_PINS } from "../lib/map-new-pins.mjs";

const android = new URL("../../android-native/app/src/main/assets/web/content/", import.meta.url);
const server = new URL("../public/content/", import.meta.url);

function load(name) {
  return JSON.parse(readFileSync(new URL(name, android), "utf8"));
}

function stamp(entry, gameX, gameY, county) {
  const point = sheetPoint(gameX, gameY);
  const hits = countiesAt(point.x, point.y);
  entry.gameX = Number(gameX.toFixed(1));
  entry.gameY = Number(gameY.toFixed(1));
  entry.x = point.x;
  entry.y = point.y;
  entry.county = county;
  return hits;
}

const legendaries = load("legendaries.json");
const secrets = load("secrets.json");
const hidden = load("hidden-places.json");
const map = load("map.json");

const problems = [];

function find(file, id) {
  if (file === "legendaries") return legendaries.find(item => item.id === id);
  if (file === "hidden") return hidden.find(item => item.id === id);
  if (file === "map") return map.find(item => item.id === id);
  for (const secret of secrets) {
    const marker = (secret.markers || []).find(item => item.id === id);
    if (marker) return marker;
  }
  return null;
}

for (const [file, id, gameX, gameY, county] of COORDINATES) {
  const entry = find(file, id);
  if (!entry) {
    problems.push(`missing ${file} ${id}`);
    continue;
  }
  const hits = stamp(entry, gameX, gameY, county);
  if (hits.length !== 1 || hits[0] !== county) problems.push(`${id} landed in [${hits.join(", ")}] not ${county} (${entry.x}, ${entry.y})`);
}

for (const [key, patch] of Object.entries(TEXT_PATCHES)) {
  const [file, id] = key.split(":");
  const entry = find(file, id);
  if (!entry) {
    problems.push(`patch missing ${key}`);
    continue;
  }
  Object.assign(entry, patch);
}

for (const pin of NEW_PINS) {
  const existing = map.find(item => item.id === pin.id);
  const entry = existing || { ...pin };
  if (!existing) map.push(entry);
  else Object.assign(entry, pin);
  const hits = stamp(entry, pin.gameX, pin.gameY, pin.county);
  delete entry.gameX;
  delete entry.gameY;
  stamp(entry, pin.gameX, pin.gameY, pin.county);
  if (hits.length !== 1 || hits[0] !== pin.county) problems.push(`${pin.id} landed in [${hits.join(", ")}] not ${pin.county} (${entry.x}, ${entry.y})`);
}

for (const id of ["online-treasure-maps", "online-collector-routes", "online-dailies"]) {
  const entry = map.find(item => item.id === id);
  if (entry) entry.approximate = true;
}

function tooClose(items, limit) {
  const close = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const distance = Math.hypot(items[i].x - items[j].x, items[i].y - items[j].y);
      if (distance < limit) close.push(`${items[i].id || items[i].name} ~ ${items[j].id || items[j].name} ${distance.toFixed(2)}`);
    }
  }
  return close;
}

const secretMarkers = secrets.flatMap(item => item.markers || []);
console.log("secret pairs under 1.0%", tooClose(secretMarkers, 1).join(" | ") || "none");
console.log("legendary pairs under 1.0%", tooClose(legendaries, 1).join(" | ") || "none");
console.log("pins", map.length, "horses", map.filter(item => item.category === "Horses").length);

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}

function save(name, data) {
  const text = `${JSON.stringify(data, null, 2)}\n`;
  writeFileSync(new URL(name, android), text);
  writeFileSync(new URL(name, server), text);
}

save("legendaries.json", legendaries);
save("secrets.json", secrets);
save("hidden-places.json", hidden);
save("map.json", map);
console.log("wrote placement json");
