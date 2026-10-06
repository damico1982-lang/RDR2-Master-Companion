import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CONTENT_DIR = new URL("./public/content/", import.meta.url);
const STOP = new Set("the and for you your with from that this what where when how are was were not but can all into over near about does just then them they its it's who whom whose which have has had will would should could may might than too also only some any out off our their there here get got one two per via".split(" "));

function readJson(root, name) {
  return JSON.parse(readFileSync(new URL(name, root), "utf8"));
}

export function loadFieldNotes(root = CONTENT_DIR) {
  return {
    guide: readJson(root, "guide.json"),
    legendaries: readJson(root, "legendaries.json"),
    animals: readJson(root, "animals.json"),
    secrets: readJson(root, "secrets.json"),
    hidden: readJson(root, "hidden-places.json")
  };
}

export function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word.length > 2 && !STOP.has(word));
}

function scoreText(text, questionWords, historyWords) {
  const haystack = text.toLowerCase();
  let score = 0;
  for (const word of questionWords) if (haystack.includes(word)) score += 2;
  for (const word of historyWords) if (haystack.includes(word)) score += 1;
  return score;
}

export function relevantNotes(notes = {}, { question = "", history = [], mode = "story" } = {}) {
  const questionWords = tokenize(question);
  const historyWords = tokenize(
    (Array.isArray(history) ? history : []).slice(-6).map(item => item?.content || "").join(" ")
  );
  const modeLine = mode === "online"
    ? "Selected mode: Red Dead Online. The bundled hunts, secrets, and hidden places are Story Mode. Say that before using one. Do not invent an Online copy."
    : mode === "either"
      ? "Selected mode: both. Keep Story Mode finds and Online roles separate."
      : "Selected mode: Story Mode. These notes are Story Mode. Gus and Harriet legendary-animal maps are Red Dead Online only.";

  const lines = [modeLine];
  const names = (notes.legendaries || []).map(item => item.name).filter(Boolean);
  if (names.length) lines.push(`Story Mode legendary animals on file: ${names.join(", ")}.`);

  const picked = [];
  const consider = (label, text) => {
    const score = scoreText(text, questionWords, historyWords);
    if (score > 0) picked.push({ score, label, text });
  };

  for (const item of notes.legendaries || []) {
    consider("Legendary", `${item.name}. ${item.region}. Landmark: ${item.landmark}. Conditions: ${item.conditions} Unlock: ${item.unlock} Weapon: ${item.weapon} ${item.ammo}. Reward: ${item.reward}`);
  }
  for (const item of notes.animals || []) {
    consider("Animal", `${item.name}. Size: ${item.size}${item.legendary ? ", legendary fish" : ""}. Where: ${item.where}. Regions: ${(item.regions || []).join(", ")}. Weapon: ${item.weapon}. Ammo or bait: ${item.bait || item.ammo}. ${item.note || ""}`);
  }
  for (const item of notes.secrets || []) {
    consider("Secret", `${item.name}. Confirmed: ${item.confirmed === false ? "no" : "yes"}. Where: ${item.where}. Requirements: ${item.requirements}. Reward: ${item.reward}. Uncertain: ${item.uncertain || "none"}. Steps: ${(item.steps || []).join(" ")}`);
  }
  for (const item of notes.hidden || []) {
    consider("Hidden", `${item.name}. Category: ${item.category}. ${item.region}. ${item.landmark}. How to enter: ${item.enter}. What's there: ${item.contents}`);
  }
  for (const item of notes.guide || []) {
    consider("Guide", `${item.title}. ${item.body}`);
  }

  picked.sort((left, right) => right.score - left.score);
  if (!picked.length) {
    lines.push("No bundled entry matched these words. If you answer anyway, say the bundled pages did not match and do not invent a pin, clock, or payout.");
  } else {
    lines.push("Matching bundled notes. Prefer these over memory. Repeat an unconfirmed or conflicting line instead of smoothing it over:");
    for (const item of picked.slice(0, 8)) lines.push(`- [${item.label}] ${item.text}`);
  }

  return lines.join("\n").slice(0, 8_000);
}
