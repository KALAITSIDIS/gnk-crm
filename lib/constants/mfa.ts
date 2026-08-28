/**
 * Is a second factor REQUIRED to use the app?
 *
 * Operator decision 2026-08-26: yes. **Turned ON 2026-08-28**, once the test
 * harness could run under it — see the history at the bottom for what that cost
 * and why it was worth doing first.
 *
 * ============================================================================
 * THIS CONSTANT IS ONE HALF OF A PAIR. THE OTHER IS MIGRATION 0059.
 *
 * This one gates the BROWSER: `proxy.ts` sends a session with no verified
 * factor to /security to enrol. Migration 0059 gates the DATABASE: it dropped
 * the opt-in arm from `mfa_satisfied()`, so `require_aal2` now refuses any
 * session that has not completed a second factor.
 *
 * Ship one without the other and the system contradicts itself:
 *
 *   DB mandatory, app not → a factor-less user is never prompted to enrol and
 *                           just sees an empty CRM, because `require_aal2` is
 *                           RESTRICTIVE and a blocked read returns no rows
 *                           rather than an error. Silent and baffling.
 *   app mandatory, DB not → the browser gate is the only thing between an aal1
 *                           token and the data, which is precisely the residual
 *                           gap this change existed to close.
 *
 * `supabase/tests/mfa-enforcement.test.ts` asserts the DATABASE's behaviour
 * against THIS CONSTANT, so the contradiction fails the suite rather than
 * reaching a user. Flipping this back to `false` without a migration restoring
 * the opt-in arm will go red, and that is deliberate.
 * ============================================================================
 *
 * WHAT IT NOW GIVES, stated precisely:
 *
 *   ✓ Nobody can USE the CRM without a second factor — the proxy redirects a
 *     factor-less session to /security before any page renders.
 *   ✓ Nobody can READ THE DATA without one either, whatever client they use.
 *     `mfa_satisfied()` no longer excuses a user for having no factor, so a raw
 *     aal1 token against PostgREST returns nothing. This is the half the
 *     browser gate could never provide, and the reason 0059 exists.
 *   ✓ Enrolment stays reachable: neither /security nor the app shell touches an
 *     RLS table, so a user who owes a factor can still get one. There is no
 *     redirect loop.
 *
 * THE LOCKOUT SURFACE IS REAL AND WORTH KNOWING. An account with no factor can
 * see nothing until it enrols, and there is no self-service password reset in
 * this app (no SMTP). Recovery for a stuck user is an admin deleting their
 * factors through the service role — `clearFactors` in lib/testing/mfa.ts is
 * exactly that call, and works the same way outside tests.
 *
 * ============================================================================
 * HISTORY — why this was decided on the 26th and only turned on on the 28th.
 *
 * Both halves broke the test suites, measured rather than predicted:
 *
 *   database half → RLS suite 58 passing became 4 failed / 16 passed /
 *                   38 skipped, three of four files down, because every shared
 *                   fixture user was password-only.
 *   app half      → `tests/e2e/auth.setup.ts` asserts the Dashboard heading
 *                   after login; the factor-less seed admin landed on /security
 *                   instead, and setup is a `dependency` of every project, so
 *                   all 204 E2E tests fell with it.
 *
 * The harness work (2026-08-28) fixed both at the source rather than working
 * around them: `createTestUser` now enrols a TOTP factor by default so fixture
 * clients arrive at aal2, and the E2E setup enrols a real factor for the seed
 * admin and answers a real challenge on /login/verify. Measured after:
 *
 *   RLS  58/58 under BOTH the opt-in and the mandatory rule
 *   E2E  205 passed, 1 skipped (mfa.spec.ts, which needs a factor-less admin)
 *
 * That is what made this a one-word change instead of a red pipeline.
 * ============================================================================
 */
export const MFA_REQUIRED = true;

/** Where the proxy sends someone who has to enrol before going further. */
export const MFA_ENROL_PATH = "/security";

/** Marks that arrival as forced, so the page can explain itself. */
export const MFA_ENROL_REASON = "enrol";
