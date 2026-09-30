# Frontier Guide AI backend

This service powers the Android app's optional live AI features:

- `POST /api/ask` — text questions, camera frames, and Android screen-capture frames
- `POST /api/live-update` — current Red Dead / Rockstar scan using web search
- `GET /api/health` — connection check

## Run locally

1. Use Node.js 20 or newer.
2. Copy `.env.example` values into your hosting provider's environment settings.
3. Set `OPENAI_API_KEY`.
4. Optionally set `FRONTIER_CLIENT_TOKEN` to protect the public endpoint from unauthorized usage.
5. Run:

```bash
npm install
npm start
```

The app expects the server base URL only, such as `https://your-service.example.com`.

## Environment

- `OPENAI_API_KEY` — required for AI requests.
- `OPENAI_MODEL` — defaults to `gpt-5.6-luna`.
- `FRONTIER_CLIENT_TOKEN` — optional shared app access key.
- `ALLOWED_ORIGINS` — comma-separated browser/WebView origins. The Android wrapper uses `https://appassets.androidplatform.net`.
- `PORT` — defaults to 3000.

Do not place `OPENAI_API_KEY` inside the Android app or any client-side JavaScript.
