export const RDR2_APPID = 1174180;

const OPENID_NS = "http://specs.openid.net/auth/2.0";
const STEAM_LOGIN = "https://steamcommunity.com/openid/login";

export function steamApiConfigured(env = process.env) {
  return Boolean(String(env.STEAM_API_KEY || "").trim());
}

export function buildSteamLoginUrl({ realm, returnTo }) {
  const url = new URL(STEAM_LOGIN);
  url.searchParams.set("openid.ns", OPENID_NS);
  url.searchParams.set("openid.mode", "checkid_setup");
  url.searchParams.set("openid.return_to", returnTo);
  url.searchParams.set("openid.realm", realm);
  url.searchParams.set("openid.identity", `${OPENID_NS}/identifier_select`);
  url.searchParams.set("openid.claimed_id", `${OPENID_NS}/identifier_select`);
  return url.toString();
}

export function extractSteamId(claimedId) {
  const match = String(claimedId || "").match(/^https?:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/);
  return match ? match[1] : "";
}

export function steamProfileIsPrivate(status, body) {
  if (status === 401 || status === 403) return true;
  const stats = body?.playerstats;
  return Boolean(stats && stats.success === false);
}

export function steamStatsAreEmpty(body) {
  const stats = body?.playerstats;
  if (!stats || stats.success === false) return false;
  return !Array.isArray(stats.achievements) || stats.achievements.length === 0;
}

export function steamPersona(body) {
  const player = body?.response?.players?.[0];
  if (!player) return { personaName: "", avatar: "" };
  return {
    personaName: String(player.personaname || ""),
    avatar: String(player.avatarmedium || player.avatarfull || player.avatar || "")
  };
}

export async function verifySteamAssertion(params, fetchImpl = globalThis.fetch) {
  const claimedId = String(params["openid.claimed_id"] || "");
  const steamId = extractSteamId(claimedId);
  if (!steamId) return "";
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (!key.startsWith("openid.")) continue;
    body.set(key, Array.isArray(value) ? String(value[0] ?? "") : String(value ?? ""));
  }
  body.set("openid.mode", "check_authentication");
  const response = await fetchImpl(STEAM_LOGIN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/plain" },
    body
  });
  const text = await response.text();
  if (!response.ok || !/\bis_valid\s*:\s*true\b/i.test(text)) return "";
  return steamId;
}

export function mergeAchievementProgress(playerBody, schemaBody) {
  const stats = new Map((playerBody?.playerstats?.achievements || []).map(item => [item.apiname, item]));
  const schema = schemaBody?.game?.availableGameStats?.achievements || [];
  const achievements = schema.map(item => {
    const got = stats.get(item.name) || {};
    const unlocked = got.achieved === 1 || got.achieved === true;
    return {
      apiName: String(item.name || ""),
      name: String(item.displayName || item.name || "Achievement"),
      description: String(item.description || ""),
      icon: unlocked ? String(item.icon || "") : String(item.icongray || item.icon || ""),
      iconUnlocked: String(item.icon || ""),
      iconLocked: String(item.icongray || ""),
      unlocked,
      unlockTime: unlocked ? Number(got.unlocktime) || 0 : 0
    };
  });
  const total = achievements.length;
  const unlocked = achievements.filter(item => item.unlocked).length;
  return {
    appId: RDR2_APPID,
    unlocked,
    total,
    percent: total ? Math.round((unlocked / total) * 1000) / 10 : 0,
    achievements
  };
}

export function parsePlaytimeHours(ownedBody, appId = RDR2_APPID) {
  const games = ownedBody?.response?.games;
  if (!Array.isArray(games)) return null;
  const game = games.find(item => Number(item.appid) === Number(appId));
  if (!game) return null;
  const minutes = Number(game.playtime_forever);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  return Math.round((minutes / 60) * 10) / 10;
}

export function createSteamSessions({ now = Date.now, ttlMs = 10 * 60 * 1000 } = {}) {
  const pending = new Map();
  return {
    begin(nonce) {
      pending.set(nonce, { steamId: "", expires: now() + ttlMs });
    },
    complete(nonce, steamId) {
      const entry = pending.get(nonce);
      if (!entry || entry.expires <= now()) {
        pending.delete(nonce);
        return false;
      }
      entry.steamId = steamId;
      entry.expires = now() + ttlMs;
      return true;
    },
    read(nonce) {
      const entry = pending.get(nonce);
      if (!entry || entry.expires <= now()) {
        pending.delete(nonce);
        return { status: "expired" };
      }
      if (!entry.steamId) return { status: "pending" };
      return { status: "connected", steamId: entry.steamId };
    }
  };
}
