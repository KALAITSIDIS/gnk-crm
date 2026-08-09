/**
 * Telling "you typed the wrong password" apart from "sign-in is broken".
 *
 * `login()` used to map EVERY `signInWithPassword` failure to "Invalid email or
 * password". That is the right answer for a real credential rejection — saying
 * more would let anyone probe which addresses have accounts — but it is the
 * wrong answer for everything else, and on 2026-08-09 it cost hours.
 *
 * The legacy Supabase API keys were disabled on 2026-08-03, and a build that
 * restored its cache kept the old key inlined. Every auth call returned
 * `401 Legacy API keys are disabled`, the app rendered "Invalid email or
 * password", and the operator reasonably concluded they had forgotten it. The
 * production error log said what was actually wrong the whole time; the screen
 * did not, and the screen is what people believe.
 *
 * So: credential rejections stay vague, and every other failure says so plainly
 * and is reported to Sentry — Vercel's runtime logs are ~1h on this plan, which
 * is far shorter than the time it takes someone to report "I can't log in".
 */

export interface AuthFailure {
  status?: number;
  code?: string;
}

/**
 * True only for a genuine "those credentials are wrong" answer from GoTrue.
 *
 * Matched on GoTrue's `error_code` first, since that is stable, with a narrow
 * status fallback for older shapes. Everything else — 401 (disabled/invalid API
 * key), 429 (rate limited), 5xx (outage), or a network failure with no status —
 * is infrastructure and must NOT be disguised as a bad password.
 */
export function isCredentialRejection(error: AuthFailure | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "invalid_credentials" || error.code === "invalid_grant") return true;
  // A bare 400 with no code is GoTrue's older invalid-login shape.
  return error.status === 400 && !error.code;
}
