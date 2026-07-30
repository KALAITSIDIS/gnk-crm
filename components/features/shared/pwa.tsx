"use client";

import { useEffect } from "react";

/**
 * Registers the service worker (IMPROVEMENTS B8).
 *
 * Production only. In dev, Next serves modules that change on every edit and a
 * cache-first worker turns that into stale-module confusion that looks like a
 * build bug — the cost of debugging that once is worse than the benefit of
 * testing the worker locally, and the E2E covers it against a real build.
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
 * Purge every cache the worker holds.
 *
 * Called before sign-out. This app caches whole rendered pages so they survive
 * a dead signal, which means a shared or stolen phone could otherwise be paged
 * back through the previous user's KYC and client data offline. Awaited (with a
 * timeout) rather than fired and forgotten, so the purge cannot lose a race
 * with the redirect to /login.
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
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch (err) {
    console.warn("[pwa] cache purge failed", err);
  }
}
