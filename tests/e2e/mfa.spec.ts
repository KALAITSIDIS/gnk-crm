import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { totp } from "../../lib/testing/totp";
import { ADMIN_EMAIL, ADMIN_PASSWORD } from "./helpers";

/**
 * Force-remove every factor on the shared local admin.
 *
 * This MUST run even when the test fails mid-flow: a stranded factor makes
 * `auth.setup.ts` land on the challenge screen instead of the dashboard, which
 * breaks every other spec in the suite. It cannot be done through the UI,
 * because a session that failed verification is still `aal1` and the app
 * (correctly) refuses to let an aal1 session switch 2FA off — so it goes through
 * the GoTrue admin API.
 *
 * The key below is the standard local-stack demo service key printed by
 * `supabase status`; it is not a secret and only ever reaches 127.0.0.1. This
 * whole spec is skipped unless the target is localhost.
 */
const LOCAL_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

async function clearAdminFactors(): Promise<void> {
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321",
    LOCAL_SERVICE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const { data: users } = await admin.auth.admin.listUsers();
  const user = users?.users.find((u) => u.email === ADMIN_EMAIL);
  if (!user) return;
  const { data } = await admin.auth.admin.mfa.listFactors({ userId: user.id });
  for (const factor of data?.factors ?? []) {
    await admin.auth.admin.mfa.deleteFactor({ userId: user.id, id: factor.id });
  }
}

/**
 * Two-factor authentication, end to end (IMPROVEMENTS C2).
 *
 * The decision logic is unit-tested (lib/services/mfa.test.ts) and the code
 * generator is pinned to the RFC vectors (lib/testing/totp.test.ts). This test
 * does what only the running app can prove: enrol a real TOTP factor, sign out,
 * and confirm the password alone is no longer enough to get in.
 *
 * It restores the account to its original state at the end — a leftover factor
 * would lock every other spec out of the shared local login.
 */
test.beforeEach(async ({ baseURL }) => {
  test.skip(
    !/localhost|127\.0\.0\.1/.test(baseURL ?? ""),
    "2FA enrolment mutates the login — local only, never production",
  );
  // self-heal: a previous crashed run must not keep the suite locked out
  await clearAdminFactors();
});

// belt and braces — runs even when the test throws mid-flow
test.afterEach(async ({ baseURL }) => {
  if (!/localhost|127\.0\.0\.1/.test(baseURL ?? "")) return;
  await clearAdminFactors();
});

// runs the whole enrol → sign out → challenge → sign in cycle in one test so the
// factor is always cleaned up, even though it makes for a long test
test("password alone stops working once a factor is enrolled", async ({ page }) => {
  // ---------- enrol ----------
  await page.goto("/security", { waitUntil: "networkidle" });
  await expect(
    page.getByRole("heading", { name: /two-factor authentication is off/i }),
  ).toBeVisible();

  await page.getByRole("button", { name: /set up two-factor/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("img", { name: /QR code/i })).toBeVisible();

  // read the shared secret the way a user who can't scan would
  await dialog.getByText(/can't scan the code/i).click();
  const secret = (await dialog.locator("p.font-mono").innerText()).trim();
  expect(secret.length).toBeGreaterThan(15);

  await dialog.getByLabel(/6-digit code/i).fill(totp(secret));
  await dialog.getByRole("button", { name: /turn on/i }).click();
  // the heading, not just any text — the success toast says the same thing
  await expect(
    page.getByRole("heading", { name: /two-factor authentication is on/i }),
  ).toBeVisible();

  // ---------- become a signed-out browser ----------
  // Deliberately NOT the app's Log out button: Supabase `signOut()` defaults to
  // GLOBAL scope, which revokes every refresh token for this user — including
  // the shared `tests/.auth/admin.json` session that every other spec runs on.
  // Doing that here failed 27 tests in the specs that happen to sort after this
  // one. Dropping the cookies gives this browser a clean slate without touching
  // the server-side session.
  await page.context().clearCookies();
  await page.goto("/login");
  await expect(page).toHaveURL(/\/login/);

  // ---------- password alone is no longer enough ----------
  await page.getByLabel(/email/i).fill(ADMIN_EMAIL);
  await page.getByLabel(/password/i).fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();

  // the proxy holds the aal1 session on the challenge screen
  await expect(page).toHaveURL(/\/login\/verify/);
  await expect(page.getByText(/two-factor authentication/i)).toBeVisible();

  // a wrong code is refused
  await page.getByLabel(/6-digit code/i).fill("000000");
  await page.getByRole("button", { name: /^verify$/i }).click();
  // assert the message itself: Next's route announcer also carries role="alert"
  await expect(page.getByText(/that code was not accepted/i)).toBeVisible();
  await expect(page).toHaveURL(/\/login\/verify/);

  // protected pages stay out of reach while the factor is owed
  await page.goto("/contacts");
  await expect(page).toHaveURL(/\/login\/verify/);

  // ---------- the right code gets in ----------
  await page.getByLabel(/6-digit code/i).fill(totp(secret));
  await page.getByRole("button", { name: /^verify$/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });

  // ---------- clean up: remove the factor ----------
  await page.goto("/security", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^remove$/i }).click();
  await page.getByRole("dialog").getByRole("button", { name: /^remove$/i }).click();
  await expect(
    page.getByRole("heading", { name: /two-factor authentication is off/i }),
  ).toBeVisible();
});
