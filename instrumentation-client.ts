import * as Sentry from "@sentry/nextjs";

/**
 * Browser Sentry init (T5.7). Env-gated on the PUBLIC DSN; a no-op without it.
 * Loaded automatically by Next (App Router). Source-map upload is intentionally
 * skipped (no build plugin) — errors are still captured, stacks just minified.
 */
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? "production",
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
  });
}

// Instruments App Router client navigations — no-ops until init() runs.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
