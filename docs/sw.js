/*! Background Bouncer | Copyright (c) 2026 Jayden Yoon ZK | MIT License | https://github.com/JaydenYoonZK/background-bouncer */
/* Offline support. The shell is precached at install, same-origin requests
   are answered from cache and refreshed in the background, and cross-origin
   requests pass through untouched. The cache name carries the release version
   and old caches are dropped on activate. */

const VERSION = "?v=2.0.1";
const CACHE = "background-bouncer-" + VERSION;
const SHELL = [
  "./",
  "404.html",
  "notfound.js" + VERSION,
  "styles.css" + VERSION,
  "app.js" + VERSION,
  "cutout.js" + VERSION,
  "cutout-core.js" + VERSION,
  "assets/sample.jpg",
];

addEventListener("install", (event) => {
  // no-cache requests, so the versioned cache holds exactly the deployed
  // bytes rather than whatever the HTTP cache still had from before a deploy
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL.map((u) => new Request(u, { cache: "no-cache" })))).then(() => skipWaiting()));
});

addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      // Only drop this shell's own old versions. The model lives in its own
      // cache (bouncer-model-*) that cutout.js owns, so a version bump must not
      // wipe it and force a 40 MB re-download.
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("background-bouncer-") && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => clients.claim())
  );
});

addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  if (new URL(req.url).origin !== location.origin) return;
  // The model is cached by cutout.js in its own bucket; leave it alone here so
  // it is not stored a second time in the shell cache.
  if (new URL(req.url).pathname.includes("/models/")) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);

    // Pages go network-first: a fresh deploy reaches the very next load
    // instead of waiting a full visit behind a cached shell, and every
    // query-string variant collapses into the one precached copy instead of
    // filling the cache with duplicates. Offline still gets the shell, and an
    // offline deep link gets the not-found page rather than a silent home.
    if (req.mode === "navigate") {
      const scopePath = new URL("./", location.href).pathname;
      try {
        const res = await fetch(req);
        if (res && res.ok && new URL(req.url).pathname === scopePath) cache.put("./", res.clone());
        return res;
      } catch (error) {
        const isRoot = new URL(req.url).pathname === scopePath;
        const fallback = (!isRoot && await cache.match("404.html")) || await cache.match("./");
        if (fallback) return fallback;
        throw error;
      }
    }

    const cached = await cache.match(req);
    const network = fetch(req).then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    });
    if (cached) {
      network.catch(() => { /* offline refresh can wait */ });
      return cached;
    }
    return network;
  })());
});
