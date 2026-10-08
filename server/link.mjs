import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function token() {
  return randomBytes(24).toString("base64url");
}

function same(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function readRows(storePath) {
  try {
    const parsed = JSON.parse(readFileSync(storePath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function createLinkHub({ now = Date.now, ttlMs = 10 * 60 * 1000, maxSessions = 200, storePath = "" } = {}) {
  const sessions = new Map();
  if (storePath) {
    for (const item of readRows(storePath)) {
      if (!item?.phoneToken || !item.code || Number(item.expires) <= now()) continue;
      sessions.set(String(item.phoneToken), {
        code: String(item.code),
        phoneToken: String(item.phoneToken),
        helperToken: String(item.helperToken || ""),
        failedClaims: Number(item.failedClaims) || 0,
        expires: Number(item.expires),
        frame: null,
        events: Array.isArray(item.events) ? item.events.slice(-50) : []
      });
    }
  }

  function remember() {
    if (!storePath) return;
    mkdirSync(dirname(storePath), { recursive: true });
    const rows = [...sessions.values()].map(entry => ({
      code: entry.code,
      phoneToken: entry.phoneToken,
      helperToken: entry.helperToken,
      failedClaims: entry.failedClaims,
      expires: entry.expires,
      events: entry.events
    }));
    const temp = `${storePath}.tmp`;
    writeFileSync(temp, JSON.stringify(rows));
    renameSync(temp, storePath);
  }

  function prune() {
    let changed = false;
    for (const [key, entry] of sessions) {
      if (entry.expires <= now()) {
        sessions.delete(key);
        changed = true;
      }
    }
    while (sessions.size > maxSessions) {
      const oldest = sessions.keys().next().value;
      sessions.delete(oldest);
      changed = true;
    }
    if (changed) remember();
  }

  function byToken(value) {
    prune();
    for (const entry of sessions.values()) {
      if (same(entry.phoneToken, value) || (entry.helperToken && same(entry.helperToken, value))) return entry;
    }
    return null;
  }

  return {
    createPair() {
      prune();
      let code = "";
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const next = String(randomInt(0, 1_000_000)).padStart(6, "0");
        if (![...sessions.values()].some(entry => entry.code === next && entry.expires > now())) {
          code = next;
          break;
        }
      }
      if (!code) {
        const error = new Error("Could not issue a pairing code.");
        error.status = 503;
        throw error;
      }
      const phoneToken = token();
      const entry = {
        code,
        phoneToken,
        helperToken: "",
        failedClaims: 0,
        expires: now() + ttlMs,
        frame: null,
        events: []
      };
      sessions.set(phoneToken, entry);
      remember();
      return { code, token: phoneToken, expiresAt: new Date(entry.expires).toISOString() };
    },
    claim(code) {
      prune();
      const needle = String(code || "");
      const entry = [...sessions.values()].find(item => item.code === needle);
      if (!entry || entry.helperToken) {
        if (entry) {
          entry.failedClaims += 1;
          if (entry.failedClaims > 8) sessions.delete(entry.phoneToken);
          remember();
        }
        return null;
      }
      entry.helperToken = token();
      entry.expires = now() + ttlMs;
      remember();
      return { token: entry.helperToken, expiresAt: new Date(entry.expires).toISOString() };
    },
    status(value) {
      const entry = byToken(value);
      if (!entry) return null;
      return { paired: Boolean(entry.helperToken), code: entry.code, expiresAt: new Date(entry.expires).toISOString() };
    },
    saveFrame(value, imageDataUrl, capturedAt) {
      const entry = byToken(value);
      if (!entry || !entry.helperToken) return false;
      entry.frame = {
        imageDataUrl: String(imageDataUrl || ""),
        capturedAt: capturedAt || new Date(now()).toISOString()
      };
      entry.expires = now() + ttlMs;
      remember();
      return true;
    },
    frame(value) {
      const entry = byToken(value);
      if (!entry?.frame) return null;
      return entry.frame;
    },
    addSightings(value, sightings) {
      const entry = byToken(value);
      if (!entry || !entry.helperToken) return null;
      const accepted = [];
      for (const item of sightings.slice(0, 20)) {
        const event = {
          seq: entry.events.length + 1,
          at: new Date(now()).toISOString(),
          ...item
        };
        entry.events.push(event);
        accepted.push(event);
      }
      if (entry.events.length > 50) entry.events.splice(0, entry.events.length - 50);
      entry.expires = now() + ttlMs;
      remember();
      return accepted;
    },
    events(value, since = 0) {
      const entry = byToken(value);
      if (!entry) return null;
      const cursor = Number(since) || 0;
      return {
        paired: Boolean(entry.helperToken),
        events: entry.events.filter(item => item.seq > cursor),
        next: entry.events.at(-1)?.seq || cursor
      };
    }
  };
}
