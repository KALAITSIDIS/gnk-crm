import * as Sentry from "@sentry/nextjs";

/**
 * Server/edge Sentry init (T5.7). Strictly env-gated: with no DSN (dev, CI,
 * or a deploy that hasn't set the secret) this is a complete no-op, so nothing
 * can throw at startup. Set SENTRY_DSN in the Vercel project to activate.
 */
export async function register() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: process.env.VERCEL_ENV ?? "production",
    tracesSampleRate: 0.1,
    enabled: true,
  });
}

// Next 15+ server-error hook — no-ops until init() has run with a DSN.
export const onRequestError = Sentry.captureRequestError;
