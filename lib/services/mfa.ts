/**
 * Two-factor authentication decision logic (IMPROVEMENTS C2).
 *
 * Pure and I/O-free so the rules that decide who gets challenged — and, more
 * importantly, who does NOT — are unit-tested rather than buried in a component.
 * Getting these wrong locks people out of a CRM holding KYC scans and the
 * commission evidence chain, so each branch of the AAL matrix is pinned.
 *
 * Supabase encodes MFA state as an Authenticator Assurance Level pair:
 *
 *   current | next | meaning
 *   --------|------|--------------------------------------------------
 *   aal1    | aal1 | no MFA enrolled
 *   aal1    | aal2 | enrolled, second factor still owed THIS session
 *   aal2    | aal2 | verified
 *   aal2    | aal1 | factor was removed; the JWT is simply stale
 */

export type AalLevel = "aal1" | "aal2";

export type MfaSessionState = "not_enrolled" | "challenge_required" | "verified";

/** A JWT with no `aal` claim is aal1 by definition. */
function level(value: string | null | undefined): AalLevel {
  return value === "aal2" ? "aal2" : "aal1";
}

export function mfaSessionState(
  currentLevel: string | null | undefined,
  nextLevel: string | null | undefined,
): MfaSessionState {
  const current = level(currentLevel);
  const next = level(nextLevel);
  if (current === "aal2") return "verified";
  // current is aal1: a second factor is owed only when the session could be
  // upgraded. aal2→aal1 (unenrolled, stale JWT) never reaches here.
  return next === "aal2" ? "challenge_required" : "not_enrolled";
}

export function needsMfaChallenge(
  currentLevel: string | null | undefined,
  nextLevel: string | null | undefined,
): boolean {
  return mfaSessionState(currentLevel, nextLevel) === "challenge_required";
}

/**
 * `enroll()` creates an `unverified` factor immediately, so only VERIFIED
 * factors may gate a login — otherwise abandoning the enrolment screen would
 * lock the user out permanently.
 */
export function hasVerifiedFactor(
  factors: readonly { status: string }[] | null | undefined,
): boolean {
  return (factors ?? []).some((f) => f.status === "verified");
}
