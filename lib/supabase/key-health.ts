import "server-only";
import * as Sentry from "@sentry/nextjs";

/**
 * Shout when the app is configured with a Supabase key that is known-dead.
 *
 * This project's legacy JWT keys (`anon`, `service_role`) were **disabled at
 * 2026-08-03T17:40:12Z**. Any call made with one returns
 * `401 Legacy API keys are disabled`. There is no case where a legacy key is
 * correct here, so a JWT-shaped key in the environment is unambiguously a
 * misconfiguration and can be detected without calling anything.
 *
 * Why this exists rather than trusting the environment variable: on 2026-08-09
 * production ran for days with the disabled anon key still compiled in, because
 * `NEXT_PUBLIC_*` is inlined at BUILD time and a deployment restored its build
 * cache — so the variable in Vercel was not what the running code held. Nobody
 * could sign in. Every symptom lied:
 *
 *   - `login()` said "Invalid email or password" (fixed — see auth-errors.ts)
 *   - `/p/[token]` showed its deliberately neutral "link unavailable" page
 *   - middleware just saw "no user" and redirected to /login forever
 *
 * The failure was legible only in the runtime error log, which this plan keeps
 * for about an hour. So the check reports to **Sentry**, which is durable, and
 * names the variable so the fix is obvious: set the `sb_publishable_…` /
 * `sb_secret_…` value AND redeploy with the build cache OFF.
 *
 * Deliberately does not throw. A hard failure at client-construction would turn
 * a recoverable misconfiguration into a total outage, including for the pages
 * that would otherwise still work.
 */

/** `eyJ…` — a JWT header. Modern keys are `sb_publishable_…` / `sb_secret_…`. */
const LEGACY_JWT = /^eyJ[A-Za-z0-9_-]+\./;

/** Once per process: these run on every request and Sentry is not a log. */
const reported = new Set<string>();

export function assertModernSupabaseKey(varName: string, key: string | undefined): void {
  // A missing key is a different (and much louder) failure — supabase-js throws
  // on construction, so it does not need help being noticed.
  if (!key || !LEGACY_JWT.test(key)) return;
  if (reported.has(varName)) return;
  reported.add(varName);

  const message =
    `${varName} holds a LEGACY JWT Supabase key. This project disabled legacy keys ` +
    `on 2026-08-03, so every call with it returns 401 "Legacy API keys are disabled". ` +
    `Set the sb_publishable_/sb_secret_ value in Vercel AND redeploy with build cache ` +
    `OFF — NEXT_PUBLIC_* is inlined at build time, so a cached build keeps the old one.`;

  console.error(`[supabase-key] ${message}`);
  Sentry.captureException(new Error(message));
}

/** Test seam: the once-per-process guard would otherwise hide later calls. */
export function __resetKeyHealthForTests(): void {
  reported.clear();
}
