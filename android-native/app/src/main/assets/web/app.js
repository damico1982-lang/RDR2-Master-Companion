if (typeof Element !== "undefined" && !Element.prototype.replaceChildren) {
  Element.prototype.replaceChildren = function (...nodes) {
    while (this.firstChild) this.removeChild(this.firstChild);
    if (nodes.length) this.append(...nodes);
  };
}

const sessionApi = window.FrontierSession;
if (!sessionApi?.parseSseBuffer || !sessionApi.createVoiceSession || !sessionApi.createAskGate || !sessionApi.createSpeechGate) {
  throw new Error("Frontier Guide session helpers did not load.");
}
const voice = sessionApi.createVoiceSession();
const askGate = sessionApi.createAskGate();
const speechGate = sessionApi.createSpeechGate();
const parseSseBuffer = sessionApi.parseSseBuffer;
const attachmentOutcome = sessionApi.attachmentOutcome;
let spokenToken = 0;
let screenPhase = "idle";
let screenToken = 0;
let pendingScreenToken = 0;
let screenSession = "";
let activeGen = 0;
const coach = {
  state: "stopped",
  source: "camera",
  session: 0,
  frame: 0,
  timer: 0,
  busy: false,
  abort: null,
  muted: false,
  paused: false,
  lastTip: "",
  lastUpload: 0,
  lastMean: -1,
  ownsScreen: false,
  profile: {}
};

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
  baseMap: [],
  gazetteer: [],
  disabledMapCategories: new Set(),
  selectedMapId: null,
  legendaries: [],
  animals: [],
  secrets: [],
  hiddenPlaces: [],
  animalSize: "All",
  animalRegion: "All",
  hiddenCategory: "All",
  selectedHiddenId: null,
  speechAudio: null,
  speechUrl: "",
  attachmentId: 0
};

try {
  const savedMode = localStorage.getItem("fg_mode");
  if (savedMode === "story" || savedMode === "online" || savedMode === "either") state.mode = savedMode;
} catch {
  // Private mode can block storage. The in-memory mode still works for this visit.
}

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const hostedApiBase = ["http:", "https:"].includes(window.location.protocol)
  && window.location.hostname !== "appassets.androidplatform.net"
  ? window.location.origin
  : "";
const defaultApiBase = "https://frontier-guide-api.onrender.com";
const settings = {
  get serverMode() {
    const mode = localStorage.getItem("fg_server_mode") || "auto";
    return mode === "custom" || mode === "offline" ? mode : "auto";
  },
  set serverMode(value) {
    const mode = value === "custom" || value === "offline" ? value : "auto";
    localStorage.setItem("fg_server_mode", mode);
  },
  get api() {
    if (this.serverMode === "offline") return "";
    if (this.serverMode === "custom") return localStorage.getItem("fg_api") || "";
    return hostedApiBase || defaultApiBase;
  },
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

  if (url.username || url.password) {
    throw new Error("Remove the username and password from the server URL.");
  }

  const localHosts = new Set(["localhost", "127.0.0.1", "10.0.2.2"]);
  const localHttp = url.protocol === "http:" && localHosts.has(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("Frontier Guide requires an HTTPS backend URL outside local development.");
  }

  url.hash = "";
  url.search = "";
  url.username = "";
  url.password = "";
  url.pathname = url.pathname
    .replace(/\/+$/, "")
    .replace(/\/api(?:\/(?:health|ask|speak|coach|live-update))?$/i, "") || "/";
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

function navFor(view) {
  if (view === "map" || view === "hidden") return "guide";
  return view;
}

function setView(view) {
  closePreviewDialog();
  $$(".view").forEach(element => element.classList.remove("active"));
  const panel = $(`#${view}View`);
  panel?.classList.add("active");
  const nav = navFor(view);
  $$(".bottom-nav button").forEach(button => {
    const on = button.dataset.view === nav;
    button.classList.toggle("active", on);
    if (on) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  panel?.scrollIntoView({ block: "start", behavior: "auto" });
  if (view === "map" || view === "hidden") {
    const map = document.getElementById(view === "map" ? "fieldMap" : "hiddenMap");
    requestAnimationFrame(() => map?.frontierReflow?.());
  }
  syncMapScrollLock();
}

function syncMapScrollLock() {
  const open = Boolean(document.querySelector("#mapView.active, #hiddenView.active"));
  document.documentElement.classList.toggle("map-open", open);
}

$$('[data-view]').forEach(button => {
  button.addEventListener("click", () => setView(button.dataset.view));
});
window.__frontierBound = true;

function applyModeButtons() {
  $$("[data-mode]").forEach(item => item.classList.toggle("active", item.dataset.mode === state.mode));
  if (state.mode === "online") {
    const live = $("#liveSearch");
    if (live) live.checked = true;
  }
}

$$("[data-mode]").forEach(button => {
  button.addEventListener("click", () => {
    $$("[data-mode]").forEach(item => item.classList.remove("active"));
    button.classList.add("active");
    state.mode = button.dataset.mode;
    try { localStorage.setItem("fg_mode", state.mode); } catch { /* keep the choice for this visit */ }
    if (state.mode === "online") $("#liveSearch").checked = true;
    reconcileModeSelection();
    renderTags();
    renderGuide();
    renderMapTags();
    renderMap();
    renderLegendaries();
    renderAnimalFilters();
    renderAnimals();
    renderSecrets();
    renderHiddenTags();
    renderHiddenMap();
    renderHiddenList();
  });
});
applyModeButtons();

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
    .slice(0, 5000);
}

function updateVoiceStatus(label, transcript = "") {
  $("#voiceStatus").textContent = label;
  if (transcript) $("#voiceTranscript").textContent = transcript;
  $("#talkBtn").classList.toggle("listening", state.listening);
}

function silenceOutput() {
  try { window.AndroidBridge?.stopSpeaking?.(); } catch {}
  try { window.speechSynthesis?.cancel(); } catch {}
  if (state.speechAudio) {
    state.speechAudio.onended = null;
    state.speechAudio.pause();
    state.speechAudio = null;
  }
  if (state.speechUrl) {
    URL.revokeObjectURL(state.speechUrl);
    state.speechUrl = "";
  }
}

function stopSpeaking() {
  speechGate.invalidate();
  spokenToken = 0;
  silenceOutput();
}

function pickDeepMaleVoice() {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  const english = voices.filter(voice => /^en/i.test(voice.lang || ""));
  const ranked = english.map(voice => {
    const name = `${voice.name || ""}`.toLowerCase();
    let score = 0;
    if (name.includes("female")) score -= 30;
    if (name.includes("male")) score += 16;
    if (/deep|low|daniel|alex|david|fred|arthur|marcus|george|brian/.test(name)) score += 8;
    return { voice, score };
  }).sort((left, right) => right.score - left.score);
  if (ranked[0]?.score > 0) return ranked[0].voice;
  return english[0] || null;
}

function deviceSpeak(spoken, token) {
  if (!speechGate.current(token)) return;
  try {
    if (window.AndroidBridge?.speak) {
      window.AndroidBridge.speak(spoken, 0.92, 0.78);
      return;
    }
  } catch {}

  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(spoken);
    const chosen = pickDeepMaleVoice();
    if (chosen) utterance.voice = chosen;
    utterance.rate = 0.94;
    utterance.pitch = 0.78;
    utterance.onend = () => {
      if (!speechGate.current(token)) return;
      window.FrontierGuideNative?.onSpeechFinished?.();
    };
    utterance.onerror = () => {
      if (speechGate.current(token)) updateVoiceStatus("Voice playback stopped");
    };
    window.speechSynthesis.speak(utterance);
  }
}

async function speakAnswer(text) {
  if (!settings.autoSpeak || coach.muted) {
    if (voice.handsFree && !coach.muted) voice.queueRestart(350, startListening);
    return;
  }

  const spoken = cleanForSpeech(text);
  if (!spoken) {
    if (voice.handsFree) voice.queueRestart(350, startListening);
    return;
  }
  const turn = speechGate.begin();
  spokenToken = turn.token;
  silenceOutput();
  updateVoiceStatus("Frontier is answering", spoken.slice(0, 180));

  if (settings.api) {
    try {
      const response = await fetch(`${settings.api}/api/speak`, {
        method: "POST",
        headers: serverHeaders(true),
        body: JSON.stringify({ text: spoken.slice(0, 3500) }),
        signal: turn.signal
      });
      if (!speechGate.current(turn.token)) return;
      const type = response.headers.get("content-type") || "";
      if (response.ok && type.includes("audio")) {
        const blob = await response.blob();
        if (!speechGate.current(turn.token)) return;
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        state.speechAudio = audio;
        state.speechUrl = url;
        audio.onended = () => {
          URL.revokeObjectURL(url);
          if (state.speechUrl === url) state.speechUrl = "";
          state.speechAudio = null;
          if (!speechGate.current(turn.token)) return;
          window.FrontierGuideNative?.onSpeechFinished?.();
        };
        audio.onerror = () => deviceSpeak(spoken, turn.token);
        await audio.play();
        return;
      }
    } catch (error) {
      if (!speechGate.current(turn.token) || error?.name === "AbortError") return;
    }
  }

  deviceSpeak(spoken, turn.token);
}

function setAskBusy(busy) {
  const button = $("#askSend");
  if (!button) return;
  button.innerHTML = busy ? "Cancel" : "Ask Guide <span>→</span>";
  button.setAttribute("aria-label", busy ? "Cancel the question" : "Ask Guide");
}

function clearAttachedImage() {
  state.attachmentId += 1;
  state.image = null;
  $("#imagePreviewWrap")?.classList.add("hidden");
  $("#analyzeImageBtn")?.classList.add("hidden");
}

async function askQuestion(question, { fromVoice = false } = {}) {
  const cleanQuestion = String(question || "").trim();
  if (!cleanQuestion) return;
  const turn = askGate.begin();
  if (!turn) {
    if (fromVoice) updateVoiceStatus("Still answering", "The last question is still running. Tap Stop to cancel it.");
    return;
  }
  const attachmentId = state.attachmentId;
  const imageSnap = state.image;
  setAskBusy(true);

  msg("user", cleanQuestion);
  state.history.push({ role: "user", content: cleanQuestion });
  state.history = state.history.slice(-12);
  const questionField = $("#question");
  if (questionField) questionField.value = "";
  if (fromVoice) updateVoiceStatus("Frontier is thinking", cleanQuestion);
  const loading = msg("assistant", "Thinking");
  loading.classList.add("loading");

  let answer = "";
  let sources = [];
  let sawDone = false;
  let failed = false;
  const paragraph = loading.querySelector("p");
  const applyEvents = events => {
    for (const message of events) {
      if (!message.data) continue;
      let event;
      try {
        event = JSON.parse(message.data);
      } catch {
        continue;
      }
      if (event.type === "delta" && event.text) {
        answer += event.text;
        paragraph.textContent = answer;
        const chat = $("#chat");
        if (chat) chat.scrollTop = chat.scrollHeight;
      } else if (event.type === "done") {
        sawDone = true;
        answer = event.answer || answer;
        sources = event.sources || [];
      } else if (event.type === "error") {
        const error = new Error(event.error || "The live guide stopped early.");
        error.partial = true;
        throw error;
      }
    }
  };
  const readAnswer = async response => {
    const type = response.headers.get("content-type") || "";
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const error = new Error(data.error || `Server returned ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    if (!type.includes("text/event-stream") || !response.body?.getReader) {
      const output = await response.json();
      answer = output.answer || "No answer returned.";
      sources = output.sources || [];
      sawDone = true;
      fillAnswer(paragraph, answer);
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      if (!askGate.matches(turn.token)) {
        const abortError = new Error("Cancelled");
        abortError.name = "AbortError";
        throw abortError;
      }
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseBuffer(buffer, false);
      buffer = parsed.rest;
      applyEvents(parsed.events);
    }
    buffer += decoder.decode();
    const ended = parseSseBuffer(buffer, true);
    applyEvents(ended.events);
    if (!answer) answer = "No answer returned.";
    else if (!sawDone) answer = `${answer}\n\nThe live reply ended early.`;
    fillAnswer(paragraph, answer);
  };
  try {
    if (!settings.api) {
      answer = localAnswer(cleanQuestion);
      fillAnswer(paragraph, answer);
    } else {
      const payload = {
        question: cleanQuestion,
        mode: state.mode,
        imageDataUrl: imageSnap,
        live: $("#liveSearch")?.checked === true,
        history: state.history.slice(0, -1)
      };
      const postAsk = (stream, signal) => fetch(`${settings.api}/api/ask`, {
        method: "POST",
        headers: serverHeaders(true),
        body: JSON.stringify({ ...payload, stream }),
        signal
      });
      const timeout = new AbortController();
      const onAbort = () => timeout.abort();
      turn.signal?.addEventListener("abort", onAbort);
      const timer = setTimeout(() => {
        if (!answer) timeout.abort();
      }, 40000);
      try {
        await readAnswer(await postAsk(true, timeout.signal));
      } catch (error) {
        if (!askGate.matches(turn.token) || turn.signal?.aborted) throw error;
        if (answer) throw error;
        await readAnswer(await postAsk(false, turn.signal));
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (error) {
    if (!askGate.matches(turn.token) || error.name === "AbortError") {
      failed = "abort";
    } else {
      failed = true;
      if (error.status === 429) setConnectionState("warning", "AI busy");
      const detail = error.status === 401
        ? "The server access key is missing or incorrect. Open Settings and paste the FRONTIER_CLIENT_TOKEN value."
        : error.message;
      if (!answer || !error.partial) {
        answer = `Live guide: ${detail}\n\n${localAnswer(cleanQuestion)}`;
      } else {
        answer = `${answer}\n\nLive guide stopped early. ${detail}`;
      }
      fillAnswer(paragraph, answer);
    }
  } finally {
    const live = askGate.finish(turn.token);
    if (!live || failed === "abort") {
      if (live) setAskBusy(false);
      return;
    }
    setAskBusy(false);
    loading.classList.remove("loading");
    appendSources(loading.querySelector(".message-body"), sources);
    state.history.push({ role: "assistant", content: answer });
    state.history = state.history.slice(-12);
    if (attachmentOutcome(attachmentId, state.attachmentId, failed !== true) === "clear") clearAttachedImage();
    if (fromVoice || settings.autoSpeak) speakAnswer(answer);
  }
}

function localAnswer(question) {
  const stop = new Set("the and for you your with from that this what where when how are was were not but can all into over near about does just then them they its who have has had will would should could may might than too also only some any out off our their there here get got".split(" "));
  const words = value => String(value || "").toLowerCase().split(/[^a-z0-9]+/).filter(term => term.length > 2 && !stop.has(term));
  const current = words(question);
  const prior = words(state.history.slice(-6, -1).map(item => item.content).join(" "));
  const entries = [
    ...state.guide.map(item => ({ title: item.title, body: item.body, mode: item.mode })),
    ...state.legendaries.map(item => ({
      title: item.name,
      mode: item.mode,
      body: `${item.region}. Near ${item.landmark}. ${item.conditions} ${item.unlock} Weapon: ${item.weapon} ${item.ammo}. Reward: ${item.reward}`.slice(0, 900)
    })),
    ...state.animals.map(item => ({
      title: item.name,
      mode: item.mode,
      body: `${item.where} Weapon: ${item.weapon}. ${item.bait ? `Bait: ${item.bait}.` : `Ammo: ${item.ammo}.`} ${item.note || ""}`.slice(0, 500)
    })),
    ...state.secrets.map(item => ({
      title: item.name,
      mode: item.mode,
      body: `${item.confirmed === false ? "Not confirmed. " : ""}${item.where} ${item.requirements} Reward: ${item.reward} ${(item.steps || []).join(" ")}`.slice(0, 900)
    })),
    ...state.hiddenPlaces.map(item => ({
      title: item.name,
      mode: item.mode,
      body: `${item.category}. ${item.region}. ${item.landmark}. ${item.enter} ${item.contents}`.slice(0, 700)
    }))
  ].filter(modeMatches);

  const ranked = entries
    .map(item => {
      const haystack = `${item.title} ${item.body}`.toLowerCase();
      let score = 0;
      for (const term of current) if (haystack.includes(term)) score += 2;
      for (const term of prior) if (haystack.includes(term)) score += 1;
      return [item, score];
    })
    .filter(([, score]) => score > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3);

  const lead = "Live guide is quiet, so this is straight from the bundled pages.";
  if (!ranked.length) {
    return `${lead} Nothing on file matches that. Try Legendary Animals, Animals & Weapons, Secrets, or Hidden Places.`;
  }
  return `${lead}\n\n${ranked.map(([item], index) => `${index + 1}. ${item.title}: ${item.body}`).join("\n\n")}`;
}

$("#askForm").addEventListener("submit", event => {
  event.preventDefault();
  if (askGate.busy) {
    askGate.abort();
    setAskBusy(false);
    document.querySelector("#chat .message.loading")?.remove();
    return;
  }
  const question = $("#question").value.trim();
  if (!question) return;
  askQuestion(question);
});

$("#clearChat").onclick = () => {
  askGate.abort();
  setAskBusy(false);
  $("#chat").innerHTML = "";
  state.history = [];
  msg("assistant", "Fresh trail. What do you need?");
};

function finishListening() {
  state.listening = voice.listening;
  if (!state.listening) updateVoiceStatus("Tap the microphone and talk");
}

function handleVoiceResult(text, gen) {
  const token = gen == null ? activeGen : Number(gen);
  if (!voice.acceptResult(token)) return;
  state.listening = false;
  const result = String(text || "").trim();
  if (!result) {
    updateVoiceStatus("I did not catch that", "Tap the microphone and try again.");
    return;
  }
  updateVoiceStatus("You said", result);
  setView("voice");
  askQuestion(result, { fromVoice: true });
}

function startBrowserRecognition(gen) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    voice.stop();
    state.listening = false;
    state.handsFree = false;
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
    if (gen !== activeGen) return;
    let interim = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const text = event.results[index][0]?.transcript || "";
      if (event.results[index].isFinal) finalText += text;
      else interim += text;
    }
    updateVoiceStatus("Listening…", finalText || interim);
  };
  recognition.onend = () => {
    if (finalText) handleVoiceResult(finalText, gen);
    else if (gen === activeGen) {
      state.listening = false;
      updateVoiceStatus("Tap the microphone and talk");
    }
  };
  recognition.onerror = event => {
    if (gen !== activeGen) return;
    state.listening = false;
    updateVoiceStatus("Microphone stopped", event.error === "not-allowed" ? "Allow microphone access, then try again." : "Tap the microphone to retry.");
  };
  recognition.start();
}

function startListening() {
  const gen = voice.begin();
  if (!gen) return;
  activeGen = gen;
  state.listening = true;
  stopSpeaking();
  updateVoiceStatus("Listening…", "Ask about the screen, a mission, gold, money, collectibles, or your next move.");
  try {
    if (window.AndroidBridge?.beginVoiceInput) {
      if (window.AndroidBridge.hasMicrophonePermission && !window.AndroidBridge.hasMicrophonePermission()) {
        updateVoiceStatus("Microphone", "Android is asking for microphone access. Choose Allow, then speak.");
      }
      window.AndroidBridge.beginVoiceInput(String(gen));
      return;
    }
    if (window.AndroidBridge?.requestMicrophonePermission) {
      window.AndroidBridge.requestMicrophonePermission();
      return;
    }
    if (window.AndroidBridge?.startVoiceInput) {
      window.AndroidBridge.startVoiceInput();
      return;
    }
  } catch (error) {
    window.frontierReport?.(error && (error.stack || error.message) || error);
  }
  startBrowserRecognition(gen);
}

function stopVoiceMode() {
  voice.stop();
  askGate.abort();
  setAskBusy(false);
  document.querySelector("#chat .message.loading")?.remove();
  state.handsFree = false;
  state.listening = false;
  try {
    state.recognition.onend = null;
    state.recognition.onerror = null;
    state.recognition.onresult = null;
    state.recognition.abort?.();
  } catch {}
  state.recognition = null;
  try { window.AndroidBridge?.cancelVoiceInput?.(); } catch {}
  stopSpeaking();
  $("#handsFreeBtn").textContent = "Hands-Free: Off";
  $("#handsFreeBtn").classList.remove("active");
  updateVoiceStatus("Voice stopped", "Tap the microphone whenever you are ready.");
}

window.FrontierGuideNative = {
  onSpeechResult(text, gen) { handleVoiceResult(text, gen); },
  onSpeechError(message) {
    state.listening = false;
    updateVoiceStatus("Microphone stopped", message || "Tap the microphone to retry.");
  },
  onSpeechFinished() {
    if (!speechGate.current(spokenToken)) return;
    updateVoiceStatus(voice.handsFree ? "Listening again…" : "Ready for your next question");
    if (voice.handsFree) voice.queueRestart(500, startListening);
  },
  onCameraGranted() {
    const owner = state.pendingCameraOwner;
    state.pendingCameraOwner = null;
    if (owner === "coach") {
      if (coach.state === "stopped") return;
      startCoach();
    } else openCamera();
  },
  onCameraDenied(message) {
    const owner = state.pendingCameraOwner;
    state.pendingCameraOwner = null;
    window.alert(message || "Camera permission was not available.");
    if (owner === "coach") haltCoach(message || "Camera permission was not available. Coach is stopped.");
  },
  onScreenShareReady(session) { acceptScreenShare(session); },
  onScreenShareDenied(message) { denyScreenShare(message); },
  onScreenShareStopped() { sharingStopped(); }
};

$("#talkBtn").onclick = startListening;
$("#stopVoice").onclick = stopVoiceMode;
$("#handsFreeBtn").onclick = () => {
  const next = !voice.handsFree;
  voice.setHandsFree(next);
  state.handsFree = next;
  $("#handsFreeBtn").textContent = `Hands-Free: ${next ? "On" : "Off"}`;
  $("#handsFreeBtn").classList.toggle("active", next);
  if (next && !voice.listening) startListening();
  if (!next) stopVoiceMode();
};
$("#autoSpeak").checked = settings.autoSpeak;
$("#autoSpeak").onchange = event => { settings.autoSpeak = event.target.checked; };

function actionButton(className, label, onclick) {
  const button = document.createElement("button");
  button.className = className;
  button.type = "button";
  button.textContent = label;
  button.onclick = onclick;
  return button;
}

function addField(card, label, value) {
  if (!value) return;
  const paragraph = document.createElement("p");
  const strong = document.createElement("strong");
  strong.textContent = `${label}. `;
  paragraph.append(strong, document.createTextNode(value));
  card.appendChild(paragraph);
}

function addSteps(card, steps) {
  if (!steps?.length) return;
  const list = document.createElement("ol");
  list.className = "steps";
  for (const step of steps) {
    const item = document.createElement("li");
    item.textContent = step;
    list.appendChild(item);
  }
  card.appendChild(list);
}

function storyEmpty(container, noun) {
  const online = state.mode === "online";
  const card = document.createElement("article");
  card.className = "card";
  const title = document.createElement("h3");
  title.textContent = online ? "Story Mode finds" : "No matches";
  const body = document.createElement("p");
  body.textContent = online
    ? `These ${noun} are Story Mode. Switch Play Mode to Story Mode or Both. Online legendary animals from Harriet and Gus are a separate activity and are not pinned here.`
    : "Try a shorter search or another filter.";
  card.append(title, body);
  container.appendChild(card);
}

function highlightEntry(id) {
  window.setTimeout(() => {
    const card = document.querySelector(`[data-entry="${CSS.escape(id)}"]`);
    if (!card) return;
    card.classList.add("highlight");
    const box = card.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) return;
    if (document.documentElement.classList.contains("map-open")) return;
    card.scrollIntoView({ block: "center" });
  }, 40);
}

function clearField(id) {
  const field = document.getElementById(id);
  if (field) field.value = "";
}

function openEntry(view, id) {
  if (view === "map") {
    showOnMap(id);
    return;
  }
  if (view === "legendary") clearField("legendarySearch");
  if (view === "secrets") clearField("secretSearch");
  if (view === "animals") {
    clearField("animalSearch");
    state.animalSize = "All";
    state.animalRegion = "All";
  }
  if (view === "guide") {
    clearField("guideSearch");
    state.category = "All";
  }
  if (view === "hidden") {
    state.hiddenCategory = "All";
    const place = state.hiddenPlaces.find(item => item.id === id);
    setView("hidden");
    renderHiddenTags();
    renderHiddenMap();
    renderHiddenList();
    if (place) showHiddenDetail(place);
    highlightEntry(id);
    return;
  }
  setView(view);
  if (view === "legendary") renderLegendaries();
  if (view === "secrets") renderSecrets();
  if (view === "animals") {
    renderAnimalFilters();
    renderAnimals();
  }
  if (view === "guide") {
    renderTags();
    renderGuide();
  }
  highlightEntry(id);
}

function showOnMap(id) {
  const item = state.mapLocations.find(entry => entry.id === id);
  if (!item || !modeMatches(item)) return;
  state.disabledMapCategories.delete(item.category);
  state.selectedMapId = id;
  setView("map");
  renderMapTags();
  showMapDetail(item);
}

function renderLegendaries() {
  const query = ($("#legendarySearch")?.value || "").toLowerCase();
  const items = state.legendaries.filter(item => {
    const text = `${item.name} ${item.region} ${item.landmark} ${item.reward}`.toLowerCase();
    return modeMatches(item) && (!query || text.includes(query));
  });
  const results = $("#legendaryResults");
  if (!results) return;
  results.replaceChildren();
  $("#legendaryCount").textContent = `${items.length} legendary animal${items.length === 1 ? "" : "s"}`;
  if (!items.length) {
    storyEmpty(results, "legendary hunts");
    return;
  }
  for (const item of items) {
    const card = document.createElement("article");
    card.className = "card";
    card.dataset.entry = item.id;
    const title = document.createElement("h3");
    title.textContent = item.name;
    card.appendChild(title);
    addField(card, "Where", `${item.region}. Nearest landmark: ${item.landmark}.`);
    addField(card, "When", item.conditions);
    addField(card, "Unlock", item.unlock);
    addField(card, "Weapon", `${item.weapon} ${item.ammo}`);
    addField(card, "Reward", item.reward);
    const actions = document.createElement("div");
    actions.className = "card-actions";
    actions.appendChild(actionButton("ghost compact", "Show on map", () => showOnMap(`leg-${item.id}`)));
    card.appendChild(actions);
    results.appendChild(card);
  }
}

function animalRecords() {
  const legendary = state.legendaries.map(item => ({
    id: `hunt-${item.id}`,
    name: item.name,
    size: "legendary",
    legendary: true,
    regions: [item.regionName],
    where: `${item.region}. ${item.landmark}.`,
    weapon: item.weapon,
    ammo: item.ammo,
    mode: item.mode,
    note: "Pelt quality is not graded. The trinket and the full hunt are on the Legendary Animals page.",
    linkId: item.id
  }));
  return [...state.animals, ...legendary];
}

function renderAnimalFilters() {
  const sizes = [["All", "All"], ["small", "Small"], ["medium", "Medium"], ["large", "Large"], ["bird", "Birds"], ["fish", "Fish"], ["legendary", "Legendary"]];
  const regions = ["All", "Ambarino", "New Hanover", "Lemoyne", "West Elizabeth", "New Austin", "Guarma"];
  const sizeRow = $("#animalSizeTags");
  const regionRow = $("#animalRegionTags");
  if (!sizeRow || !regionRow) return;
  sizeRow.replaceChildren();
  regionRow.replaceChildren();
  for (const [value, label] of sizes) {
    const button = document.createElement("button");
    button.className = `tag${state.animalSize === value ? " active" : ""}`;
    button.textContent = label;
    button.onclick = () => {
      state.animalSize = value;
      renderAnimalFilters();
      renderAnimals();
    };
    sizeRow.appendChild(button);
  }
  for (const region of regions) {
    const button = document.createElement("button");
    button.className = `tag${state.animalRegion === region ? " active" : ""}`;
    button.textContent = region;
    button.onclick = () => {
      state.animalRegion = region;
      renderAnimalFilters();
      renderAnimals();
    };
    regionRow.appendChild(button);
  }
}

function renderAnimals() {
  const query = ($("#animalSearch")?.value || "").toLowerCase();
  const items = animalRecords().filter(item => {
    if (!modeMatches(item)) return false;
    const isLegendary = item.size === "legendary" || item.legendary === true;
    if (state.animalSize === "legendary" && !isLegendary) return false;
    if (state.animalSize === "fish" && item.size !== "fish") return false;
    if (!["All", "legendary", "fish"].includes(state.animalSize) && item.size !== state.animalSize) return false;
    if (state.animalRegion !== "All") {
      const regions = item.regions || [];
      if (!regions.includes(state.animalRegion) && !regions.includes("Widespread")) return false;
    }
    const text = `${item.name} ${item.where} ${item.weapon} ${item.ammo} ${item.bait || ""} ${item.note || ""}`.toLowerCase();
    return !query || text.includes(query);
  });
  const results = $("#animalResults");
  if (!results) return;
  results.replaceChildren();
  $("#animalCount").textContent = `${items.length} entr${items.length === 1 ? "y" : "ies"}`;
  if (!items.length) {
    storyEmpty(results, "animals");
    return;
  }
  for (const item of items) {
    const card = document.createElement("article");
    card.className = "card";
    card.dataset.entry = item.id;
    const title = document.createElement("h3");
    title.textContent = item.name;
    card.appendChild(title);
    const sizeLabel = item.size === "legendary" ? "Legendary animal" : item.legendary ? "Legendary fish" : item.size;
    addField(card, "Class", `${sizeLabel}. ${(item.regions || []).join(", ")}.`);
    addField(card, "Where", item.where);
    addField(card, item.bait ? "Bait" : "Weapon", item.bait ? `${item.weapon}. ${item.bait}.` : `${item.weapon}. ${item.ammo}.`);
    if (item.note) addField(card, "Note", item.note);
    if (item.linkId) {
      const actions = document.createElement("div");
      actions.className = "card-actions";
      actions.appendChild(actionButton("ghost compact", "Open legendary page", () => openEntry("legendary", item.linkId)));
      card.appendChild(actions);
    }
    results.appendChild(card);
  }
}

function renderSecrets() {
  const query = ($("#secretSearch")?.value || "").toLowerCase();
  const items = state.secrets.filter(item => {
    const text = `${item.name} ${item.region} ${item.where} ${item.reward} ${(item.steps || []).join(" ")}`.toLowerCase();
    return modeMatches(item) && (!query || text.includes(query));
  });
  const results = $("#secretResults");
  if (!results) return;
  results.replaceChildren();
  $("#secretCount").textContent = `${items.length} secret${items.length === 1 ? "" : "s"}`;
  if (!items.length) {
    storyEmpty(results, "secrets");
    return;
  }
  for (const item of items) {
    const card = document.createElement("article");
    card.className = "card";
    card.dataset.entry = item.id;
    const title = document.createElement("h3");
    title.textContent = item.name;
    card.appendChild(title);
    if (item.confirmed === false) {
      const warning = document.createElement("p");
      warning.className = "unconfirmed";
      warning.textContent = "Not confirmed. This is a warning, not a place to ride to.";
      card.appendChild(warning);
    }
    addField(card, "Where", item.where);
    addSteps(card, item.steps);
    addField(card, "Requirements", item.requirements);
    addField(card, "Reward", item.reward);
    if (item.uncertain) addField(card, "Check this", item.uncertain);
    if (item.pinAccuracy === "regional") addField(card, "Map pin", "Regional only. It puts you in the right part of the schematic, not on a surveyed door.");
    const actions = document.createElement("div");
    actions.className = "card-actions";
    const marker = (item.markers || []).find(pin => Number.isFinite(pin.x));
    if (marker) actions.appendChild(actionButton("ghost compact", "Show on map", () => showOnMap(marker.id)));
    if (item.hiddenId) actions.appendChild(actionButton("ghost compact", "Open hidden place", () => openEntry("hidden", item.hiddenId)));
    if (actions.childElementCount) card.appendChild(actions);
    results.appendChild(card);
  }
}

function hiddenItems() {
  return state.hiddenPlaces.filter(item => modeMatches(item) && (state.hiddenCategory === "All" || item.category === state.hiddenCategory));
}

function renderHiddenTags() {
  const row = $("#hiddenTags");
  if (!row) return;
  const categories = ["All", "Cave", "Waterfall", "Mine", "Underground", "Mountain"];
  if (!categories.includes(state.hiddenCategory)) state.hiddenCategory = "All";
  const pool = state.hiddenPlaces.filter(modeMatches);
  row.replaceChildren(sheetHandle(row));
  for (const category of categories) {
    const button = document.createElement("button");
    button.type = "button";
    const on = state.hiddenCategory === category;
    button.className = `layer-row${on ? " is-on" : ""}`;
    button.setAttribute("aria-pressed", on ? "true" : "false");
    const check = document.createElement("span");
    check.className = `filter-check${on ? " is-on" : ""}`;
    check.textContent = on ? "✓" : "";
    const label = document.createElement("span");
    label.className = "layer-name";
    label.textContent = category;
    const tally = document.createElement("span");
    tally.className = "layer-count";
    tally.textContent = String(category === "All" ? pool.length : pool.filter(item => item.category === category).length);
    button.append(check, label, tally);
    button.onclick = () => {
      state.hiddenCategory = category;
      state.selectedHiddenId = null;
      renderHiddenTags();
      renderHiddenMap();
      renderHiddenList();
      const detail = $("#hiddenDetail");
      detail.classList.remove("is-open");
      detail.style.transform = "";
      detail.replaceChildren();
      const title = document.createElement("h3");
      title.textContent = "Select a hidden place";
      const body = document.createElement("p");
      body.textContent = "Tap a marker or a name in the list.";
      detail.append(title, body);
    };
    row.appendChild(button);
  }
  const legend = document.createElement("div");
  legend.className = "map-legend";
  const places = hiddenItems();
  assignMapNumbers(places);
  for (const item of [...places].sort((a, b) => a.mapNumber - b.mapNumber)) {
    const entry = document.createElement("button");
    entry.type = "button";
    entry.className = "legend-item";
    entry.textContent = `${item.mapNumber}  ${item.name}`;
    entry.onclick = () => {
      if (Number.isFinite(item.lat) && Number.isFinite(item.lng)) $("#hiddenMap")?.frontierZoomTo?.(3.6, item.x, item.y);
      showHiddenDetail(item);
    };
    legend.appendChild(entry);
  }
  row.appendChild(legend);
}

function sourceLabel(url) {
  const value = String(url || "");
  if (/jeanropke\/(?:RDOMap|RDR2CollectorsMap)/i.test(value)) return "Jean Ropke RDOMap";
  if (/the0neWhoKnocks/i.test(value)) return "Community map";
  if (/pastebin\.com/i.test(value)) return "Coordinate list";
  if (/gtaboss\.gg/i.test(value)) return "GTA Boss";
  try {
    const host = new URL(value).hostname.replace(/^www\./, "");
    if (host === "github.com") return "GitHub";
    return host;
  } catch {
    return "Published map";
  }
}

function playerText(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const kept = raw.split(/(?<=[.!?])\s+/).filter(sentence => {
    if (/^source\s+(id|name)\b/i.test(sentence)) return false;
    if (/map frame/i.test(sentence)) return false;
    if (/\b[a-z]+_[a-z0-9_]{2,}\b/i.test(sentence)) return false;
    if (/sourceLat|sourceLng|least-squares|0\.01552|game-to-map|lat\/lng|plotted (position|point|lat)|converted (from|into|with)|RDOMap frame/i.test(sentence)) return false;
    return true;
  });
  return kept.join(" ").trim();
}

function userNote(note) {
  return playerText(note);
}

function placeRegion(item) {
  const region = String(item.region || "").trim();
  const landmark = String(item.landmark || "").trim();
  let line = region;
  if (landmark && !region.toLowerCase().includes(landmark.toLowerCase())) line = line ? `${line} · ${landmark}` : landmark;
  const mode = item.mode === "story" ? "Story" : item.mode === "online" ? "Online" : item.mode === "either" ? "Story and Online" : "";
  if (mode) line = line ? `${line} · ${mode}` : mode;
  return line;
}

function howToGet(item) {
  const parts = [];
  const obtain = String(item.obtain || "").trim();
  const steps = playerText(item.directions || item.enter || "");
  if (obtain && (!steps || !steps.toLowerCase().includes(obtain.toLowerCase()))) parts.push(obtain.endsWith(".") ? obtain : `${obtain}.`);
  if (steps) parts.push(steps);
  if (item.chapter) parts.push(/[.!?]$/.test(String(item.chapter)) ? String(item.chapter) : `${item.chapter}.`);
  if (item.price) parts.push(/[.!?]$/.test(String(item.price)) ? String(item.price) : `${item.price}.`);
  return parts.join(" ");
}

function cardNotes(item) {
  const parts = [];
  if (item.breed || item.coat) {
    const bits = [];
    if (item.breed) bits.push(String(item.breed));
    if (item.coat) bits.push(`${item.coat} coat`);
    parts.push(`${bits.join(", ")}.`);
  }
  const note = userNote(item.note);
  if (note) parts.push(note);
  if (item.contents) parts.push(String(item.contents));
  if (item.approximate || item.accuracyNote) parts.push(item.accuracyNote || "Approximate. No exact published coordinate.");
  else if (!Number.isFinite(item.lat) && item.enter) parts.push("Not pinned. No published coordinate.");
  return parts.join(" ");
}

function sheetLine(label, text) {
  const p = document.createElement("p");
  p.className = "map-detail-line";
  const name = document.createElement("b");
  name.textContent = label;
  const body = document.createElement("span");
  body.textContent = text;
  p.append(name, body);
  return p;
}

function sourceDetails(url) {
  const href = String(url || "");
  if (!/^https?:\/\//i.test(href)) return null;
  const details = document.createElement("details");
  details.className = "map-source";
  const summary = document.createElement("summary");
  summary.textContent = "Source";
  const link = document.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = sourceLabel(href);
  details.append(summary, link);
  return details;
}

function closeFieldCard() {
  state.selectedMapId = null;
  const detail = $("#mapDetail");
  if (detail) {
    detail.classList.remove("is-open");
    detail.style.transform = "";
  }
  renderMap();
}

function closeHiddenCard() {
  state.selectedHiddenId = null;
  const detail = $("#hiddenDetail");
  if (detail) {
    detail.classList.remove("is-open");
    detail.style.transform = "";
  }
  renderHiddenMap();
}

function bindSheetSwipe(detail) {
  if (detail.dataset.swipeBound) return;
  detail.dataset.swipeBound = "1";
  let startY = 0;
  let startX = 0;
  let tracking = false;
  let dragged = false;
  detail.addEventListener("pointerdown", event => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (event.target.closest("button, a, input, textarea, summary, label")) return;
    if (detail.scrollTop > 2 && !event.target.closest(".map-sheet-handle")) return;
    tracking = true;
    dragged = false;
    startY = event.clientY;
    startX = event.clientX;
  });
  detail.addEventListener("pointermove", event => {
    if (!tracking) return;
    const dy = event.clientY - startY;
    const dx = event.clientX - startX;
    if (dy > 6 && dy > Math.abs(dx)) {
      dragged = true;
      detail.style.transform = `translateY(${dy}px)`;
    }
  });
  const end = event => {
    if (!tracking) return;
    tracking = false;
    const dy = event.clientY - startY;
    detail.style.transform = "";
    if (dragged && dy > 56) detail._closeSheet?.();
    dragged = false;
  };
  detail.addEventListener("pointerup", end);
  detail.addEventListener("pointercancel", end);
}

function fillPlaceCard(detail, item, actions) {
  detail.replaceChildren();
  const style = styleFor(item.category);
  const handle = document.createElement("div");
  handle.className = "map-sheet-handle";
  handle.setAttribute("aria-hidden", "true");
  const kicker = document.createElement("div");
  kicker.className = "map-detail-kicker";
  const swatch = document.createElement("span");
  swatch.className = "filter-swatch";
  swatch.style.background = style.color;
  swatch.style.color = style.ink;
  swatch.append(markerGlyph(style.glyph));
  const category = document.createElement("span");
  category.textContent = style.label;
  kicker.append(swatch, category);
  const title = document.createElement("h3");
  title.textContent = item.title || item.name || "Place";
  detail.append(handle, kicker, title);
  const region = placeRegion(item);
  if (region) detail.append(sheetLine("Region", region));
  const how = howToGet(item);
  if (how) detail.append(sheetLine("How to get it", how));
  const notes = cardNotes(item);
  if (notes) detail.append(sheetLine("Notes", notes));
  const source = sourceDetails(item.sourceUrl);
  if (source) detail.append(source);
  if (actions) detail.append(actions);
  detail.classList.add("is-open");
  const sheet = detail.closest(".map-panel")?.querySelector(".map-sheet");
  if (sheet) {
    sheet.hidden = true;
    sheet.closest(".map-frame")?.querySelector(".map-layers-toggle")?.setAttribute("aria-expanded", "false");
  }
  bindSheetSwipe(detail);
}

function showHiddenDetail(item) {
  state.selectedHiddenId = item.id;
  renderHiddenMap();
  const detail = $("#hiddenDetail");
  detail._closeSheet = closeHiddenCard;
  const actions = document.createElement("div");
  actions.className = "map-actions";
  actions.appendChild(foundButton(item.id));
  actions.appendChild(actionButton("ghost compact map-detail-close", "Close card", closeHiddenCard));
  fillPlaceCard(detail, item, actions);
  highlightEntry(item.id);
}

function renderHiddenMap() {
  const items = hiddenItems();
  assignMapNumbers(items);
  paintLeaflet($("#hiddenMap"), items.filter(item => Number.isFinite(item.lat) && Number.isFinite(item.lng)), state.selectedHiddenId, showHiddenDetail);
}

function renderHiddenList() {
  const list = $("#hiddenList");
  if (!list) return;
  list.replaceChildren();
  const items = hiddenItems();
  if (!items.length) {
    storyEmpty(list, "hidden places");
    return;
  }
  for (const item of items) {
    const card = document.createElement("article");
    card.className = `card${state.selectedHiddenId === item.id ? " highlight" : ""}`;
    card.dataset.entry = item.id;
    const title = document.createElement("h3");
    title.textContent = item.name;
    card.appendChild(title);
    addField(card, "Category", item.category);
    addField(card, "Region", `${item.region}. ${item.landmark}.`);
    addField(card, "How to enter", item.enter);
    addField(card, "What's there", item.contents);
    card.appendChild(actionButton("ghost compact", "Show on this map", () => showHiddenDetail(item)));
    list.appendChild(card);
  }
}

async function loadFieldContent() {
  const [legendaries, animals, secrets, hiddenPlaces] = await Promise.all([
    loadJson("content/legendaries.json"),
    loadJson("content/animals.json"),
    loadJson("content/secrets.json"),
    loadJson("content/hidden-places.json")
  ]);
  state.legendaries = legendaries;
  state.animals = animals;
  state.secrets = secrets;
  state.hiddenPlaces = hiddenPlaces;
  rebuildMap();
  renderLegendaries();
  renderAnimalFilters();
  renderAnimals();
  renderSecrets();
  renderHiddenTags();
  renderHiddenMap();
  renderHiddenList();
}

async function loadGuide() {
  state.guide = await loadJson("content/guide.json");
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
$("#legendarySearch")?.addEventListener("input", renderLegendaries);
$("#animalSearch")?.addEventListener("input", renderAnimals);
$("#secretSearch")?.addEventListener("input", renderSecrets);

function attachImage(dataUrl) {
  if (!String(dataUrl || "").startsWith("data:image")) return;
  state.attachmentId += 1;
  state.image = dataUrl;
  $("#imagePreview").src = dataUrl;
  $("#imagePreviewWrap").classList.remove("hidden");
  $("#analyzeImageBtn").classList.remove("hidden");
}

async function imageFileToDataUrl(file) {
  if (!file?.type?.startsWith("image/")) throw new Error("Choose a JPG, PNG, WEBP, or GIF image.");
  if (file.size > 20000000) throw new Error("That image is too large. Choose one under 20 MB.");
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
  const maxSide = 1600;
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

function stopStream(owner) {
  if (state.streamOwner !== owner) return;
  state.cameraStream?.getTracks?.().forEach(track => track.stop());
  state.cameraStream = null;
  state.streamOwner = null;
  for (const id of ["cameraVideo", "coachVideo"]) {
    const video = document.getElementById(id);
    if (video && video.srcObject) video.srcObject = null;
  }
}

async function openOwnedCamera(owner, video) {
  if (window.AndroidBridge?.hasCameraPermission && !window.AndroidBridge.hasCameraPermission()) {
    state.pendingCameraOwner = owner;
    window.AndroidBridge.requestCameraPermission();
    return false;
  }
  stopStream(state.streamOwner);
  state.cameraStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: state.cameraFacing },
    audio: false
  });
  state.streamOwner = owner;
  if (video) video.srcObject = state.cameraStream;
  return true;
}

async function openCamera() {
  try {
    const opened = await openOwnedCamera("dialog", $("#cameraVideo"));
    if (opened && !$("#cameraDialog").open) $("#cameraDialog").showModal();
  } catch {
    alert("Camera permission was not available. Check the Frontier Guide camera permission in Android Settings.");
  }
}

function closePreviewDialog() {
  const camera = $("#cameraDialog");
  if (camera?.open) camera.close();
  const screen = $("#screenDialog");
  if (screen?.open) screen.close();
  if (screenPhase === "sharing") return;
  clearInterval(state.screenTimer);
  state.screenTimer = null;
}

$("#cameraBtn").onclick = openCamera;
$("#closeCamera").onclick = () => {
  stopStream("dialog");
  if ($("#cameraDialog")?.open) $("#cameraDialog").close();
};
$("#cameraDialog")?.addEventListener("close", () => stopStream("dialog"));
$("#flipCamera").onclick = async () => {
  state.cameraFacing = state.cameraFacing === "environment" ? "user" : "environment";
  if (state.streamOwner === "coach") await openOwnedCamera("coach", $("#coachVideo"));
  else await openCamera();
};
function drawVideoFrame(video, quality = 0.82) {
  const canvas = $("#cameraCanvas");
  const width = video?.videoWidth || 1280;
  const height = video?.videoHeight || 720;
  const scale = Math.min(1, 960 / Math.max(width, height));
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}
function captureCameraFrame() {
  return drawVideoFrame($("#cameraVideo"), 0.82);
}
$("#captureCamera").onclick = () => {
  const frame = captureCameraFrame();
  haltCoach("Coach stopped because you took a still frame.");
  attachImage(frame);
  stopStream("dialog");
  if ($("#cameraDialog")?.open) $("#cameraDialog").close();
  setView("ask");
  $("#question").focus();
};
$("#removeImage").onclick = () => clearAttachedImage();
$("#liveCoachCamera").onclick = () => {
  const source = $("#coachSource");
  if (source) source.value = "camera";
  stopStream("dialog");
  if ($("#cameraDialog")?.open) $("#cameraDialog").close();
  setView("coach");
  startCoach();
};

function nativeAvailable() {
  return Boolean(window.AndroidBridge?.startScreenShare);
}

function setFrameActions(enabled) {
  for (const id of ["useScreenFrame", "analyzeScreenFrame"]) {
    const button = document.getElementById(id);
    if (!button) continue;
    button.disabled = !enabled;
    button.classList.toggle("hidden", !enabled);
  }
}

function resetScreenUi(message) {
  screenPhase = "idle";
  screenSession = "";
  clearInterval(state.screenTimer);
  state.screenTimer = null;
  const preview = $("#screenPreview");
  if (preview) {
    preview.removeAttribute("src");
    preview.classList.add("hidden");
  }
  setFrameActions(false);
  const start = $("#startNativeScreen");
  if (start) start.disabled = false;
  $("#stopNativeScreen")?.classList.add("hidden");
  if (message && $("#screenStatus")) $("#screenStatus").textContent = message;
}

function startScreenPoll() {
  clearInterval(state.screenTimer);
  state.screenTimer = setInterval(refreshNativeFrame, 1800);
  refreshNativeFrame();
}

function updateScreenDialog() {
  const status = $("#screenStatus");
  if (!nativeAvailable()) {
    $("#screenHelp").innerHTML = "<p><b>This browser cannot capture the Android screen directly.</b> Install the Android app for screen sharing. The phone camera works here.</p>";
    $("#startNativeScreen")?.classList.add("hidden");
    $("#stopNativeScreen")?.classList.add("hidden");
    return;
  }
  $("#startNativeScreen")?.classList.remove("hidden");
  if (screenPhase === "sharing") {
    $("#screenHelp").innerHTML = "<p><b>Sharing is on.</b> Closing this window only hides the preview. Use Stop sharing to end the capture.</p>";
    if (status) status.textContent = "Sharing is on.";
    $("#startNativeScreen").disabled = true;
    $("#stopNativeScreen")?.classList.remove("hidden");
  } else if (screenPhase === "pending") {
    $("#screenHelp").innerHTML = "<p>Waiting for Android to allow screen share.</p>";
    $("#startNativeScreen").disabled = true;
    $("#stopNativeScreen")?.classList.remove("hidden");
  } else {
    $("#screenHelp").innerHTML = "<p><b>Android screen capture is available.</b> Tap Start and approve the system prompt. Frame buttons stay off until a new frame arrives.</p>";
    if (status && !status.textContent) status.textContent = "Not sharing.";
    $("#startNativeScreen").disabled = false;
    $("#stopNativeScreen")?.classList.add("hidden");
    setFrameActions(false);
  }
}

function beginScreenShare() {
  if (screenPhase === "pending" || screenPhase === "sharing") return;
  if (!nativeAvailable()) {
    alert("Android screen capture is only available in the Frontier Guide app.");
    return;
  }
  screenToken += 1;
  pendingScreenToken = screenToken;
  screenPhase = "pending";
  $("#startNativeScreen").disabled = true;
  $("#stopNativeScreen")?.classList.remove("hidden");
  setFrameActions(false);
  if ($("#screenStatus")) $("#screenStatus").textContent = "Waiting for Android to allow screen share.";
  try {
    window.AndroidBridge.startScreenShare();
  } catch {
    resetScreenUi("Android screen capture could not start.");
  }
}

function stopSharing() {
  screenToken += 1;
  pendingScreenToken = 0;
  const owned = coach.ownsScreen;
  try { window.AndroidBridge?.stopScreenShare?.(); } catch {}
  resetScreenUi("Screen sharing is stopped.");
  if (owned) haltCoach("Screen sharing stopped, so Coach stopped too.");
}

function acceptScreenShare(session) {
  if (pendingScreenToken !== screenToken && !(screenToken === 0 && pendingScreenToken === 0 && screenPhase === "idle")) return;
  if (screenPhase === "sharing" && screenSession === String(session || "")) {
    startScreenPoll();
    return;
  }
  if (screenPhase !== "pending" && screenPhase !== "idle") return;
  screenPhase = "sharing";
  screenSession = String(session || "");
  $("#startNativeScreen").disabled = true;
  $("#stopNativeScreen")?.classList.remove("hidden");
  if ($("#screenStatus")) $("#screenStatus").textContent = "Sharing is starting. Frame buttons appear after the first new frame. Closing this window does not stop sharing.";
  startScreenPoll();
  if (coach.source === "screen" && (coach.state === "waiting" || coach.state === "reconnecting")) {
    setCoachState("watching", "Screen share is on. Waiting for a readable frame.");
  }
}

function denyScreenShare(message) {
  resetScreenUi(message || "Screen share was cancelled.");
  if (coach.source === "screen" && coach.state !== "stopped") haltCoach(message || "Screen share was cancelled.");
}

function sharingStopped() {
  if (screenPhase === "idle") return;
  const owned = coach.ownsScreen;
  resetScreenUi("Screen sharing is stopped.");
  if (owned && coach.state !== "stopped") haltCoach("Screen sharing stopped.");
}

function refreshNativeFrame() {
  if (screenPhase !== "sharing") return;
  let meta = {};
  try {
    meta = JSON.parse(window.AndroidBridge?.getLatestScreenMeta?.() || "{}");
  } catch {
    meta = {};
  }
  if (meta.state === "stopped") {
    sharingStopped();
    return;
  }
  if (screenSession && String(meta.session || "") !== String(screenSession)) return;
  if (meta.frame == null && window.AndroidBridge?.getLatestScreenMeta) return;
  let dataUrl = "";
  try { dataUrl = window.AndroidBridge.getLatestScreenDataUrl() || ""; } catch { dataUrl = ""; }
  if (!String(dataUrl).startsWith("data:image")) return;
  const preview = $("#screenPreview");
  if (preview) {
    preview.src = dataUrl;
    preview.classList.remove("hidden");
  }
  setFrameActions(true);
  if ($("#screenStatus")) $("#screenStatus").textContent = `Sharing is on. Frame ${meta.frame || "latest"} is ready. Closing this window does not stop sharing.`;
  const coachPreview = $("#coachPreview");
  if (coach.source === "screen" && coach.state !== "stopped" && coach.state !== "paused" && coachPreview) {
    coachPreview.src = dataUrl;
    coachPreview.classList.remove("hidden");
  }
}

$("#screenBtn").onclick = () => {
  updateScreenDialog();
  $("#screenDialog").showModal();
  if (screenPhase === "sharing") startScreenPoll();
};
$("#closeScreen").onclick = () => {
  $("#screenDialog").close();
  clearInterval(state.screenTimer);
  state.screenTimer = null;
  if (screenPhase === "sharing" && $("#screenStatus")) {
    $("#screenStatus").textContent = "Preview closed. Sharing is still on until you tap Stop sharing.";
  } else if (screenPhase === "pending" && $("#screenStatus")) {
    $("#screenStatus").textContent = "Preview closed. Waiting on Android permission. Tap Stop sharing to cancel.";
  }
};
$("#startNativeScreen").onclick = beginScreenShare;
$("#stopNativeScreen").onclick = stopSharing;
$("#useScreenFrame").onclick = () => {
  refreshNativeFrame();
  const src = $("#screenPreview")?.src || "";
  if (!src.startsWith("data:image")) {
    if ($("#screenStatus")) $("#screenStatus").textContent = "No current frame yet. Switch to the game, then come back.";
    return;
  }
  attachImage(src);
  $("#screenDialog").close();
  clearInterval(state.screenTimer);
  state.screenTimer = null;
  setView("ask");
};
$("#analyzeScreenFrame").onclick = () => {
  refreshNativeFrame();
  const src = $("#screenPreview")?.src || "";
  if (!src.startsWith("data:image")) {
    if ($("#screenStatus")) $("#screenStatus").textContent = "No current frame yet. Switch to the game, then come back.";
    return;
  }
  attachImage(src);
  $("#screenDialog").close();
  clearInterval(state.screenTimer);
  state.screenTimer = null;
  setView("voice");
  askQuestion("Analyze my latest game screen and talk me through the next action. Read any visible objective or map marker and keep the answer short enough to follow while playing.", { fromVoice: true });
};

const contentErrors = [];

function installedPack() {
  try {
    const raw = localStorage.getItem("fg_content");
    if (!raw) return null;
    const pack = JSON.parse(raw);
    if (!pack || typeof pack.version !== "string") return null;
    for (const key of ["guide", "legendaries", "animals", "secrets", "hiddenPlaces", "map"]) {
      if (pack[key] != null && !Array.isArray(pack[key])) return null;
    }
    return pack;
  } catch {
    return null;
  }
}

function contentKey(path) {
  const name = path.split("/").pop().replace(/\.json$/, "");
  return name === "hidden-places" ? "hiddenPlaces" : name;
}

async function loadJson(path) {
  const pack = installedPack();
  const key = contentKey(path);
  if (pack && Array.isArray(pack[key])) return pack[key];
  try {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`${path} returned ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error(`${path} was not a list`);
    return data;
  } catch (error) {
    contentErrors.push(error.message || String(path));
    return [];
  }
}

async function loadMap() {
  state.baseMap = await loadJson("content/map.json");
  try {
    const response = await fetch("content/gazetteer.json");
    state.gazetteer = response.ok ? await response.json() : [];
    if (!Array.isArray(state.gazetteer)) state.gazetteer = [];
  } catch {
    state.gazetteer = [];
  }
  rebuildMap();
}

function rebuildMap() {
  const secretMarkers = state.secrets.flatMap(item => (item.markers || [])
    .filter(marker => Number.isFinite(marker.lat) && Number.isFinite(marker.lng))
    .filter(marker => !state.baseMap.some(pin => pin.id === marker.id))
    .map(marker => ({
      id: marker.id,
      category: "Secrets",
      mode: item.mode,
      title: marker.title,
      region: marker.region,
      lat: marker.lat,
      lng: marker.lng,
      x: marker.x,
      y: marker.y,
      sourceUrl: marker.sourceUrl,
      sourceLat: marker.sourceLat,
      sourceLng: marker.sourceLng,
      approximate: marker.approximate,
      accuracyNote: marker.accuracyNote,
      directions: marker.directions,
      note: marker.note,
      linkView: "secrets",
      linkId: item.id,
      linkLabel: "Open secret"
    })));
  state.mapLocations = [...state.baseMap, ...secretMarkers];
  renderMapTags();
  renderMap();
}

function mapCategoryOn(category) {
  return !state.disabledMapCategories.has(category);
}

function closeLayerSheet(sheet) {
  if (!sheet) return;
  sheet.hidden = true;
  sheet.closest(".map-frame")?.querySelector(".map-layers-toggle")?.setAttribute("aria-expanded", "false");
}

function sheetHandle(sheet) {
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "map-sheet-handle";
  handle.setAttribute("aria-label", "Close layers");
  handle.onclick = () => closeLayerSheet(sheet);
  return handle;
}

function renderMapTags() {
  const sheet = $("#mapTags");
  if (!sheet) return;
  const visible = state.mapLocations.filter(modeMatches);
  const present = [...new Set(visible.map(item => item.category))];
  const categories = MARKER_ORDER.filter(category => present.includes(category));
  for (const category of present) if (!categories.includes(category)) categories.push(category);
  const allOn = categories.length > 0 && categories.every(mapCategoryOn);
  sheet.replaceChildren(sheetHandle(sheet));
  const all = document.createElement("button");
  all.type = "button";
  all.className = `layer-row layer-all${allOn ? " is-on" : ""}`;
  all.setAttribute("aria-pressed", allOn ? "true" : "false");
  const mark = document.createElement("span");
  mark.className = `filter-check${allOn ? " is-on" : ""}`;
  mark.textContent = allOn ? "✓" : "";
  const name = document.createElement("span");
  name.className = "layer-name";
  name.textContent = allOn ? "None" : "All";
  const total = document.createElement("span");
  total.className = "layer-count";
  total.textContent = String(visible.length);
  all.append(mark, name, total);
  all.onclick = () => {
    if (allOn) categories.forEach(category => state.disabledMapCategories.add(category));
    else state.disabledMapCategories.clear();
    state.selectedMapId = null;
    $("#mapDetail")?.classList.remove("is-open");
    renderMapTags();
    renderMap();
  };
  sheet.appendChild(all);
  const legend = document.createElement("div");
  legend.className = "map-legend";
  for (const category of categories) {
    const style = styleFor(category);
    const count = visible.filter(item => item.category === category).length;
    const on = mapCategoryOn(category);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `layer-row${on ? " is-on" : ""}`;
    button.setAttribute("aria-pressed", on ? "true" : "false");
    const check = document.createElement("span");
    check.className = `filter-check${on ? " is-on" : ""}`;
    check.textContent = on ? "✓" : "";
    const swatch = document.createElement("span");
    swatch.className = "filter-swatch";
    swatch.style.background = style.color;
    swatch.style.color = style.ink;
    swatch.append(markerGlyph(style.glyph));
    const label = document.createElement("span");
    label.className = "layer-name";
    label.textContent = style.label;
    const tally = document.createElement("span");
    tally.className = "layer-count";
    tally.textContent = String(count);
    button.append(check, swatch, label, tally);
    button.onclick = () => {
      if (on) state.disabledMapCategories.add(category);
      else state.disabledMapCategories.delete(category);
      state.selectedMapId = null;
      $("#mapDetail")?.classList.remove("is-open");
      renderMapTags();
      renderMap();
    };
    legend.appendChild(button);
  }
  sheet.appendChild(legend);
}

function showMapDetail(item) {
  state.selectedMapId = item.id;
  renderMap();
  const detail = $("#mapDetail");
  detail._closeSheet = closeFieldCard;
  const actions = document.createElement("div");
  actions.className = "map-actions";
  const ask = document.createElement("button");
  ask.className = "send compact";
  ask.type = "button";
  ask.textContent = "Speak full directions";
  ask.onclick = () => {
    setView("voice");
    askQuestion(`Give me spoken step-by-step directions and all requirements for ${item.title} in ${item.region}. My selected mode is ${state.mode}. Correct me if this location does not apply to my mode.`, { fromVoice: true });
  };
  actions.appendChild(ask);
  if (item.linkView && item.linkId) {
    actions.appendChild(actionButton("ghost compact", item.linkLabel || "Open guide entry", () => openEntry(item.linkView, item.linkId)));
  }
  actions.appendChild(foundButton(item.id));
  actions.appendChild(actionButton("ghost compact map-detail-close", "Close card", closeFieldCard));
  fillPlaceCard(detail, item, actions);
}

function assignMapNumbers(items) {
  const ordered = [...items].sort((a, b) => (Number(a.y) - Number(b.y)) || (Number(a.x) - Number(b.x)) || String(a.title || a.name || "").localeCompare(String(b.title || b.name || "")));
  ordered.forEach((item, index) => { item.mapNumber = index + 1; });
  return ordered;
}

function renderMap() {
  const items = state.mapLocations.filter(item => {
    const categoryMatch = mapCategoryOn(item.category);
    return categoryMatch && modeMatches(item);
  });
  assignMapNumbers(items);
  paintLeaflet($("#fieldMap"), items.filter(item => Number.isFinite(item.lat) && Number.isFinite(item.lng)), state.selectedMapId, showMapDetail);
}

function setConnectionState(kind, label) {
  const status = $("#onlineDot");
  status.classList.remove("online", "warning");
  if (kind) status.classList.add(kind);
  status.innerHTML = `<span></span> ${label}`;
}

async function checkStatus(showMessage = false) {
  if (!settings.api) {
    const offlineOnly = settings.serverMode === "offline";
    setConnectionState("", offlineOnly ? "Offline only" : "Offline ready");
    const status = $("#onlineDot");
    if (status) status.title = offlineOnly ? "Offline only. Tap to check again." : "No server selected. Tap to check again.";
    if (showMessage) {
      $("#settingsMsg").textContent = offlineOnly
        ? "Offline only. Bundled pages stay available and no AI request will be sent."
        : "Settings saved. Add an HTTPS backend URL to enable live AI.";
    }
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
    const status = $("#onlineDot");
    if (status) status.title = `Connected to Frontier Guide ${data.version || ""}. Tap to check again.`;
    if (showMessage) {
      $("#settingsMsg").textContent = `Connected to Frontier Guide ${data.version || ""} using ${data.model || "the configured model"}.`;
    }
    return true;
  } catch (error) {
    setConnectionState("", settings.serverMode === "offline" ? "Offline only" : "Offline ready");
    const status = $("#onlineDot");
    if (status) status.title = error.message || "Offline. Tap to try again.";
    if (showMessage) $("#settingsMsg").textContent = `Connection failed: ${error.message}`;
    return false;
  }
}

function syncServerModeButtons() {
  $$("#serverMode .mode").forEach(button => button.classList.toggle("active", button.dataset.server === settings.serverMode));
  if ($("#apiBase")) $("#apiBase").disabled = settings.serverMode !== "custom";
  if ($("#apiBase") && settings.serverMode === "auto") $("#apiBase").value = hostedApiBase || defaultApiBase;
}

$("#apiBase").value = settings.serverMode === "custom" ? (localStorage.getItem("fg_api") || "") : (hostedApiBase || defaultApiBase);
$("#apiToken").value = settings.token;
$("#manifestUrl").value = settings.manifest;
syncServerModeButtons();
$$("#serverMode .mode").forEach(button => {
  button.addEventListener("click", () => {
    settings.serverMode = button.dataset.server;
    syncServerModeButtons();
  });
});
$("#saveSettings").onclick = async () => {
  try {
    settings.token = $("#apiToken").value.trim();
    settings.manifest = $("#manifestUrl").value.trim();
    if (settings.serverMode === "custom") {
      settings.api = normalizeApiBase($("#apiBase").value);
      $("#apiBase").value = settings.api;
    }
    if (settings.serverMode === "offline") {
      await checkStatus(true);
      return;
    }
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
    if (!showSavedUpdate()) setUpdateCard("AI server not configured", "Offline only, or no server is selected. The bundled guide still works. A saved field report stays here when one exists.");
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
    try {
      localStorage.setItem("fg_last_update", JSON.stringify({
        answer: data.answer || "",
        sources: data.sources || [],
        checkedAt: new Date().toISOString()
      }));
    } catch {}
  } catch (error) {
    if (error.status === 429) setConnectionState("warning", "AI busy");
    const detail = error.status === 401
      ? "The server access key is missing or incorrect. Check Settings."
      : error.message;
    setUpdateCard("Update scan failed", detail);
  }
}

$("#refreshUpdates").onclick = liveUpdate;

let checkedManifest = null;

function validateContentList(value, label) {
  if (!Array.isArray(value) || !value.length) throw new Error(`${label} was empty or not a list.`);
  if (value.some(item => !item || typeof item !== "object")) throw new Error(`${label} has an invalid row.`);
  return value;
}

function freshFetch(url) {
  return fetch(url, /^https?:/i.test(url) ? { cache: "no-store" } : {});
}

async function contentUpdate() {
  const typed = $("#manifestUrl")?.value.trim() || "";
  if (typed) settings.manifest = typed;
  if (!settings.manifest) {
    $("#settingsMsg").textContent = "No remote guide manifest URL is set.";
    return;
  }
  try {
    const response = await freshFetch(settings.manifest);
    if (!response.ok) throw new Error(`Manifest returned ${response.status}.`);
    const manifest = await response.json();
    if (!manifest || typeof manifest.version !== "string") throw new Error("The manifest has no version.");
    checkedManifest = manifest;
    const installed = installedPack()?.version || "bundled";
    $("#settingsMsg").textContent = `Remote guide ${manifest.version}. Installed: ${installed}. ${manifest.notes || ""} Tap Apply to install it.`;
  } catch (error) {
    checkedManifest = null;
    $("#settingsMsg").textContent = `Could not load the remote manifest: ${error.message}`;
  }
}

async function applyContentUpdate() {
  if (!checkedManifest) {
    $("#settingsMsg").textContent = "Check the guide update before applying it.";
    return;
  }
  try {
    const pack = { version: checkedManifest.version, notes: checkedManifest.notes || "", appliedAt: new Date().toISOString() };
    if (checkedManifest.content && typeof checkedManifest.content === "object") {
      for (const [key, label] of [["guide", "Guide"], ["legendaries", "Legendaries"], ["animals", "Animals"], ["secrets", "Secrets"], ["hiddenPlaces", "Hidden places"], ["map", "Map"]]) {
        if (checkedManifest.content[key]) pack[key] = validateContentList(checkedManifest.content[key], label);
      }
    } else if (checkedManifest.files && typeof checkedManifest.files === "object") {
      for (const [key, url] of Object.entries(checkedManifest.files)) {
        const response = await freshFetch(url);
        if (!response.ok) throw new Error(`${key} returned ${response.status}.`);
        pack[key] = validateContentList(await response.json(), key);
      }
    } else {
      throw new Error("The manifest has no content or file list.");
    }
    if (!pack.guide && !pack.legendaries && !pack.map) throw new Error("The update did not include guide data.");
    const previous = localStorage.getItem("fg_content");
    localStorage.setItem("fg_content", JSON.stringify(pack));
    if (!installedPack()) {
      if (previous == null) localStorage.removeItem("fg_content");
      else localStorage.setItem("fg_content", previous);
      throw new Error("The saved update failed validation and was not kept.");
    }
    if (previous) localStorage.setItem("fg_content_prev", previous);
    contentErrors.length = 0;
    await reloadContent();
    $("#settingsMsg").textContent = `Installed guide ${pack.version}. The previous copy can be restored.`;
  } catch (error) {
    $("#settingsMsg").textContent = `Update was not applied. The last usable guide is unchanged. ${error.message}`;
  }
}

function rollbackContent() {
  const previous = localStorage.getItem("fg_content_prev");
  if (!previous) {
    localStorage.removeItem("fg_content");
    $("#settingsMsg").textContent = "Rolled back to the bundled pages.";
  } else {
    localStorage.setItem("fg_content", previous);
    localStorage.removeItem("fg_content_prev");
    if (!installedPack()) {
      localStorage.removeItem("fg_content");
      $("#settingsMsg").textContent = "The previous update was unreadable, so the bundled pages are back.";
    } else {
      $("#settingsMsg").textContent = `Restored guide ${installedPack().version}.`;
    }
  }
  contentErrors.length = 0;
  reloadContent();
}

$("#checkUpdates").onclick = contentUpdate;
if ($("#applyUpdate")) $("#applyUpdate").onclick = applyContentUpdate;
if ($("#rollbackUpdate")) $("#rollbackUpdate").onclick = rollbackContent;

function mapViewportScale(viewport) {
  const value = Number(viewport && viewport.dataset.scale || 1);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function markerKind(item) {
  const classes = [];
  if (item.category === "Legendary") classes.push("legendary");
  if (item.category === "Secrets") classes.push("secret");
  const hidden = String(item.category || "").toLowerCase();
  if (hidden === "cave" || hidden === "waterfall" || hidden === "mine" || hidden === "underground" || hidden === "mountain") classes.push(hidden);
  const slug = String(item.category || "pin").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  classes.push(`kind-${slug}`);
  return classes.length ? ` ${classes.join(" ")}` : "";
}

const MARKER_ORDER = ["Gold", "Treasure", "Legendary", "Fish", "Secrets", "Weapons", "Ammo", "Horses", "Money", "Online Gold", "Valuables"];

const MARKER_STYLES = {
  Gold: { color: "#e2b23a", ink: "#2c2218", glyph: "bars", label: "Gold bars" },
  Treasure: { color: "#e07a2f", ink: "#2c2218", glyph: "xmark", label: "Treasure" },
  Legendary: { color: "#8e1e24", ink: "#f8efe0", glyph: "paw", label: "Legendary animals" },
  Fish: { color: "#1f7a78", ink: "#f8efe0", glyph: "fish", label: "Legendary fish" },
  Secrets: { color: "#6d4ea3", ink: "#f8efe0", glyph: "eye", label: "Secrets" },
  Weapons: { color: "#4d6278", ink: "#f8efe0", glyph: "guns", label: "Weapons" },
  Ammo: { color: "#2f6b3a", ink: "#f8efe0", glyph: "bullet", label: "Ammo" },
  Horses: { color: "#8a4b2f", ink: "#f8efe0", glyph: "horse", label: "Rare horses" },
  Money: { color: "#c4a35a", ink: "#2c2218", glyph: "coin", label: "Money" },
  "Online Gold": { color: "#d4a017", ink: "#2c2218", glyph: "coin", label: "Online gold" },
  Valuables: { color: "#b08d57", ink: "#2c2218", glyph: "coin", label: "Valuables" }
};

const MARKER_GLYPHS = {
  bars: '<path fill="currentColor" d="M4 6.5h16v2.4H4zm0 4.3h16v2.4H4zm0 4.3h16V18H4z"/>',
  xmark: '<path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/>',
  paw: '<circle cx="7.5" cy="8" r="1.7" fill="currentColor"/><circle cx="12" cy="6.4" r="1.7" fill="currentColor"/><circle cx="16.5" cy="8" r="1.7" fill="currentColor"/><ellipse cx="12" cy="15.2" rx="4.2" ry="3.1" fill="currentColor"/>',
  fish: '<path fill="currentColor" d="M3 12l5.2-3.6c2.6-1.2 6.4-1.3 9.4.4 1.2 1.6 1.3 3.6 0 5.2-3 1.8-6.8 1.7-9.4.4L3 12z"/><circle cx="15.2" cy="12" r=".8" fill="#2a1c12"/>',
  eye: '<ellipse cx="12" cy="12" rx="7" ry="4" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="2" fill="currentColor"/>',
  cave: '<path fill="currentColor" d="M3 18V9.5L8 4l4 3.2L16 4l5 5.5V18H3z"/>',
  guns: '<path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M4 16.5l8.5-8.5M6.5 6.5h3.2l2 2M15 4.5l4.5 4.5-2.2 2.2-4.5-4.5zM5 18l2.6-.8"/>',
  bullet: '<path fill="currentColor" d="M9.2 4h5.6l.8 3.2H8.4zM8.2 7.2h7.6V17l-3.8 2.4L8.2 17z"/>',
  horse: '<path fill="currentColor" d="M8 16.5c.2-2.6 2-4.6 4.6-5.4.2-1.8 1.4-3.6 3.2-4.2.7 1.1.5 2.2-.3 2.9 1.5.5 2.6 1.5 3 2.8l1.6 1.1-1.9.7.5 2.1h-2.3l-.7-2c-1 .5-2.2.7-3.2.4l-.6 2.2H9.2l.7-2.4C8.4 15.2 8 15.8 8 16.5z"/>',
  coin: '<circle cx="12" cy="12" r="6.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M12 8.2v7.6M10.2 10.1c.5-.8 3.2-.9 3.4.5.2 1.1-.8 1.4-1.8 1.6s-1.7.6-1.5 1.6c.3 1.2 2.8 1.2 3.4.2"/>'
};

function styleFor(category) {
  if (category === "Cave" || category === "Waterfall" || category === "Mine" || category === "Underground" || category === "Mountain") {
    return { color: "#5c4030", ink: "#f8efe0", glyph: "cave", label: category };
  }
  return MARKER_STYLES[category] || { color: "#4a3828", ink: "#f8efe0", glyph: "xmark", label: category || "Place" };
}

function markerGlyph(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = MARKER_GLYPHS[name] || MARKER_GLYPHS.xmark;
  return svg;
}

function foundIds() {
  try { return new Set(JSON.parse(localStorage.getItem("fg_found") || "[]")); }
  catch { return new Set(); }
}

function foundButton(id) {
  const button = actionButton("ghost compact", foundIds().has(id) ? "Marked found" : "Mark found", () => {
    const ids = foundIds();
    if (ids.has(id)) ids.delete(id);
    else ids.add(id);
    localStorage.setItem("fg_found", JSON.stringify([...ids]));
    button.textContent = ids.has(id) ? "Marked found" : "Mark found";
    renderMap();
    renderHiddenMap();
  });
  return button;
}

const MAP_FRAME = typeof L === "undefined" ? null : L.latLngBounds([-144, 0], [0, 176]);
const ACCURACY_MAP = new URLSearchParams(location.search).get("accuracy") === "1";

function paintLeaflet(viewport, items, activeId, onSelect) {
  if (!viewport) return;
  viewport._pinItems = items;
  viewport._pinActive = activeId;
  viewport._pinSelect = onSelect;
  drawPins(viewport);
}

function drawPins(viewport) {
  const map = viewport?.frontierMap;
  if (!map || !viewport._pinItems || !map._loaded) return;
  if (map._pinLayer) map.removeLayer(map._pinLayer);
  const items = viewport._pinItems;
  const activeId = viewport._pinActive;
  const onSelect = viewport._pinSelect;
  const found = foundIds();
  const layer = L.layerGroup();
  const detail = viewport.dataset.detail || "far";
  const stacks = new Map();
  const addIcon = (item, lat, lng) => {
    const stacksKey = `${lat}|${lng}`;
    const index = stacks.get(stacksKey) || 0;
    stacks.set(stacksKey, index + 1);
    const style = styleFor(item.category);
    const angle = index * 1.15;
    const radius = index === 0 ? 0 : 12 + (index - 1) * 3;
    const icon = L.divIcon({
      className: `map-marker${markerKind(item)}${activeId === item.id ? " active" : ""}${found.has(item.id) ? " found" : ""}`,
      html: `<svg viewBox="0 0 24 24" aria-hidden="true">${MARKER_GLYPHS[style.glyph] || MARKER_GLYPHS.xmark}</svg>`,
      iconSize: [22, 22],
      iconAnchor: [11 - Math.cos(angle) * radius, 11 - Math.sin(angle) * radius]
    });
    const marker = L.marker([lat, lng], { icon, pane: "pins", keyboard: false, bubblingMouseEvents: false });
    marker.on("click", event => {
      if (event.originalEvent) event.originalEvent.stopPropagation();
      onSelect(item);
    });
    marker.on("add", () => {
      const element = marker.getElement();
      if (!element) return;
      element.style.background = style.color;
      element.style.color = style.ink;
      const name = item.title || item.name || "Marker";
      element.title = name;
      element.setAttribute("aria-label", name);
    });
    layer.addLayer(marker);
  };
  if (detail !== "close") {
    const groups = new Map();
    for (const item of items) {
      const point = map.latLngToContainerPoint([item.lat, item.lng]);
      const key = `${Math.round(point.x / 36)}:${Math.round(point.y / 36)}`;
      const group = groups.get(key) || [];
      group.push(item);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      if (group.length === 1 && detail !== "far") {
        addIcon(group[0], group[0].lat, group[0].lng);
        continue;
      }
      if (group.length === 1) {
        const item = group[0];
        const style = styleFor(item.category);
        const icon = L.divIcon({
          className: "map-dot",
          html: "",
          iconSize: [9, 9],
          iconAnchor: [4, 4]
        });
        const marker = L.marker([item.lat, item.lng], { icon, pane: "pins", keyboard: false, bubblingMouseEvents: false });
        marker.on("click", event => {
          if (event.originalEvent) event.originalEvent.stopPropagation();
          onSelect(item);
        });
        marker.on("add", () => {
          const element = marker.getElement();
          if (!element) return;
          element.style.background = style.color;
          const name = item.title || item.name || "Marker";
          element.title = name;
          element.setAttribute("aria-label", name);
        });
        layer.addLayer(marker);
        continue;
      }
      const lat = group.reduce((sum, item) => sum + item.lat, 0) / group.length;
      const lng = group.reduce((sum, item) => sum + item.lng, 0) / group.length;
      const counts = new Map();
      for (const item of group) counts.set(item.category, (counts.get(item.category) || 0) + 1);
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const style = styleFor(top);
      const size = group.length > 12 ? 30 : 26;
      const icon = L.divIcon({
        className: "map-cluster",
        html: String(group.length),
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2]
      });
      const marker = L.marker([lat, lng], { icon, pane: "pins", keyboard: false, bubblingMouseEvents: false });
      marker.on("click", event => {
        if (event.originalEvent) event.originalEvent.stopPropagation();
        viewport._userMoved = true;
        map.setView([lat, lng], Math.min(map.getMaxZoom(), map.getZoom() + 1.4), { animate: true });
      });
      marker.on("add", () => {
        const element = marker.getElement();
        if (!element) return;
        element.style.background = style.color;
        element.style.color = style.ink;
        element.title = `${group.length} places`;
        element.setAttribute("aria-label", element.title);
      });
      layer.addLayer(marker);
    }
  } else {
    for (const item of items) addIcon(item, item.lat, item.lng);
  }
  layer.addTo(map);
  map._pinLayer = layer;
}

function mountLeafletMap(viewport, paneId) {
  if (!viewport || viewport.dataset.zoomReady || typeof L === "undefined" || !MAP_FRAME) return;
  viewport.dataset.zoomReady = "1";
  viewport.dataset.scale = "1";
  viewport.dataset.detail = "far";
  const map = L.map(viewport, {
    crs: L.CRS.Simple,
    minZoom: -2,
    maxZoom: 7,
    zoomSnap: 0,
    zoomDelta: 0.5,
    inertia: true,
    inertiaDeceleration: 2800,
    zoomControl: false,
    attributionControl: false,
    doubleClickZoom: true,
    touchZoom: true,
    scrollWheelZoom: true,
    boxZoom: false,
    keyboard: false,
    maxBounds: MAP_FRAME,
    maxBoundsViscosity: 1
  });
  viewport.frontierMap = map;
  const pane = map.createPane("pins");
  pane.id = paneId;
  pane.style.zIndex = "650";
  const layers = ["far", "mid", "close"].map(name => L.imageOverlay(`content/parchment-${name}.jpg`, MAP_FRAME));
  viewport._drawPins = () => drawPins(viewport);
  if (ACCURACY_MAP) {
    L.tileLayer("https://s.rsg.sc/sc/images/games/RDR2/map/game/{z}/{x}/{y}.jpg", {
      bounds: MAP_FRAME,
      minZoom: 2,
      maxZoom: 7,
      noWrap: true
    }).addTo(map);
  } else {
    layers.forEach(layer => layer.addTo(map));
  }
  let fitting = false;
  const applyDetail = () => {
    const fit = Number.isFinite(viewport._fitZoom) ? viewport._fitZoom : map.getZoom();
    const ratio = Math.pow(2, map.getZoom() - fit);
    const detail = !Number.isFinite(ratio) || ratio < 1.8 ? "far" : ratio < 3.6 ? "mid" : "close";
    const changed = viewport.dataset.detail !== detail;
    viewport.dataset.scale = ratio.toFixed(3);
    viewport.dataset.detail = detail;
    if (!ACCURACY_MAP) {
      layers[0].setOpacity(detail === "far" ? 1 : 0);
      layers[1].setOpacity(detail === "mid" ? 1 : 0);
      layers[2].setOpacity(detail === "close" ? 1 : 0);
    }
    if (changed) viewport._drawPins?.();
  };
  const fitHome = () => {
    const box = viewport.getBoundingClientRect();
    if (box.width < 20 || box.height < 20) return false;
    fitting = true;
    map.setMinZoom(-2);
    map.invalidateSize({ animate: false });
    const home = viewport._landBounds?.isValid?.() ? viewport._landBounds : MAP_FRAME;
    map.fitBounds(home, { animate: false, padding: [0, 0] });
    viewport._fitZoom = map.getZoom();
    map.setMinZoom(viewport._fitZoom);
    viewport._userMoved = false;
    fitting = false;
    applyDetail();
    viewport._drawPins?.();
    return true;
  };
  viewport.frontierReflow = () => {
    if (viewport._userMoved) {
      map.invalidateSize({ animate: false });
      applyDetail();
      return;
    }
    fitHome();
  };
  viewport.frontierZoomTo = (nextScale, xPercent, yPercent) => {
    if (!Number.isFinite(viewport._fitZoom) && !fitHome()) return;
    const ratio = Math.max(0.2, Number(nextScale) || 1);
    const fit = viewport._fitZoom;
    const zoom = Math.min(map.getMaxZoom(), Math.max(map.getMinZoom(), fit + Math.log2(ratio)));
    const lat = Number.isFinite(Number(yPercent)) ? -144 * (Number(yPercent) / 100) : -72;
    const lng = Number.isFinite(Number(xPercent)) ? 176 * (Number(xPercent) / 100) : 88;
    viewport._userMoved = ratio > 1.05;
    map.setView([lat, lng], zoom, { animate: false });
    applyDetail();
  };
  map.on("zoom move", () => {
    if (!fitting) viewport._userMoved = true;
    applyDetail();
  });
  map.on("moveend", () => {
    if (!fitting && viewport.dataset.detail !== "close") viewport._drawPins?.();
  });
  map.on("click", () => {
    const card = viewport.closest(".map-panel")?.querySelector(".map-detail");
    if (card?.classList.contains("is-open")) card._closeSheet?.();
  });
  const frame = viewport.closest(".map-frame");
  frame?.querySelector(".map-zoom-in")?.addEventListener("click", () => map.zoomIn(0.5));
  frame?.querySelector(".map-zoom-out")?.addEventListener("click", () => map.zoomOut(0.5));
  frame?.querySelector(".map-recenter")?.addEventListener("click", () => {
    viewport._userMoved = false;
    fitHome();
  });
  const searchToggle = frame?.querySelector(".map-search-toggle");
  const searchPop = frame?.querySelector(".map-search-pop");
  const search = frame?.querySelector(".map-search-input");
  searchToggle?.addEventListener("click", () => {
    const open = Boolean(searchPop?.hidden);
    if (searchPop) searchPop.hidden = !open;
    searchToggle.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) search?.focus();
  });
  const layersButton = frame?.querySelector(".map-layers-toggle");
  const sheet = frame?.querySelector(".map-sheet");
  layersButton?.addEventListener("click", () => {
    const open = Boolean(sheet?.hidden);
    if (sheet) sheet.hidden = !open;
    layersButton.setAttribute("aria-expanded", open ? "true" : "false");
    const card = viewport.closest(".map-panel")?.querySelector(".map-detail");
    if (open && card?.classList.contains("is-open")) card._closeSheet?.();
  });
  const fly = () => {
    const query = search.value.trim().toLowerCase();
    if (!query) return;
    const hidden = viewport.id === "hiddenMap";
    const pool = hidden ? state.hiddenPlaces.filter(modeMatches) : state.mapLocations.filter(modeMatches);
    const labelOf = item => `${item.title || ""} ${item.name || ""}`.toLowerCase();
    const item = pool.find(entry => labelOf(entry) === query)
      || pool.find(entry => labelOf(entry).startsWith(query))
      || pool.find(entry => `${labelOf(entry)} ${entry.breed || ""} ${entry.coat || ""} ${entry.region || ""}`.includes(query));
    const gaz = (state.gazetteer || []).find(entry => entry.name.toLowerCase() === query)
      || (state.gazetteer || []).find(entry => entry.name.toLowerCase().startsWith(query))
      || (state.gazetteer || []).find(entry => entry.name.toLowerCase().includes(query));
    if (!item && !gaz) {
      search.setCustomValidity("No matching place");
      search.reportValidity();
      return;
    }
    search.setCustomValidity("");
    if (item && hidden) showHiddenDetail(item);
    else if (item) {
      if (!mapCategoryOn(item.category)) {
        state.disabledMapCategories.delete(item.category);
        renderMapTags();
      }
      showMapDetail(item);
    }
    const lat = Number.isFinite(item?.lat) ? item.lat : gaz?.lat;
    const lng = Number.isFinite(item?.lng) ? item.lng : gaz?.lng;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const zoom = Math.min(map.getMaxZoom(), (viewport._fitZoom || 1) + Math.log2(4.2));
    viewport._userMoved = true;
    map.setView([lat, lng], zoom, { animate: true });
  };
  search?.addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    fly();
  });
  searchPop?.addEventListener("submit", event => {
    event.preventDefault();
    fly();
  });
  window.addEventListener("resize", () => viewport.frontierReflow());
  let bootTries = 0;
  const bootFit = () => {
    if (fitHome() || bootTries++ > 12) return;
    requestAnimationFrame(bootFit);
  };
  requestAnimationFrame(bootFit);
}

function setCoachState(stateName, detail) {
  coach.state = stateName;
  const label = { waiting: "Waiting for game", watching: "Watching", paused: "Paused", reconnecting: "Reconnecting", offline: "Offline", stopped: "Stopped" }[stateName] || stateName;
  const node = $("#coachState");
  if (node) node.textContent = label;
  if (detail && $("#coachMeta")) $("#coachMeta").textContent = detail;
}

function saveCoachProfile() {
  const profile = {
    source: $("#coachSource")?.value || "camera",
    platform: $("#coachPlatform")?.value || "console",
    progress: $("#coachProgress")?.value || "",
    goal: $("#coachGoal")?.value || "",
    spoiler: $("#coachSpoiler")?.checked === true,
    crop: $("#coachCrop")?.value || "full",
    quality: $("#coachQuality")?.value || "balanced"
  };
  try { localStorage.setItem("fg_coach_profile", JSON.stringify(profile)); } catch {}
  coach.profile = profile;
  return profile;
}

function restoreCoachProfile() {
  try {
    const profile = JSON.parse(localStorage.getItem("fg_coach_profile") || "null");
    if (!profile) return;
    if ($("#coachSource") && profile.source) $("#coachSource").value = profile.source;
    if ($("#coachPlatform") && profile.platform) $("#coachPlatform").value = profile.platform;
    if ($("#coachProgress")) $("#coachProgress").value = profile.progress || "";
    if ($("#coachGoal")) $("#coachGoal").value = profile.goal || "";
    if ($("#coachSpoiler")) $("#coachSpoiler").checked = profile.spoiler === true;
    if ($("#coachCrop") && profile.crop) $("#coachCrop").value = profile.crop;
    if ($("#coachQuality") && profile.quality) $("#coachQuality").value = profile.quality;
  } catch {}
}

function haltCoach(message) {
  coach.session += 1;
  clearInterval(coach.timer);
  coach.timer = 0;
  try { coach.abort?.abort(); } catch {}
  coach.abort = null;
  coach.busy = false;
  coach.paused = false;
  coach.ownsScreen = false;
  if (state.pendingCameraOwner === "coach") state.pendingCameraOwner = null;
  stopStream("coach");
  const pause = $("#coachPause");
  if (pause) pause.textContent = "Pause";
  try { window.AndroidBridge?.hideCoachOverlay?.(); } catch {}
  stopSpeaking();
  const preview = $("#coachPreview");
  if (preview) preview.classList.add("hidden");
  setCoachState("stopped", message || "Coach is stopped.");
  const panel = $("#coachObjective");
  if (panel) panel.textContent = "Coach is stopped";
  const next = $("#coachNext");
  if (next) next.textContent = "Start Coach when the game is on screen. Nothing is being watched.";
  const tips = $("#coachTips");
  if (tips) tips.replaceChildren();
}

function cropCanvas(source, mode) {
  if (!source || mode === "full") return source;
  const canvas = document.createElement("canvas");
  const sw = source.width;
  const sh = source.height;
  let sx = 0;
  let sy = 0;
  let width = sw;
  let height = sh;
  if (mode === "center") {
    sx = sw * 0.15; sy = sh * 0.15; width = sw * 0.7; height = sh * 0.7;
  } else if (mode === "top") {
    height = sh * 0.4;
  }
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  canvas.getContext("2d").drawImage(source, sx, sy, width, height, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function measureFrame(canvas) {
  const ctx = canvas.getContext("2d");
  const sample = ctx.getImageData(0, 0, Math.min(48, canvas.width), Math.min(48, canvas.height));
  let sum = 0;
  let sumSq = 0;
  const count = sample.data.length / 4 || 1;
  for (let index = 0; index < sample.data.length; index += 4) {
    const tone = sample.data[index] * 0.3 + sample.data[index + 1] * 0.59 + sample.data[index + 2] * 0.11;
    sum += tone;
    sumSq += tone * tone;
  }
  const mean = sum / count;
  const variance = sumSq / count - mean * mean;
  return { mean, variance, readable: variance >= 40 };
}

function canvasFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 960 / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas);
    };
    image.onerror = () => reject(new Error("frame"));
    image.src = dataUrl;
  });
}

async function currentCoachCanvas() {
  const profile = coach.profile || saveCoachProfile();
  const quality = profile.quality === "sharp" ? 0.86 : 0.72;
  if (coach.source === "camera") {
    const video = $("#coachVideo");
    if (!video || !video.videoWidth) return null;
    const raw = document.createElement("canvas");
    const scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
    raw.width = Math.max(1, Math.round(video.videoWidth * scale));
    raw.height = Math.max(1, Math.round(video.videoHeight * scale));
    raw.getContext("2d").drawImage(video, 0, 0, raw.width, raw.height);
    const cropped = cropCanvas(raw, profile.crop);
    return { canvas: cropped, dataUrl: cropped.toDataURL("image/jpeg", quality) };
  }
  refreshNativeFrame();
  const src = $("#coachPreview")?.src || $("#screenPreview")?.src || "";
  if (!src.startsWith("data:image")) return null;
  const canvas = cropCanvas(await canvasFromDataUrl(src), profile.crop);
  return { canvas, dataUrl: canvas.toDataURL("image/jpeg", quality) };
}

function renderCoachAdvice(data, ageMs) {
  const objective = $("#coachObjective");
  const next = $("#coachNext");
  const tips = $("#coachTips");
  if (objective) objective.textContent = data.observation || "Nothing confirmed in this frame.";
  if (next) next.textContent = data.nextAction || "Hold steady and try again.";
  if (!tips) return;
  tips.replaceChildren();
  if (data.uncertainty) {
    const note = document.createElement("p");
    note.textContent = data.uncertainty;
    tips.appendChild(note);
  }
  for (const tip of data.tips || []) {
    const card = document.createElement("article");
    card.className = "card";
    const title = document.createElement("h3");
    title.textContent = tip.text;
    card.appendChild(title);
    const link = guideLink(tip.guideId);
    if (link) card.appendChild(actionButton("ghost compact", "Open guide", () => openEntry(link.view, link.id)));
    tips.appendChild(card);
  }
  const age = document.createElement("p");
  age.textContent = `Latest analyzed frame: ${Math.max(0, Math.round(ageMs / 1000))}s ago. Tips stay on this phone. A TV overlay is not part of this app.`;
  tips.appendChild(age);
}

function guideLink(id) {
  if (!id) return null;
  if (state.legendaries.some(item => item.id === id)) return { view: "legendary", id };
  if (state.secrets.some(item => item.id === id)) return { view: "secrets", id };
  if (state.hiddenPlaces.some(item => item.id === id)) return { view: "hidden", id };
  if (state.guide.some(item => item.id === id)) return { view: "guide", id };
  return null;
}

async function ensureCoachOverlay() {
  if ($("#coachOverlay")?.checked !== true || coach.source !== "screen") {
    try { window.AndroidBridge?.hideCoachOverlay?.(); } catch {}
    return false;
  }
  if (!window.AndroidBridge?.canDrawOverlays) return false;
  if (!window.AndroidBridge.canDrawOverlays()) {
    $("#coachOverlay").checked = false;
    setCoachState(coach.state, "Android has not allowed a floating tip. In-app tips and voice still work. Allow display over other apps, then turn the floating tip on again.");
    try { window.AndroidBridge.requestOverlayPermission(); } catch {}
    return false;
  }
  return true;
}

async function analyzeCoachFrame(session, force = false) {
  if (session !== coach.session || coach.paused || coach.state === "stopped") return;
  if (coach.busy && !force) return;
  if (!settings.api) {
    setCoachState("offline", "Offline. Bundled pages still work. Coach vision needs the server, and a health check is not a gameplay connection.");
    return;
  }
  let frame = null;
  try {
    frame = await currentCoachCanvas();
  } catch {
    frame = null;
  }
  if (session !== coach.session || coach.paused) return;
  if (!frame) {
    setCoachState("waiting", coach.source === "screen" ? "Waiting for a screen frame." : "Waiting for the camera. Point it at the game.");
    return;
  }
  const reading = measureFrame(frame.canvas);
  const changed = coach.lastMean < 0 || Math.abs(reading.mean - coach.lastMean) > 4;
  if (!force && !changed && Date.now() - coach.lastUpload < 20000) return;
  coach.lastMean = reading.mean;
  if (!reading.readable) {
    setCoachState("watching", "This frame is hard to read. Reduce glare, fill the game picture, or change the crop.");
    return;
  }
  coach.busy = true;
  coach.frame += 1;
  const frameId = String(coach.frame);
  const controller = new AbortController();
  coach.abort = controller;
  const started = Date.now();
  const profile = coach.profile;
  try {
    const data = await requestJson("/api/coach", {
      method: "POST",
      headers: serverHeaders(true),
      signal: controller.signal,
      body: JSON.stringify({
        sessionId: String(session),
        frameId,
        capturedAt: new Date().toISOString(),
        imageDataUrl: frame.dataUrl,
        mode: state.mode,
        platform: profile.platform,
        progress: profile.progress,
        goal: profile.goal,
        spoiler: profile.spoiler === true,
        history: state.history.slice(-6)
      })
    });
    if (session !== coach.session || coach.paused) return;
    if (String(data.sessionId || "") !== String(session) || String(data.frameId || "") !== frameId) return;
    coach.lastUpload = Date.now();
    const elapsed = Date.now() - started;
    renderCoachAdvice(data, 0);
    const slow = elapsed > 5000 ? ` Last advice took ${Math.round(elapsed / 1000)}s.` : "";
    setCoachState("watching", `Watching.${slow}`);
    const spoken = data.nextAction || "";
    if (!coach.muted && spoken && spoken !== coach.lastTip) {
      coach.lastTip = spoken;
      speakAnswer(spoken);
    }
    if (await ensureCoachOverlay()) {
      try { window.AndroidBridge.showCoachOverlay(spoken || data.observation || "Watching"); } catch {}
    }
  } catch (error) {
    if (session !== coach.session || coach.paused || error?.name === "AbortError") return;
    setCoachState("reconnecting", error.message || "The coach request failed. It will try the next frame.");
  } finally {
    if (coach.abort === controller) coach.abort = null;
    coach.busy = false;
  }
}

async function startCoach() {
  haltCoach("");
  const profile = saveCoachProfile();
  coach.source = profile.source === "screen" ? "screen" : "camera";
  coach.muted = $("#coachMute")?.dataset.muted === "1";
  coach.paused = false;
  coach.ownsScreen = false;
  coach.lastMean = -1;
  coach.lastTip = "";
  const session = coach.session;
  setCoachState("waiting", "Waiting for a readable game frame. A server health check does not mean the game is connected.");
  try {
    if (coach.source === "camera") {
      const video = $("#coachVideo");
      if (video) video.classList.remove("hidden");
      const opened = await openOwnedCamera("coach", video);
      if (!opened) {
        setCoachState("waiting", "Android is asking for camera access. Choose Allow to start watching. Deny leaves Coach stopped.");
        return;
      }
    } else {
      coach.ownsScreen = true;
      if (!nativeAvailable()) {
        haltCoach("Screen capture needs the Android app. Use the phone camera for a TV.");
        return;
      }
      const dialog = $("#screenDialog");
      if (dialog && !dialog.open) dialog.showModal();
      beginScreenShare();
    }
  } catch {
    haltCoach("The selected input did not start. Check the camera or screen-share permission.");
    return;
  }
  if (coach.session !== session) return;
  coach.timer = setInterval(() => analyzeCoachFrame(session, false), 8000);
  analyzeCoachFrame(session, true);
}

function pauseCoach() {
  if (coach.state === "stopped" || coach.state === "paused") return;
  coach.paused = true;
  clearInterval(coach.timer);
  coach.timer = 0;
  try { coach.abort?.abort(); } catch {}
  stopSpeaking();
  setCoachState("paused", "Paused. The preview can stay up. Analysis, uploads, and coaching speech are stopped.");
}

function resumeCoach() {
  if (coach.state !== "paused") return;
  const cameraOk = coach.source !== "camera" || state.streamOwner === "coach";
  const screenOk = coach.source !== "screen" || screenPhase === "sharing";
  if (!cameraOk || !screenOk) {
    haltCoach("That capture session ended. Start Coach again.");
    return;
  }
  coach.paused = false;
  const session = coach.session;
  setCoachState("watching", "Watching again from the current session.");
  coach.timer = setInterval(() => analyzeCoachFrame(session, false), 8000);
  analyzeCoachFrame(session, true);
}

async function reloadContent() {
  contentErrors.length = 0;
  await loadGuide();
  await loadMap();
  await loadFieldContent();
  const node = $("#contentVersion");
  const version = installedPack()?.version;
  if (node) node.textContent = version ? `Installed guide data: ${version}` : "Installed guide data: bundled pages";
}

function showSavedUpdate() {
  try {
    const saved = JSON.parse(localStorage.getItem("fg_last_update") || "null");
    if (!saved?.answer) return false;
    const card = setUpdateCard(`Saved field report · ${saved.checkedAt || "earlier"}`, saved.answer);
    appendSources(card, saved.sources || []);
    return true;
  } catch {
    return false;
  }
}

if ("serviceWorker" in navigator && window.location.hostname !== "appassets.androidplatform.net") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

$("#onlineDot").onclick = () => checkStatus(true);
restoreCoachProfile();
mountLeafletMap($("#fieldMap"), "mapMarkers");
mountLeafletMap($("#hiddenMap"), "hiddenMarkers");
fetch("content/land-bounds.json").then(response => response.ok ? response.json() : null).then(data => {
  if (!data || !Number.isFinite(data.south) || !Number.isFinite(data.west) || !Number.isFinite(data.north) || !Number.isFinite(data.east)) return;
  const bounds = L.latLngBounds([data.south, data.west], [data.north, data.east]);
  for (const id of ["fieldMap", "hiddenMap"]) {
    const node = document.getElementById(id);
    if (!node) continue;
    node._landBounds = bounds;
    if (!node._userMoved) node.frontierReflow?.();
  }
}).catch(() => {});
const coachStart = $("#coachStart");
if (coachStart) coachStart.onclick = () => startCoach();
const coachPause = $("#coachPause");
if (coachPause) coachPause.onclick = () => {
  if (coach.state === "paused") resumeCoach();
  else pauseCoach();
  coachPause.textContent = coach.state === "paused" ? "Resume" : "Pause";
};
const coachStop = $("#coachStop");
if (coachStop) coachStop.onclick = () => {
  if (coach.ownsScreen) stopSharing();
  else haltCoach("Coach is stopped. Capture and speech are off.");
};
const coachMute = $("#coachMute");
if (coachMute) coachMute.onclick = () => {
  coach.muted = !coach.muted;
  coachMute.dataset.muted = coach.muted ? "1" : "0";
  coachMute.textContent = coach.muted ? "Unmute" : "Mute";
  if (coach.muted) stopSpeaking();
};
const coachAsk = $("#coachAsk");
if (coachAsk) coachAsk.onclick = () => analyzeCoachFrame(coach.session, true);
const coachMore = $("#coachMore");
if (coachMore) coachMore.onclick = () => {
  const text = $("#coachNext")?.textContent || "";
  if (!text || coach.state === "stopped") return;
  setView("ask");
  askQuestion(`Explain that coach tip in a bit more detail, still without inventing anything you did not confirm: ${text}`);
};
const coachFlip = $("#coachFlip");
if (coachFlip) coachFlip.onclick = async () => {
  state.cameraFacing = state.cameraFacing === "environment" ? "user" : "environment";
  if (coach.source === "camera" && coach.state !== "stopped") await openOwnedCamera("coach", $("#coachVideo"));
};

try {
  const rawPack = localStorage.getItem("fg_content");
  if (rawPack && !installedPack()) contentErrors.push("The saved guide update could not be read. Bundled pages are in use.");
} catch {}

loadGuide();
loadMap();
loadFieldContent();
checkStatus();
showSavedUpdate();
window.speechSynthesis?.getVoices?.();
window.speechSynthesis?.addEventListener?.("voiceschanged", () => {});
