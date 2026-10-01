const state = {
  mode: "story",
  image: null,
  cameraFacing: "environment",
  cameraStream: null,
  guide: [],
  category: "All",
  screenTimer: null
};

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const hostedApiBase = ["http:", "https:"].includes(window.location.protocol)
  && window.location.hostname !== "appassets.androidplatform.net"
  ? window.location.origin
  : "";
const settings = {
  get api() { return localStorage.getItem("fg_api") || hostedApiBase; },
  set api(value) { localStorage.setItem("fg_api", value); },
  get token() { return localStorage.getItem("fg_token") || ""; },
  set token(value) { localStorage.setItem("fg_token", value); },
  get manifest() { return localStorage.getItem("fg_manifest") || ""; },
  set manifest(value) { localStorage.setItem("fg_manifest", value); }
};

function normalizeApiBase(value) {
  const raw = value.trim();
  if (!raw) return "";

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Enter the complete backend URL, including https://");
  }

  const localHosts = new Set(["localhost", "127.0.0.1", "10.0.2.2"]);
  const localHttp = url.protocol === "http:" && localHosts.has(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("Frontier Guide requires an HTTPS backend URL outside local development.");
  }

  url.hash = "";
  url.search = "";
  url.pathname = url.pathname
    .replace(/\/+$/, "")
    .replace(/\/api(?:\/(?:health|ask|live-update))?$/i, "") || "/";
  return url.toString().replace(/\/$/, "");
}

function serverHeaders(json = false) {
  const headers = {};
  if (json) headers["content-type"] = "application/json";
  if (settings.token) headers["x-frontier-key"] = settings.token;
  return headers;
}

async function requestJson(path, options = {}) {
  if (!settings.api) {
    const error = new Error("AI server is not configured.");
    error.code = "NO_API";
    throw error;
  }

  const response = await fetch(`${settings.api}${path}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Server returned ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function setView(view) {
  $$(".view").forEach(element => element.classList.remove("active"));
  $(`#${view}View`)?.classList.add("active");
  $$(".bottom-nav button").forEach(button => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

$$('[data-view]').forEach(button => {
  button.addEventListener("click", () => setView(button.dataset.view));
});

$$(".mode").forEach(button => {
  button.addEventListener("click", () => {
    $$(".mode").forEach(item => item.classList.remove("active"));
    button.classList.add("active");
    state.mode = button.dataset.mode;
    renderGuide();
  });
});

function appendSources(container, sources = []) {
  const list = document.createElement("div");
  list.className = "sources";

  for (const source of sources.slice(0, 8)) {
    try {
      const url = new URL(source.url);
      if (!["http:", "https:"].includes(url.protocol)) continue;
      const link = document.createElement("a");
      link.href = url.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = `Source: ${source.title || url.hostname}`;
      list.appendChild(link);
    } catch {
      // Ignore malformed source URLs returned by an upstream provider.
    }
  }

  if (list.childElementCount) container.appendChild(list);
}

function msg(role, text, sources = []) {
  const message = document.createElement("div");
  message.className = `message ${role}`;
  const body = document.createElement("div");
  body.className = "message-body";

  if (role === "assistant") {
    const avatar = document.createElement("div");
    avatar.className = "message-avatar";
    avatar.textContent = "FG";
    message.appendChild(avatar);
  }

  const speaker = document.createElement("b");
  speaker.textContent = role === "user" ? "You" : "Frontier Guide";
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  body.append(speaker, paragraph);
  appendSources(body, sources);
  message.appendChild(body);
  $("#chat").appendChild(message);
  $("#chat").scrollTop = $("#chat").scrollHeight;
  return message;
}

function localAnswer(question) {
  const terms = question.toLowerCase().split(/\W+/).filter(term => term.length > 2);
  const ranked = state.guide
    .map(item => {
      const haystack = `${item.title} ${item.body} ${item.category}`.toLowerCase();
      const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
      return [item, score];
    })
    .filter(([, score]) => score > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3);

  if (!ranked.length) {
    return "I don't have a strong offline match for that yet. Try the Master Guide, show me a camera frame, or configure the AI server in Settings for full visual and live-web help.";
  }
  return ranked.map(([item], index) => `${index + 1}. ${item.title}: ${item.body}`).join("\n\n");
}

$("#askForm").addEventListener("submit", async event => {
  event.preventDefault();
  const question = $("#question").value.trim();
  if (!question) return;

  msg("user", question);
  $("#question").value = "";
  const loading = msg("assistant", "Thinking");
  loading.classList.add("loading");

  try {
    if (!settings.api) {
      loading.remove();
      msg("assistant", localAnswer(question));
      return;
    }

    const output = await requestJson("/api/ask", {
      method: "POST",
      headers: serverHeaders(true),
      body: JSON.stringify({
        question,
        mode: state.mode,
        imageDataUrl: state.image,
        live: $("#liveSearch").checked
      })
    });
    loading.remove();
    msg("assistant", output.answer || "No answer returned.", output.sources || []);
  } catch (error) {
    loading.remove();
    const detail = error.status === 401
      ? "The server access key is missing or incorrect. Open Settings and paste the FRONTIER_CLIENT_TOKEN value."
      : error.message;
    msg("assistant", `AI server: ${detail}\n\nOffline guide result:\n\n${localAnswer(question)}`);
  } finally {
    state.image = null;
    $("#imagePreviewWrap").classList.add("hidden");
  }
});

$("#clearChat").onclick = () => {
  $("#chat").innerHTML = "";
  msg("assistant", "Fresh trail. What do you need?");
};

async function loadGuide() {
  try {
    const response = await fetch("content/guide.json");
    state.guide = await response.json();
  } catch {
    state.guide = [];
  }
  renderTags();
  renderGuide();
}

function renderTags() {
  const categories = ["All", ...new Set(state.guide.map(item => item.category))];
  $("#guideTags").innerHTML = "";
  for (const category of categories) {
    const button = document.createElement("button");
    button.className = `tag${state.category === category ? " active" : ""}`;
    button.textContent = category;
    button.onclick = () => {
      state.category = category;
      renderTags();
      renderGuide();
    };
    $("#guideTags").appendChild(button);
  }
}

function renderGuide() {
  const query = ($("#guideSearch")?.value || "").toLowerCase();
  const items = state.guide.filter(item => {
    const modeMatches = state.mode === "either" || item.mode === "either" || item.mode === state.mode;
    const categoryMatches = state.category === "All" || item.category === state.category;
    const textMatches = !query || `${item.title} ${item.body} ${item.category}`.toLowerCase().includes(query);
    return modeMatches && categoryMatches && textMatches;
  });

  $("#guideResults").innerHTML = "";
  for (const item of items) {
    const card = document.createElement("article");
    card.className = "card";
    const title = document.createElement("h3");
    title.textContent = item.title;
    const body = document.createElement("p");
    body.textContent = item.body;
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = `${item.category} • ${item.mode}`;
    card.append(title, body, badge);
    $("#guideResults").appendChild(card);
  }

  if (!items.length) {
    const card = document.createElement("article");
    card.className = "card";
    card.innerHTML = "<h3>No matches</h3><p>Try a broader search or switch mode.</p>";
    $("#guideResults").appendChild(card);
  }
}

$("#guideSearch").addEventListener("input", renderGuide);

async function openCamera() {
  try {
    state.cameraStream?.getTracks().forEach(track => track.stop());
    state.cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: state.cameraFacing },
      audio: false
    });
    $("#cameraVideo").srcObject = state.cameraStream;
    $("#cameraDialog").showModal();
  } catch {
    alert("Camera permission was not available. Check the Frontier Guide camera permission in Android Settings.");
  }
}

$("#cameraBtn").onclick = openCamera;
$("#closeCamera").onclick = () => {
  $("#cameraDialog").close();
  state.cameraStream?.getTracks().forEach(track => track.stop());
  state.cameraStream = null;
};
$("#flipCamera").onclick = async () => {
  state.cameraFacing = state.cameraFacing === "environment" ? "user" : "environment";
  await openCamera();
};
$("#captureCamera").onclick = () => {
  const video = $("#cameraVideo");
  const canvas = $("#cameraCanvas");
  canvas.width = video.videoWidth || 1_280;
  canvas.height = video.videoHeight || 720;
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  state.image = canvas.toDataURL("image/jpeg", 0.82);
  $("#imagePreview").src = state.image;
  $("#imagePreviewWrap").classList.remove("hidden");
  $("#cameraDialog").close();
  state.cameraStream?.getTracks().forEach(track => track.stop());
  state.cameraStream = null;
  setView("ask");
  $("#question").focus();
};
$("#removeImage").onclick = () => {
  state.image = null;
  $("#imagePreviewWrap").classList.add("hidden");
};

function nativeAvailable() {
  return Boolean(window.AndroidBridge?.startScreenShare);
}

function updateScreenDialog() {
  if (nativeAvailable()) {
    $("#screenHelp").innerHTML = "<p><b>Android screen capture is available.</b> Tap Start, approve Android’s system prompt, then switch to your game or remote-play screen. Frontier Guide keeps only the latest frame for you to attach.</p>";
    $("#startNativeScreen").classList.remove("hidden");
  } else {
    $("#screenHelp").innerHTML = "<p><b>This browser cannot capture the Android screen directly.</b> Install the included Android app for screen sharing. Camera mode works here now.</p>";
    $("#startNativeScreen").classList.add("hidden");
  }
}

$("#screenBtn").onclick = () => {
  updateScreenDialog();
  $("#screenDialog").showModal();
};
$("#closeScreen").onclick = () => {
  $("#screenDialog").close();
  clearInterval(state.screenTimer);
};
$("#startNativeScreen").onclick = () => {
  try {
    window.AndroidBridge.startScreenShare();
    $("#screenHelp").innerHTML = "<p>Approve Android’s screen-capture prompt, switch to the game, then return here and tap <b>Use latest frame</b>.</p>";
    $("#useScreenFrame").classList.remove("hidden");
    clearInterval(state.screenTimer);
    state.screenTimer = setInterval(refreshNativeFrame, 1_800);
  } catch {
    alert("Android screen capture could not start.");
  }
};

function refreshNativeFrame() {
  try {
    const dataUrl = window.AndroidBridge.getLatestScreenDataUrl();
    if (dataUrl?.startsWith("data:image")) {
      $("#screenPreview").src = dataUrl;
      $("#screenPreview").classList.remove("hidden");
    }
  } catch {
    // The bridge can be temporarily unavailable while Android starts capture.
  }
}

$("#useScreenFrame").onclick = () => {
  refreshNativeFrame();
  if ($("#screenPreview").src?.startsWith("data:image")) {
    state.image = $("#screenPreview").src;
    $("#imagePreview").src = state.image;
    $("#imagePreviewWrap").classList.remove("hidden");
    $("#screenDialog").close();
    clearInterval(state.screenTimer);
    setView("ask");
  }
};

function setConnectionState(kind, label) {
  const status = $("#onlineDot");
  status.classList.remove("online", "warning");
  if (kind) status.classList.add(kind);
  status.innerHTML = `<span></span> ${label}`;
}

async function checkStatus(showMessage = false) {
  if (!settings.api) {
    setConnectionState("", "Offline ready");
    if (showMessage) $("#settingsMsg").textContent = "Settings saved. Add the HTTPS backend URL to enable live AI.";
    return false;
  }

  try {
    const data = await requestJson("/api/health", {
      cache: "no-store",
      headers: serverHeaders()
    });

    if (data.authRequired && !data.authorized) {
      setConnectionState("warning", "Access key needed");
      if (showMessage) $("#settingsMsg").textContent = "Server found, but the access key is missing or incorrect.";
      return false;
    }
    if (!data.configured) {
      setConnectionState("warning", "Server needs API key");
      if (showMessage) $("#settingsMsg").textContent = "Server found, but OPENAI_API_KEY is not configured on the host.";
      return false;
    }

    setConnectionState("online", "AI connected");
    if (showMessage) {
      $("#settingsMsg").textContent = `Connected to Frontier Guide ${data.version || ""} using ${data.model || "the configured model"}.`;
    }
    return true;
  } catch (error) {
    setConnectionState("", "Offline ready");
    if (showMessage) $("#settingsMsg").textContent = `Connection failed: ${error.message}`;
    return false;
  }
}

$("#apiBase").value = settings.api;
$("#apiToken").value = settings.token;
$("#manifestUrl").value = settings.manifest;
$("#saveSettings").onclick = async () => {
  try {
    settings.api = normalizeApiBase($("#apiBase").value);
    settings.token = $("#apiToken").value.trim();
    settings.manifest = $("#manifestUrl").value.trim();
    $("#apiBase").value = settings.api;
    $("#settingsMsg").textContent = "Saved. Checking the server…";
    await checkStatus(true);
  } catch (error) {
    $("#settingsMsg").textContent = error.message;
  }
};

function setUpdateCard(title, text, extraClass = "") {
  const card = document.createElement("article");
  card.className = `card ${extraClass}`.trim();
  const heading = document.createElement("h3");
  heading.textContent = title;
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  card.append(heading, paragraph);
  $("#updatesFeed").replaceChildren(card);
  return card;
}

async function liveUpdate() {
  if (!settings.api) {
    setUpdateCard("AI server not configured", "Open Settings and add the backend URL. The bundled guide still works offline.");
    return;
  }

  setUpdateCard("Checking the frontier…", "Scanning current Rockstar and community sources. This can take a moment.");
  try {
    const data = await requestJson("/api/live-update", {
      method: "POST",
      headers: serverHeaders(true),
      body: "{}"
    });
    const card = setUpdateCard("Latest field report", data.answer || "No update returned.");
    appendSources(card, data.sources || []);
  } catch (error) {
    const detail = error.status === 401
      ? "The server access key is missing or incorrect. Check Settings."
      : error.message;
    setUpdateCard("Update scan failed", detail);
  }
}

$("#refreshUpdates").onclick = liveUpdate;

async function contentUpdate() {
  if (!settings.manifest) {
    $("#settingsMsg").textContent = "No remote guide manifest URL is set.";
    return;
  }
  try {
    const response = await fetch(settings.manifest, { cache: "no-store" });
    if (!response.ok) throw new Error(`Manifest returned ${response.status}.`);
    const manifest = await response.json();
    $("#settingsMsg").textContent = `Remote guide version: ${manifest.version || "unknown"}. ${manifest.notes || ""}`;
  } catch (error) {
    $("#settingsMsg").textContent = `Could not load the remote manifest: ${error.message}`;
  }
}

$("#checkUpdates").onclick = contentUpdate;

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

loadGuide();
checkStatus();
