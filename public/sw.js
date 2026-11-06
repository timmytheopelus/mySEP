// App-shell cache for STATIC assets only. It never touches navigations (authenticated HTML), /api/*,
// non-GET requests or anything with credentials-bearing responses: those always go to the network.
const CACHE = "kep-shell-" + (new URL(self.location.href).searchParams.get("v") || "0");
const STATIC = [/^\/_next\/static\//, /^\/icons\//, /^\/manifest\.webmanifest$/];

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.mode === "navigate") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !STATIC.some((re) => re.test(url.pathname))) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && res.type === "basic" && !res.headers.has("set-cookie")) cache.put(req, res.clone());
      return res;
    }),
  );
});
