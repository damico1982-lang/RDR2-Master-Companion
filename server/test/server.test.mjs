import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../server.mjs";

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
      version: "1.3.0"
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
    assert.match(await script.text(), /hostedApiBase/);

    const api = await fetch(`${baseUrl}/api`);
    assert.equal(api.status, 200);
    assert.deepEqual((await api.json()).endpoints, ["/api/health", "/api/ask", "/api/live-update"]);
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
    assert.equal(calls[0].body.input[0].content[1].type, "input_image");
    assert.match(calls[0].body.input[0].content[0].text, /Recent call-and-response context/);
    assert.match(calls[0].body.input[0].content[0].text, /near Valentine/);
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
