/* GN Real Estate OS — service worker (IMPROVEMENTS B8).
 *
 * Scope, deliberately: INSTALLABLE + RESILIENT READS. The shell and the last
 * page you loaded still render on a dead signal, which is the Peyia car-park
 * case. WRITES are NOT queued — they need connectivity and fail honestly with a
 * retry. Offline slip signing was considered and rejected for now: it would put
 * commission evidence in a client-side queue, and that evidence chain is the one
 * thing in this product that must never be doubted.
 *
 * PRIVACY: this app holds KYC scans and client PII, and phones get shared and
 * lost. So:
 *   - only GET navigations and immutable build assets are ever cached;
 *   - nothing under /api/ is cached, ever;
 *   - EVERY cache is purged on sign-out (the app posts PURGE before logging
 *     out). Without that, the next person to open the browser could page
 *     through the previous user's screens offline.
 */

const VERSION = "v1";
const SHELL = `gnk-shell-${VERSION}`;
const PAGES = `gnk-pages-${VERSION}`;
const STATIC = `gnk-static-${VERSION}`;
const OFFLINE_URL = "/offline";

const PRECACHE = [OFFLINE_URL, "/icon-192.png", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      // One bad URL must not fail the whole install and leave the app with no
      // offline page at all, so each is added independently.
      .then((cache) => Promise.allSettled(PRECACHE.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

/** Sign-out purge. See the PRIVACY note above — this is not optional. */
self.addEventListener("message", (event) => {
  if (event.data?.type !== "PURGE") return;
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))),
  );
});

const isStaticAsset = (url) =>
  url.pathname.startsWith("/_next/static/") ||
  /\.(?:png|jpg|jpeg|webp|avif|svg|ico|woff2?)$/.test(url.pathname);

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache API routes. /api/csp-report in particular must always reach the
  // network, and a cached auth response would be actively dangerous.
  if (url.pathname.startsWith("/api/")) return;

  // Immutable build output: cache-first is safe and makes the shell instant.
  if (isStaticAsset(url)) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(STATIC).then((c) => c.put(request, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Pages: network-first, so a signed-in user always sees live data when they
  // have signal, and a stale screen only ever appears when the alternative is
  // no screen at all.
  //
  // Only real navigations. Next's RSC payload requests share a URL with the
  // HTML document, so caching both under one key serves an RSC blob to a
  // document request and the page renders as garbage.
  if (request.mode === "navigate" && !request.headers.has("RSC")) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(PAGES).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(request, { ignoreSearch: false });
          if (cached) return cached;
          const offline = await caches.match(OFFLINE_URL);
          return (
            offline ||
            new Response("Offline", { status: 503, headers: { "content-type": "text/plain" } })
          );
        }),
    );
  }
});
