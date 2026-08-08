import { test, expect } from "@playwright/test";

/**
 * The `/session-clock` recovery page (DECISIONS 2026-08-08 `T-jwt-skew`).
 *
 * The routing decision itself is unit-tested in lib/supabase/unwrap.test.ts, and
 * PostgREST's `PGRST303` was measured directly. What neither of those can reach
 * is the part that actually broke the earlier design: whether this page is
 * REACHABLE. `proxy.ts` redirects an authenticated visitor away from `/login`,
 * and the `(app)` layout builds its own Supabase client — so a recovery page put
 * in the wrong place either bounces or re-enters the failing session and loops.
 *
 * That is exactly the class of mistake a passing unit suite hid last time: the
 * branch was correct and unreachable. So these assert reachability and that the
 * one button does what it claims, not the detection.
 */
test.describe("Session clock recovery", () => {
  test("an authenticated user reaches it instead of being bounced to /dashboard", async ({
    page,
  }) => {
    await page.goto("/session-clock");

    // The middleware sends authenticated users on /login to /dashboard. If this
    // page were placed inside (auth) or matched that branch, the URL below would
    // be /dashboard and the recovery route would be dead.
    await expect(page).toHaveURL(/\/session-clock$/);
    await expect(page.getByRole("heading", { name: /session is out of step/i })).toBeVisible();
  });

  test("says plainly that reloading will not help, and offers the one action that does", async ({
    page,
  }) => {
    // The whole point over the T5.7 boundary, whose "Try again" re-runs the
    // segment with the same rejected token.
    await page.goto("/session-clock");
    await expect(page.getByText(/Reloading will not clear it/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /sign in again/i })).toBeVisible();
  });

  /**
   * NOT tested here: clicking that button.
   *
   * It submits `logout()`, which is not new code — the header's `LogoutButton`
   * already uses it — so asserting it again buys nothing. And it would cost
   * something real: Supabase `signOut()` defaults to GLOBAL scope (HANDOFF §7),
   * so the click revokes every session for the user, including the one in
   * `tests/.auth/admin.json` that every other spec shares. A first draft of this
   * file did click it and poisoned the stored auth state for the rest of the run
   * — the same residue anti-pattern as the csp.spec.ts entry in BACKLOG, only
   * pointing the other way: damaging shared state instead of depending on it.
   */
});
