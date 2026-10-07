import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const content = new URL("../public/content/", import.meta.url);
const read = name => JSON.parse(readFileSync(new URL(name, content), "utf8"));

test("every plotted pin carries a published source and stays inside the map frame", () => {
  const map = read("map.json");
  assert.ok(map.length >= 90);
  for (const pin of map) {
    assert.equal(typeof pin.sourceUrl, "string", pin.id);
    assert.equal(pin.sourceUrl.startsWith("http"), true, pin.id);
    assert.equal(typeof pin.sourceLat, "number", pin.id);
    assert.equal(typeof pin.sourceLng, "number", pin.id);
    assert.equal(pin.lat <= 0 && pin.lat >= -144, true, pin.id);
    assert.equal(pin.lng >= 0 && pin.lng <= 176, true, pin.id);
    assert.equal(pin.gameX, undefined, pin.id);
    assert.equal(pin.gameY, undefined, pin.id);
    if (pin.approximate) assert.equal(typeof pin.note, "string", pin.id);
  }
  const exact = map.filter(pin => !pin.approximate);
  assert.equal(exact.length, map.length - 1);
  assert.equal(map.find(pin => pin.id === "horse-silver-turkoman").approximate, true);
});

test("story hunts, the rare shotgun, and the white arabian use their published points", () => {
  const map = read("map.json");
  const legendaries = read("legendaries.json");
  assert.equal(legendaries.length, 16);
  for (const animal of legendaries) {
    assert.equal(typeof animal.x, "number");
    assert.equal(typeof animal.y, "number");
    assert.equal(animal.x, animal.lng);
    assert.equal(animal.y, animal.lat);
    const pin = map.find(item => item.id === `leg-${animal.id}`);
    assert.equal(pin.lat, animal.lat, animal.id);
    assert.match(pin.sourceUrl, /RDOMap/);
  }
  const shotgun = map.find(item => item.id === "rare-shotgun");
  const manito = map.find(item => item.id === "sec-manito") || read("secrets.json").flatMap(item => item.markers || []).find(item => item.id === "sec-manito");
  assert.match(shotgun.directions, /Manito Glade/);
  assert.match(shotgun.directions, /not a Lemoyne cabin/);
  assert.match(shotgun.directions, /not the Semi-Auto Shotgun/);
  assert.ok(Math.hypot(shotgun.lat - manito.lat, shotgun.lng - manito.lng) < 2, "rare shotgun stays on the isolationist shack");
  const white = map.find(item => item.id === "horse-white-arabian");
  assert.equal(white.coat, "White");
  assert.equal(white.obtain, "Wild");
  assert.ok(Math.hypot(white.lat - (-36.907), white.lng - 84.3357) < 4, "white arabian stays by Lake Isabella");
  const jack = map.find(item => item.id === "treasure-jack-hall");
  assert.ok(Math.hypot(jack.lat - (-37.3004), jack.lng - 141.8745) > 3, "Jack Hall is the island cache, not the hunter zone");
  assert.equal(map.some(item => /granite pass/i.test(item.title)), false);
  const granite = read("hidden-places.json").find(item => item.id === "granite-pass");
  assert.equal(granite.approximate, true);
  assert.match(granite.sourceUrl, /gtaboss\.gg\/red-dead\/map\/derailed-train-gold-bar/);
  assert.equal(granite.sourceLat, 73.45);
  assert.equal(granite.sourceLng, 31.5);
  assert.ok(Math.hypot(granite.lat - (-37.2391), granite.lng - 112.6067) < 0.01);
  assert.equal(map.some(item => /northern pike/i.test(item.title)), false);
  assert.equal(map.filter(item => item.category === "Fish").length, 14);
  assert.equal(map.filter(item => item.category === "Legendary").length, 16);
  assert.equal(map.filter(item => item.category === "Weapons").length, 6);
  assert.equal(map.filter(item => item.category === "Ammo").length, 9);
  assert.equal(map.filter(item => item.category === "Horses").length, 10);
});

test("the parchment fit reports the raw affine error and lands towns on their fast-travel points", () => {
  const fit = JSON.parse(readFileSync(new URL("../lib/parchment-fit.json", import.meta.url), "utf8"));
  assert.ok(fit.affineRms > 1, "the traced sheet is not an affine of the game frame");
  assert.equal(fit.towns.length, 13);
  assert.ok(fit.controlCount >= fit.towns.length);
  for (const town of fit.towns) {
    assert.ok(town.tpsPixelError < 0.05, town.name);
    assert.equal(typeof town.affineError, "number");
  }
  const blackwater = fit.towns.find(town => town.name === "Blackwater");
  assert.ok(blackwater.affineError > 10);
});
