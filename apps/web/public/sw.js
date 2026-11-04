/* DropBeam service worker — minimal app-shell cache so the page loads on a
 * LAN with no internet once it has been opened at least once. We never cache
 * transfer payloads; the WebSocket handshake always goes to the network.
 *
 * Strategy:
 *   - Page navigations / HTML: network-first, cached copy only when offline.
 *     (Cache-first HTML breaks after a redeploy: the stale page points at
 *     hashed assets that no longer exist.)
 *   - /assets/* (content-hashed, immutable): cache-first.
 *   - Everything else same-origin: stale-while-revalidate.
 */

const VERSION = "dropbeam-v2";
const SHELL = ["/", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL).catch(() => {})),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function cacheIfOk(cache, req, resp) {
  if (resp && resp.ok && resp.type === "basic") cache.put(req, resp.clone());
  return resp;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/ws")) return;

  const isPage = req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html");

  if (isPage) {
    event.respondWith(
      caches.open(VERSION).then((cache) =>
        fetch(req)
          .then((resp) => {
            // Store every page under "/" — it's a single-page app.
            if (resp && resp.ok && resp.type === "basic") cache.put("/", resp.clone());
            return resp;
          })
          .catch(async () => (await cache.match("/")) || Response.error()),
      ),
    );
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.open(VERSION).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        return fetch(req).then((resp) => cacheIfOk(cache, req, resp));
      }),
    );
    return;
  }

  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req).then((resp) => cacheIfOk(cache, req, resp)).catch(() => cached);
      return cached || network;
    }),
  );
});
