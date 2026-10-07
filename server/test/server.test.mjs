import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createApp, parseCoachAnswer } from "../server.mjs";

const silentLogger = { log() {}, error() {} };

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
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
}

function mockOpenAI(calls) {
  return async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({
      output: [{
        type: "message",
        content: [{
          type: "output_text",
          text: "Head west, then check the ridge.",
          annotations: [{
            type: "url_citation",
            title: "Rockstar Games",
            url: "https://www.rockstargames.com/"
          }]
        }]
      }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
}

test("GET /api/health stays public for Render and reports readiness", async () => {
  const app = createApp({
    env: {
      OPENAI_API_KEY: "test-key",
      OPENAI_MODEL: "gpt-6-luna",
      FRONTIER_CLIENT_TOKEN: "frontier-secret"
    },
    logger: silentLogger
  });

  await withServer(app, async baseUrl => {
    const unauthenticated = await fetch(`${baseUrl}/api/health`);
    assert.equal(unauthenticated.status, 200);
    assert.deepEqual(await unauthenticated.json(), {
      ok: true,
      configured: true,
      model: "gpt-6-luna",
      authRequired: true,
      authorized: false,
      version: "1.5.3",
      tts: {
        enabled: true,
        model: "gpt-4o-mini-tts",
        voice: "onyx"
      }
    });

    const authenticated = await fetch(`${baseUrl}/api/health`, {
      headers: { "x-frontier-key": "frontier-secret" }
    });
    assert.equal(authenticated.status, 200);
    assert.equal((await authenticated.json()).authorized, true);
  });
});

test("GET / serves the installable Frontier Guide web app", async () => {
  const app = createApp({ logger: silentLogger });

  await withServer(app, async baseUrl => {
    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    assert.match(await page.text(), /Frontier Guide — RDR2 Companion/);

    const script = await fetch(`${baseUrl}/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("cache-control") || "", /no-cache/);
    assert.match(await script.text(), /hostedApiBase/);

    const api = await fetch(`${baseUrl}/api`);
    assert.equal(api.status, 200);
    assert.deepEqual((await api.json()).endpoints, ["/api/health", "/api/ask", "/api/speak", "/api/coach", "/api/live-update"]);
  });
});

test("protected routes reject a missing app access key", async () => {
  const app = createApp({
    env: { OPENAI_API_KEY: "test-key", FRONTIER_CLIENT_TOKEN: "frontier-secret" },
    logger: silentLogger
  });

  await withServer(app, async baseUrl => {
    const ask = await fetch(`${baseUrl}/api/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "Where is camp?" })
    });
    assert.equal(ask.status, 401);
    assert.match((await ask.json()).error, /access key/i);

    const update = await fetch(`${baseUrl}/api/live-update`, { method: "POST" });
    assert.equal(update.status, 401);
  });
});

test("first-party Android and hosted web clients work without manual token entry", async () => {
  const calls = [];
  const app = createApp({
    env: {
      OPENAI_API_KEY: "test-key",
      FRONTIER_CLIENT_TOKEN: "frontier-secret",
      ALLOWED_ORIGINS: "https://appassets.androidplatform.net"
    },
    fetchImpl: mockOpenAI(calls),
    logger: silentLogger
  });

  await withServer(app, async baseUrl => {
    const android = await fetch(`${baseUrl}/api/ask`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://appassets.androidplatform.net"
      },
      body: JSON.stringify({ question: "What should I do next?", mode: "online" })
    });
    assert.equal(android.status, 200);

    const hosted = await fetch(`${baseUrl}/api/ask`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ question: "Where is the treasure?" })
    });
    assert.equal(hosted.status, 200);
    assert.equal(calls.length, 2);
  });
});

test("POST /api/ask sends vision-ready Responses API input", async () => {
  const calls = [];
  const app = createApp({
    env: {
      OPENAI_API_KEY: "test-key",
      OPENAI_MODEL: "gpt-6-luna",
      FRONTIER_CLIENT_TOKEN: "frontier-secret"
    },
    fetchImpl: mockOpenAI(calls),
    logger: silentLogger
  });

  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/ask`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-frontier-key": "frontier-secret"
      },
      body: JSON.stringify({
        question: "What am I looking at?",
        mode: "story",
        imageDataUrl: "data:image/jpeg;base64,YQ==",
        live: true,
        history: [
          { role: "user", content: "I am near Valentine." },
          { role: "assistant", content: "Head toward the station." }
        ]
      })
    });

    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.answer, "Head west, then check the ridge.");
    assert.deepEqual(data.sources, [{ title: "Rockstar Games", url: "https://www.rockstargames.com/" }]);
    assert.equal(data.model, "gpt-6-luna");

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.openai.com/v1/responses");
    assert.equal(calls[0].body.model, "gpt-6-luna");
    assert.equal(calls[0].body.store, false);
    assert.deepEqual(calls[0].body.tools, [{ type: "web_search", search_context_size: "medium" }]);
    const lastTurn = calls[0].body.input.at(-1);
    assert.equal(lastTurn.role, "user");
    assert.equal(lastTurn.content[1].type, "input_image");
    assert.match(lastTurn.content[0].text, /Current player question/);
    assert.match(lastTurn.content[0].text, /Bundled field notes|legendary animals on file/i);
    assert.equal(calls[0].body.input[0].role, "user");
    assert.match(calls[0].body.input[0].content, /near Valentine/);
    assert.equal(calls[0].body.input[1].role, "assistant");
    assert.match(calls[0].body.instructions, /trail partner/);
  });
});

test("upstream AI failures stay useful and do not leak provider secrets", async () => {
  const limited = createApp({
    env: { OPENAI_API_KEY: "test-key", FRONTIER_CLIENT_TOKEN: "frontier-secret" },
    fetchImpl: async () => new Response(JSON.stringify({
      error: { message: "Rate limit reached for gpt-6-luna in organization org-secret on tokens per min." }
    }), { status: 429, headers: { "content-type": "application/json" } }),
    logger: silentLogger
  });

  await withServer(limited, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/ask`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-frontier-key": "frontier-secret"
      },
      body: JSON.stringify({ question: "Where is camp?" })
    });
    assert.equal(response.status, 429);
    const body = await response.json();
    assert.match(body.error, /out of capacity/i);
    assert.equal(JSON.stringify(body).includes("org-secret"), false);
  });

  const rejected = createApp({
    env: { OPENAI_API_KEY: "test-key" },
    fetchImpl: async () => new Response(JSON.stringify({
      error: { message: "Incorrect API key provided: sk-live-secret. You can find your API key at https://platform.openai.com/account/api-keys." }
    }), { status: 401, headers: { "content-type": "application/json" } }),
    logger: silentLogger
  });

  await withServer(rejected, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "Where is camp?" })
    });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.match(body.error, /OPENAI_API_KEY/);
    const encoded = JSON.stringify(body);
    assert.equal(encoded.includes("sk-live-secret"), false);
    assert.equal(encoded.includes("platform.openai.com"), false);
  });
});

test("POST /api/live-update always enables web search", async () => {
  const calls = [];
  const app = createApp({
    env: { OPENAI_API_KEY: "test-key" },
    fetchImpl: mockOpenAI(calls),
    logger: silentLogger
  });

  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/live-update`, { method: "POST" });
    assert.equal(response.status, 200);
    assert.deepEqual(calls[0].body.tools, [{ type: "web_search", search_context_size: "medium" }]);
    assert.match(calls[0].body.input[0].content[0].text, /current update scan/i);
  });
});

test("input, configuration, and CORS failures return JSON", async () => {
  const app = createApp({
    env: { ALLOWED_ORIGINS: "https://appassets.androidplatform.net" },
    logger: silentLogger
  });

  await withServer(app, async baseUrl => {
    const missingQuestion = await fetch(`${baseUrl}/api/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(missingQuestion.status, 400);
    assert.equal((await missingQuestion.json()).error, "Question is required.");

    const unconfigured = await fetch(`${baseUrl}/api/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "Help" })
    });
    assert.equal(unconfigured.status, 503);
    assert.match((await unconfigured.json()).error, /OPENAI_API_KEY/);

    const forbiddenOrigin = await fetch(`${baseUrl}/api/health`, {
      headers: { origin: "https://example.com" }
    });
    assert.equal(forbiddenOrigin.status, 403);
    assert.equal((await forbiddenOrigin.json()).error, "Origin not allowed.");

    const sameOrigin = await fetch(`${baseUrl}/api/health`, {
      headers: { origin: baseUrl }
    });
    assert.equal(sameOrigin.status, 200);
  });
});

test("POST /api/ask streams replies and grounds them in bundled notes", async () => {
  const calls = [];
  const app = createApp({
    env: { OPENAI_API_KEY: "test-key" },
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      const events = [
        { type: "response.output_text.delta", delta: "North bank of the Dakota. " },
        { type: "response.output_text.delta", delta: "Wolf Heart Trinket." },
        { type: "response.completed", response: { output: [] } }
      ];
      const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("");
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
    logger: silentLogger
  });

  await withServer(app, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: "Where is the legendary wolf and what does the trinket do?",
        mode: "story",
        stream: true,
        history: [{ role: "user", content: "I am hunting legendaries." }, { role: "assistant", content: "Start with Hosea's map." }]
      })
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /text\/event-stream/);
    const text = await response.text();
    assert.match(text, /North bank of the Dakota/);
    assert.match(text, /"type":"done"/);
    assert.match(calls[0].body.input.at(-1).content[0].text, /Cotorra/);
    assert.equal(calls[0].body.input[0].content, "I am hunting legendaries.");
    assert.equal(calls[0].body.stream, true);
  });
});

test("POST /api/speak requests the deep male neural voice and degrades without leaking secrets", async () => {
  const calls = [];
  const app = createApp({
    env: {
      OPENAI_API_KEY: "test-key",
      OPENAI_TTS_VOICE: "onyx",
      OPENAI_TTS_MODEL: "gpt-4o-mini-tts"
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return new Response(Buffer.from("fake-mp3"), {
        status: 200,
        headers: { "content-type": "audio/mpeg" }
      });
    },
    logger: silentLogger
  });

  await withServer(app, async baseUrl => {
    const spoken = await fetch(`${baseUrl}/api/speak`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "The wolf is north of the Dakota." })
    });
    assert.equal(spoken.status, 200);
    assert.match(spoken.headers.get("content-type") || "", /audio\/mpeg/);
    assert.equal(calls[0].url, "https://api.openai.com/v1/audio/speech");
    assert.equal(calls[0].body.voice, "onyx");
    assert.equal(calls[0].body.model, "gpt-4o-mini-tts");
    assert.match(calls[0].body.instructions, /deep, warm Black man/i);
    assert.equal(calls[0].body.input, "The wolf is north of the Dakota.");
  });

  const limited = createApp({
    env: { OPENAI_API_KEY: "test-key" },
    fetchImpl: async () => new Response(JSON.stringify({
      error: { message: "You exceeded your current quota, org-secret." }
    }), { status: 429, headers: { "content-type": "application/json" } }),
    logger: silentLogger
  });

  await withServer(limited, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/speak`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Hello from the trail." })
    });
    assert.equal(response.status, 429);
    const body = await response.json();
    assert.match(body.error, /out of capacity/i);
    assert.equal(JSON.stringify(body).includes("org-secret"), false);
  });
});

test("bundled Story Mode pages are served with the confirmed counts", async () => {
  const app = createApp({ logger: silentLogger });
  await withServer(app, async baseUrl => {
    const html = await (await fetch(`${baseUrl}/`)).text();
    assert.match(html, /Legendary Animals/);
    assert.match(html, /Animals &amp; Weapons/);
    assert.match(html, /id="secretsView"/);
    assert.match(html, /id="hiddenView"/);

    const legendaries = await (await fetch(`${baseUrl}/content/legendaries.json`)).json();
    assert.equal(legendaries.length, 16);
    for (const animal of legendaries) {
      assert.equal(animal.mode, "story");
      assert.ok(animal.region && animal.landmark && animal.conditions && animal.unlock && animal.weapon && animal.reward);
      assert.equal(typeof animal.x, "number");
      assert.equal(typeof animal.y, "number");
    }

    const animals = await (await fetch(`${baseUrl}/content/animals.json`)).json();
    assert.equal(animals.length, 105);
    for (const animal of animals) {
      assert.ok(animal.weapon);
      assert.ok(animal.ammo || animal.bait);
      assert.ok(animal.regions.length > 0);
    }
    assert.equal(animals.filter(animal => animal.legendary).length, 14);

    const secrets = await (await fetch(`${baseUrl}/content/secrets.json`)).json();
    assert.equal(secrets.length, 26);
    assert.equal(secrets.filter(item => item.confirmed === false).map(item => item.id).sort().join(","), "gilded-bachelor,meteor-third,talking-cave,ufo-new-austin");

    const hidden = await (await fetch(`${baseUrl}/content/hidden-places.json`)).json();
    const counts = {};
    for (const place of hidden) counts[place.category] = (counts[place.category] || 0) + 1;
    assert.deepEqual(counts, { Waterfall: 1, Cave: 4, Mine: 2, Underground: 4, Mountain: 9 });
  });
});

test("android assets match the web guide shell", () => {
  const files = [
    "app.js",
    "frontier-session.js",
    "index.html",
    "styles.css",
    "sw.js",
    "frontier-map.svg",
    "content/guide.json",
    "content/map.json",
    "content/legendaries.json",
    "content/animals.json",
    "content/secrets.json",
    "content/hidden-places.json"
  ];
  for (const file of files) {
    const web = readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8");
    const android = readFileSync(new URL(`../../android-native/app/src/main/assets/web/${file}`, import.meta.url), "utf8");
    assert.equal(web, android, file);
  }
});

test("coach JSON keeps only confirmed structured advice", () => {
  const parsed = parseCoachAnswer(`{"observation":"A mission banner is visible.","uncertainty":"The reward is not readable.","nextAction":"Open the banner.","readable":true,"tips":[{"id":"banner","text":"Read the banner before you ride.","priority":1,"guideId":""}]}`);
  assert.equal(parsed.nextAction, "Open the banner.");
  assert.equal(parsed.readable, true);
  assert.equal(parsed.tips.length, 1);
  assert.equal(parseCoachAnswer("not json"), null);
});

test("POST /api/coach requires a frame and returns structured advice", async () => {
  const calls = [];
  const app = createApp({
    env: { OPENAI_API_KEY: "test-key", FRONTIER_CLIENT_TOKEN: "frontier-secret" },
    logger: silentLogger,
    fetchImpl: async (url, options) => {
      calls.push(JSON.parse(options.body));
      return new Response(JSON.stringify({
        output: [{ type: "message", content: [{ type: "output_text", text: "{\"observation\":\"Snow trail.\",\"uncertainty\":\"The animal is not identifiable.\",\"nextAction\":\"Dismount and look again.\",\"readable\":true,\"tips\":[]}" }] }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  await withServer(app, async baseUrl => {
    const missing = await fetch(`${baseUrl}/api/coach`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://appassets.androidplatform.net" },
      body: JSON.stringify({ sessionId: "1", frameId: "1" })
    });
    assert.equal(missing.status, 400);

    const denied = await fetch(`${baseUrl}/api/coach`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ imageDataUrl: "data:image/jpeg;base64,aGVsbG8=" })
    });
    assert.equal(denied.status, 401);

    const coach = await fetch(`${baseUrl}/api/coach`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://appassets.androidplatform.net" },
      body: JSON.stringify({
        sessionId: "7",
        frameId: "3",
        imageDataUrl: "data:image/jpeg;base64,aGVsbG8=",
        mode: "story",
        platform: "console",
        spoiler: false
      })
    });
    assert.equal(coach.status, 200);
    const body = await coach.json();
    assert.equal(body.sessionId, "7");
    assert.equal(body.frameId, "3");
    assert.equal(body.nextAction, "Dismount and look again.");
    assert.equal(body.readable, true);
    assert.match(calls[0].input.at(-1).content[0].text, /Do not reveal future story events/);
    assert.equal(calls[0].input.at(-1).content[1].type, "input_image");
  });
});
