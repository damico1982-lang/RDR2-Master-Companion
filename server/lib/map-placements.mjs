// Game-world anchors for every pinned marker.
// Town shops: Dimmies/redm-locations and femga interiors, cross-checked against each other.
// Named landmarks: Jean Ropke treasure-zone centers converted with the leaflet formula
// that matches the Gaptooth Breach mine, then shifted by the IGN/Fandom direction.
// A few story sites use a published coordinate paste cross-checked with those landmarks.

export const COORDINATES = [
  ["legendaries", "bull-gator", 2180, -720, "Bayou Nwa"],
  ["legendaries", "beaver", 2550, 500, "Roanoke Ridge"],
  ["legendaries", "bharati-bear", 1970, 1950, "Grizzlies East"],
  ["legendaries", "bighorn-ram", -780, 900, "Cumberland Forest"],
  ["legendaries", "boar", 2100, -280, "Bluewater Marsh"],
  ["legendaries", "buck", -2645, 153, "Big Valley"],
  ["legendaries", "cougar", -5800, -2900, "Gaptooth Ridge"],
  ["legendaries", "coyote", 900, -1100, "Scarlett Meadows"],
  ["legendaries", "elk", 900, 1650, "Cumberland Forest"],
  ["legendaries", "fox", 1400, -900, "Scarlett Meadows"],
  ["legendaries", "moose", 2850, 1900, "Roanoke Ridge"],
  ["legendaries", "giaguaro", 1600, -2000, "Scarlett Meadows"],
  ["legendaries", "pronghorn", -3900, -3650, "Rio Bravo"],
  ["legendaries", "tatanka", -2200, -2600, "Hennigan's Stead"],
  ["legendaries", "white-bison", -1660, 1860, "Grizzlies West"],
  ["legendaries", "wolf", 250, 1850, "Grizzlies East"],

  ["secrets", "sec-strange-man", 1100, -2000, "Scarlett Meadows"],
  ["secrets", "sec-vampire", 2680, -1250, "Bayou Nwa"],
  ["secrets", "sec-ufo-emerald", 1470, 804, "Heartlands"],
  ["secrets", "sec-ufo-shann", -2200, 200, "Big Valley"],
  ["secrets", "sec-giant", -2450, 40, "Big Valley"],
  ["secrets", "sec-ghost-train", 1500, -1700, "Scarlett Meadows"],
  ["secrets", "sec-agnes", 2300, -450, "Bluewater Marsh"],
  ["secrets", "sec-murder-valentine", -300, 500, "Heartlands"],
  ["secrets", "sec-murder-wallace", -1500, 200, "Big Valley"],
  ["secrets", "sec-murder-braithwaite", 1300, -1700, "Scarlett Meadows"],
  ["secrets", "sec-luckys-cabin", -500, 400, "Heartlands"],
  ["secrets", "sec-viking", 3400, 1500, "Roanoke Ridge"],
  ["secrets", "sec-meteor-house", 2500, 1900, "Roanoke Ridge"],
  ["secrets", "sec-meteor-crater", 2300, 2100, "Roanoke Ridge"],
  ["secrets", "sec-sinclair", -1850, 400, "Big Valley"],
  ["secrets", "sec-fossil-man", 2700, 2100, "Roanoke Ridge"],
  ["secrets", "sec-whale", -3000, 0, "Big Valley"],
  ["secrets", "sec-manito", 2930, 1650, "Roanoke Ridge"],
  ["secrets", "sec-doverhill", 2529, 2289, "Roanoke Ridge"],
  ["secrets", "sec-icarus", -1200, 2300, "Grizzlies West"],
  ["secrets", "sec-hill-home", 1200, 2100, "Grizzlies East"],
  ["secrets", "sec-pleasance", 1600, -700, "Scarlett Meadows"],
  ["secrets", "sec-two-crows", -4200, -3400, "Rio Bravo"],

  ["hidden", "elysian-cave", 2380, 220, "Roanoke Ridge"],
  ["hidden", "strange-statues-cave", 1250, 2050, "Grizzlies East"],
  ["hidden", "mount-shann-cave", -2350, 80, "Big Valley"],
  ["hidden", "beaver-hollow", 2352, 1358, "Roanoke Ridge"],
  ["hidden", "cochinay", -2300, -1800, "Tall Trees"],
  ["hidden", "elysian-mine", 2450, 420, "Roanoke Ridge"],
  ["hidden", "gaptooth-breach", -6001, -3319, "Gaptooth Ridge"],
  ["hidden", "luckys-cabin", -500, 400, "Heartlands"],
  ["hidden", "valentine-doctor", -278, 807, "Heartlands"],
  ["hidden", "rhodes-gunsmith", 1326, -1324, "Scarlett Meadows"],
  ["hidden", "viking-tomb", 3380, 1480, "Roanoke Ridge"],
  ["hidden", "window-rock", 500, 2000, "Grizzlies East"],
  ["hidden", "granite-pass", 80, 1750, "Cumberland Forest"],
  ["hidden", "high-stakes-ledge", 700, 1650, "Cumberland Forest"],
  ["hidden", "calibans-seat", 1900, 2050, "Grizzlies East"],
  ["hidden", "the-loft", 2800, 1650, "Roanoke Ridge"],
  ["hidden", "meteor-house", 2500, 1900, "Roanoke Ridge"],
  ["hidden", "meteor-crater", 2300, 2100, "Roanoke Ridge"],
  ["hidden", "whinyard-strait", -2000, 1600, "Grizzlies West"],
  ["hidden", "spider-gorge", -800, 2000, "Grizzlies West"],

  ["map", "limpany-gold", -354, -124, "Heartlands"],
  ["map", "train-wreck-gold", 80, 1750, "Cumberland Forest"],
  ["map", "strange-statues", 1250, 2050, "Grizzlies East"],
  ["map", "braithwaite-gold", 1011, -1741, "Scarlett Meadows"],
  ["map", "jack-hall-final", 1971, 1750, "Grizzlies East"],
  ["map", "high-stakes-final", 720, 1680, "Cumberland Forest"],
  ["map", "poisonous-trail-final", 2380, 220, "Roanoke Ridge"],
  ["map", "landmarks-riches-final", -2200, 220, "Big Valley"],
  ["map", "emerald-ranch-fence", 1417.818, 268.03, "Heartlands"],
  ["map", "saint-denis-fence", 2849.29, -1203.05, "Bayou Nwa"],
  ["map", "rhodes-fence", 1450, -1250, "Scarlett Meadows"],
  ["map", "aberdeen-stash", 1900, -700, "Scarlett Meadows"],
  ["map", "online-bounty-board", -272.5, 805.2, "Heartlands"]
];

export const TEXT_PATCHES = {
  "legendaries:bighorn-ram": {
    regionName: "New Hanover",
    region: "New Hanover — Cumberland Forest, just east of Cattail Pond",
    landmark: "The hills east of Cattail Pond, north of the railroad. Cattail Pond itself sits west of Valentine; the ram is on the pond's east side."
  },
  "legendaries:coyote": {
    region: "Lemoyne — west end of Dewberry Creek, northwest of Rhodes",
    landmark: "The west end of Dewberry Creek"
  },
  "legendaries:moose": {
    region: "New Hanover — Roanoke Ridge, tracks north of Annesburg and upriver from Brandywine Drop",
    landmark: "The Kamassa country north of Annesburg, upriver from Brandywine Drop"
  },
  "legendaries:giaguaro": {
    region: "Lemoyne — woods south of Bolger Glade and west of Shady Belle",
    landmark: "The woods south of Bolger Glade. Older guides misspell it Bolder Blade."
  },
  "legendaries:pronghorn": {
    region: "New Austin — Rio Bravo, east and slightly south of Fort Mercer",
    landmark: "The plain east of Fort Mercer, toward Rio del Lobo Rock"
  },
  "legendaries:white-bison": {
    region: "Ambarino — north shore of Lake Isabella, Grizzlies West",
    landmark: "The snowy north shore of Lake Isabella"
  },
  "legendaries:buck": {
    landmark: "Black Bone Forest, at the western foot of Mount Shann. This is not the Ringneck Creek herd."
  },
  "legendaries:bull-gator": {
    landmark: "The swamp shore just west of Lakay, in Bayou Nwa. The territory meets Bluewater Marsh, but the hunt is the Lakay side."
  },
  "map:emerald-ranch-fence": {
    category: "Ammo",
    shop: true,
    directions: "Seamus's wagon barn on the south side of Emerald Ranch. The fence sells ammunition and buys valuables. Story access opens in early Chapter 2.",
    note: "Shop. Cross-checked with the Emerald Ranch fence coordinate used by story-mode maps."
  },
  "map:saint-denis-fence": {
    category: "Ammo",
    shop: true,
    region: "Lemoyne — Saint Denis",
    directions: "The Saint Denis fence is in the market, northeast of the stables. He sells ammunition and special ammo and buys valuables.",
    note: "Shop. The pin is the fence's published stall coordinate, not a random alley."
  },
  "map:rhodes-fence": {
    category: "Ammo",
    shop: true,
    region: "Lemoyne — northeast side of Rhodes",
    directions: "The Rhodes fence stands on the northeast side of town, off the general-store block. He sells ammunition and buys valuables.",
    note: "Shop. Placed from the Rhodes town block, northeast of the sheriff's office."
  },
  "map:aberdeen-stash": {
    region: "Lemoyne — Scarlett Meadows, southeast of Emerald Ranch",
    directions: "If the Aberdeen encounter takes Arthur's money, return to the pig farm southeast of Emerald Ranch and look behind the portrait near the front door."
  },
  "map:online-bounty-board": {
    title: "Valentine bounty board",
    region: "New Hanover — Valentine",
    directions: "This pin is the Valentine bounty board. Other towns and stations have their own boards. In Red Dead Online, bounty work needs the Bounty Hunter license.",
    note: "The board coordinate is the Valentine bounty-board interior. Payouts change with the role and with limited-time bonuses."
  },
  "map:train-wreck-gold": {
    region: "New Hanover — Cumberland Forest, the Granite Pass ravine on the Ambarino line",
    directions: "The wreck sits in the ravine southwest of Cotorra Springs, where Cumberland Forest meets the Grizzlies. Climb down to the upright car."
  }
};
