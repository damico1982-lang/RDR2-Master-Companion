import { timingSafeEqual } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import cors from "cors";
import express from "express";
import { loadFieldNotes, relevantNotes } from "./field-notes.mjs";
import { parseSseBuffer } from "./sse.mjs";

const DEFAULT_MODEL = "gpt-6-luna";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts";
const DEFAULT_TTS_VOICE = "onyx";
const DEFAULT_TTS_INSTRUCTIONS = "Speak as a deep, warm Black man in his thirties or forties. Low chest voice, unhurried, dry humor, direct. Sound like someone talking across a campfire, not an announcer, not a cartoon, and not a whisper.";
const APP_VERSION = "1.5.9";
const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));
const PUBLIC_INDEX = fileURLToPath(new URL("./public/index.html", import.meta.url));

const SYSTEM = `You are Frontier Guide, the in-app companion for Red Dead Redemption 2 and Red Dead Online.
Talk like a sharp trail partner: conversational, direct, and a little wry. No corporate tone, no filler, and no catchphrase spam. Personality is welcome. Made-up game facts are not.
You remember this conversation. A follow-up such as "then what?", "that one", or "the other gun" refers to what you and the player just said. Use the earlier turns. Do not ask them to repeat a location they already gave you.
Lead with the next thing to do. Keep answers easy to hear out loud, in short steps, because the player may be riding.
Bundled field notes arrive with the question when something on file matches. Prefer those notes for legendary animals, perfect-pelt weapons, bait, secrets, and hidden places. If a note says a detail is unconfirmed or that two guides conflict, say that in plain words. Do not pick a side the note refused to pick. If the notes do not cover the question, answer from general RDR2 knowledge and say you are past the bundled pages.
Help with missions, maps, treasure chains, gold, cash, jewelry, collectibles, role progression, hunting, fishing, crafting, horses, weapons, challenges, achievements, secrets, hidden interiors, encounter conditions, puzzles, and efficient routes.
Give practical, spoiler-aware help unless the player explicitly asks for spoilers.
When an image is attached, identify visible HUD text, map markers, landmarks, mission state, inventory, and relevant hazards before explaining exactly what to do next. If the image is unclear, say what cannot be confirmed and request the specific view needed.
Always distinguish Story Mode from Red Dead Online. Do not claim Story Mode gold-bar spawns, cheat codes, or encounters work Online. If asked for diamonds or another item that is not a normal obtainable item in the selected mode, say so and name the closest real valuables instead.
Treat "cheats" as built-in cheat codes, legitimate strategies, and secrets. Never recommend hacks, mod menus, account theft, duplication abuse, or ban-risk exploits in Online.
Never invent a mission, item, patch, event, location, payout, spawn cycle, clock time, or mechanic. Mention prerequisites, chapter or role requirements, platform/version differences, randomized spawns, and limited-time availability when they change the answer.
For live or current questions, prefer official Rockstar sources for patches, events, and service changes. Clearly label community maps, spawn-cycle tools, bugs, and workarounds as third-party or unverified when applicable.
Do not write in dialect and do not describe an accent. The spoken voice is handled separately.
The parchment map in the app is an original schematic, not Rockstar's map. Give landmark directions, not a claim that a pin is a surveyed coordinate.`;

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function tokenMatches(provided, expected) {
  if (!provided || !expected) return false;
  const left = Buffer.from(String(provided));
  const right = Buffer.from(String(expected));
  return left.length === right.length && timingSafeEqual(left, right);
}

function validImageDataUrl(value) {
  if (!value) return true;
  if (typeof value !== "string") return false;
  if (!/^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(value)) return false;
  return value.length <= 10_500_000;
}

export function parseCoachAnswer(text) {
  const trimmed = String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const data = JSON.parse(trimmed.slice(start, end + 1));
    const tips = Array.isArray(data.tips) ? data.tips.slice(0, 3).map((tip, index) => ({
      id: String(tip?.id || `tip-${index + 1}`).slice(0, 80),
      text: String(tip?.text || "").slice(0, 400),
      priority: Number(tip?.priority) || index + 1,
      guideId: String(tip?.guideId || "").slice(0, 80)
    })).filter(tip => tip.text) : [];
    return {
      observation: String(data.observation || "").slice(0, 600),
      uncertainty: String(data.uncertainty || "").slice(0, 400),
      nextAction: String(data.nextAction || data.next_action || "").slice(0, 400),
      readable: data.readable !== false,
      tips
    };
  } catch {
    return null;
  }
}

function extractText(response) {
  const parts = [];
  for (const item of response.output || []) {
    if (item.type !== "message") continue;
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) parts.push(content.text);
    }
  }
  return parts.join("\n").trim() || "No answer returned.";
}

function clientSafeAiError(status) {
  if (status === 429) {
    return "The AI service is temporarily out of capacity. Wait a bit and try again. Offline guide answers still work.";
  }
  if (status === 401 || status === 403) {
    return "The AI service rejected the server credentials. Check OPENAI_API_KEY on the host.";
  }
  return "The AI service could not answer that request. Try again shortly.";
}

function extractSources(response) {
  const seen = new Set();
  const sources = [];
  for (const item of response.output || []) {
    if (item.type !== "message") continue;
    for (const content of item.content || []) {
      if (content.type !== "output_text") continue;
      for (const annotation of content.annotations || []) {
        if (annotation.type !== "url_citation" || !annotation.url || seen.has(annotation.url)) continue;
        seen.add(annotation.url);
        sources.push({ title: annotation.title || annotation.url, url: annotation.url });
      }
    }
  }
  return sources.slice(0, 8);
}

export function createApp({ env = process.env, fetchImpl = globalThis.fetch, logger = console, fieldNotes = null } = {}) {
  const apiKey = String(env.OPENAI_API_KEY || "").trim();
  const model = String(env.OPENAI_MODEL || DEFAULT_MODEL).trim();
  const ttsModel = String(env.OPENAI_TTS_MODEL || DEFAULT_TTS_MODEL).trim();
  const ttsVoice = String(env.OPENAI_TTS_VOICE || DEFAULT_TTS_VOICE).trim();
  const ttsInstructions = String(env.OPENAI_TTS_INSTRUCTIONS || DEFAULT_TTS_INSTRUCTIONS).trim();
  const clientToken = String(env.FRONTIER_CLIENT_TOKEN || "").trim();
  const openaiBaseUrl = String(env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
  const requestTimeoutMs = positiveInteger(env.OPENAI_TIMEOUT_MS, 90_000);
  const rateLimitMax = positiveInteger(env.RATE_LIMIT_MAX, 30);
  const rateLimitWindowMs = positiveInteger(env.RATE_LIMIT_WINDOW_MS, 60_000);
  const allowedOrigins = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);

  let notes = fieldNotes;
  if (!notes) {
    try {
      notes = loadFieldNotes();
    } catch (error) {
      logger.error(error);
      notes = { guide: [], legendaries: [], animals: [], secrets: [], hidden: [] };
    }
  }

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "12mb" }));
  const crossOrigin = cors({
    origin(origin, callback) {
      if (!origin || !allowedOrigins.length || allowedOrigins.includes(origin)) return callback(null, true);
      const error = new Error("Origin not allowed.");
      error.status = 403;
      return callback(error);
    }
  });
  app.use((req, res, next) => {
    const origin = req.get("origin");
    const requestOrigin = `${req.protocol}://${req.get("host")}`;
    if (origin && origin === requestOrigin) return next();
    return crossOrigin(req, res, next);
  });
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data: https:; media-src 'self' blob:; connect-src 'self' https:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), geolocation=()");
    if (req.path.startsWith("/api")) res.setHeader("Cache-Control", "no-store");
    next();
  });

  function firstPartyClient(req) {
    const origin = req.get("origin");
    const requestOrigin = `${req.protocol}://${req.get("host")}`;
    const referer = req.get("referer") || "";
    const fetchSite = req.get("sec-fetch-site");
    return origin === requestOrigin
      || origin === "https://appassets.androidplatform.net"
      || fetchSite === "same-origin"
      || (!origin && referer.startsWith(`${requestOrigin}/`));
  }

  function clientAuthorized(req) {
    return !clientToken || firstPartyClient(req) || tokenMatches(req.get("x-frontier-key"), clientToken);
  }

  function requireClientToken(req, res, next) {
    if (clientAuthorized(req)) return next();
    return res.status(401).json({ error: "Invalid or missing app access key." });
  }

  app.get("/api/health", (req, res) => {
    res.json({
      ok: true,
      configured: Boolean(apiKey),
      model,
      authRequired: Boolean(clientToken),
      authorized: clientAuthorized(req),
      version: APP_VERSION,
      tts: {
        enabled: Boolean(apiKey),
        model: ttsModel,
        voice: ttsVoice
      }
    });
  });

  const hits = new Map();
  function rateLimit(req, res, next) {
    const now = Date.now();
    const key = req.ip || "unknown";
    const current = hits.get(key) || { count: 0, reset: now + rateLimitWindowMs };

    if (now >= current.reset) {
      current.count = 0;
      current.reset = now + rateLimitWindowMs;
    }

    current.count += 1;
    hits.set(key, current);
    res.setHeader("X-RateLimit-Limit", String(rateLimitMax));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, rateLimitMax - current.count)));

    if (hits.size > 5_000) {
      for (const [storedKey, entry] of hits) {
        if (entry.reset <= now) hits.delete(storedKey);
      }
    }

    if (current.count > rateLimitMax) {
      res.setHeader("Retry-After", String(Math.ceil((current.reset - now) / 1_000)));
      return res.status(429).json({ error: "Too many requests. Try again shortly." });
    }
    return next();
  }

  function normalizeHistory(history) {
    return Array.isArray(history)
      ? history
        .filter(item => item && ["user", "assistant"].includes(item.role) && typeof item.content === "string")
        .map(item => ({ role: item.role, content: item.content.trim().slice(0, 2_000) }))
        .filter(item => item.content)
        .slice(-12)
      : [];
  }

  function responseBody({ question, mode = "story", imageDataUrl, history = [], live = false, purpose = "ask", stream = false }) {
    const notesText = purpose === "updates"
      ? ""
      : relevantNotes(notes, { question, history, mode });
    const content = [{
      type: "input_text",
      text: purpose === "updates"
        ? "Give me a concise current update scan for Red Dead Redemption 2 and Red Dead Online as of today. Cover official Rockstar announcements, patches, event changes, and service changes first. Then cover major actively reported issues or useful workarounds. Separate confirmed information from community reports and include dates when available."
        : purpose === "coach"
          ? `${notesText}\n\n${question}\n\nReturn one JSON object only, with no markdown. Keys: observation, uncertainty, nextAction, readable, tips. tips is an array of at most 3 objects with id, text, priority, and guideId. Describe only what is visible in the image or already in the field notes. If the frame is unreadable, set readable to false and do not invent a mission, location, or HUD value.`
          : `${notesText}\n\nCurrent player question: ${question}`
    }];

    if (imageDataUrl) {
      content.push({ type: "input_image", image_url: imageDataUrl, detail: "high" });
    }

    const body = {
      model,
      instructions: SYSTEM,
      input: [
        ...history.map(item => ({ role: item.role, content: item.content })),
        { role: "user", content }
      ],
      max_output_tokens: purpose === "updates" ? 1_200 : purpose === "coach" ? 700 : 1_000,
      store: false
    };

    if (live) body.tools = [{ type: "web_search", search_context_size: "medium" }];
    if (stream) body.stream = true;
    return body;
  }

  async function postOpenAI(path, body, timeoutMs = requestTimeoutMs) {
    if (!apiKey) {
      const error = new Error("OPENAI_API_KEY is not configured on the server.");
      error.status = 503;
      throw error;
    }

    try {
      return await fetchImpl(`${openaiBaseUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (cause) {
      const timedOut = cause?.name === "TimeoutError" || cause?.name === "AbortError";
      const error = new Error(timedOut ? "The AI request timed out. Try again." : "Could not reach the OpenAI API.");
      error.status = timedOut ? 504 : 502;
      error.cause = cause;
      throw error;
    }
  }

  async function rejectUpstream(response) {
    const data = await response.json().catch(() => ({}));
    const providerMessage = typeof data?.error?.message === "string" ? data.error.message : "";
    const safeLog = /api key|sk-|bearer /i.test(providerMessage)
      ? "provider rejected the credentials"
      : providerMessage.slice(0, 300);
    logger.error(`OpenAI request failed with status ${response.status}: ${safeLog}`);
    const error = new Error(clientSafeAiError(response.status));
    error.status = response.status === 429 ? 429 : 502;
    throw error;
  }

  function writeSse(res, payload) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  async function streamResponse(upstream, res) {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no");

    const reader = upstream.body?.getReader?.();
    if (!reader) {
      const data = await upstream.json().catch(() => ({}));
      const answer = extractText(data);
      writeSse(res, { type: "delta", text: answer });
      writeSse(res, { type: "done", answer, sources: extractSources(data), model });
      res.end();
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let answer = "";
    let completed = null;

    const consume = (flush) => {
      const parsed = parseSseBuffer(buffer, flush);
      buffer = parsed.rest;
      for (const message of parsed.events) {
        if (!message.data || message.data === "[DONE]") continue;
        let event;
        try {
          event = JSON.parse(message.data);
        } catch {
          continue;
        }
        if (event.type === "response.output_text.delta" && event.delta) {
          answer += event.delta;
          writeSse(res, { type: "delta", text: event.delta });
        } else if (event.type === "response.completed" && event.response) {
          completed = event.response;
        }
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      consume(false);
    }
    buffer += decoder.decode();
    consume(true);

    const finalAnswer = (completed ? extractText(completed) : answer) || answer || "No answer returned.";
    writeSse(res, {
      type: "done",
      answer: finalAnswer,
      sources: completed ? extractSources(completed) : [],
      model
    });
    res.end();
  }

  async function createResponse({ question, mode = "story", imageDataUrl, history = [], live = false, purpose = "ask" }) {
    const response = await postOpenAI("/responses", responseBody({ question, mode, imageDataUrl, history, live, purpose }));
    if (!response.ok) await rejectUpstream(response);
    const data = await response.json().catch(() => ({}));
    return {
      answer: extractText(data),
      sources: extractSources(data),
      model
    };
  }

  app.post("/api/ask", rateLimit, requireClientToken, async (req, res) => {
    const question = String(req.body?.question || "").trim();
    const mode = ["story", "online", "either"].includes(req.body?.mode) ? req.body.mode : "story";
    const imageDataUrl = req.body?.imageDataUrl || null;
    const history = normalizeHistory(req.body?.history);
    const live = req.body?.live === true;
    const stream = req.body?.stream === true;

    if (!question) return res.status(400).json({ error: "Question is required." });
    if (question.length > 4_000) return res.status(400).json({ error: "Question is too long." });
    if (!validImageDataUrl(imageDataUrl)) return res.status(400).json({ error: "Unsupported or oversized image." });

    try {
      if (!stream) return res.json(await createResponse({ question, mode, imageDataUrl, history, live }));
      const upstream = await postOpenAI("/responses", responseBody({ question, mode, imageDataUrl, history, live, stream: true }));
      if (!upstream.ok) await rejectUpstream(upstream);
      await streamResponse(upstream, res);
      return undefined;
    } catch (error) {
      logger.error(error);
      if (res.headersSent) {
        writeSse(res, { type: "error", error: error.message || "The live guide stopped early." });
        res.end();
        return undefined;
      }
      return res.status(error.status || 500).json({ error: error.message || "Server error." });
    }
  });

  app.post("/api/coach", rateLimit, requireClientToken, async (req, res) => {
    const imageDataUrl = req.body?.imageDataUrl || null;
    const mode = ["story", "online", "either"].includes(req.body?.mode) ? req.body.mode : "story";
    const history = normalizeHistory(req.body?.history);
    const sessionId = String(req.body?.sessionId || "").slice(0, 40);
    const frameId = String(req.body?.frameId || "").slice(0, 40);
    const platform = String(req.body?.platform || "unknown").slice(0, 40);
    const progress = String(req.body?.progress || "").slice(0, 200);
    const goal = String(req.body?.goal || "").slice(0, 200);
    const spoiler = req.body?.spoiler === true;
    if (!validImageDataUrl(imageDataUrl)) return res.status(400).json({ error: "Unsupported or oversized image." });
    if (!imageDataUrl) return res.status(400).json({ error: "A gameplay frame is required." });
    const question = [
      "Read this single gameplay frame for Frontier Guide.",
      `Mode: ${mode}. Platform: ${platform}.`,
      progress ? `Player-confirmed progress: ${progress}.` : "Progress was not confirmed.",
      goal ? `Current goal: ${goal}.` : "No specific goal was set.",
      spoiler ? "The player allowed future-story spoilers." : "Do not reveal future story events.",
      "If you cannot read the frame, say so. Do not invent unseen game state or exact coordinates."
    ].join(" ");
    try {
      const created = await createResponse({ question, mode, imageDataUrl, history, purpose: "coach" });
      const parsed = parseCoachAnswer(created.answer) || {
        observation: "",
        uncertainty: "The vision reply was not usable structured advice.",
        nextAction: "Hold the frame steady on the game HUD and try again.",
        readable: false,
        tips: []
      };
      return res.json({
        sessionId,
        frameId,
        capturedAt: req.body?.capturedAt || null,
        ...parsed,
        model: created.model
      });
    } catch (error) {
      logger.error(error);
      return res.status(error.status || 500).json({ error: error.message || "Server error." });
    }
  });

  app.post("/api/speak", rateLimit, requireClientToken, async (req, res) => {
    const text = String(req.body?.text || "").replace(/\s+/g, " ").trim();
    if (!text) return res.status(400).json({ error: "Text is required." });
    if (text.length > 3_500) return res.status(400).json({ error: "Text is too long to speak." });

    const speechBody = {
      model: ttsModel,
      voice: ttsVoice,
      input: text,
      response_format: "mp3"
    };
    if (ttsInstructions && /gpt-4o(?:-mini)?-tts/i.test(ttsModel)) speechBody.instructions = ttsInstructions;

    try {
      const upstream = await postOpenAI("/audio/speech", speechBody, Math.min(requestTimeoutMs, 60_000));
      if (!upstream.ok) await rejectUpstream(upstream);
      const audio = Buffer.from(await upstream.arrayBuffer());
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "no-store");
      return res.send(audio);
    } catch (error) {
      logger.error(error);
      return res.status(error.status || 500).json({ error: error.message || "Server error." });
    }
  });

  app.post("/api/live-update", rateLimit, requireClientToken, async (req, res) => {
    try {
      return res.json(await createResponse({ question: "", mode: "either", live: true, purpose: "updates" }));
    } catch (error) {
      logger.error(error);
      return res.status(error.status || 500).json({ error: error.message || "Server error." });
    }
  });

  app.get("/api", (req, res) => {
    res.json({
      name: "Frontier Guide API",
      ok: true,
      version: APP_VERSION,
      endpoints: ["/api/health", "/api/ask", "/api/speak", "/api/coach", "/api/live-update"]
    });
  });

  app.use(express.static(PUBLIC_DIR, {
    index: false,
    etag: true,
    setHeaders(res, filePath) {
      const longLived = filePath.endsWith(".svg") || filePath.endsWith(".png");
      res.setHeader("Cache-Control", longLived ? "public, max-age=86400" : "no-cache");
    }
  }));
  app.get("/", (req, res) => res.sendFile(PUBLIC_INDEX));

  app.use((req, res) => {
    res.status(404).json({ error: "Endpoint not found." });
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = Number(error.status || error.statusCode) || 500;
    if (status >= 500) logger.error(error);
    return res.status(status).json({ error: status === 500 ? "Server error." : error.message });
  });

  return app;
}

export function startServer({ env = process.env, logger = console } = {}) {
  const port = positiveInteger(env.PORT, 3_000);
  const app = createApp({ env, logger });
  const server = app.listen(port, () => {
    logger.log(`Frontier Guide API v${APP_VERSION} listening on port ${port}`);
  });

  const shutdown = signal => {
    logger.log(`${signal} received; closing HTTP server.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  return server;
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) startServer();
