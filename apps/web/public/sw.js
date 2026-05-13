/* DropBeam service worker — minimal app-shell cache so the page loads on a
 * LAN with no internet once it has been opened at least once. We deliberately
 * never cache transfer payloads; the WebSocket handshake to the signaling
 * server must always go to the network. */

const VERSION = "dropbeam-v1";
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL).catch(() => {})),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Never intercept WebSocket / API / cross-origin requests.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/ws")) return;

  // Stale-while-revalidate for same-origin GETs.
  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(req);
      const networkFetch = fetch(req)
        .then((resp) => {
          if (resp && resp.ok && resp.type === "basic") cache.put(req, resp.clone());
          return resp;
        })
        .catch(() => cached);
      return cached || networkFetch;
    }),
  );
});
