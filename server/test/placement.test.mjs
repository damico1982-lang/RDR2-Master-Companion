import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { affineResiduals, countiesAt, sheetPoint } from "../lib/map-calibration.mjs";
import { COORDINATES } from "../lib/map-placements.mjs";
import { NEW_PINS } from "../lib/map-new-pins.mjs";

const content = new URL("../public/content/", import.meta.url);

function read(name) {
  return JSON.parse(readFileSync(new URL(name, content), "utf8"));
}

function locate(file, id, data) {
  if (file === "legendaries") return data.legendaries.find(item => item.id === id);
  if (file === "hidden") return data.hidden.find(item => item.id === id);
  if (file === "map") return data.map.find(item => item.id === id);
  for (const secret of data.secrets) {
    const marker = (secret.markers || []).find(item => item.id === id);
    if (marker) return marker;
  }
  return null;
}

test("the affine is fit to twelve towns and the corrected sheet hits their labels", () => {
  const residuals = affineResiduals();
  assert.equal(residuals.length, 12);
  for (const town of residuals) {
    assert.equal(typeof town.error, "number");
    const corrected = sheetPoint(town.gameX, town.gameY);
    assert.ok(Math.abs(corrected.x - town.labelX) < 0.05, town.name);
    assert.ok(Math.abs(corrected.y - town.labelY) < 0.05, town.name);
  }
  const blackwater = residuals.find(town => town.name === "Blackwater");
  assert.ok(blackwater.error > 1, "the raw affine residual is reported when the traced label is not an affine fit");
});

test("every sourced marker sits in its county and on the projected sheet point", () => {
  const data = {
    legendaries: read("legendaries.json"),
    secrets: read("secrets.json"),
    hidden: read("hidden-places.json"),
    map: read("map.json")
  };
  const pins = [
    ...COORDINATES.map(([file, id, gameX, gameY, county]) => ({ file, id, gameX, gameY, county })),
    ...NEW_PINS.map(pin => ({ file: "map", id: pin.id, gameX: pin.gameX, gameY: pin.gameY, county: pin.county }))
  ];
  assert.ok(pins.length > 80);
  for (const pin of pins) {
    const entry = locate(pin.file, pin.id, data);
    assert.ok(entry, pin.id);
    const point = sheetPoint(pin.gameX, pin.gameY);
    assert.equal(entry.x, point.x, pin.id);
    assert.equal(entry.y, point.y, pin.id);
    assert.equal(entry.county, pin.county, pin.id);
    assert.deepEqual(countiesAt(entry.x, entry.y), [pin.county], pin.id);
  }
  const valentine = sheetPoint(-304.469, 791.214);
  assert.equal(countiesAt(valentine.x, valentine.y).includes("Bayou Nwa"), false);
});

test("rare horses, fish, weapons, and ammo are tagged for the map", () => {
  const map = read("map.json");
  const horses = map.filter(item => item.category === "Horses");
  assert.ok(horses.length >= 18);
  for (const horse of horses) {
    assert.ok(horse.breed && horse.coat && horse.obtain && horse.chapter, horse.id);
    if (horse.obtain === "Stable") assert.ok(horse.price, horse.id);
  }
  const white = horses.find(item => item.id === "horse-white-arabian");
  assert.equal(white.obtain, "Wild");
  assert.equal(white.county, "Grizzlies West");
  assert.equal(white.coat, "White");
  const black = horses.find(item => item.id === "horse-black-arabian");
  assert.equal(black.obtain, "Stable");
  assert.equal(black.county, "Bayou Nwa");
  assert.match(black.price, /1,050/);
  assert.equal(horses.some(item => /wild black arabian herd/i.test(item.title)), false);
  assert.equal(map.filter(item => item.category === "Fish").length, 14);
  assert.equal(map.filter(item => item.category === "Weapons").length, 8);
  assert.ok(map.filter(item => item.category === "Ammo" && item.shop).length >= 9);
  assert.equal(map.some(item => item.category === "Services"), false);
  const shotgun = map.find(item => item.id === "rare-shotgun");
  assert.equal(shotgun.county, "Roanoke Ridge");
  assert.match(shotgun.directions, /Manito Glade/);
  assert.match(shotgun.note, /not a Lemoyne cabin/);
});
