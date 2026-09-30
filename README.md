# RDR2 Master Companion

Unofficial phone-first companion app for Red Dead Redemption 2 and Red Dead Online.

## Current build

Android v1.2.0 includes:

- Story Mode / Online mode switching
- offline searchable master guide
- camera capture for visual questions
- Android screen capture with latest-frame attachment
- live AI questions through the optional backend
- current Red Dead / Rockstar web-update scans
- source links returned with live answers
- optional shared server access key so a public backend cannot be used freely by strangers

The Android wrapper lives in `android-native/`. GitHub Actions builds the installable debug APK.

## AI backend

The backend lives in `server/` and exposes:

- `GET /api/health`
- `POST /api/ask`
- `POST /api/live-update`

It uses the OpenAI Responses API. Camera and screen images are sent as image inputs only when the player submits a question with an image attached. Live web search is enabled only when requested by the app or by the live-update endpoint.

### Required hosting environment

Set:

- `OPENAI_API_KEY`
- `OPENAI_MODEL` (defaults to `gpt-5.6-luna`)
- `FRONTIER_CLIENT_TOKEN` (recommended)
- `ALLOWED_ORIGINS=https://appassets.androidplatform.net`

A `render.yaml` deployment blueprint is included, but the Node server can run on any host that supports Node.js 20+.

After deployment, open the app's **Settings** page and enter:

1. the backend base URL, for example `https://your-service.example.com`
2. the server access key if `FRONTIER_CLIENT_TOKEN` is enabled

Do not put the OpenAI API key in the Android app or browser JavaScript.

## Build Android APK

Use the **Build Android APK** workflow in GitHub Actions. The downloadable artifact is named `Frontier-Guide-debug-apk`.
