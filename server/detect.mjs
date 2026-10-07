export function normalizeSightingText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function includesPhrase(text, phrase) {
  if (!phrase) return false;
  return ` ${text} `.includes(` ${phrase} `);
}

export function matchSightings(text, places) {
  const normalized = normalizeSightingText(text);
  const marks = [];
  const seen = new Set();
  for (const place of places) {
    const title = normalizeSightingText(place.title);
    if (title.length < 8 || !includesPhrase(normalized, title)) continue;
    if (seen.has(place.id)) continue;
    seen.add(place.id);
    marks.push({ id: place.id, title: place.title });
  }
  const prompts = [];
  const markedGold = marks.some(item => normalizeSightingText(item.title).includes("gold"));
  if (!markedGold && includesPhrase(normalized, "gold bar")) {
    const candidates = places.filter(place => place.category === "Gold").slice(0, 8);
    if (candidates.length) {
      prompts.push({
        kind: "gold-bar",
        label: "Gold Bar",
        candidates: candidates.map(place => ({ id: place.id, title: place.title }))
      });
    }
  }
  const markedLegendary = marks.some(item => normalizeSightingText(item.title).includes("legendary"));
  if (!markedLegendary && includesPhrase(normalized, "legendary pelt")) {
    const candidates = places.filter(place => place.category === "Legendary").slice(0, 8);
    if (candidates.length) {
      prompts.push({
        kind: "legendary-pelt",
        label: "Legendary pelt",
        candidates: candidates.map(place => ({ id: place.id, title: place.title }))
      });
    }
  }
  if (includesPhrase(normalized, "challenge complete")) {
    prompts.push({ kind: "challenge", label: "Challenge complete", candidates: [] });
  }
  return { marks, prompts };
}
