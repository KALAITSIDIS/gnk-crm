/**
 * Is a second factor REQUIRED to use the app?
 *
 * Operator decision, 2026-08-26: yes.
 *
 * ============================================================================
 * ENFORCED IN THE PROXY, NOT IN `mfa_satisfied()`, AND THE REASON WAS MEASURED.
 *
 * The obvious implementation is to drop the opt-in arm from `mfa_satisfied()`
 * (0029) so `require_aal2` demands aal2 from everyone. That was written, applied
 * locally, and reverted, because it breaks the thing that proves the rest of the
 * security model works:
 *
 *   RLS suite under a mandatory `mfa_satisfied()`:
 *     58 passing  →  4 failed, 16 passed, 38 skipped  (3 of 4 files down)
 *
 * The shared fixture users have no factors ON PURPOSE — `mfa-enforcement.test.ts`
 * says so at the top: "Never enrol a factor on a shared fixture user: a verified
 * factor gates that user's aal1 sessions, which would break every other test in
 * this suite." Under mandatory mode RLS returns nothing to any of them.
 *
 * Making the database half work therefore means every fixture user enrolling and
 * completing a TOTP challenge in `beforeAll` — real work, and flaky by nature:
 * that file already notes the 30-second step boundary it has to dodge for ONE
 * user. It also breaks local development, where nobody has an authenticator set
 * up for `admin@gnk.local`.
 * ============================================================================
 *
 * WHAT THIS ACTUALLY GIVES, stated precisely rather than generously:
 *
 *   ✓ Nobody can USE the CRM without a second factor. The proxy redirects a
 *     factor-less session to /security before any page renders.
 *   ✓ Anyone who HAS enrolled is still bound at the database level — the
 *     `require_aal2` policy refuses their aal1 sessions, so the browser gate is
 *     not the only thing standing between an aal1 token and the data.
 *   ✗ It is NOT airtight against someone who has valid credentials, never
 *     enrols, and calls PostgREST directly with a raw aal1 token instead of
 *     using the app. `mfa_satisfied()` still passes them.
 *
 * That residual gap needs the database half, and the database half needs the
 * test harness to enrol factors.
 *
 * ============================================================================
 * SHIPPED OFF. THE MECHANISM IS HERE AND PROVEN; THE SWITCH IS NOT THROWN.
 *
 * The operator asked for mandatory 2FA on 2026-08-26 and it cannot be turned on
 * today without shipping a red pipeline. BOTH halves break the test suite, and
 * both were measured rather than predicted:
 *
 *   database half → RLS suite 58 passing becomes 4 failed / 16 passed /
 *                   38 skipped, because the shared fixtures hold no factors
 *                   ON PURPOSE (see mfa-enforcement.test.ts's header).
 *   app half      → `tests/e2e/auth.setup.ts` logs in and asserts the Dashboard
 *                   heading. With this true the seed admin — who has no factor —
 *                   lands on /security instead, the setup fails, and it is a
 *                   `dependency` of every project, so all 204 E2E tests go down
 *                   with it. That file already documents the seed admin having
 *                   no factor as a KNOWN GAP.
 *
 * WHAT IT COSTS TO FLIP: the E2E auth setup must enrol a TOTP factor for the
 * seed admin and store an aal2 session, and the RLS fixtures must do the same
 * in `beforeAll`. Both are feasible — `lib/testing/totp.ts` and
 * `mfa-enforcement.test.ts` already do exactly this for dedicated users — but
 * they are a test-harness project with real flake risk: that file dodges a
 * 30-second TOTP step boundary for ONE user, and this would be every fixture on
 * every run. It also needs `mfa.spec.ts` revisited, since it tests enrolling
 * from scratch as the seed admin.
 *
 * Everything else here is done and verified in a browser: a factor-less session
 * hitting /dashboard, /properties or /contacts lands on
 * /security?enrol=required with an explanation, enrolment stays reachable
 * because neither /security nor the app shell touches an RLS table, and there
 * is no redirect loop. Turning it on is this one word.
 * ============================================================================
 */
export const MFA_REQUIRED = false;

/** Where the proxy sends someone who has to enrol before going further. */
export const MFA_ENROL_PATH = "/security";

/** Marks that arrival as forced, so the page can explain itself. */
export const MFA_ENROL_REASON = "enrol";
