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

await openPage();
try {
  await send("Runtime.enable");
} catch (error) {
  console.error("Runtime.enable failed once, retrying", error.message);
  dumpLogs();
  const previous = ws;
  ws = null;
  previous.close();
  await delay(1000);
  await openPage();
  await send("Runtime.enable");
}
await send("Console.enable").catch(() => {});

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
      const svg = document.querySelectorAll("#fieldMap svg").length;
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
  await send("Runtime.evaluate", {
    expression: `(() => {
      const panel = document.getElementById(${JSON.stringify(`${view}View`)});
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

await send("Page.enable").catch(() => {});
async function mapShot(name, elementId, scale, x, y, detailName) {
  const detail = await send("Runtime.evaluate", {
    expression: `(async () => {
      const panelId = ${JSON.stringify(elementId === "hiddenMap" ? "hiddenView" : "mapView")};
      document.querySelectorAll(".view").forEach(element => element.classList.remove("active"));
      document.getElementById(panelId)?.classList.add("active");
      const map = document.getElementById(${JSON.stringify(elementId)});
      map?.scrollIntoView({ block: "start", behavior: "auto" });
      if (map && map.frontierZoomTo) map.frontierZoomTo(${scale}, ${x}, ${y});
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const stage = map?.querySelector(".map-stage");
      return JSON.stringify({ detail: map?.dataset.detail || "missing", transform: stage?.style.transform || "" });
    })()`,
    awaitPromise: true,
    returnByValue: true
  });
  let reported = "";
  let transform = "";
  try {
    const parsed = JSON.parse(detail?.result?.value || "{}");
    reported = parsed.detail || "";
    transform = parsed.transform || "";
  } catch {
    reported = String(detail?.result?.value || "");
  }
  console.log(name, reported, transform);
  if (reported !== detailName) problems.push(`${name} detail ${reported}`);
  await delay(1600);
  const captured = await send("Page.captureScreenshot", { format: "png" }).catch(() => null);
  if (captured?.data) writeFileSync(`emulator-screenshots/${name}.png`, Buffer.from(captured.data, "base64"));
  else shot(name);
}
await mapShot("map-zoom-0", "fieldMap", 1, 50, 50, "far");
await mapShot("map-zoom-mid", "fieldMap", 2.5, 70, 55, "mid");
await mapShot("map-zoom-close", "fieldMap", 5.6, 84, 65, "close");
await mapShot("hidden-zoom-mid", "hiddenMap", 2.5, 55, 41, "mid");

const health = await send("Runtime.evaluate", {
  expression: `fetch("https://frontier-guide-api.onrender.com/api/health", { cache: "no-store" }).then(async response => JSON.stringify({ status: response.status, body: await response.json() })).catch(error => JSON.stringify({ error: String(error) }))`,
  awaitPromise: true,
  returnByValue: true
}, 90000);
let healthReport = {};
try { healthReport = JSON.parse(health?.result?.value || "{}"); } catch { healthReport = { raw: health?.result?.value }; }
console.log("health", JSON.stringify(healthReport));
if (healthReport.body?.authorized !== true) problems.push(`production health was not authorized: ${JSON.stringify(healthReport)}`);

await show("ask");
await send("Runtime.evaluate", {
  expression: `(() => { document.getElementById("question").value = "Where is the White Arabian? One sentence."; document.getElementById("askForm").requestSubmit(); return "sent"; })()`,
  returnByValue: true
});
let liveAnswer = "";
for (let attempt = 0; attempt < 24; attempt += 1) {
  await delay(3000);
  const current = await send("Runtime.evaluate", {
    expression: `(() => { const nodes = [...document.querySelectorAll("#chat .message.assistant p")]; return nodes.at(-1)?.innerText || ""; })()`,
    returnByValue: true
  });
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
