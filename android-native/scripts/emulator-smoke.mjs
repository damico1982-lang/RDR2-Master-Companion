import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { get as httpGet } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = randomBytes(4);
  let prefix;
  if (data.length < 126) {
    prefix = Buffer.alloc(2);
    prefix[1] = 0x80 | data.length;
  } else if (data.length < 65536) {
    prefix = Buffer.alloc(4);
    prefix[1] = 0x80 | 126;
    prefix.writeUInt16BE(data.length, 2);
  } else {
    prefix = Buffer.alloc(10);
    prefix[1] = 0x80 | 127;
    prefix.writeBigUInt64BE(BigInt(data.length), 2);
  }
  prefix[0] = 0x80 | opcode;
  const masked = Buffer.alloc(data.length);
  for (let index = 0; index < data.length; index += 1) masked[index] = data[index] ^ mask[index % 4];
  return Buffer.concat([prefix, mask, masked]);
}

function connectDevtools(wsUrl) {
  const url = new URL(wsUrl);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port) || 80 });
    const key = randomBytes(16).toString("base64");
    let raw = Buffer.alloc(0);
    let opened = false;
    const queued = [];
    const early = [];
    let handler = null;
    const api = {
      send(text) {
        const frame = encodeFrame(1, text);
        if (opened) socket.write(frame);
        else queued.push(frame);
      },
      close() {
        socket.end();
      },
      onclose: null,
      set onmessage(value) {
        handler = value;
        if (!value) return;
        for (const text of early.splice(0)) value(text);
      },
      get onmessage() {
        return handler;
      }
    };
    const fail = error => {
      socket.destroy();
      if (!opened) reject(error);
    };
    socket.setTimeout(20000, () => fail(new Error("DevTools socket timed out")));
    socket.on("error", fail);
    socket.on("close", () => api.onclose?.());
    socket.on("connect", () => {
      socket.write(
        `GET ${url.pathname}${url.search} HTTP/1.1\r\n` +
        `Host: ${url.host}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`
      );
    });
    const consume = () => {
      while (raw.length >= 2) {
        const opcode = raw[0] & 0x0f;
        const masked = (raw[1] & 0x80) !== 0;
        let length = raw[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (raw.length < 4) return;
          length = raw.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (raw.length < 10) return;
          length = Number(raw.readBigUInt64BE(2));
          offset = 10;
        }
        const maskLength = masked ? 4 : 0;
        if (raw.length < offset + maskLength + length) return;
        let payload = raw.subarray(offset + maskLength, offset + maskLength + length);
        if (masked) {
          const mask = raw.subarray(offset, offset + 4);
          const copy = Buffer.alloc(length);
          for (let index = 0; index < length; index += 1) copy[index] = payload[index] ^ mask[index % 4];
          payload = copy;
        } else {
          payload = Buffer.from(payload);
        }
        raw = raw.subarray(offset + maskLength + length);
        if (opcode === 1 || opcode === 2) {
          const text = payload.toString("utf8");
          if (handler) handler(text);
          else early.push(text);
        } else if (opcode === 8) socket.end();
        else if (opcode === 9) socket.write(encodeFrame(10, payload));
      }
    };
    socket.on("data", chunk => {
      raw = Buffer.concat([raw, chunk]);
      if (!opened) {
        const marker = raw.indexOf("\r\n\r\n");
        if (marker < 0) return;
        const status = raw.subarray(0, marker).toString("latin1").split("\r\n")[0];
        if (!status.includes(" 101 ")) {
          fail(new Error(`DevTools upgrade failed: ${status}`));
          return;
        }
        raw = raw.subarray(marker + 4);
        opened = true;
        socket.setTimeout(0);
        resolve(api);
        for (const frame of queued) socket.write(frame);
        queued.length = 0;
      }
      consume();
    });
  });
}

if (process.env.SMOKE_SELFTEST === "1") {
  const { createServer } = await import("node:net");
  const server = createServer(socket => {
    let raw = Buffer.alloc(0);
    let open = false;
    socket.on("data", chunk => {
      raw = Buffer.concat([raw, chunk]);
      if (!open) {
        const marker = raw.indexOf("\r\n\r\n");
        if (marker < 0) return;
        const accept = randomBytes(16).toString("base64");
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        raw = raw.subarray(marker + 4);
        open = true;
      }
      if (raw.length < 6) return;
      const length = raw[1] & 0x7f;
      const payload = Buffer.alloc(length);
      const mask = raw.subarray(2, 6);
      for (let index = 0; index < length; index += 1) payload[index] = raw[2 + 4 + index] ^ mask[index % 4];
      const reply = Buffer.from(JSON.stringify({ id: JSON.parse(payload.toString()).id, result: { ok: true } }));
      const header = Buffer.from([0x81, reply.length]);
      socket.write(Buffer.concat([header, reply]));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const ws = await connectDevtools(`ws://127.0.0.1:${address.port}/devtools/page/test`);
  let received = "";
  ws.onmessage = text => { received = text; };
  ws.send(JSON.stringify({ id: 7, method: "Runtime.enable" }));
  for (let attempt = 0; attempt < 20 && !received; attempt += 1) await delay(50);
  ws.close();
  server.close();
  if (!received.includes('"id":7') || !received.includes('"ok":true')) {
    console.error("devtools round-trip failed", received);
    process.exit(1);
  }
  console.log("devtools client connected");
  process.exit(0);
}

const apk = process.argv[2];
if (!apk) {
  console.error("Usage: node emulator-smoke.mjs path/to/app-debug.apk");
  process.exit(1);
}

function adb(...args) {
  const result = spawnSync("adb", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`adb ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  return `${result.stdout || ""}${result.stderr || ""}`;
}

function adbOk(...args) {
  const result = spawnSync("adb", args, { encoding: "utf8" });
  return { status: result.status, out: `${result.stdout || ""}${result.stderr || ""}` };
}

function appLog() {
  return adbOk("logcat", "-d", "-s", "FrontierGuide:I", "chromium:E", "AndroidRuntime:E").out;
}

function dumpLogs() {
  console.error(appLog().slice(-7000));
}

process.on("unhandledRejection", error => {
  console.error(error);
  dumpLogs();
  process.exit(1);
});

adb("wait-for-device");
adb("install", "-r", "-t", apk);
for (const permission of [
  "android.permission.CAMERA",
  "android.permission.RECORD_AUDIO",
  "android.permission.POST_NOTIFICATIONS"
]) {
  adbOk("shell", "pm", "grant", "com.frontierguide.app", permission);
}
adb("logcat", "-c");
adb("shell", "am", "start", "-n", "com.frontierguide.app/.MainActivity");

let appPid = "";
let socketName = "";
let guideLog = "";
for (let attempt = 0; attempt < 45; attempt += 1) {
  appPid = adbOk("shell", "pidof", "com.frontierguide.app").out.trim().split(/\s+/).filter(Boolean)[0] || "";
  guideLog = appLog();
  if (appPid) {
    const listed = adbOk("shell", "cat", "/proc/net/unix").out;
    const name = `webview_devtools_remote_${appPid}`;
    if (listed.includes(name)) socketName = name;
  }
  if (socketName && guideLog.includes("page finished")) break;
  await delay(2000);
}
console.log(guideLog.slice(-4000));
if (!socketName || !guideLog.includes("page finished")) {
  throw new Error(`Frontier Guide did not finish loading. pid ${appPid || "missing"}, devtools ${socketName || "missing"}`);
}
console.log(`devtools socket ${socketName} pid ${appPid}`);

adb("forward", "--remove-all");
adb("forward", "tcp:9222", `localabstract:${socketName}`);

function devtoolsJson() {
  return new Promise((resolve, reject) => {
    const request = httpGet("http://127.0.0.1:9222/json", { headers: { Connection: "close" } }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        response.socket?.destroy();
        try {
          if (response.statusCode !== 200) {
            reject(new Error(`DevTools list returned ${response.statusCode}`));
            return;
          }
          const pages = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const page = pages.find(item => item.type === "page" && item.webSocketDebuggerUrl);
          if (!page) reject(new Error(`No WebView page in ${JSON.stringify(pages)}`));
          else resolve(page);
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(20000, () => {
      request.destroy();
      reject(new Error("DevTools list timed out"));
    });
    request.on("error", reject);
  });
}

let page;
for (let attempt = 0; attempt < 20; attempt += 1) {
  try {
    page = await devtoolsJson();
    const description = JSON.parse(page.description || "{}");
    if (description.attached && !description.empty) break;
  } catch (error) {
    page = null;
    if (attempt === 19) throw error;
  }
  await delay(1500);
}
if (!page?.webSocketDebuggerUrl) throw new Error("WebView page never became ready");
await delay(400);

const pending = new Map();
const consoleErrors = [];
let nextId = 0;
let ws;

function send(method, params = {}, timeoutMs = 30000) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) {
      reject(new Error("DevTools websocket closed"));
      return;
    }
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function handleDevtoolsMessage(text) {
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    consoleErrors.push(text.slice(0, 240));
    return;
  }
  if (message.id && pending.has(message.id)) {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
    return;
  }
  if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
    consoleErrors.push(JSON.stringify(message.params.args || message.params));
  }
  if (message.method === "Runtime.exceptionThrown") {
    consoleErrors.push(message.params?.exceptionDetails?.text || JSON.stringify(message.params));
  }
}

async function openPage() {
  const target = new URL(page.webSocketDebuggerUrl);
  target.hostname = "127.0.0.1";
  target.port = "9222";
  const socket = await connectDevtools(target.toString());
  ws = socket;
  socket.onmessage = handleDevtoolsMessage;
  socket.onclose = () => {
    if (ws !== socket) return;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("DevTools websocket closed"));
    }
    pending.clear();
  };
}

async function reconnectDevtools() {
  try { ws?.close(); } catch { /* already closed */ }
  ws = null;
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error("DevTools reconnect"));
  }
  pending.clear();
  adb("forward", "--remove-all");
  adb("forward", "tcp:9222", `localabstract:${socketName}`);
  await delay(400);
  page = await devtoolsJson();
  await openPage();
  await send("Runtime.enable");
  await send("Console.enable").catch(() => {});
}

async function sendRetry(method, params = {}, timeoutMs = 30000) {
  let last = new Error(`DevTools ${method} failed`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await send(method, params, timeoutMs);
    } catch (error) {
      last = error;
      console.log(`devtools retry ${attempt + 1} after ${error.message}`);
      try {
        await reconnectDevtools();
      } catch (reconnectError) {
        console.log(`devtools reconnect failed: ${reconnectError.message}`);
        await delay(800);
      }
    }
  }
  throw last;
}

await openPage();
await sendRetry("Runtime.enable");
await sendRetry("Console.enable").catch(() => {});

let snapshot;
for (let attempt = 0; attempt < 15; attempt += 1) {
  snapshot = await send("Runtime.evaluate", {
    expression: `(() => {
      const show = view => {
        document.querySelectorAll(".view").forEach(element => element.classList.remove("active"));
        document.getElementById(view + "View")?.classList.add("active");
      };
      show("guide");
      const guide = document.querySelectorAll("#guideResults .card").length;
      show("legendary");
      const legendary = document.querySelectorAll("#legendaryResults .card").length;
      show("animals");
      const animals = document.querySelectorAll("#animalResults .card").length;
      show("secrets");
      const secrets = document.querySelectorAll("#secretResults .card").length;
      show("hidden");
      const hiddenMap = document.getElementById("hiddenMap");
      if (hiddenMap && hiddenMap.frontierZoomTo) hiddenMap.frontierZoomTo(4, 50, 45);
      const hidden = document.querySelectorAll("#hiddenList .card").length;
      const hiddenMarkers = document.querySelectorAll("#hiddenMarkers .map-marker").length;
      show("map");
      const map = document.getElementById("fieldMap");
      if (map && map.frontierZoomTo) map.frontierZoomTo(4, 50, 45);
      const markers = document.querySelectorAll("#mapMarkers .map-marker").length;
      const legendaryMarkers = document.querySelectorAll("#mapMarkers .map-marker.legendary").length;
      const secretMarkers = document.querySelectorAll("#mapMarkers .map-marker.secret").length;
      const svg = document.querySelectorAll("#fieldMap .leaflet-image-layer").length;
      if (map && map.frontierZoomTo) map.frontierZoomTo(1, 50, 50);
      if (hiddenMap && hiddenMap.frontierZoomTo) hiddenMap.frontierZoomTo(1, 50, 50);
      return {
        title: document.title,
        href: location.href,
        guide, legendary, animals, secrets, hidden, hiddenMarkers,
        markers, legendaryMarkers, secretMarkers, svg,
        bridge: typeof AndroidBridge
      };
    })()`,
    returnByValue: true
  });
  const counts = snapshot?.result?.value;
  if (counts && counts.legendary >= 16 && counts.guide >= 10 && counts.svg >= 1 && counts.markers >= 40) break;
  await delay(1000);
}

const value = snapshot?.result?.value;
if (!value) throw new Error(`WebView evaluation failed: ${JSON.stringify(snapshot)}`);
console.log(JSON.stringify(value, null, 2));

const problems = [];
if (!String(value.title).includes("Frontier Guide")) problems.push(`unexpected title ${value.title}`);
if (!String(value.href).includes("appassets.androidplatform.net")) problems.push(`unexpected url ${value.href}`);
if (value.guide < 10) problems.push(`guide cards ${value.guide}`);
if (value.legendary < 16) problems.push(`legendary cards ${value.legendary}`);
if (value.animals < 100) problems.push(`animal cards ${value.animals}`);
if (value.secrets < 20) problems.push(`secret cards ${value.secrets}`);
if (value.hidden < 15) problems.push(`hidden cards ${value.hidden}`);
if (value.hiddenMarkers < 15) problems.push(`hidden markers ${value.hiddenMarkers}`);
if (value.markers < 40) problems.push(`map markers ${value.markers}`);
if (value.legendaryMarkers < 16) problems.push(`legendary markers ${value.legendaryMarkers}`);
if (value.secretMarkers < 20) problems.push(`secret markers ${value.secretMarkers}`);
if (value.svg < 1) problems.push("parchment map art missing");
if (value.bridge !== "object") problems.push(`Android bridge ${value.bridge}`);
if (consoleErrors.length) problems.push(`console errors: ${consoleErrors.join(" | ")}`);

mkdirSync("emulator-screenshots", { recursive: true });
function shot(name) {
  const result = spawnSync("adb", ["exec-out", "screencap", "-p"], { encoding: "buffer", maxBuffer: 12 * 1024 * 1024 });
  if (result.status !== 0 || !result.stdout?.length || result.stdout[0] !== 0x89) {
    problems.push(`screenshot ${name} failed`);
    return;
  }
  writeFileSync(`emulator-screenshots/${name}.png`, result.stdout);
}
async function show(view) {
  await sendRetry("Runtime.evaluate", {
    expression: `(() => {
      const view = ${JSON.stringify(view)};
      if (typeof setView === "function") {
        setView(view);
        return "ok";
      }
      const panel = document.getElementById(view + "View");
      document.querySelectorAll(".view").forEach(element => element.classList.remove("active"));
      panel?.classList.add("active");
      panel?.scrollIntoView({ block: "start", behavior: "auto" });
      return "ok";
    })()`,
    returnByValue: true
  });
  await delay(700);
  shot(view);
}
for (const view of ["ask", "voice", "guide", "legendary", "animals", "secrets", "hidden", "map", "updates", "settings", "coach"]) {
  await show(view);
}

const progressText = await send("Runtime.evaluate", {
  expression: `(() => {
    localStorage.removeItem("fg_steam_progress");
    localStorage.removeItem("fg_steam_id");
    localStorage.setItem("fg_server_mode", "auto");
    if (typeof setView === "function") setView("progress");
    const text = document.getElementById("progressView")?.innerText || "";
    const homeActive = document.getElementById("homeView")?.classList.contains("active");
    return JSON.stringify({ text, homeActive });
  })()`,
  returnByValue: true
});
let progressBody = "";
try {
  const parsed = JSON.parse(progressText?.result?.value || "{}");
  progressBody = parsed.text || "";
  if (parsed.homeActive) problems.push("progress opened on top of the home list");
} catch {
  progressBody = String(progressText?.result?.value || "");
}
console.log("progress", progressBody.slice(0, 240));
if (!progressBody.includes("Connect Steam") || /42\.5|Back in the Mud/.test(progressBody)) {
  problems.push(`progress screen did not show the empty state: ${progressBody.slice(0, 180)}`);
}
await delay(400);
shot("progress-empty-1.7.4");

await send("Page.enable").catch(() => {});
async function mapShot(name, elementId, scale, x, y, detailName) {
  const detail = await sendRetry("Runtime.evaluate", {
    expression: `(async () => {
      const view = ${JSON.stringify(elementId === "hiddenMap" ? "hidden" : "map")};
      if (typeof setView === "function") setView(view);
      const map = document.getElementById(${JSON.stringify(elementId)});
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      map?.frontierReflow?.();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const started = Date.now();
      while (map && map._vectorsReady !== true && Date.now() - started < 8000) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (map && map.frontierZoomTo) map.frontierZoomTo(${scale}, ${x}, ${y});
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rect = map?.getBoundingClientRect();
      return JSON.stringify({ detail: map?.dataset.detail || "missing", zoom: map?.frontierMap?.getZoom(), width: rect?.width || 0, height: rect?.height || 0, vectors: map?._vectors?.getLayers?.().length || 0 });
    })()`,
    awaitPromise: true,
    returnByValue: true
  });
  let reported = "";
  let parsed = {};
  try {
    parsed = JSON.parse(detail?.result?.value || "{}");
    reported = parsed.detail || "";
  } catch {
    reported = String(detail?.result?.value || "");
  }
  console.log(name, JSON.stringify(parsed));
  if (reported !== detailName) problems.push(`${name} detail ${reported}`);
  if (elementId === "fieldMap" && !(parsed.vectors > 20)) problems.push(`${name} vectors ${parsed.vectors}`);
  await delay(900);
  shot(name);
  return parsed;
}
await mapShot("map-full-1.7.4", "fieldMap", 1, 50, 50, "far");
await mapShot("map-mid-1.7.4", "fieldMap", 2.5, 70, 55, "mid");
await mapShot("map-close-1.7.4", "fieldMap", 4.2, 72, 46, "close");
async function maxShot(name, lat, lng) {
  const detail = await sendRetry("Runtime.evaluate", {
    expression: `(async () => {
      if (typeof setView === "function") setView("map");
      window.frontierShowAccuracy?.(false);
      const detail = document.getElementById("mapDetail");
      detail?.classList.remove("is-open");
      const layers = document.querySelector("#mapView .map-sheet");
      if (layers) layers.hidden = true;
      const map = document.getElementById("fieldMap");
      const started = Date.now();
      while (map && map._vectorsReady !== true && Date.now() - started < 8000) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      map?.frontierMap?.setView([${lat}, ${lng}], map.frontierMap.getMaxZoom(), { animate: false });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return JSON.stringify({
        zoom: map?.frontierMap?.getZoom(),
        max: map?.frontierMap?.getMaxZoom(),
        detail: map?.dataset.detail || "",
        vectors: map?._vectors?.getLayers?.().length || 0,
        card: Boolean(detail?.classList.contains("is-open")),
        accuracy: Boolean(map?._accuracyOn)
      });
    })()`,
    awaitPromise: true,
    returnByValue: true
  });
  let parsed = {};
  try { parsed = JSON.parse(detail?.result?.value || "{}"); } catch { parsed = {}; }
  console.log(name, JSON.stringify(parsed));
  if (!(parsed.zoom >= 6.5) || parsed.detail !== "close" || !(parsed.vectors > 20) || parsed.card || parsed.accuracy) {
    problems.push(`${name} ${JSON.stringify(parsed)}`);
  }
  await delay(900);
  shot(name);
}
await maxShot("map-max-valentine-1.7.4", -53.602, 108.3971);
await maxShot("map-max-saintdenis-1.7.4", -86.3787, 152.6896);
await maxShot("map-max-blackwater-1.7.4", -82.9581, 99.7447);

const layoutReport = await send("Runtime.evaluate", {
  expression: `(() => {
    const map = document.getElementById("fieldMap");
    const nav = document.querySelector(".bottom-nav");
    const navRect = nav.getBoundingClientRect();
    const tops = [...nav.querySelectorAll("button")].map(button => button.getBoundingClientRect().top);
    const zoomOut = document.querySelector("#mapView .map-zoom-out")?.getBoundingClientRect();
    const recenter = document.querySelector("#mapView .map-recenter")?.getBoundingClientRect();
    const image = map?.querySelector(".leaflet-image-layer")?.getBoundingClientRect();
    const mapRect = map?.getBoundingClientRect();
    const audit = window.auditMapLabels?.("fieldMap") || { overlaps: ["missing"], clipped: ["missing"] };
    const covers = Boolean(image && mapRect && image.left <= mapRect.left + 2 && image.right >= mapRect.right - 2 && image.top <= mapRect.top + 2 && image.bottom >= mapRect.bottom - 2);
    return JSON.stringify({
      tops, navHeight: navRect.height, navTop: navRect.top,
      zoomOutBottom: zoomOut?.bottom, recenterBottom: recenter?.bottom,
      covers, audit, buttons: nav.querySelectorAll("button").length
    });
  })()`,
  returnByValue: true
});
let layout = {};
try { layout = JSON.parse(layoutReport?.result?.value || "{}"); } catch { layout = {}; }
console.log("layout", JSON.stringify(layout));
const topSpread = layout.tops?.length ? Math.max(...layout.tops) - Math.min(...layout.tops) : 99;
if (layout.buttons !== 6 || topSpread > 8 || !(layout.navHeight < 90)) problems.push(`nav is not one row: ${JSON.stringify(layout.tops)} h=${layout.navHeight}`);
if (!layout.covers) problems.push("parchment does not cover the map viewport");
if (layout.audit?.clipped?.length || layout.audit?.overlaps?.length) problems.push(`close labels ${JSON.stringify(layout.audit)}`);
if (!(layout.zoomOutBottom <= layout.navTop + 1) || !(layout.recenterBottom <= layout.navTop + 1)) {
  problems.push(`map controls overlap the nav: ${JSON.stringify(layout)}`);
}

await send("Runtime.evaluate", {
  expression: `(() => { document.querySelector("#mapView .map-layers-toggle")?.click(); return "layers"; })()`,
  returnByValue: true
});
await delay(500);
const layersReport = await send("Runtime.evaluate", {
  expression: `(() => {
    const row = document.querySelector("#mapTags .layer-all");
    const names = [...document.querySelectorAll("#mapTags .layer-name")].map(node => node.textContent);
    return JSON.stringify({
      name: row?.querySelector(".layer-name")?.textContent || "",
      count: row?.querySelector(".layer-count")?.textContent || "",
      pressed: row?.getAttribute("aria-pressed") || "",
      names
    });
  })()`,
  returnByValue: true
});
let layersLayout = {};
try { layersLayout = JSON.parse(layersReport?.result?.value || "{}"); } catch { layersLayout = {}; }
console.log("layers", JSON.stringify(layersLayout));
if (layersLayout.name !== "All" || layersLayout.pressed !== "true" || !(Number(layersLayout.count) > 0) || (layersLayout.names || []).includes("None")) {
  problems.push(`layers sheet ${JSON.stringify(layersLayout)}`);
}
shot("layers-sheet-1.7.4");
await send("Runtime.evaluate", {
  expression: `(() => { document.querySelector("#mapView .map-layers-toggle")?.click(); return "layers-closed"; })()`,
  returnByValue: true
});

async function openMarker(id) {
  const report = await send("Runtime.evaluate", {
    expression: `(() => {
      if (typeof setView === "function") setView("map");
      const sheet = document.querySelector("#mapView .map-sheet");
      if (sheet) sheet.hidden = true;
      const item = (state.mapLocations || []).find(row => row.id === ${JSON.stringify(id)});
      if (!item || typeof showMapDetail !== "function") return JSON.stringify({ error: "missing" });
      const node = document.getElementById("fieldMap");
      const map = node?.frontierMap;
      if (map && Number.isFinite(item.lat)) {
        map.setView([item.lat, item.lng], Math.min(map.getMaxZoom(), (node._fitZoom || 1) + 1.6), { animate: false });
      }
      showMapDetail(item);
      const detail = document.getElementById("mapDetail");
      const card = detail?.getBoundingClientRect();
      const nav = document.querySelector(".bottom-nav")?.getBoundingClientRect();
      return JSON.stringify({
        open: Boolean(detail?.classList.contains("is-open")),
        text: detail?.innerText || "",
        title: item.title,
        sourceCollapsed: Boolean(detail?.querySelector(".map-source")) && !detail.querySelector(".map-source")?.open,
        cardBottom: card?.bottom, navTop: nav?.top, cardHeight: card?.height
      });
    })()`,
    returnByValue: true
  });
  let parsed = {};
  try { parsed = JSON.parse(report?.result?.value || "{}"); } catch { parsed = { error: "parse" }; }
  console.log("card", id, JSON.stringify({ ...parsed, text: String(parsed.text || "").slice(0, 280) }));
  return parsed;
}
const bullCard = await openMarker("leg-bull-gator");
if (!bullCard.open || !(bullCard.cardBottom <= bullCard.navTop + 2) || !(bullCard.cardHeight > 40)) {
  problems.push(`marker card is not above the nav: ${JSON.stringify(bullCard)}`);
}
if (!/Bayou Nwa,\s*Lemoyne/.test(bullCard.text || "") || /RDOMap|Story mode/.test(bullCard.text || "") || !/Lakay/.test(bullCard.text || "")) {
  problems.push(`bull gator card copy: ${String(bullCard.text || "").slice(0, 240)}`);
}
if (!bullCard.sourceCollapsed) problems.push("source link is not inside a collapsed Source section");
await delay(400);
shot("map-card-bullgator-1.7.4");
const arabianCard = await openMarker("horse-white-arabian");
if (!/Lake Isabella/.test(arabianCard.text || "") || /RDOMap|Published White Arabian marker/.test(arabianCard.text || "")) {
  problems.push(`white arabian card copy: ${String(arabianCard.text || "").slice(0, 240)}`);
}
await delay(400);
shot("map-card-whitearabian-1.7.4");
const gunsmithCard = await openMarker("gunsmith-valentine");
if (!/Valentine,\s*New Hanover/.test(gunsmithCard.text || "") || /Published shop coordinate/.test(gunsmithCard.text || "") || !/ammunition/i.test(gunsmithCard.text || "")) {
  problems.push(`gunsmith card copy: ${String(gunsmithCard.text || "").slice(0, 240)}`);
}
await delay(400);
shot("map-card-gunsmith-1.7.4");

spawnSync("adb", ["shell", "settings", "put", "system", "accelerometer_rotation", "0"]);
spawnSync("adb", ["shell", "settings", "put", "system", "user_rotation", "1"]);
await delay(1200);
const landscape = await send("Runtime.evaluate", {
  expression: `(async () => {
    if (typeof setView === "function") setView("map");
    const map = document.getElementById("fieldMap");
    map?.frontierReflow?.();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    map?.frontierZoomTo?.(2.5, 74, 58);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const marker = document.querySelector("#mapMarkers .map-marker, #mapMarkers .map-cluster, #mapMarkers .map-dot");
    marker?.click();
    await new Promise(resolve => requestAnimationFrame(resolve));
    const card = document.getElementById("mapDetail")?.getBoundingClientRect();
    const nav = document.querySelector(".bottom-nav")?.getBoundingClientRect();
    const tops = [...document.querySelectorAll(".bottom-nav button")].map(button => button.getBoundingClientRect().top);
    return JSON.stringify({ open: document.getElementById("mapDetail")?.classList.contains("is-open"), cardBottom: card?.bottom, navTop: nav?.top, cardHeight: card?.height, tops, navHeight: nav?.height });
  })()`,
  awaitPromise: true,
  returnByValue: true
});
let landscapeLayout = {};
try { landscapeLayout = JSON.parse(landscape?.result?.value || "{}"); } catch { landscapeLayout = {}; }
console.log("landscape", JSON.stringify(landscapeLayout));
const landscapeSpread = landscapeLayout.tops?.length ? Math.max(...landscapeLayout.tops) - Math.min(...landscapeLayout.tops) : 99;
if (!landscapeLayout.open || !(landscapeLayout.cardBottom <= landscapeLayout.navTop + 2)) {
  problems.push(`landscape card is behind the nav: ${JSON.stringify(landscapeLayout)}`);
}
if (landscapeSpread > 8) problems.push(`landscape nav wrapped: ${JSON.stringify(landscapeLayout.tops)}`);
await delay(700);
shot("map-landscape-card-1.7.4");
spawnSync("adb", ["shell", "settings", "put", "system", "user_rotation", "0"]);
await delay(800);

await show("hidden");
shot("hidden-1.7.4");
await show("home");
shot("home-1.7.4");
const homeReport = await send("Runtime.evaluate", {
  expression: `(() => {
    const home = document.getElementById("homeView");
    const progress = document.getElementById("progressView");
    return JSON.stringify({
      home: Boolean(home?.classList.contains("active")),
      progress: Boolean(progress?.classList.contains("active")),
      grid: Boolean(home?.querySelector(".quick-grid"))
    });
  })()`,
  returnByValue: true
});
let homeLayout = {};
try { homeLayout = JSON.parse(homeReport?.result?.value || "{}"); } catch { homeLayout = {}; }
if (!homeLayout.home || homeLayout.progress || !homeLayout.grid) problems.push(`home screen ${JSON.stringify(homeLayout)}`);

await show("settings");
const pillReport = await send("Runtime.evaluate", {
  expression: `(() => document.getElementById("onlineDot")?.innerText || "")()`,
  returnByValue: true
});
const pill = String(pillReport?.result?.value || "");
console.log("pill", pill);
if (/Offline only|Server needs API key/i.test(pill)) problems.push(`status pill ${pill}`);
const steamCopy = await send("Runtime.evaluate", {
  expression: `(() => document.getElementById("steamCard")?.innerText || "")()`,
  returnByValue: true
});
if (!String(steamCopy?.result?.value || "").includes("Connect Steam")) problems.push("settings steam card missing");

const places = [
  ["white-arabian", "horse-white-arabian", -37.6706, 82.2251],
  ["jack-hall", "treasure-jack-hall", -40.8291, 136.8836],
  ["bull-gator", "leg-bull-gator", -75.6282, 144.9287],
  ["valentine", "gunsmith-valentine", -51.509, 106.9164],
  ["saint-denis", "gunsmith-saint-denis", -83.5753, 153.4529],
  ["blackwater", "horse-rose-grey-arabian", -82.9581, 99.7447],
  ["rhodes", "gunsmith-rhodes", -84.1323, 131.8113],
  ["strawberry", "", -70.03, 84.3196],
  ["armadillo", "", -104.3897, 53.4547],
  ["tumbleweed", "gunsmith-tumbleweed", -109.3272, 26.8317]
];
for (const [name, id, lat, lng] of places) {
  const frame = await sendRetry("Runtime.evaluate", {
    expression: `(() => {
      if (typeof setView === "function") setView("map");
      window.frontierShowAccuracy?.(false);
      const detail = document.getElementById("mapDetail");
      detail?.classList.remove("is-open");
      const layers = document.querySelector("#mapView .map-sheet");
      if (layers) layers.hidden = true;
      const item = ${JSON.stringify(id)} ? (state.mapLocations || []).find(row => row.id === ${JSON.stringify(id)}) : null;
      state.selectedMapId = item ? item.id : null;
      if (typeof renderMap === "function") renderMap();
      const node = document.getElementById("fieldMap");
      const map = node?.frontierMap;
      const point = item && Number.isFinite(item.lat) ? [item.lat, item.lng] : [${lat}, ${lng}];
      map?.setView(point, Math.min(map.getMaxZoom(), (node?._fitZoom || 1) + 2.2), { animate: false });
      detail?.classList.remove("is-open");
      const labels = [...(node?.querySelectorAll(".map-label") || [])].map(node => node.textContent);
      return JSON.stringify({
        title: item?.title || "town-label",
        card: Boolean(detail?.classList.contains("is-open")),
        accuracy: Boolean(node?._accuracyOn),
        labels
      });
    })()`,
    returnByValue: true
  });
  let frameReport = {};
  try { frameReport = JSON.parse(frame?.result?.value || "{}"); } catch { frameReport = {}; }
  console.log("accuracy", name, JSON.stringify(frameReport));
  if (frameReport.card || frameReport.accuracy) problems.push(`accuracy frame ${name} still covered: ${JSON.stringify(frameReport)}`);
  if (id && frameReport.title === "town-label") problems.push(`accuracy frame ${name} missed its marker`);
  await delay(900);
  shot(`accuracy-part-${name}`);
}
await sendRetry("Runtime.evaluate", {
  expression: `(() => { window.frontierShowAccuracy?.(false); if (typeof setView === "function") setView("map"); const detail = document.getElementById("mapDetail"); detail?.classList.remove("is-open"); return "map-ready"; })()`,
  returnByValue: true
});

const gestureStart = await sendRetry("Runtime.evaluate", {
  expression: `(async () => {
    if (typeof setView === "function") setView("map");
    const node = document.getElementById("fieldMap");
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    node?.frontierReflow?.();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const map = node?.frontierMap;
    if (!map) return JSON.stringify({ error: "no map" });
    document.getElementById("mapDetail")?._closeSheet?.();
    document.getElementById("mapDetail")?.classList.remove("is-open");
    const layers = document.querySelector("#mapView .map-sheet");
    if (layers) layers.hidden = true;
    map.touchZoom?.enable?.();
    const zoom = map.getMinZoom() + 1;
    map.setView([-72, 88], zoom, { animate: false });
    const rect = map.getContainer().getBoundingClientRect();
    const center = map.getCenter();
    return JSON.stringify({ left: rect.left, top: rect.top, width: rect.width, height: rect.height, zoom: map.getZoom(), lat: center.lat, lng: center.lng, touch: Boolean(map.touchZoom?.enabled?.()) });
  })()`,
  awaitPromise: true,
  returnByValue: true
}, 45000);
let gestureReport = {};
try { gestureReport = JSON.parse(gestureStart?.result?.value || "{}"); } catch { gestureReport = { error: "parse" }; }
if (!gestureReport.error && gestureReport.width) {
  const x = gestureReport.left + 36;
  const y = gestureReport.top + 36;
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
  await delay(50);
  await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + 120, y: y + 24, id: 1 }] });
  await delay(50);
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await delay(200);
  const cx = gestureReport.left + gestureReport.width / 2;
  const cy = gestureReport.top + gestureReport.height / 2;
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx - 28, y: cy, id: 1 }, { x: cx + 28, y: cy, id: 2 }] });
  await delay(40);
  await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: cx - 70, y: cy, id: 1 }, { x: cx + 70, y: cy, id: 2 }] });
  await delay(40);
  await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: cx - 120, y: cy, id: 1 }, { x: cx + 120, y: cy, id: 2 }] });
  await delay(40);
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await delay(200);
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: cy, id: 1 }] });
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await delay(40);
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: cy, id: 1 }] });
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await delay(250);
  const gestureEnd = await sendRetry("Runtime.evaluate", {
    expression: `(() => {
      const map = document.getElementById("fieldMap").frontierMap;
      const center = map.getCenter();
      return JSON.stringify({ zoom: map.getZoom(), lat: center.lat, lng: center.lng });
    })()`,
    returnByValue: true
  });
  const end = JSON.parse(gestureEnd?.result?.value || "{}");
  gestureReport.pinched = end.zoom;
  gestureReport.pan = Math.hypot(end.lng - gestureReport.lng, end.lat - gestureReport.lat);
  gestureReport.endZoom = end.zoom;
}
console.log("gesture", JSON.stringify(gestureReport));
if (!(gestureReport.pan > 0.2)) problems.push(`pan ${JSON.stringify(gestureReport)}`);
if (!(gestureReport.pinched > gestureReport.zoom)) problems.push(`pinch zoom ${JSON.stringify(gestureReport)}`);

const health = await sendRetry("Runtime.evaluate", {
  expression: `fetch("https://frontier-guide-api.onrender.com/api/health", { cache: "no-store" }).then(async response => JSON.stringify({ status: response.status, body: await response.json() })).catch(error => JSON.stringify({ error: String(error) }))`,
  awaitPromise: true,
  returnByValue: true
}, 90000);
let healthReport = {};
try { healthReport = JSON.parse(health?.result?.value || "{}"); } catch { healthReport = { raw: health?.result?.value }; }
console.log("health", JSON.stringify(healthReport));
if (healthReport.body?.authorized !== true) problems.push(`production health was not authorized: ${JSON.stringify(healthReport)}`);

await reconnectDevtools();
await show("ask");
await sendRetry("Runtime.evaluate", {
  expression: `(() => { document.getElementById("question").value = "Where is the White Arabian? One sentence."; document.getElementById("askForm").requestSubmit(); return "sent"; })()`,
  returnByValue: true
}, 45000);
let liveAnswer = "";
for (let attempt = 0; attempt < 24; attempt += 1) {
  await delay(3000);
  const current = await sendRetry("Runtime.evaluate", {
    expression: `(() => { const nodes = [...document.querySelectorAll("#chat .message.assistant p")]; return nodes.at(-1)?.innerText || ""; })()`,
    returnByValue: true
  }, 45000);
  liveAnswer = current?.result?.value || "";
  if (liveAnswer && !liveAnswer.startsWith("Thinking")) break;
}
shot("ask-answer");
console.log("answer", liveAnswer.slice(0, 400));
if (liveAnswer.startsWith("Live guide:") || !/isabella|arabian/i.test(liveAnswer)) {
  problems.push(`production answer did not mention the White Arabian: ${liveAnswer.slice(0, 240)}`);
}

const log = adbOk("logcat", "-d", "-t", "400").out;
if (/renderer gone|FATAL EXCEPTION|Render process \(/i.test(log)) {
  problems.push("logcat reports a WebView renderer crash");
}
if (/FrontierGuide: console ERROR/.test(log)) {
  problems.push("logcat reports a JavaScript console error");
}
const alive = adbOk("shell", "pidof", "com.frontierguide.app").out.trim();
if (!alive) problems.push("Frontier Guide process is not running");

ws.close();
if (problems.length) {
  console.error(problems.join("\n"));
  console.error(log.slice(-4000));
  process.exit(1);
}
console.log("Emulator smoke passed");
