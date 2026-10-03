import { timingSafeEqual } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import cors from "cors";
import express from "express";

const DEFAULT_MODEL = "gpt-6-luna";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const APP_VERSION = "1.3.1";
const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));
const PUBLIC_INDEX = fileURLToPath(new URL("./public/index.html", import.meta.url));

const SYSTEM = `You are Frontier Guide, a hands-free expert companion for Red Dead Redemption 2 Story Mode and Red Dead Online.
Help with missions, maps, treasure chains, gold, cash, jewelry, collectibles, role progression, hunting, fishing, crafting, horses, weapons, challenges, achievements, secrets, hidden interiors, encounter conditions, puzzles, and efficient routes.
Give practical, spoiler-aware help unless the player explicitly asks for spoilers. Lead with the immediate next action and use short spoken-friendly steps because the player may be listening while playing.
When an image is attached, identify visible HUD text, map markers, landmarks, mission state, inventory, and relevant hazards before explaining exactly what to do next. If the image is unclear, say what cannot be confirmed and request the specific view needed.
Always distinguish Story Mode from Red Dead Online. Do not claim Story Mode gold-bar spawns, cheat codes, or encounters work Online. If asked for diamonds or another item that is not a normal obtainable item in the selected mode, say so and name the closest real valuables instead.
Treat “cheats” as built-in cheat codes, legitimate strategies, and secrets. Never recommend hacks, mod menus, account theft, duplication abuse, or ban-risk exploits in Online.
Never invent a mission, item, patch, event, location, payout, spawn cycle, or mechanic. Mention prerequisites, chapter or role requirements, platform/version differences, randomized spawns, and limited-time availability when they change the answer.
For live/current questions, prefer official Rockstar sources for patches, events, and service changes. Clearly label community maps, spawn-cycle tools, bugs, and workarounds as third-party or unverified when applicable.
Keep answers conversational and remember the recent call-and-response context so follow-up questions such as “then what?” make sense.`;

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

export function createApp({ env = process.env, fetchImpl = globalThis.fetch, logger = console } = {}) {
  const apiKey = String(env.OPENAI_API_KEY || "").trim();
  const model = String(env.OPENAI_MODEL || DEFAULT_MODEL).trim();
  const clientToken = String(env.FRONTIER_CLIENT_TOKEN || "").trim();
  const openaiBaseUrl = String(env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
  const requestTimeoutMs = positiveInteger(env.OPENAI_TIMEOUT_MS, 90_000);
  const rateLimitMax = positiveInteger(env.RATE_LIMIT_MAX, 30);
  const rateLimitWindowMs = positiveInteger(env.RATE_LIMIT_WINDOW_MS, 60_000);
  const allowedOrigins = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);

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
      version: APP_VERSION
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

  async function createResponse({ question, mode = "story", imageDataUrl, history = [], live = false, purpose = "ask" }) {
    if (!apiKey) {
      const error = new Error("OPENAI_API_KEY is not configured on the server.");
      error.status = 503;
      throw error;
    }

    const modeLabel = mode === "online"
      ? "Red Dead Online"
      : mode === "either"
        ? "Story Mode or Online"
        : "Story Mode";
    const recentContext = history
      .slice(-8)
      .map(item => `${item.role === "assistant" ? "Frontier" : "Player"}: ${item.content}`)
      .join("\n");
    const content = [{
      type: "input_text",
      text: purpose === "updates"
        ? "Give me a concise current update scan for Red Dead Redemption 2 and Red Dead Online as of today. Cover official Rockstar announcements, patches, event changes, and service changes first. Then cover major actively reported issues or useful workarounds. Separate confirmed information from community reports and include dates when available."
        : `Player mode: ${modeLabel}.${recentContext ? `\nRecent call-and-response context:\n${recentContext}` : ""}\nCurrent player question: ${question}`
    }];

    if (imageDataUrl) {
      content.push({ type: "input_image", image_url: imageDataUrl, detail: "high" });
    }

    const body = {
      model,
      instructions: SYSTEM,
      input: [{ role: "user", content }],
      max_output_tokens: purpose === "updates" ? 1_200 : 1_000,
      store: false
    };

    if (live) body.tools = [{ type: "web_search", search_context_size: "medium" }];

    let response;
    try {
      response = await fetchImpl(`${openaiBaseUrl}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(requestTimeoutMs)
      });
    } catch (cause) {
      const timedOut = cause?.name === "TimeoutError" || cause?.name === "AbortError";
      const error = new Error(timedOut ? "The AI request timed out. Try again." : "Could not reach the OpenAI API.");
      error.status = timedOut ? 504 : 502;
      error.cause = cause;
      throw error;
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const providerMessage = typeof data?.error?.message === "string" ? data.error.message : "";
      const safeLog = /api key|sk-|bearer /i.test(providerMessage)
        ? "provider rejected the credentials"
        : providerMessage.slice(0, 300);
      logger.error(`OpenAI request failed with status ${response.status}: ${safeLog}`);
      const error = new Error(clientSafeAiError(response.status));
      error.status = response.status === 429 ? 429 : 502;
      throw error;
    }

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
    const history = Array.isArray(req.body?.history)
      ? req.body.history
        .filter(item => item && ["user", "assistant"].includes(item.role) && typeof item.content === "string")
        .map(item => ({ role: item.role, content: item.content.trim().slice(0, 2_000) }))
        .filter(item => item.content)
        .slice(-8)
      : [];
    const live = req.body?.live === true;

    if (!question) return res.status(400).json({ error: "Question is required." });
    if (question.length > 4_000) return res.status(400).json({ error: "Question is too long." });
    if (!validImageDataUrl(imageDataUrl)) return res.status(400).json({ error: "Unsupported or oversized image." });

    try {
      return res.json(await createResponse({ question, mode, imageDataUrl, history, live }));
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
      endpoints: ["/api/health", "/api/ask", "/api/live-update"]
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
