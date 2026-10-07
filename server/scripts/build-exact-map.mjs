// Rebuild map pins from published Jean Ropke / community-map coordinates.
// Run: node server/scripts/build-exact-map.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(root, "data/rdomap");
const trees = [
  join(root, "public/content"),
  join(root, "../android-native/app/src/main/assets/web/content")
];

const RDO = "https://github.com/jeanropke/RDOMap/blob/master/data";
const KNOCKS = "https://github.com/the0neWhoKnocks/red-dead-redemption-2-map/blob/master/public/markers.default.json";
const PASTEBIN = "https://pastebin.com/raw/YRdi3fRK";

const discoverables = JSON.parse(readFileSync(join(dataDir, "discoverables.json"), "utf8"));
const shops = JSON.parse(readFileSync(join(dataDir, "rdo-shops.json"), "utf8"));
const fast = JSON.parse(readFileSync(join(dataDir, "rdo-fast.json"), "utf8"));
const knocks = JSON.parse(readFileSync(join(dataDir, "markers.default.json"), "utf8"));

function group(list, key) {
  return list.find(item => item.key === key);
}
function byName(key) {
  const found = new Map();
  for (const item of group(discoverables, key).locations) found.set(item.name, item);
  return found;
}
const legend = byName("sp_legendaries");
const pois = byName("discoverable");
const text = byName("text");

function shopAt(key, textName) {
  const row = shops.find(item => item.key === key);
  return row.locations.find(item => item.text === textName);
}

// Shared landmarks, Knocks frame -> RDOMap frame. Least squares is recomputed below.
const PAIRS = [
  ["bear", [-50.18414, 180.35989], [legend.get("animal_legendary_bear").lat, legend.get("animal_legendary_bear").lng]],
  ["beaver", [-72.37217, 199.73114], [legend.get("animal_legendary_beaver").lat, legend.get("animal_legendary_beaver").lng]],
  ["boar", [-90.98930, 199.40328], [legend.get("animal_legendary_boar").lat, legend.get("animal_legendary_boar").lng]],
  ["buck", [-84.91918, 96.15759], [legend.get("animal_legendary_buck").lat, legend.get("animal_legendary_buck").lng]],
  ["cougar", [-149.28128, 24.23065], [legend.get("animal_legendary_cougar").lat, legend.get("animal_legendary_cougar").lng]],
  ["coyote", [-96.12075, 165.24306], [legend.get("animal_legendary_coyote").lat, legend.get("animal_legendary_coyote").lng]],
  ["elk", [-50.73561, 163.49445], [legend.get("animal_legendary_elk").lat, legend.get("animal_legendary_elk").lng]],
  ["fox", [-106.35235, 176.54653], [legend.get("animal_legendary_fox").lat, legend.get("animal_legendary_fox").lng]],
  ["moose", [-38.67945, 207.94138], [legend.get("animal_legendary_moose").lat, legend.get("animal_legendary_moose").lng]],
  ["panther", [-127.47264, 182.94767], [legend.get("animal_legendary_panther").lat, legend.get("animal_legendary_panther").lng]],
  ["pronghorn", [-160.35770, 70.24469], [legend.get("animal_legendary_pronghorn").lat, legend.get("animal_legendary_pronghorn").lng]],
  ["ram", [-66.58364, 124.58802], [legend.get("animal_legendary_big_horn").lat, legend.get("animal_legendary_big_horn").lng]],
  ["tatanka", [-142.52279, 107.27372], [legend.get("animal_legendary_buffalo").lat, legend.get("animal_legendary_buffalo").lng]],
  ["bison", [-48.76830, 112.11751], [legend.get("animal_legendary_white_buffalo").lat, legend.get("animal_legendary_white_buffalo").lng]],
  ["wolf", [-45.47510, 153.92007], [legend.get("animal_legendary_wolf").lat, legend.get("animal_legendary_wolf").lng]],
  ["statues", [-45.27172, 166.26958], [pois.get("discoverable_strange_statues").lat, pois.get("discoverable_strange_statues").lng]],
  ["gator", [-101.69025, 193.37684], [legend.get("animal_legendary_bullgator").lat, legend.get("animal_legendary_bullgator").lng]]
];

function solve(rows, values) {
  const ata = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const atb = [0, 0, 0];
  for (let i = 0; i < rows.length; i += 1) {
    const [a, b, c] = rows[i];
    const v = values[i];
    const r = [a, b, c];
    for (let row = 0; row < 3; row += 1) {
      atb[row] += r[row] * v;
      for (let col = 0; col < 3; col += 1) ata[row][col] += r[row] * r[col];
    }
  }
  const matrix = ata.map((row, index) => [...row, atb[index]]);
  for (let col = 0; col < 3; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 3; row += 1) if (Math.abs(matrix[row][col]) > Math.abs(matrix[pivot][col])) pivot = row;
    [matrix[col], matrix[pivot]] = [matrix[pivot], matrix[col]];
    const scale = matrix[col][col];
    for (let k = col; k < 4; k += 1) matrix[col][k] /= scale;
    for (let row = 0; row < 3; row += 1) {
      if (row === col) continue;
      const factor = matrix[row][col];
      for (let k = col; k < 4; k += 1) matrix[row][k] -= factor * matrix[col][k];
    }
  }
  return [matrix[0][3], matrix[1][3], matrix[2][3]];
}

const rows = PAIRS.map(([, source]) => [source[0], source[1], 1]);
const latCoeff = solve(rows, PAIRS.map(([, , target]) => target[0]));
const lngCoeff = solve(rows, PAIRS.map(([, , target]) => target[1]));

export function knocksToRdo(lat, lng) {
  return {
    lat: latCoeff[0] * lat + latCoeff[1] * lng + latCoeff[2],
    lng: lngCoeff[0] * lat + lngCoeff[1] * lng + lngCoeff[2]
  };
}

export function gameToMap(gameX, gameY) {
  return { lat: 0.01552 * gameY - 63.6, lng: 0.01552 * gameX + 111.29 };
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}

function pin(fields) {
  const lat = round(fields.lat);
  const lng = round(fields.lng);
  return {
    ...fields,
    lat,
    lng,
    sourceLat: round(fields.sourceLat),
    sourceLng: round(fields.sourceLng),
    x: round((lng / 176) * 100),
    y: round((-lat / 144) * 100),
    mode: fields.mode || "story"
  };
}

function rdo(id, category, title, point, extra = {}) {
  return pin({
    id,
    category,
    title,
    lat: point.lat,
    lng: point.lng,
    sourceUrl: extra.sourceUrl || `${RDO}/discoverables.json`,
    sourceLat: point.lat,
    sourceLng: point.lng,
    ...extra,
    lat: point.lat,
    lng: point.lng
  });
}

function fromKnocks(subtype) {
  const item = knocks.find(entry => {
    const data = entry.data || {};
    return data.markerSubType === subtype || data.markerCustomSubType === subtype;
  });
  if (!item) throw new Error(`missing knocks marker ${subtype}`);
  const mapped = knocksToRdo(item.lat, item.lng);
  return { sourceLat: item.lat, sourceLng: item.lng, lat: mapped.lat, lng: mapped.lng };
}

const pins = [];

const animals = [
  ["bull-gator", "Legendary Bull Gator", "animal_legendary_bullgator"],
  ["beaver", "Legendary Beaver", "animal_legendary_beaver"],
  ["bharati-bear", "Legendary Bharati Grizzly", "animal_legendary_bear"],
  ["bighorn-ram", "Legendary Bighorn Ram", "animal_legendary_big_horn"],
  ["boar", "Legendary Boar", "animal_legendary_boar"],
  ["buck", "Legendary Buck", "animal_legendary_buck"],
  ["cougar", "Legendary Cougar", "animal_legendary_cougar"],
  ["coyote", "Legendary Coyote", "animal_legendary_coyote"],
  ["elk", "Legendary Elk", "animal_legendary_elk"],
  ["fox", "Legendary Fox", "animal_legendary_fox"],
  ["moose", "Legendary Moose", "animal_legendary_moose"],
  ["giaguaro", "Legendary Panther (Giaguaro)", "animal_legendary_panther"],
  ["pronghorn", "Legendary Pronghorn", "animal_legendary_pronghorn"],
  ["tatanka", "Legendary Tatanka Bison", "animal_legendary_buffalo"],
  ["white-bison", "Legendary White Bison", "animal_legendary_white_buffalo"],
  ["wolf", "Legendary Wolf", "animal_legendary_wolf"]
];
for (const [id, title, name] of animals) {
  const point = legend.get(name);
  pins.push(rdo(`leg-${id}`, "Legendary", title, point, {
    linkView: "legendary",
    linkId: id,
    linkLabel: "Open animal page",
    directions: "Story legendary hunt. The pin is the published RDOMap story point for this animal.",
    note: `Source name ${name}.`,
    region: "Story mode"
  }));
}

const fish = [
  ["bluegill", "Legendary Bluegill", "animal_fish_bluegill"],
  ["bullhead", "Legendary Bullhead Catfish", "animal_fish_catfish_bullhead"],
  ["chain", "Legendary Chain Pickerel", "animal_fish_pickeral_chain"],
  ["gar", "Legendary Longnose Gar", "animal_fish_gar_long_nose"],
  ["largemouth", "Legendary Largemouth Bass", "animal_fish_bass_large_mouth"],
  ["muskie", "Legendary Muskie", "animal_fish_muskie"],
  ["perch", "Legendary Perch", "animal_fish_perch"],
  ["redfin", "Legendary Redfin Pickerel", "animal_fish_pickeral_redfin"],
  ["rock", "Legendary Rock Bass", "animal_fish_bass_rock"],
  ["smallmouth", "Legendary Smallmouth Bass", "animal_fish_bass_small_mouth"],
  ["sockeye", "Legendary Sockeye Salmon", "animal_fish_salmon_sockeye"],
  ["steelhead", "Legendary Steelhead Trout", "animal_fish_trout_steelhead"],
  ["sturgeon", "Legendary Lake Sturgeon", "animal_fish_sturgeon_lake"],
  ["channel", "Legendary Channel Catfish", "animal_fish_catfish_channel"]
];
for (const [id, title, name] of fish) {
  const point = legend.get(name);
  pins.push(rdo(`fish-${id}`, "Fish", title, point, {
    obtain: "Wild",
    chapter: name.includes("channel") ? "A Fisher of Fish mission" : "After A Fisher of Fish begins",
    directions: "Published story legendary-fish point from RDOMap. Use the special lure from the Lagras bait shop after Jeremy Gill's mission, then mail the fish.",
    note: name.includes("channel") ? "Mission fish on the published channel-catfish point. It is not a free-roam catch." : `Source name ${name}.`,
    region: "Story mode"
  }));
}

const burned = text.get("discoverabletext_burned_settlement");
pins.push(rdo("gold-limpany", "Gold", "Limpany gold bar", burned, {
  sourceUrl: `${RDO}/discoverables.json`,
  directions: "The published label for the burned settlement of Limpany. The lockbox is in the ruined sheriff's office.",
  note: "The coordinate is the settlement label in the RDOMap text layer, not a separate lockbox prop.",
  region: "New Hanover — Limpany"
}));

const manor = gameToMap(1010.883, -1741.42);
pins.push(pin({
  id: "gold-braithwaite",
  category: "Gold",
  title: "Braithwaite Manor gold",
  lat: manor.lat,
  lng: manor.lng,
  sourceUrl: PASTEBIN,
  sourceLat: 1010.883,
  sourceLng: -1741.42,
  sourceGameX: 1010.883,
  sourceGameY: -1741.42,
  directions: "Published Braithwaite Manor coordinate, converted with the Jean Ropke game-to-map formula (lat = 0.01552 * y - 63.6, lng = 0.01552 * x + 111.29). The gold lockbox is inside the manor after the Chapter 3 events.",
  note: "sourceLat and sourceLng here are the published game x and y. The plotted lat/lng are that formula, which is the same one RDOMap uses.",
  region: "Lemoyne — Braithwaite Manor"
}));

const jack = fromKnocks("Jack Hall Gang Treasure 3");
pins.push(pin({
  id: "treasure-jack-hall",
  category: "Treasure",
  title: "Jack Hall gang treasure",
  ...jack,
  sourceUrl: KNOCKS,
  directions: "The third Jack Hall cache, published as Jack Hall Gang Treasure 3. It is the island stash at O'Creagh's Run, not the treasure-hunter zone around the lake.",
  note: "Original values are that map's lat/lng. Plotted position is the least-squares conversion into the RDOMap frame, fit on 17 shared landmarks.",
  region: "Ambarino — O'Creagh's Run"
}));

for (const [id, title, subtype, note] of [
  ["treasure-high-stakes", "High Stakes treasure", "High Stakes Treasure", "Final cache of the High Stakes map chain."],
  ["treasure-poison", "Poisonous Trail treasure", "Poisonous Trail Final Treasure", "Final cache of the Poisonous Trail."],
  ["treasure-torn", "Torn treasure map cache", "Torn Treasure", "Cache for the torn treasure map."]
]) {
  const point = fromKnocks(subtype);
  pins.push(pin({
    id,
    category: "Treasure",
    title,
    ...point,
    sourceUrl: KNOCKS,
    directions: note,
    note: "Converted from the community marker file into the RDOMap frame.",
    region: "Story mode"
  }));
}

const isolation = text.get("shack_angry_isolationist");
const shotgun = fromKnocks("Rare Shotgun");
pins.push(pin({
  id: "rare-shotgun",
  category: "Weapons",
  title: "Rare Shotgun",
  ...shotgun,
  sourceUrl: KNOCKS,
  obtain: "Unique weapon",
  directions: "The published Rare Shotgun marker. It lands on the angry-isolationist shack north of Annesburg, the Manito Glade hermit. It is not a Lemoyne cabin and it is not the Semi-Auto Shotgun in Watson's Cabin.",
  note: "Cross-check: the converted point is the RDOMap shack_angry_isolationist, not a Lemoyne cabin.",
  region: "New Hanover — Manito Glade"
}));

const granger = text.get("shack_grangers_hoggery");
pins.push(rdo("grangers-revolver", "Weapons", "Granger's Revolver", granger, {
  obtain: "Unique weapon",
  directions: "Published location of Granger's Hoggery. The revolver is in that shack.",
  note: "Source name shack_grangers_hoggery.",
  region: "New Hanover — Granger's Hoggery"
}));

for (const [id, title, subtype, directions] of [
  ["viking-hatchet", "Viking Hatchet", "Viking Hatchet", "Published Viking Hatchet marker, in the Roanoke burial."],
  ["ancient-tomahawk", "Ancient Tomahawk", "Ancient Tomahawk", "Published Ancient Tomahawk marker."],
  ["civil-war-knife", "Civil War Knife", "Civil War Knife", "Published Civil War Knife marker."],
  ["watsons-shotgun", "Semi-Auto Shotgun", "Semi-Auto Shotgun", "Published Semi-Auto Shotgun, in the basement of Watson's Cabin. This is not the Rare Shotgun."]
]) {
  const point = fromKnocks(subtype);
  pins.push(pin({
    id,
    category: "Weapons",
    title,
    ...point,
    sourceUrl: KNOCKS,
    obtain: "Unique weapon",
    directions,
    note: "Converted from the community marker file into the RDOMap frame.",
    region: "Story mode"
  }));
}

for (const [id, title, key, textName, region] of [
  ["gunsmith-valentine", "Valentine gunsmith", "gunsmith", "shop_val_gunsmith", "New Hanover — Valentine"],
  ["gunsmith-rhodes", "Rhodes gunsmith", "gunsmith", "shop_rho_gunsmith", "Lemoyne — Rhodes"],
  ["gunsmith-saint-denis", "Saint Denis gunsmith", "gunsmith", "shop_sdn_gunsmith", "Lemoyne — Saint Denis"],
  ["gunsmith-annesburg", "Annesburg gunsmith", "gunsmith", "shop_asb_gunsmith", "New Hanover — Annesburg"],
  ["gunsmith-tumbleweed", "Tumbleweed gunsmith", "gunsmith", "shop_tbl_gunsmith", "New Austin — Tumbleweed"],
  ["fence-emerald", "Emerald Ranch fence", "fence", "shop_emr_fence", "New Hanover — Emerald Ranch"],
  ["fence-rhodes", "Rhodes fence", "fence", "shop_rho_fence", "Lemoyne — Rhodes"],
  ["fence-saint-denis", "Saint Denis fence", "fence", "shop_sdn_fence", "Lemoyne — Saint Denis"],
  ["fence-van-horn", "Van Horn fence", "fence", "shop_van_fence", "New Hanover — Van Horn"]
]) {
  const point = shopAt(key, textName);
  pins.push(pin({
    id,
    category: "Ammo",
    title,
    lat: point.x,
    lng: point.y,
    sourceUrl: `${RDO}/shops.json`,
    sourceLat: point.x,
    sourceLng: point.y,
    shop: true,
    obtain: "Shop",
    directions: "Published shop coordinate. Gunsmiths and fences sell ammunition.",
    note: `Source id ${textName}.`,
    region
  }));
}

function stableHorse(id, title, breed, coat, price, chapter, shopId, region, directions) {
  const point = shopAt("stable", shopId);
  pins.push(pin({
    id,
    category: "Horses",
    title,
    breed,
    coat,
    obtain: "Stable",
    price,
    chapter,
    lat: point.x,
    lng: point.y,
    sourceUrl: `${RDO}/shops.json`,
    sourceLat: point.x,
    sourceLng: point.y,
    directions,
    note: `Stable coordinate ${shopId}. Coats sold at the same stable share this exact point.`,
    region
  }));
}
stableHorse("horse-black-arabian", "Black Arabian", "Arabian", "Black", "$1,050", "Chapter 4", "shop_sdn_horse_shop", "Lemoyne — Saint Denis stable", "Buy it at the Saint Denis stable in Chapter 4. There is no wild Black Arabian herd.");
stableHorse("horse-gold-turkoman", "Gold Turkoman", "Turkoman", "Gold", "$950", "Chapter 4", "shop_sdn_horse_shop", "Lemoyne — Saint Denis stable", "Buy the Gold Turkoman at the Saint Denis stable in Chapter 4.");
stableHorse("horse-rose-grey-arabian", "Rose Grey Bay Arabian", "Arabian", "Rose Grey Bay", "$1,250", "Epilogue", "shop_blk_horse_shop", "West Elizabeth — Blackwater stable", "The Blackwater stable sells the Rose Grey Bay Arabian in the epilogue.");
stableHorse("horse-dark-bay-turkoman", "Dark Bay Turkoman", "Turkoman", "Dark Bay", "Blackwater stable, epilogue", "Epilogue", "shop_blk_horse_shop", "West Elizabeth — Blackwater stable", "The Blackwater stable stocks the Dark Bay Turkoman in the epilogue.");
stableHorse("horse-silver-mft", "Silver Dapple Pinto Missouri Fox Trotter", "Missouri Fox Trotter", "Silver Dapple Pinto", "Blackwater stable, epilogue", "Epilogue", "shop_blk_horse_shop", "West Elizabeth — Blackwater stable", "The Blackwater stable sells this coat in the epilogue.");
stableHorse("horse-hungarian-flaxen", "Flaxen Chestnut Hungarian Half-bred", "Hungarian Half-bred", "Flaxen Chestnut", "Valentine stable, early chapter", "Chapter 2, after the stable opens", "shop_val_horse_shop", "New Hanover — Valentine stable", "Buy it at the Valentine stable.");
stableHorse("horse-kentucky-saddler", "Kentucky Saddler", "Kentucky Saddler", "Stable coats", "Valentine stable, cheapest coats under $150", "Chapter 2, after the stable opens", "shop_val_horse_shop", "New Hanover — Valentine stable", "The Valentine stable stocks Kentucky Saddlers from Chapter 2. This is a common stable horse, pinned because riders look for it.");

const white = fromKnocks("Horse - White Arabian");
pins.push(pin({
  id: "horse-white-arabian",
  category: "Horses",
  title: "White Arabian",
  breed: "Arabian",
  coat: "White",
  obtain: "Wild",
  price: "Not sold. Guides list a $1,200 base value.",
  chapter: "Chapter 2, after Exit, Pursued by a Bruised Ego",
  ...white,
  sourceUrl: KNOCKS,
  directions: "Published White Arabian marker, on Lake Isabella. Approach slowly and save before you mount.",
  note: "There is no wild Black Arabian. The plotted point is the community horse marker converted into the RDOMap frame; it sits by the published Lake Isabella treasure-zone center.",
  region: "Ambarino — Lake Isabella"
}));

const tiger = fromKnocks("Horse - Tiger-striped Bay Mustang");
pins.push(pin({
  id: "horse-tiger-mustang",
  category: "Horses",
  title: "Tiger Striped Bay Mustang",
  breed: "Mustang",
  coat: "Tiger Striped Bay",
  obtain: "Wild",
  price: "Not sold.",
  chapter: "Epilogue",
  ...tiger,
  sourceUrl: KNOCKS,
  directions: "Published Tiger-striped Bay Mustang marker. New Austin is closed until the epilogue.",
  note: "Converted from the community horse marker into the RDOMap frame.",
  region: "New Austin"
}));

const tumble = fast.find(item => item.text === "fasttravel.tumbleweed");
pins.push(pin({
  id: "horse-silver-turkoman",
  category: "Horses",
  title: "Silver Turkoman",
  breed: "Turkoman",
  coat: "Silver",
  obtain: "Stable",
  price: "Tumbleweed stable, epilogue",
  chapter: "Epilogue",
  lat: tumble.x,
  lng: tumble.y,
  sourceUrl: `${RDO}/fasttravels.json`,
  sourceLat: tumble.x,
  sourceLng: tumble.y,
  approximate: true,
  directions: "The Silver Turkoman is sold at the Tumbleweed stable in the epilogue. This published point is the Tumbleweed fast-travel post, not a separate stall coordinate.",
  note: "Approximate. The source file has a town fast-travel point and no Tumbleweed stable interior.",
  region: "New Austin — Tumbleweed"
}));

const usedDiscoverable = new Set([
  "discoverable_strange_statues"
]);
for (const place of pois.values()) {
  if (usedDiscoverable.has(place.name)) continue;
  const title = place.name.replace(/^discoverable_/, "").replaceAll("_", " ");
  pins.push(rdo(`sec-${place.name}`, "Secrets", title, place, {
    directions: "Published story discoverable.",
    note: `Source name ${place.name}.`,
    region: "Story mode"
  }));
}

const secretUpdates = {
  "sec-ufo-emerald": text.get("shack_looney_cult"),
  "sec-giant": pois.get("discoverable_giant_remains"),
  "sec-luckys-cabin": text.get("landmark_luckys_cabin"),
  "sec-meteor-house": pois.get("discoverable_meteor_house"),
  "sec-meteor-crater": pois.get("discoverable_meteorite"),
  "sec-fossil-man": pois.get("discoverable_fossilised_man"),
  "sec-whale": pois.get("discoverable_whale_bone"),
  "sec-manito": text.get("shack_angry_isolationist"),
  "sec-doverhill": text.get("landmark_doverhill"),
  "sec-icarus": pois.get("discoverable_flying_machine"),
  "sec-pleasance": text.get("landmark_pleasance_house")
};

const hiddenUpdates = {
  "strange-statues-cave": { point: pois.get("discoverable_strange_statues"), sourceUrl: `${RDO}/discoverables.json` },
  "mount-shann-cave": { point: pois.get("discoverable_giant_remains"), sourceUrl: `${RDO}/discoverables.json` },
  "beaver-hollow": { point: text.get("hideout_beaver_hollow"), sourceUrl: `${RDO}/discoverables.json` },
  "cochinay": { point: text.get("landmark_cochinay"), sourceUrl: `${RDO}/discoverables.json` },
  "elysian-mine": { point: text.get("shack_poison_leak"), sourceUrl: `${RDO}/discoverables.json` },
  "gaptooth-breach": { point: text.get("hideout_gaptooth_breach"), sourceUrl: `${RDO}/discoverables.json` },
  "luckys-cabin": { point: text.get("landmark_luckys_cabin"), sourceUrl: `${RDO}/discoverables.json` },
  "valentine-doctor": { point: shopAt("doctor", "shop_val_doctor"), sourceUrl: `${RDO}/shops.json`, shop: true },
  "rhodes-gunsmith": { point: shopAt("gunsmith", "shop_rho_gunsmith"), sourceUrl: `${RDO}/shops.json`, shop: true },
  "the-loft": { point: text.get("landmark_the_loft"), sourceUrl: `${RDO}/discoverables.json` },
  "meteor-house": { point: pois.get("discoverable_meteor_house"), sourceUrl: `${RDO}/discoverables.json` },
  "meteor-crater": { point: pois.get("discoverable_meteorite"), sourceUrl: `${RDO}/discoverables.json` },
  "viking-tomb": { point: fromKnocks("Viking Hatchet"), sourceUrl: KNOCKS, knocks: true },
  "window-rock": { point: pois.get("discoverable_strange_statues_painting"), sourceUrl: `${RDO}/discoverables.json`, approximate: true, note: "Approximate. This is the published strange-statues painting, which the guide associates with Window Rock, not a separate overhang survey." },
  "high-stakes-ledge": { point: gameToMap(361.913, 1461.297), sourceUrl: PASTEBIN, game: [361.913, 1461.297], approximate: true, note: "Approximate. This is the published Fort Wallace coordinate. The cliff ledge is not a separate point in the source file." }
};

function applyPoint(entry, update) {
  const point = update.point;
  const lat = update.shop ? point.x : (update.knocks ? point.lat : (update.game ? point.lat : point.lat));
  const lng = update.shop ? point.y : (update.knocks ? point.lng : (update.game ? point.lng : point.lng));
  const sourceLat = update.knocks ? point.sourceLat : (update.game ? update.game[0] : lat);
  const sourceLng = update.knocks ? point.sourceLng : (update.game ? update.game[1] : lng);
  entry.lat = round(lat);
  entry.lng = round(lng);
  entry.sourceUrl = update.sourceUrl;
  entry.sourceLat = round(sourceLat);
  entry.sourceLng = round(sourceLng);
  entry.x = round((entry.lng / 176) * 100);
  entry.y = round((-entry.lat / 144) * 100);
  if (update.approximate) {
    entry.approximate = true;
    entry.accuracyNote = update.note;
  } else {
    delete entry.approximate;
    delete entry.accuracyNote;
  }
  delete entry.gameX;
  delete entry.gameY;
  delete entry.county;
}

const dropped = [
  "Granite Pass train wreck: no exact coordinate in RDOMap, the community marker file, or the published coordinate list.",
  "Red Chestnut Arabian, Warped Brindle Arabian, Perlino Andalusian, wild Nokota at Little Creek, Few Spotted Appaloosa, wild Hungarian Half-bred, Tennessee Walker herd, Amber Champagne Missouri Fox Trotter, Black Arabian night encounter: no exact point in the source files. The Nokota spawn table's nearest point is 37 map units from the Little Creek landmark, so it was not used.",
  "Calloway's Revolver, Flaco's Revolver, Midnight's Pistol, Otis Miller's revolver, Algernon's Revolver, Wicked Broken Knife, Hamish Lancaster: no exact free-roam point in the source files.",
  "Strawberry gunsmith: the RDOMap shop file has no Strawberry gunsmith.",
  "Northern pike in the legendary-fish table was not added. It is not one of the story legendary fish."
];

const fit = {
  latCoeff,
  lngCoeff,
  pairs: PAIRS.map(([name, source, target]) => {
    const mapped = knocksToRdo(source[0], source[1]);
    const error = Math.hypot(mapped.lat - target[0], mapped.lng - target[1]);
    return { name, error: round(error) };
  }),
  shotgunVersusShack: round(Math.hypot(shotgun.lat - isolation.lat, shotgun.lng - isolation.lng)),
  whiteVersusIsabella: round(Math.hypot(white.lat - (-36.907), white.lng - 84.3357)),
  dropped
};

for (const tree of trees) {
  writeFileSync(join(tree, "map.json"), `${JSON.stringify(pins, null, 2)}\n`);
  const legendaries = JSON.parse(readFileSync(join(tree, "legendaries.json"), "utf8"));
  for (const animal of legendaries) {
    const match = pins.find(item => item.id === `leg-${animal.id}`);
    animal.lat = match.lat;
    animal.lng = match.lng;
    animal.sourceUrl = match.sourceUrl;
    animal.sourceLat = match.sourceLat;
    animal.sourceLng = match.sourceLng;
    animal.x = match.lng;
    animal.y = match.lat;
    delete animal.gameX;
    delete animal.gameY;
    delete animal.county;
  }
  writeFileSync(join(tree, "legendaries.json"), `${JSON.stringify(legendaries, null, 2)}\n`);

  const secrets = JSON.parse(readFileSync(join(tree, "secrets.json"), "utf8"));
  for (const secret of secrets) {
    for (const marker of secret.markers || []) {
      const point = secretUpdates[marker.id];
      if (!point) {
        delete marker.x;
        delete marker.y;
        delete marker.lat;
        delete marker.lng;
        delete marker.gameX;
        delete marker.gameY;
        marker.approximate = true;
        marker.accuracyNote = "No exact published coordinate. This secret stays in the list and is not pinned.";
        continue;
      }
      marker.lat = round(point.lat);
      marker.lng = round(point.lng);
      marker.sourceUrl = `${RDO}/discoverables.json`;
      marker.sourceLat = round(point.lat);
      marker.sourceLng = round(point.lng);
      marker.x = round((marker.lng / 176) * 100);
      marker.y = round((-marker.lat / 144) * 100);
      delete marker.approximate;
      delete marker.gameX;
      delete marker.gameY;
    }
  }
  writeFileSync(join(tree, "secrets.json"), `${JSON.stringify(secrets, null, 2)}\n`);

  const hidden = JSON.parse(readFileSync(join(tree, "hidden-places.json"), "utf8"));
  for (const place of hidden) {
    const update = hiddenUpdates[place.id];
    if (!update) {
      delete place.lat;
      delete place.lng;
      delete place.x;
      delete place.y;
      delete place.gameX;
      delete place.gameY;
      delete place.county;
      place.approximate = true;
      place.accuracyNote = "No exact published coordinate. Shown in the list only.";
      continue;
    }
    applyPoint(place, update);
  }
  writeFileSync(join(tree, "hidden-places.json"), `${JSON.stringify(hidden, null, 2)}\n`);
}

writeFileSync(join(root, "lib/frame-fit.json"), `${JSON.stringify(fit, null, 2)}\n`);
const exact = pins.filter(item => !item.approximate).length;
console.log(`pins ${pins.length} exact ${exact} approximate ${pins.length - exact}`);
console.log(`shotgun vs shack ${fit.shotgunVersusShack} white vs isabella ${fit.whiteVersusIsabella}`);
console.log(fit.pairs.map(item => `${item.name} ${item.error}`).join("\n"));
