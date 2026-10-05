/* GN Real Estate OS — service worker (IMPROVEMENTS B8; DECISIONS T-sw-no-private-cache).
 *
 * Scope, deliberately: INSTALLABLE + AN HONEST OFFLINE SCREEN. On a dead signal
 * a navigation shows one generic page saying the app is offline and that
 * nothing was sent. WRITES are NOT queued — they need connectivity and fail
 * honestly with a retry. Offline slip signing was considered and rejected: it
 * would put commission evidence in a client-side queue, and that evidence
 * chain is the one thing in this product that must never be doubted.
 *
 * PRIVACY — the rule this file exists to keep: NOTHING A SESSION OR A SHARE
 * LINK CAN SEE IS EVER WRITTEN TO CACHE STORAGE. This app holds KYC scans and
 * client PII, and phones get shared and lost.
 *
 * Until 2026-10-05 (v1) the worker also kept the last copy of every page a user
 * loaded, in `gnk-pages-v1`, and replayed it whenever the network failed. That
 * copy did not depend on a session or on a share link still being valid: a
 * contact page outlived its session and the next user's sign-in, a withdrawn
 * proposal outlived its token, and only one of the app's sign-out paths purged
 * it. A worker cannot know whether the person holding the phone may still see
 * what it stored, so page caching is gone rather than patched.
 *
 * What may be cached is therefore an ALLOWLIST, not a pattern:
 *   - SHELL: the generic `/offline` page, precached WITHOUT credentials and
 *     refused if redirected, so it can never carry a session's output;
 *   - STATIC: Next's content-hashed build output under `/_next/static/`, and
 *     only a same-origin 200 that was not redirected and is not marked private
 *     or no-store.
 * A file extension qualifies nothing: `/contacts/<id>.png` is a page. Every
 * navigation goes to the network, and whatever the server answers is what the
 * user sees. When there is no answer at all, the generic `/offline` page stands
 * in — never a stored copy of the page that was asked for. API, RSC and every
 * other request are not intercepted, so they fail as they would with no worker.
 *
 * Upgrading from v1: activation deletes every `gnk-` cache this version does
 * not own — `gnk-pages-v1` above all — before this worker serves anything, and
 * each navigation deletes the v1 caches again in case a request still in
 * flight on the old worker re-created one. A device only runs this after it is
 * next online and fetches this file; until then a deploy cannot reach its v1
 * cache. ROLLING THE APP BACK past this version re-serves v1, which every
 * device that comes online re-installs, and page caching resumes — roll
 * forward to a new VERSION instead.
 */

const VERSION = "v2";
const SHELL = `gnk-shell-${VERSION}`;
const STATIC = `gnk-static-${VERSION}`;
/** Every cache this app has ever created carries this prefix. */
const OWNED_PREFIX = "gnk-";
const CURRENT_CACHES = [SHELL, STATIC];
/** What the v1 worker left behind. Named, so a newer version's caches are never mistaken for them. */
const V1_CACHES = ["gnk-pages-v1", "gnk-shell-v1", "gnk-static-v1"];
const OFFLINE_URL = "/offline";
const BUILD_ASSET_PREFIX = "/_next/static/";

const isBuildAsset = (pathname) => pathname.startsWith(BUILD_ASSET_PREFIX);

async function deleteCaches(isDoomed) {
  const keys = await caches.keys();
  await Promise.all(keys.filter(isDoomed).map((key) => caches.delete(key)));
}

/**
 * At activation: every cache of this app that this version does not own.
 * Limited to the `gnk-` prefix — nothing else on the origin is ours to remove.
 */
const deleteOtherVersionsCaches = () =>
  deleteCaches((key) => key.startsWith(OWNED_PREFIX) && !CURRENT_CACHES.includes(key));

/**
 * On every navigation: the v1 caches only, by name. Not the activation sweep —
 * a successor installing alongside this version must keep its new caches.
 */
const deleteV1Caches = () => deleteCaches((key) => V1_CACHES.includes(key));

/**
 * A build-asset response may be stored only if it is exactly what was asked
 * for: a 200 (not an opaque or partial response, not an error page) that was
 * NOT redirected — so its final URL is the approved one that was requested; a
 * redirect to /login stored under an asset's key is how a page ends up in an
 * asset cache — and that the server did not mark private or no-store.
 */
function isStorableBuildAsset(response) {
  if (response.status !== 200 || response.redirected) return false;
  return !/\b(?:private|no-store)\b/i.test(response.headers.get("cache-control") ?? "");
}

/**
 * Store the generic offline page. Anonymous (`credentials: "omit"`), so the
 * copy is the same for every visitor whoever is signed in, and
 * `redirect: "error"`, so an auth gate that bounces it stores nothing rather
 * than the login page under its name. `/offline` is force-dynamic and so
 * answers no-store; what makes it safe to keep is that it is fetched without a
 * session and renders no data (app/offline/page.tsx), not its cache headers.
 */
async function precacheOfflinePage() {
  const response = await fetch(
    new Request(OFFLINE_URL, { credentials: "omit", redirect: "error", cache: "reload" }),
  );
  if (response.status !== 200) throw new Error(`[sw] ${OFFLINE_URL} not cached: ${response.status}`);
  await (await caches.open(SHELL)).put(OFFLINE_URL, response);
}

/** Re-store the offline page if anything (storage pressure, a v1 purge) removed it. */
async function ensureOfflinePage() {
  if (await (await caches.open(SHELL)).match(OFFLINE_URL)) return;
  await precacheOfflinePage();
}

/** Looked up in SHELL only — never across every cache on the origin. */
async function offlineFallback() {
  const offline = await (await caches.open(SHELL)).match(OFFLINE_URL);
  return (
    offline ||
    new Response("Offline", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    })
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    // A failed precache must not fail the install: the worker is still worth
    // having, and the fallback degrades to plain text until it is re-stored.
    precacheOfflinePage()
      .catch((err) => console.warn(err))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  // Awaited before claiming, and no fetch reaches this worker until activation
  // has settled: every cache of another version present at activation is gone
  // before it serves anything. A v1 write still in flight can re-create one
  // afterwards — it is never read (the fallback reads SHELL only), and the next
  // navigation deletes it.
  event.waitUntil(deleteOtherVersionsCaches().then(() => self.clients.claim()));
});

/**
 * Sign-out purge (the app posts PURGE before logging out). On a device still
 * running v1 it is v1's own listener, plus purgeOfflineCaches' window-side
 * delete, that clears the old copies; this listener only meets v2's caches.
 * It keeps SHELL: the offline page is anonymous and the same for everyone, and
 * sign-out and the next sign-in are client-side navigations — nothing would
 * re-store it before the next full page load, so the next person would lose
 * the "nothing was sent" screen exactly when it is needed.
 */
self.addEventListener("message", (event) => {
  if (event.data?.type !== "PURGE") return;
  event.waitUntil(deleteCaches((key) => key !== SHELL));
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // API routes are never touched, not even to stand the offline page in for a
  // failed request: /api/csp-report in particular must always reach the network.
  if (url.pathname.startsWith("/api/")) return;

  // Pages: network only. The live page, a redirect to /login, a 403, a
  // withdrawn link's neutral page — the server's answer is what the user gets,
  // and nothing about it is kept.
  if (request.mode === "navigate") {
    event.waitUntil(Promise.allSettled([deleteV1Caches(), ensureOfflinePage()]));
    event.respondWith(fetch(request).catch(offlineFallback));
    return;
  }

  // Immutable, content-hashed build output: cache-first is safe and makes the
  // app shell instant on a slow signal. Read from STATIC only. Offline, a miss
  // is a network error like any other subresource — never the offline page.
  if (isBuildAsset(url.pathname)) {
    const answered = caches.open(STATIC).then(async (cache) => {
      const hit = await cache.match(request);
      if (hit) return { response: hit, stored: null };
      const response = await fetch(request);
      // The write is started here, on a clone taken before the page reads the
      // body; waitUntil below keeps the worker alive until it lands. A failed
      // write costs that cache entry and nothing else.
      const stored = isStorableBuildAsset(response) ? cache.put(request, response.clone()) : null;
      return { response, stored };
    });
    event.respondWith(answered.then(({ response }) => response));
    event.waitUntil(answered.then(({ stored }) => stored));
    return;
  }

  // Every other request that is not a navigation — RSC payloads, images, an
  // export fetched with <a download> — is not intercepted: the browser handles
  // it exactly as with no worker.
});
