const state = {
  mode: "story",
  image: null,
  cameraFacing: "environment",
  cameraStream: null,
  guide: [],
  category: "All",
  screenTimer: null,
  history: [],
  listening: false,
  handsFree: false,
  recognition: null,
  voiceRequest: false,
  coachTimer: null,
  coachBusy: false,
  mapLocations: [],
  mapCategory: "All",
  selectedMapId: null
};

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const hostedApiBase = ["http:", "https:"].includes(window.location.protocol)
  && window.location.hostname !== "appassets.androidplatform.net"
  ? window.location.origin
  : "";
const defaultApiBase = "https://frontier-guide-api.onrender.com";
const settings = {
  get api() { return localStorage.getItem("fg_api") || hostedApiBase || defaultApiBase; },
  set api(value) { localStorage.setItem("fg_api", value); },
  get token() { return localStorage.getItem("fg_token") || ""; },
  set token(value) { localStorage.setItem("fg_token", value); },
  get manifest() { return localStorage.getItem("fg_manifest") || ""; },
  set manifest(value) { localStorage.setItem("fg_manifest", value); },
  get autoSpeak() { return localStorage.getItem("fg_auto_speak") !== "false"; },
  set autoSpeak(value) { localStorage.setItem("fg_auto_speak", String(Boolean(value))); }
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
    if (state.mode === "online") $("#liveSearch").checked = true;
    renderTags();
    renderGuide();
    renderMapTags();
    renderMap();
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

function fillAnswer(element, text) {
  element.replaceChildren();
  const parts = String(text || "").split(/(\*\*[^*]+\*\*)/g);
  for (const part of parts) {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      const strong = document.createElement("strong");
      strong.textContent = part.slice(2, -2);
      element.appendChild(strong);
    } else {
      element.appendChild(document.createTextNode(part));
    }
  }
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
  fillAnswer(paragraph, text);
  body.append(speaker, paragraph);
  appendSources(body, sources);
  message.appendChild(body);
  $("#chat").appendChild(message);
  $("#chat").scrollTop = $("#chat").scrollHeight;
  return message;
}

function cleanForSpeech(text) {
  return String(text || "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_`#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 5_000);
}

function updateVoiceStatus(label, transcript = "") {
  $("#voiceStatus").textContent = label;
  if (transcript) $("#voiceTranscript").textContent = transcript;
  $("#talkBtn").classList.toggle("listening", state.listening);
}

function stopSpeaking() {
  try { window.AndroidBridge?.stopSpeaking?.(); } catch {}
  try { window.speechSynthesis?.cancel(); } catch {}
}

function speakAnswer(text) {
  if (!settings.autoSpeak) {
    if (state.handsFree) window.setTimeout(startListening, 350);
    return;
  }

  const spoken = cleanForSpeech(text);
  if (!spoken) return;
  updateVoiceStatus("Frontier is answering", spoken);
  try {
    if (window.AndroidBridge?.speak) {
      window.AndroidBridge.speak(spoken, 0.96, 0.92);
      return;
    }
  } catch {}

  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(spoken);
    utterance.rate = 0.96;
    utterance.pitch = 0.92;
    utterance.onend = () => window.FrontierGuideNative.onSpeechFinished();
    utterance.onerror = () => updateVoiceStatus("Voice playback stopped");
    window.speechSynthesis.speak(utterance);
  }
}

async function askQuestion(question, { fromVoice = false } = {}) {
  const cleanQuestion = String(question || "").trim();
  if (!cleanQuestion) return;

  msg("user", cleanQuestion);
  state.history.push({ role: "user", content: cleanQuestion });
  state.history = state.history.slice(-10);
  $("#question").value = "";
  if (fromVoice) updateVoiceStatus("Frontier is thinking", cleanQuestion);
  const loading = msg("assistant", "Thinking");
  loading.classList.add("loading");

  let answer = "";
  let sources = [];
  try {
    if (!settings.api) {
      answer = localAnswer(cleanQuestion);
    } else {
      const output = await requestJson("/api/ask", {
        method: "POST",
        headers: serverHeaders(true),
        body: JSON.stringify({
          question: cleanQuestion,
          mode: state.mode,
          imageDataUrl: state.image,
          live: $("#liveSearch").checked,
          history: state.history.slice(0, -1)
        })
      });
      answer = output.answer || "No answer returned.";
      sources = output.sources || [];
    }
  } catch (error) {
    if (error.status === 429) setConnectionState("warning", "AI busy");
    const detail = error.status === 401
      ? "The server access key is missing or incorrect. Open Settings and paste the FRONTIER_CLIENT_TOKEN value."
      : error.message;
    answer = `AI server: ${detail}\n\nOffline guide result:\n\n${localAnswer(cleanQuestion)}`;
  } finally {
    loading.remove();
    msg("assistant", answer, sources);
    state.history.push({ role: "assistant", content: answer });
    state.history = state.history.slice(-10);
    state.image = null;
    $("#imagePreviewWrap").classList.add("hidden");
    $("#analyzeImageBtn").classList.add("hidden");
  }

  if (fromVoice || settings.autoSpeak) speakAnswer(answer);
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
  await askQuestion(question);
});

$("#clearChat").onclick = () => {
  $("#chat").innerHTML = "";
  state.history = [];
  msg("assistant", "Fresh trail. What do you need?");
};

function finishListening() {
  state.listening = false;
  updateVoiceStatus("Tap the microphone and talk");
}

function handleVoiceResult(text) {
  const result = String(text || "").trim();
  finishListening();
  if (!result) {
    updateVoiceStatus("I did not catch that", "Tap the microphone and try again.");
    return;
  }
  updateVoiceStatus("You said", result);
  setView("voice");
  askQuestion(result, { fromVoice: true });
}

function startBrowserRecognition() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    finishListening();
    updateVoiceStatus("Voice input is unavailable", "Use the Android app or type your question in Ask Guide.");
    return;
  }

  const recognition = new Recognition();
  state.recognition = recognition;
  recognition.lang = "en-US";
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;
  let finalText = "";
  recognition.onresult = event => {
    let interim = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const text = event.results[index][0]?.transcript || "";
      if (event.results[index].isFinal) finalText += text;
      else interim += text;
    }
    updateVoiceStatus("Listening…", finalText || interim);
  };
  recognition.onend = () => finalText ? handleVoiceResult(finalText) : finishListening();
  recognition.onerror = event => {
    finishListening();
    updateVoiceStatus("Microphone stopped", event.error === "not-allowed" ? "Allow microphone access, then try again." : "Tap the microphone to retry.");
  };
  recognition.start();
}

function startListening() {
  if (state.listening) return;
  stopSpeaking();
  state.listening = true;
  updateVoiceStatus("Listening…", "Ask about the screen, a mission, gold, money, collectibles, or your next move.");
  try {
    if (window.AndroidBridge?.startVoiceInput) {
      window.AndroidBridge.startVoiceInput();
      return;
    }
  } catch {}
  startBrowserRecognition();
}

function stopVoiceMode() {
  state.handsFree = false;
  state.listening = false;
  state.recognition?.stop?.();
  stopSpeaking();
  $("#handsFreeBtn").textContent = "Hands-Free: Off";
  $("#handsFreeBtn").classList.remove("active");
  updateVoiceStatus("Voice stopped", "Tap the microphone whenever you are ready.");
}

window.FrontierGuideNative = {
  onSpeechResult: handleVoiceResult,
  onSpeechError(message) {
    finishListening();
    updateVoiceStatus("Microphone stopped", message || "Tap the microphone to retry.");
  },
  onSpeechFinished() {
    updateVoiceStatus(state.handsFree ? "Listening again…" : "Ready for your next question");
    if (state.handsFree) window.setTimeout(startListening, 500);
  }
};

$("#talkBtn").onclick = startListening;
$("#stopVoice").onclick = stopVoiceMode;
$("#handsFreeBtn").onclick = () => {
  state.handsFree = !state.handsFree;
  $("#handsFreeBtn").textContent = `Hands-Free: ${state.handsFree ? "On" : "Off"}`;
  $("#handsFreeBtn").classList.toggle("active", state.handsFree);
  if (state.handsFree && !state.listening) startListening();
};
$("#autoSpeak").checked = settings.autoSpeak;
$("#autoSpeak").onchange = event => { settings.autoSpeak = event.target.checked; };

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

function modeMatches(item) {
  return state.mode === "either" || item.mode === "either" || item.mode === state.mode;
}

function renderTags() {
  const visible = state.guide.filter(modeMatches);
  const categories = ["All", ...new Set(visible.map(item => item.category))];
  if (!categories.includes(state.category)) state.category = "All";
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
    const categoryMatches = state.category === "All" || item.category === state.category;
    const textMatches = !query || `${item.title} ${item.body} ${item.category}`.toLowerCase().includes(query);
    return modeMatches(item) && categoryMatches && textMatches;
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

function attachImage(dataUrl) {
  if (!String(dataUrl || "").startsWith("data:image")) return;
  state.image = dataUrl;
  $("#imagePreview").src = dataUrl;
  $("#imagePreviewWrap").classList.remove("hidden");
  $("#analyzeImageBtn").classList.remove("hidden");
}

async function imageFileToDataUrl(file) {
  if (!file?.type?.startsWith("image/")) throw new Error("Choose a JPG, PNG, WEBP, or GIF image.");
  if (file.size > 20_000_000) throw new Error("That image is too large. Choose one under 20 MB.");
  const source = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("The image could not be read."));
    reader.readAsDataURL(file);
  });
  const image = await new Promise((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error("The image format could not be opened."));
    element.src = source;
  });
  const maxSide = 1_600;
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.84);
}

$("#uploadImageBtn").onclick = () => $("#imageUpload").click();
$("#imageUpload").onchange = async event => {
  try {
    const file = event.target.files?.[0];
    if (!file) return;
    attachImage(await imageFileToDataUrl(file));
    setView("ask");
    $("#question").focus();
  } catch (error) {
    alert(error.message);
  } finally {
    event.target.value = "";
  }
};
$("#analyzeImageBtn").onclick = () => {
  askQuestion($("#question").value.trim() || "Analyze this Red Dead game image. Identify what is visible and tell me exactly what I should do next.", { fromVoice: true });
};

async function openCamera() {
  try {
    state.cameraStream?.getTracks().forEach(track => track.stop());
    state.cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: state.cameraFacing },
      audio: false
    });
    $("#cameraVideo").srcObject = state.cameraStream;
    if (!$("#cameraDialog").open) $("#cameraDialog").showModal();
  } catch {
    alert("Camera permission was not available. Check the Frontier Guide camera permission in Android Settings.");
  }
}

$("#cameraBtn").onclick = openCamera;
$("#closeCamera").onclick = () => {
  stopLiveCoach();
  $("#cameraDialog").close();
  state.cameraStream?.getTracks().forEach(track => track.stop());
  state.cameraStream = null;
};
$("#flipCamera").onclick = async () => {
  state.cameraFacing = state.cameraFacing === "environment" ? "user" : "environment";
  await openCamera();
};
function captureCameraFrame() {
  const video = $("#cameraVideo");
  const canvas = $("#cameraCanvas");
  canvas.width = video.videoWidth || 1_280;
  canvas.height = video.videoHeight || 720;
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.82);
}
$("#captureCamera").onclick = () => {
  attachImage(captureCameraFrame());
  $("#cameraDialog").close();
  state.cameraStream?.getTracks().forEach(track => track.stop());
  state.cameraStream = null;
  setView("ask");
  $("#question").focus();
};
$("#removeImage").onclick = () => {
  state.image = null;
  $("#imagePreviewWrap").classList.add("hidden");
  $("#analyzeImageBtn").classList.add("hidden");
};

async function runLiveCoachFrame() {
  if (state.coachBusy || !state.cameraStream) return;
  state.coachBusy = true;
  try {
    attachImage(captureCameraFrame());
    await askQuestion("Act as my live Red Dead coach. Read this screen, identify what changed, and tell me the single best next action in two or three short spoken sentences. If you cannot confirm the view, tell me how to point the camera.", { fromVoice: true });
  } finally {
    state.coachBusy = false;
  }
}

function stopLiveCoach() {
  clearInterval(state.coachTimer);
  state.coachTimer = null;
  state.coachBusy = false;
  $("#liveCoachCamera").textContent = "Start Live Coach";
  $("#liveCoachCamera").classList.remove("active");
}

$("#liveCoachCamera").onclick = () => {
  if (state.coachTimer) {
    stopLiveCoach();
    return;
  }
  $("#liveCoachCamera").textContent = "Stop Live Coach";
  $("#liveCoachCamera").classList.add("active");
  runLiveCoachFrame();
  state.coachTimer = setInterval(runLiveCoachFrame, 15_000);
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
    $("#analyzeScreenFrame").classList.remove("hidden");
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
    attachImage($("#screenPreview").src);
    $("#screenDialog").close();
    clearInterval(state.screenTimer);
    setView("ask");
  }
};

$("#analyzeScreenFrame").onclick = async () => {
  refreshNativeFrame();
  if (!$("#screenPreview").src?.startsWith("data:image")) {
    $("#screenHelp").innerHTML = "<p>No frame is ready yet. Switch to the game for a moment, then return and try again.</p>";
    return;
  }
  attachImage($("#screenPreview").src);
  $("#screenDialog").close();
  clearInterval(state.screenTimer);
  setView("voice");
  await askQuestion("Analyze my latest game screen and talk me through the next action. Read any visible objective or map marker and keep the answer short enough to follow while playing.", { fromVoice: true });
};

async function loadMap() {
  try {
    const response = await fetch("content/map.json");
    state.mapLocations = await response.json();
  } catch {
    state.mapLocations = [];
  }
  renderMapTags();
  renderMap();
}

function renderMapTags() {
  const visible = state.mapLocations.filter(modeMatches);
  const categories = ["All", ...new Set(visible.map(item => item.category))];
  if (!categories.includes(state.mapCategory)) state.mapCategory = "All";
  $("#mapTags").replaceChildren();
  for (const category of categories) {
    const button = document.createElement("button");
    button.className = `tag${state.mapCategory === category ? " active" : ""}`;
    button.textContent = category;
    button.onclick = () => {
      state.mapCategory = category;
      state.selectedMapId = null;
      renderMapTags();
      renderMap();
    };
    $("#mapTags").appendChild(button);
  }
}

function showMapDetail(item) {
  state.selectedMapId = item.id;
  renderMap();
  const detail = $("#mapDetail");
  detail.replaceChildren();
  const title = document.createElement("h3");
  title.textContent = item.title;
  const body = document.createElement("p");
  body.textContent = `${item.region} • ${item.mode}\n\n${item.directions}\n\n${item.note}`;
  const actions = document.createElement("div");
  actions.className = "map-actions";
  const ask = document.createElement("button");
  ask.className = "send compact";
  ask.textContent = "Speak full directions";
  ask.onclick = () => {
    setView("voice");
    askQuestion(`Give me spoken step-by-step directions and all requirements for ${item.title} in ${item.region}. My selected mode is ${state.mode}. Correct me if this location does not apply to my mode.`, { fromVoice: true });
  };
  actions.appendChild(ask);
  detail.append(title, body, actions);
}

function renderMap() {
  const items = state.mapLocations.filter(item => {
    const categoryMatch = state.mapCategory === "All" || item.category === state.mapCategory;
    return categoryMatch && modeMatches(item);
  });
  $("#mapMarkers").replaceChildren();
  items.forEach((item, index) => {
    const marker = document.createElement("button");
    marker.className = `map-marker${state.selectedMapId === item.id ? " active" : ""}`;
    marker.style.left = `${item.x}%`;
    marker.style.top = `${item.y}%`;
    marker.title = item.title;
    marker.setAttribute("aria-label", item.title);
    const label = document.createElement("span");
    label.textContent = String(index + 1);
    marker.appendChild(label);
    marker.onclick = () => showMapDetail(item);
    $("#mapMarkers").appendChild(marker);
  });
}

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
  fillAnswer(paragraph, text);
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
    if (error.status === 429) setConnectionState("warning", "AI busy");
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

if ("serviceWorker" in navigator && window.location.hostname !== "appassets.androidplatform.net") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

loadGuide();
loadMap();
checkStatus();
