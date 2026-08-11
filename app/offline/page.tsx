export const dynamic = "force-dynamic";

/**
 * Offline fallback (IMPROVEMENTS B8). Served by the service worker when a
 * navigation fails and nothing for that URL is cached.
 *
 * Dependency-free by design: it renders with no session and no data, and must
 * not touch Supabase or any dynamic API. That has not changed.
 *
 * `force-dynamic` REPLACED `force-static` on 2026-08-11, reversing a decision
 * that this file and `scripts/check-static-routes.mjs` both stated outright. The
 * old reasoning: a PWA fallback must be precacheable and must not need the
 * server, so it can never carry a per-request nonce — accepting that under the
 * enforced CSP the page renders but does not hydrate.
 *
 * What that acceptance actually cost. A static page carries no nonce, and
 * `'strict-dynamic'` makes the browser ignore `'self'`, so EVERY script here was
 * refused — ~20 violations in one burst. That burst segfaults
 * chrome-headless-shell in CI (`SEGV_MAPERR 0000000001b0`; in 4 of 4 crashes,
 * all 20 console lines before the signal came from `/offline`), killing the
 * browser mid-run — which was blamed on `security.spec.ts` for two days, because
 * that spec merely runs next and asks for a context. It also means production
 * files ~20 CSP reports every time anyone reaches this page.
 *
 * Being dynamic does not cost the offline guarantee. The worker precaches this
 * URL at install time, while ONLINE, and serves that cached copy — HTML and CSP
 * header together, so the nonce still matches — once the network is gone.
 * Nothing here reads a request, a cookie or a session; `force-dynamic` only
 * moves rendering from build time to request time.
 *
 * The same fix `T-prod-day` applied to `/login`, `/login/verify` and
 * `/session-clock` on 2026-08-09, for the same reason.
 */
export const metadata = { title: "Offline — GN Real Estate OS" };

export default function OfflinePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-xl font-semibold text-text-1">You are offline</h1>
      <p className="text-sm text-text-2">
        This screen has not been opened on this device yet, so there is nothing saved to show.
        Screens you have already visited still work without signal.
      </p>
      <p className="text-sm text-text-2">
        Anything you were saving has <strong>not</strong> been sent. Reconnect and try again —
        nothing was lost, and nothing was recorded.
      </p>
    </main>
  );
}
