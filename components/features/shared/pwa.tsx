"use client";

import { useEffect } from "react";

/**
 * Registers the service worker (IMPROVEMENTS B8).
 *
 * Production only. In dev, Next serves modules that change on every edit and a
 * cache-first worker turns that into stale-module confusion that looks like a
 * build bug — the cost of debugging that once is worse than the benefit of
 * testing the worker locally. `tests/e2e/pwa-offline-privacy.spec.ts` drives
 * the real worker against a production build (CI serves `next start`), and
 * `tests/unit/service-worker.test.ts` runs it in a simulated worker scope.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    // Registration failure must never break the app — it only costs offline
    // resilience, so it is logged and swallowed.
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .catch((err) => console.warn("[pwa] service worker registration failed", err));
  }, []);

  return null;
}

/**
 * Purge the worker's caches — all but the anonymous offline page.
 *
 * Called before sign-out. Since T-sw-no-private-cache (2026-10-05) the worker
 * keeps no page, so on an up-to-date device this clears only build assets. It
 * stays because a device still running the v1 worker, which cached whole
 * rendered pages, may sign out before the new worker activates — and there
 * this window-side delete (with v1's own PURGE listener) is what stops the next
 * person paging through the previous user's client data offline. Awaited
 * rather than fired and forgotten, so the purge cannot lose a race with the
 * redirect to /login.
 *
 * `gnk-shell-*` is kept: it holds only `/offline`, which renders no session
 * data in any version, and sign-out is a client-side navigation — deleting it
 * would leave the next person without the "nothing was sent" screen until a
 * full page load re-stored it.
 */
export async function purgeOfflineCaches(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    registration?.active?.postMessage({ type: "PURGE" });
    // Belt and braces: if the worker is not controlling this page yet, clear
    // the caches directly from the window.
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => !k.startsWith("gnk-shell-")).map((k) => caches.delete(k)));
    }
  } catch (err) {
    console.warn("[pwa] cache purge failed", err);
  }
}
