(function (root) {
  function parseSseBlock(block) {
    if (!block || !String(block).trim()) return null;
    const data = [];
    let eventName = "message";
    for (const line of String(block).split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") data.push(value);
      else if (field === "event") eventName = value;
    }
    if (!data.length) return null;
    return { event: eventName, data: data.join("\n") };
  }

  function parseSseBuffer(input, flush) {
    let text = String(input ?? "");
    let held = "";
    if (!flush && text.endsWith("\r")) {
      held = "\r";
      text = text.slice(0, -1);
    }
    text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const segments = text.split("\n\n");
    const rest = flush ? "" : `${segments.pop() ?? ""}${held}`;
    const events = [];
    for (const block of segments) {
      const event = parseSseBlock(block);
      if (event) events.push(event);
    }
    return { events, rest };
  }

  function createVoiceSession() {
    let voiceGen = 0;
    let capture = 0;
    let handsFree = false;
    let listening = false;
    let timer = 0;

    return {
      get listening() { return listening; },
      get handsFree() { return handsFree; },
      setHandsFree(value) { handsFree = Boolean(value); },
      begin() {
        if (listening) return 0;
        clearTimeout(timer);
        timer = 0;
        voiceGen += 1;
        capture = voiceGen;
        listening = true;
        return capture;
      },
      stop() {
        voiceGen += 1;
        capture = 0;
        handsFree = false;
        listening = false;
        clearTimeout(timer);
        timer = 0;
      },
      acceptResult(gen) {
        const token = Number(gen);
        if (!token || token !== voiceGen || token !== capture) return false;
        capture = 0;
        listening = false;
        return true;
      },
      queueRestart(delay, start) {
        clearTimeout(timer);
        const gen = voiceGen;
        timer = setTimeout(() => {
          timer = 0;
          if (gen !== voiceGen || !handsFree || listening) return;
          start();
        }, delay);
      }
    };
  }

  function createAskGate() {
    let generation = 0;
    let busy = false;
    let controller = null;
    return {
      get busy() { return busy; },
      begin() {
        if (busy) return null;
        busy = true;
        generation += 1;
        controller = typeof AbortController === "undefined" ? null : new AbortController();
        return { token: generation, signal: controller ? controller.signal : undefined };
      },
      matches(token) { return Boolean(token) && token === generation; },
      abort() {
        generation += 1;
        busy = false;
        try { controller?.abort(); } catch { /* already settled */ }
        controller = null;
      },
      finish(token) {
        if (token !== generation) return false;
        busy = false;
        controller = null;
        return true;
      }
    };
  }

  function createSpeechGate() {
    let generation = 0;
    let active = 0;
    let controller = null;
    return {
      invalidate() {
        generation += 1;
        active = 0;
        try { controller?.abort(); } catch { /* already settled */ }
        controller = null;
      },
      begin() {
        this.invalidate();
        active = generation;
        controller = typeof AbortController === "undefined" ? null : new AbortController();
        return { token: active, signal: controller ? controller.signal : undefined };
      },
      current(token) { return Boolean(token) && token === active; }
    };
  }

  function attachmentOutcome(requestId, currentId, succeeded) {
    if (!succeeded) return "keep";
    return requestId === currentId ? "clear" : "keep";
  }

  const api = { parseSseBuffer, createVoiceSession, createAskGate, createSpeechGate, attachmentOutcome };
  root.FrontierSession = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
