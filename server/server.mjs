import { timingSafeEqual } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import cors from "cors";
import express from "express";

const DEFAULT_MODEL = "gpt-6-luna";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const APP_VERSION = "1.2.1";
const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));
const PUBLIC_INDEX = fileURLToPath(new URL("./public/index.html", import.meta.url));

const SYSTEM = `You are Frontier Guide, an unofficial expert companion for Red Dead Redemption 2 and Red Dead Online.
Give practical, spoiler-aware help unless the player explicitly asks for spoilers.
When an image is attached, first identify what is visible, then explain the next useful action.
Distinguish Story Mode from Online when relevant. Never invent a mission, item, patch, event, location, or mechanic.
For live/current questions, prefer official Rockstar sources for patches, events, and service changes, and clearly label community-reported bugs or workarounds as unverified when applicable.
Keep answers direct, useful on a phone, and organized around the player's immediate next step.`;

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
    res.setHeader("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
    if (req.path.startsWith("/api")) res.setHeader("Cache-Control", "no-store");
    next();
  });

  function clientAuthorized(req) {
    return !clientToken || tokenMatches(req.get("x-frontier-key"), clientToken);
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

  async function createResponse({ question, mode = "story", imageDataUrl, live = false, purpose = "ask" }) {
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
    const content = [{
      type: "input_text",
      text: purpose === "updates"
        ? "Give me a concise current update scan for Red Dead Redemption 2 and Red Dead Online as of today. Cover official Rockstar announcements, patches, event changes, and service changes first. Then cover major actively reported issues or useful workarounds. Separate confirmed information from community reports and include dates when available."
        : `Player mode: ${modeLabel}. Player question: ${question}`
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
      const error = new Error(data?.error?.message || `AI request failed with status ${response.status}.`);
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
    const live = req.body?.live === true;

    if (!question) return res.status(400).json({ error: "Question is required." });
    if (question.length > 4_000) return res.status(400).json({ error: "Question is too long." });
    if (!validImageDataUrl(imageDataUrl)) return res.status(400).json({ error: "Unsupported or oversized image." });

    try {
      return res.json(await createResponse({ question, mode, imageDataUrl, live }));
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

  app.use(express.static(PUBLIC_DIR, { index: false, maxAge: "1h" }));
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
