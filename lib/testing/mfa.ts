import type { SupabaseClient } from "@supabase/supabase-js";
import { totp } from "@/lib/testing/totp";

/**
 * TOTP enrolment for TEST HARNESSES — the half that makes mandatory 2FA
 * testable at all.
 *
 * ============================================================================
 * WHY THIS EXISTS, AND WHY IT IS SHARED.
 *
 * `MFA_REQUIRED` (lib/constants/mfa.ts) cannot be turned on while the suites
 * assume password-only sessions. Measured before this file existed:
 *
 *   database half → RLS suite 58 passing became 4 failed / 16 passed /
 *                   38 skipped, because every shared fixture user had no factor
 *   app half      → `tests/e2e/auth.setup.ts` asserts the Dashboard heading
 *                   after login; a factor-less seed admin lands on /security
 *                   instead, and setup is a `dependency` of every project, so
 *                   all 204 E2E tests fall with it
 *
 * Both halves need the same three steps — enrol, challenge, verify — so they
 * are written once here rather than twice, differently, in two suites.
 *
 * `enrolAndVerify` began life inside `supabase/tests/mfa-enforcement.test.ts`
 * for dedicated users. Nothing about it was test-file specific.
 * ============================================================================
 *
 * NOT APPLICATION CODE. The app never generates a TOTP code — Supabase verifies
 * them server-side. This is here so a harness can behave like an authenticator.
 */

export interface EnrolledFactor {
  factorId: string;
  /** Base32 shared secret. Needed to answer any LATER challenge in this run. */
  secret: string;
}

/**
 * Enrol a TOTP factor on `client`'s user and complete the challenge, leaving
 * that client's session at **aal2**.
 *
 * Returns the secret as well as the id, which the caller needs when the same
 * user has to pass a SECOND challenge later — a browser login, for instance,
 * where the session that enrolled is not the session that signs in.
 */
export async function enrolAndVerify(client: SupabaseClient): Promise<EnrolledFactor> {
  const { data: enrolled, error: enrolErr } = await client.auth.mfa.enroll({
    factorType: "totp",
  });
  if (enrolErr) throw new Error(`mfa.enroll: ${enrolErr.message}`);

  const { data: ch, error: chErr } = await client.auth.mfa.challenge({
    factorId: enrolled.id,
  });
  if (chErr) throw new Error(`mfa.challenge: ${chErr.message}`);

  // Generated immediately before verify() to minimise the chance of straddling
  // a 30-second TOTP step boundary; GoTrue's clock-skew tolerance covers the
  // rest, which is why there is no retry loop here.
  const { error: verifyErr } = await client.auth.mfa.verify({
    factorId: enrolled.id,
    challengeId: ch.id,
    code: totp(enrolled.totp.secret),
  });
  if (verifyErr) throw new Error(`mfa.verify: ${verifyErr.message}`);

  return { factorId: enrolled.id, secret: enrolled.totp.secret };
}

/**
 * Remove every factor a user has, using the SERVICE ROLE.
 *
 * THIS IS WHAT MAKES A RE-RUN POSSIBLE. `enroll()` hands back the shared secret
 * exactly once, at enrolment. A suite that enrols on run 1 and stops there finds
 * on run 2 a user who owes a factor whose secret nobody kept — the login is then
 * unanswerable, and the harness has locked itself out of its own fixture.
 *
 * Unenrolling from the user's own session cannot solve it either: that needs
 * aal2, which needs the secret. So the escape has to come from outside the
 * user, and the admin API is that outside.
 *
 * Deleting a VERIFIED factor logs the user out of all active sessions, which is
 * why this belongs at the START of a run rather than anywhere near the middle.
 */
export async function clearFactors(admin: SupabaseClient, userId: string): Promise<number> {
  const { data, error } = await admin.auth.admin.mfa.listFactors({ userId });
  if (error) throw new Error(`admin.mfa.listFactors: ${error.message}`);

  const factors = data?.factors ?? [];
  for (const f of factors) {
    const { error: delErr } = await admin.auth.admin.mfa.deleteFactor({ userId, id: f.id });
    if (delErr) throw new Error(`admin.mfa.deleteFactor ${f.id}: ${delErr.message}`);
  }
  return factors.length;
}

/**
 * Answer a challenge for a user whose secret is already known — the browser
 * case, where enrolment happened in a different session.
 */
export async function passChallenge(client: SupabaseClient, factor: EnrolledFactor): Promise<void> {
  const { data: ch, error: chErr } = await client.auth.mfa.challenge({
    factorId: factor.factorId,
  });
  if (chErr) throw new Error(`mfa.challenge: ${chErr.message}`);

  const { error } = await client.auth.mfa.verify({
    factorId: factor.factorId,
    challengeId: ch.id,
    code: totp(factor.secret),
  });
  if (error) throw new Error(`mfa.verify: ${error.message}`);
}
