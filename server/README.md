# Frontier Guide AI backend

This Node/Express service powers the Android app's optional live features:

- `GET /api/health` — public Render health and configuration check
- `POST /api/ask` — protected text, camera-frame, and screen-frame questions. Send `"stream": true` for server-sent deltas.
- `POST /api/speak` — protected neural speech for a guide answer. Uses the same `OPENAI_API_KEY`. Returns `audio/mpeg`, or JSON if the provider is out of capacity.
- `POST /api/live-update` — protected current Red Dead / Rockstar scan with web search

## Run locally

1. Use Node.js 22.
2. Copy the keys from `.env.example` into your shell or hosting provider.
3. Set `OPENAI_API_KEY`.
4. Set a strong `FRONTIER_CLIENT_TOKEN` for a public server.
5. Install, test, and start:

```bash
npm ci
npm run check
npm test
npm start
```

## Render values

| Field | Value |
|---|---|
| Runtime | `node` |
| Plan | `free` |
| Region | `virginia` |
| Branch | `main` |
| Root directory | `server` |
| Build command | `npm ci --omit=dev` |
| Start command | `npm start` |
| Health path | `/api/health` |
| Node | `22.22.0` |

The health route must remain public because Render health probes cannot supply `x-frontier-key`. It reports whether client authentication is required and whether the supplied key is valid, while protected routes still enforce the key.

## Environment

- `OPENAI_API_KEY` — required for AI requests.
- `OPENAI_MODEL` — `gpt-6-luna` by default.
- `FRONTIER_CLIENT_TOKEN` — recommended shared app access key.
- `ALLOWED_ORIGINS` — comma-separated WebView/browser origins; Android uses `https://appassets.androidplatform.net`.
- `OPENAI_BASE_URL` — optional; defaults to `https://api.openai.com/v1`.
- `OPENAI_TIMEOUT_MS` — optional; defaults to `90000`.
- `OPENAI_TTS_MODEL` — optional; defaults to `gpt-4o-mini-tts`.
- `OPENAI_TTS_VOICE` — optional; defaults to `onyx`, the deepest stock male voice. `ash` is the smoother alternate.
- `OPENAI_TTS_INSTRUCTIONS` — optional style line for `gpt-4o-mini-tts`. The default asks for a deep, warm Black male delivery. OpenAI does not publish an ethnicity label for voices, so this is delivery guidance, not a named actor. Ignored on older `tts-1` models.
- `RATE_LIMIT_MAX` — optional; defaults to `30` requests per window per client IP.
- `RATE_LIMIT_WINDOW_MS` — optional; defaults to `60000`.
- `PORT` — supplied by Render; local default is `3000`.

Never place `OPENAI_API_KEY` inside Android, client-side JavaScript, a committed `.env` file, or `render.yaml`.

## Smoke checks

```bash
export FRONTIER_BASE_URL="https://frontier-guide-api.onrender.com"
export FRONTIER_CLIENT_TOKEN="paste-the-render-generated-value"

curl -i "$FRONTIER_BASE_URL/api/health"

curl -i -X POST "$FRONTIER_BASE_URL/api/ask" \
  -H "content-type: application/json" \
  -H "x-frontier-key: $FRONTIER_CLIENT_TOKEN" \
  --data '{"question":"How do I get a perfect pelt?","mode":"story","live":false}'

curl -i -X POST "$FRONTIER_BASE_URL/api/live-update" \
  -H "content-type: application/json" \
  -H "x-frontier-key: $FRONTIER_CLIENT_TOKEN" \
  --data '{}'
```

Healthy results are HTTP `200`. `/api/health` returns `ok`, `configured`, `model`, `authRequired`, `authorized`, and `version`. Protected routes return `401` for a missing or incorrect `x-frontier-key` and `503` if the OpenAI key is missing.
