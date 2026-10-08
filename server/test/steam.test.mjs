import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { matchSightings } from "../detect.mjs";
import { createLinkHub } from "../link.mjs";
import { createApp } from "../server.mjs";
import {
  buildSteamLoginUrl,
  extractSteamId,
  mergeAchievementProgress,
  parsePlaytimeHours,
  steamProfileIsPrivate,
  verifySteamAssertion
} from "../steam.mjs";

const silentLogger = { log() {}, error() {} };
const player = JSON.parse(readFileSync(new URL("./fixtures/steam-player.json", import.meta.url), "utf8"));
const schema = JSON.parse(readFileSync(new URL("./fixtures/steam-schema.json", import.meta.url), "utf8"));
const owned = JSON.parse(readFileSync(new URL("./fixtures/steam-owned.json", import.meta.url), "utf8"));
const privateProfile = JSON.parse(readFileSync(new URL("./fixtures/steam-private.json", import.meta.url), "utf8"));

async function withServer(app, run) {
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    listening.once("error", reject);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await run(baseUrl);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test("Steam achievement fixtures keep unlock state, icons, dates, and percent", () => {
  const progress = mergeAchievementProgress(player, schema);
  assert.equal(progress.total, 2);
  assert.equal(progress.unlocked, 1);
  assert.equal(progress.percent, 50);
  assert.equal(progress.achievements[0].name, "Back in the Mud");
  assert.equal(progress.achievements[0].unlocked, true);
  assert.equal(progress.achievements[0].unlockTime, 1609459200);
  assert.equal(progress.achievements[0].icon, "https://steamcdn.example/back.jpg");
  assert.equal(progress.achievements[1].name, "Horseman");
  assert.equal(progress.achievements[1].unlocked, false);
  assert.equal(progress.achievements[1].icon, "https://steamcdn.example/horse-locked.jpg");
  assert.equal(progress.achievements[1].unlockTime, 0);
  assert.equal(parsePlaytimeHours(owned), 42.5);
  assert.equal(steamProfileIsPrivate(200, privateProfile), true);
  assert.equal(steamProfileIsPrivate(403, {}), true);
});

test("Steam OpenID returns a SteamID64 only after Steam says the assertion is valid", async () => {
  const claimed = "https://steamcommunity.com/openid/id/76561198000000000";
  assert.equal(extractSteamId(claimed), "76561198000000000");
  assert.equal(extractSteamId("https://example.com/openid/id/76561198000000000"), "");
  const login = new URL(buildSteamLoginUrl({
    realm: "https://frontier-guide-api.onrender.com",
    returnTo: "https://frontier-guide-api.onrender.com/auth/steam/callback?nonce=abc1234567890123"
  }));
  assert.equal(login.hostname, "steamcommunity.com");
  assert.equal(login.searchParams.get("openid.mode"), "checkid_setup");
  const params = { "openid.claimed_id": claimed, "openid.mode": "id_res" };
  const rejected = await verifySteamAssertion(params, async () => new Response("is_valid:false\n"));
  assert.equal(rejected, "");
  const accepted = await verifySteamAssertion(params, async () => new Response("ns:http://specs.openid.net/auth/2.0\nis_valid:true\n"));
  assert.equal(accepted, "76561198000000000");
});

test("progress stays disabled until a Steam Web API key is configured", async () => {
  const app = createApp({ env: { FRONTIER_CLIENT_TOKEN: "frontier-secret" }, logger: silentLogger });
  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/steam/progress?steamId=76561198000000000`, {
      headers: { "x-frontier-key": "frontier-secret" }
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.code, "steam_disabled");
    assert.match(body.error, /STEAM_API_KEY/);
    assert.match(body.error, /public/i);
  });
});

test("progress uses the recorded Steam responses and a private profile is explained", async () => {
  const calls = [];
  const fetchImpl = async url => {
    const target = String(url);
    calls.push(target);
    if (target.includes("GetPlayerAchievements")) return Response.json(player);
    if (target.includes("GetSchemaForGame")) return Response.json(schema);
    if (target.includes("GetOwnedGames")) return Response.json(owned);
    return new Response("missing", { status: 404 });
  };
  const app = createApp({
    env: { FRONTIER_CLIENT_TOKEN: "frontier-secret", STEAM_API_KEY: "steam-test-key" },
    fetchImpl,
    logger: silentLogger
  });
  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/steam/progress?steamId=76561198000000000`, {
      headers: { "x-frontier-key": "frontier-secret" }
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.hoursPlayed, 42.5);
    assert.equal(body.percent, 50);
    assert.equal(body.achievements[0].name, "Back in the Mud");
    assert.equal(calls.length, 3);
    assert.match(calls[0], /appid=1174180/);
    assert.match(calls[0], /key=steam-test-key/);
  });

  const privateFetch = async url => {
    if (String(url).includes("GetPlayerAchievements")) return Response.json(privateProfile);
    return Response.json({});
  };
  const privateApp = createApp({
    env: { FRONTIER_CLIENT_TOKEN: "frontier-secret", STEAM_API_KEY: "steam-test-key" },
    fetchImpl: privateFetch,
    logger: silentLogger
  });
  await withServer(privateApp, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/steam/progress?steamId=76561198000000000`, {
      headers: { "x-frontier-key": "frontier-secret" }
    });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.code, "steam_private");
    assert.match(body.error, /Game details, to Public/);
  });
});

test("empty Steam stats ask for public game details", async () => {
  const fetchImpl = async url => {
    if (String(url).includes("GetPlayerAchievements")) {
      return Response.json({ playerstats: { steamID: "76561198000000000", success: true, achievements: [] } });
    }
    return Response.json({});
  };
  const app = createApp({
    env: { FRONTIER_CLIENT_TOKEN: "frontier-secret", STEAM_API_KEY: "steam-test-key" },
    fetchImpl,
    logger: silentLogger
  });
  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/steam/progress?steamId=76561198000000000`, {
      headers: { "x-frontier-key": "frontier-secret" }
    });
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.code, "steam_empty");
    assert.match(body.error, /Game details, to Public/);
  });
});

test("a connected Steam profile includes the persona name and avatar", async () => {
  const fetchImpl = async url => {
    if (String(url).includes("GetPlayerSummaries")) {
      return Response.json({
        response: {
          players: [{
            steamid: "76561198000000000",
            personaname: "Arthur",
            avatarmedium: "https://avatars.steamstatic.com/arthur.jpg"
          }]
        }
      });
    }
    return Response.json({});
  };
  const app = createApp({
    env: { FRONTIER_CLIENT_TOKEN: "frontier-secret", STEAM_API_KEY: "steam-test-key" },
    fetchImpl,
    logger: silentLogger
  });
  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/steam/profile?steamId=76561198000000000`, {
      headers: { "x-frontier-key": "frontier-secret" }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      steamId: "76561198000000000",
      personaName: "Arthur",
      avatar: "https://avatars.steamstatic.com/arthur.jpg"
    });
  });
  const missing = createApp({ env: { FRONTIER_CLIENT_TOKEN: "frontier-secret" }, logger: silentLogger });
  await withServer(missing, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/steam/profile?steamId=76561198000000000`, {
      headers: { "x-frontier-key": "frontier-secret" }
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "steam_disabled");
  });
});

test("OpenID callback stores the SteamID64 for the phone to pick up", async () => {
  const fetchImpl = async () => new Response("is_valid:true\n");
  const app = createApp({
    env: { FRONTIER_CLIENT_TOKEN: "frontier-secret" },
    fetchImpl,
    logger: silentLogger
  });
  await withServer(app, async baseUrl => {
    const start = await fetch(`${baseUrl}/auth/steam?nonce=nonce1234567890ab`, { redirect: "manual" });
    assert.equal(start.status, 302);
    assert.match(start.headers.get("location"), /steamcommunity\.com\/openid\/login/);
    const callback = await fetch(`${baseUrl}/auth/steam/callback?nonce=nonce1234567890ab&openid.claimed_id=${encodeURIComponent("https://steamcommunity.com/openid/id/76561198000000000")}&openid.mode=id_res`);
    assert.equal(callback.status, 200);
    assert.match(await callback.text(), /76561198000000000/);
    const session = await fetch(`${baseUrl}/api/steam/session?nonce=nonce1234567890ab`, {
      headers: { "x-frontier-key": "frontier-secret" }
    });
    assert.deepEqual(await session.json(), { status: "connected", steamId: "76561198000000000" });
  });
});

test("Frontier Link pairs with a 6-digit code and only accepts known collectible ids", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frontier-link-app-"));
  const app = createApp({
    env: { FRONTIER_CLIENT_TOKEN: "frontier-secret", LINK_STORE_PATH: join(dir, "sessions.json") },
    logger: silentLogger
  });
  try {
  await withServer(app, async baseUrl => {
    const paired = await fetch(`${baseUrl}/api/link/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-frontier-key": "frontier-secret" },
      body: "{}"
    });
    const phone = await paired.json();
    assert.match(phone.code, /^\d{6}$/);
    assert.match(phone.qrSvg, /<svg/);
    const absent = phone.code === "000000" ? "111111" : "000000";
    const missing = await fetch(`${baseUrl}/api/link/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: absent })
    });
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error, /Show pairing code again/);
    const claim = await fetch(`${baseUrl}/api/link/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: phone.code })
    });
    assert.equal(claim.status, 200);
    const helper = await claim.json();
    const frame = "data:image/jpeg;base64,/9j/4AAQ";
    const posted = await fetch(`${baseUrl}/api/link/frame`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${helper.token}` },
      body: JSON.stringify({ imageDataUrl: frame, capturedAt: "2026-01-02T00:00:00.000Z" })
    });
    assert.equal(posted.status, 200);
    const latest = await fetch(`${baseUrl}/api/link/frame?token=${encodeURIComponent(phone.token)}`, {
      headers: { "x-frontier-key": "frontier-secret" }
    });
    assert.equal((await latest.json()).imageDataUrl, frame);
    const sight = await fetch(`${baseUrl}/api/link/sightings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${helper.token}` },
      body: JSON.stringify({
        marks: [
          { id: "horse-white-arabian", title: "White Arabian" },
          { id: "not-a-real-place", title: "Nope" }
        ],
        text: "You picked up a Gold Bar"
      })
    });
    assert.equal(sight.status, 200);
    const events = await fetch(`${baseUrl}/api/link/events?token=${encodeURIComponent(phone.token)}&since=0`, {
      headers: { "x-frontier-key": "frontier-secret" }
    });
    const body = await events.json();
    assert.equal(body.events.some(item => item.id === "horse-white-arabian"), true);
    assert.equal(body.events.some(item => item.id === "not-a-real-place"), false);
    assert.equal(body.events.some(item => item.promptKind === "gold-bar"), true);
  });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("on-screen text marks a named collectible and asks before a generic gold bar", () => {
  const places = [
    { id: "horse-white-arabian", title: "White Arabian", category: "Horse" },
    { id: "leg-bull-gator", title: "Legendary Bull Gator", category: "Legendary" },
    { id: "gold-limpany", title: "Limpany gold bar", category: "Gold" },
    { id: "gold-braithwaite", title: "Braithwaite Manor gold", category: "Gold" }
  ];
  const named = matchSightings("Legendary Bull Gator pelt added", places);
  assert.deepEqual(named.marks.map(item => item.id), ["leg-bull-gator"]);
  assert.equal(named.prompts.length, 0);
  const generic = matchSightings("You received a Gold Bar", places);
  assert.equal(generic.marks.length, 0);
  assert.equal(generic.prompts[0].kind, "gold-bar");
  assert.deepEqual(generic.prompts[0].candidates.map(item => item.id), ["gold-limpany", "gold-braithwaite"]);
  const challenge = matchSightings("Challenge Complete", places);
  assert.equal(challenge.prompts.some(item => item.kind === "challenge"), true);
});

test("a pairing code survives a new hub and a frame is not written to disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "frontier-link-"));
  const storePath = join(dir, "link-sessions.json");
  try {
    let clock = 5_000;
    const first = createLinkHub({ now: () => clock, ttlMs: 10 * 60 * 1000, storePath });
    const pair = first.createPair();
    const claimed = first.claim(pair.code);
    assert.equal(first.saveFrame(claimed.token, "data:image/jpeg;base64,aaaa", "2026-01-02T00:00:00.000Z"), true);
    const raw = readFileSync(storePath, "utf8");
    assert.equal(raw.includes("image/jpeg"), false);
    const second = createLinkHub({ now: () => clock, ttlMs: 10 * 60 * 1000, storePath });
    assert.equal(second.status(pair.token).paired, true);
    assert.equal(second.claim(pair.code), null);
    clock += 11 * 60 * 1000;
    const third = createLinkHub({ now: () => clock, ttlMs: 10 * 60 * 1000, storePath });
    assert.equal(third.status(pair.token), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pairing hub expires nothing while the code is fresh", () => {
  let clock = 1_000;
  const hub = createLinkHub({ now: () => clock, ttlMs: 50 });
  const pair = hub.createPair();
  assert.equal(hub.claim("000000"), null);
  const claimed = hub.claim(pair.code);
  assert.ok(claimed.token);
  clock = 2_000;
  assert.equal(hub.status(pair.token), null);
});
