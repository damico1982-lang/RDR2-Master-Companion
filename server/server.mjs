import express from "express";
import cors from "cors";

const app = express();
const port = Number(process.env.PORT || 3000);
const apiKey = process.env.OPENAI_API_KEY || "";
const model = process.env.OPENAI_MODEL || "gpt-5.6-luna";
const clientToken = process.env.FRONTIER_CLIENT_TOKEN || "";
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(x => x.trim())
  .filter(Boolean);

const SYSTEM = `You are Frontier Guide, an unofficial expert companion for Red Dead Redemption 2 and Red Dead Online.
Give practical, spoiler-aware help unless the player explicitly asks for spoilers.
When an image is attached, first identify what is visible, then explain the next useful action.
Distinguish Story Mode from Online when relevant. Never invent a mission, item, patch, event, location, or mechanic.
For live/current questions, prefer official Rockstar sources for patches, events, and service changes, and clearly label community-reported bugs or workarounds as unverified when applicable.
Keep answers direct, useful on a phone, and organized around the player's immediate next step.`;

app.disable("x-powered-by");
app.use(express.json({ limit: "12mb" }));
app.use(cors({
  origin(origin, cb) {
    if (!origin || !allowedOrigins.length || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error("Origin not allowed"));
  }
}));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

const hits = new Map();
app.use((req, res, next) => {
  const key = req.ip || "unknown";
  const now = Date.now();
  const windowMs = 60_000;
  const max = 30;
  const current = hits.get(key) || { count: 0, reset: now + windowMs };
  if (now > current.reset) {
    current.count = 0;
    current.reset = now + windowMs;
  }
  current.count += 1;
  hits.set(key, current);
  if (current.count > max) return res.status(429).json({ error: "Too many requests. Try again shortly." });
  next();
});

function requireClientToken(req, res, next) {
  if (!clientToken) return next();
  if (req.get("x-frontier-key") === clientToken) return next();
  return res.status(401).json({ error: "Invalid app access key." });
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

async function createResponse({ question, mode = "story", imageDataUrl, live = false, purpose = "ask" }) {
  if (!apiKey) {
    const err = new Error("OPENAI_API_KEY is not configured on the server.");
    err.status = 503;
    throw err;
  }

  const modeLabel = mode === "online" ? "Red Dead Online" : mode === "either" ? "Story Mode or Online" : "Story Mode";
  const content = [{
    type: "input_text",
    text: purpose === "updates"
      ? `Give me a concise current update scan for Red Dead Redemption 2 / Red Dead Online as of today. Cover official Rockstar announcements or patch/service changes first, then major actively reported issues or useful workarounds. Separate confirmed information from community reports. Include dates when available.`
      : `Player mode: ${modeLabel}. Player question: ${question}`
  }];

  if (imageDataUrl) {
    content.push({ type: "input_image", image_url: imageDataUrl, detail: "high" });
  }

  const body = {
    model,
    instructions: SYSTEM,
    input: [{ role: "user", content }],
    max_output_tokens: purpose === "updates" ? 1200 : 1000
  };

  if (live) {
    body.tools = [{ type: "web_search", search_context_size: "medium" }];
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data?.error?.message || `AI request failed with status ${response.status}`);
    err.status = response.status;
    throw err;
  }

  return {
    answer: extractText(data),
    sources: extractSources(data),
    model
  };
}

app.get("/api/health", requireClientToken, (req, res) => {
  res.json({ ok: true, configured: Boolean(apiKey), model });
});

app.post("/api/ask", requireClientToken, async (req, res) => {
  const question = String(req.body?.question || "").trim();
  const mode = ["story", "online", "either"].includes(req.body?.mode) ? req.body.mode : "story";
  const imageDataUrl = req.body?.imageDataUrl || null;
  const live = Boolean(req.body?.live);

  if (!question) return res.status(400).json({ error: "Question is required." });
  if (question.length > 4000) return res.status(400).json({ error: "Question is too long." });
  if (!validImageDataUrl(imageDataUrl)) return res.status(400).json({ error: "Unsupported or oversized image." });

  try {
    res.json(await createResponse({ question, mode, imageDataUrl, live }));
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || "Server error." });
  }
});

app.post("/api/live-update", requireClientToken, async (req, res) => {
  try {
    res.json(await createResponse({ question: "", mode: "either", live: true, purpose: "updates" }));
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || "Server error." });
  }
});

app.get("/", (req, res) => {
  res.json({
    name: "Frontier Guide API",
    ok: true,
    endpoints: ["/api/health", "/api/ask", "/api/live-update"]
  });
});

app.listen(port, () => {
  console.log(`Frontier Guide API listening on port ${port}`);
});
