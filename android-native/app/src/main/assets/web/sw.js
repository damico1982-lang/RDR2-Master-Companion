const CACHE = "frontier-guide-v16";
const ASSETS = ["./","index.html","styles.css","app.js","frontier-session.js","frontier-map.svg","manifest.webmanifest","icon.svg","content/guide.json","content/map.json","content/legendaries.json","content/animals.json","content/secrets.json","content/hidden-places.json"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))));
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  if (url.origin === self.location.origin && url.pathname.startsWith("/api/")) return;

  event.respondWith(fetch(event.request).then(response => {
    if (response.ok && url.origin === self.location.origin) {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(event.request, copy)).catch(() => {});
    }
    return response;
  }).catch(async () => {
    const cached = await caches.match(event.request);
    if (cached) return cached;
    if (event.request.mode === "navigate") {
      const home = await caches.match("./");
      if (home) return home;
    }
    throw new Error("offline");
  }));
});
