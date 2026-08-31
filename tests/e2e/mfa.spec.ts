import { test, expect } from "@playwright/test";
import { totp } from "../../lib/testing/totp";
import { fixtureProfile, isLocal, opTimeout, serviceClient } from "./helpers";

/**
 * Two-factor authentication, end to end (IMPROVEMENTS C2; reworked for
 * mandatory 2FA per docs/BACKLOG.md).
 *
 * The decision logic is unit-tested (lib/services/mfa.test.ts) and the code
 * generator is pinned to the RFC vectors (lib/testing/totp.test.ts). This test
 * does what only the running app can prove: enrol a real TOTP factor, sign
 * out, and confirm the password alone is no longer enough to get in — plus
 * the wrong-code refusal, which nothing else exercises.
 *
 * IT RUNS ON A DEDICATED USER, NOT THE SEED ADMIN — that is the whole rework.
 * The previous version needed the shared admin to START factor-less (which
 * mandatory mode forbids: auth.setup.ts enrols one every run so the suite can
 * log in at all) and its cleanup deleted a VERIFIED factor, which revokes
 * every session for the user — including the shared `tests/.auth/admin.json`
 * state; that failure once took 27 unrelated tests down with it. A user this
 * spec creates and destroys has no shared session to revoke, no factor
 * history to restore, and works identically under either MFA mode.
 */

const MFA_USER_EMAIL = "mfa-spec-dedicated@gnk.local";
const MFA_USER_PASSWORD = "mfa-spec-password-1";

/**
 * Remove the dedicated user entirely — auth.users cascades the profile.
 *
 * Looked up through the PROFILES table, not listUsers(): the default listUsers
 * page is 50 newest-first, and the shared local DB gains 5 users per RLS-suite
 * run — a user stranded by a hard-killed run would drop off page 1 within days
 * and this self-heal would silently stop seeing it, failing every later run at
 * createUser ("email already registered"). The profiles read is deterministic
 * at any residue level; the paginated auth scan below covers the one window
 * the profile can't (crashed between createUser and the profile insert).
 */
async function destroyDedicatedUser(): Promise<void> {
  const admin = serviceClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("id")
    .eq("email", MFA_USER_EMAIL)
    .maybeSingle();
  if (profile) {
    await admin.auth.admin.deleteUser(profile.id);
    return;
  }
  for (let page = 1; page <= 40; page++) {
    const { data } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    const user = data?.users.find((u) => u.email === MFA_USER_EMAIL);
    if (user) {
      await admin.auth.admin.deleteUser(user.id);
      return;
    }
    if (!data || data.users.length < 200) return; // ran off the end — user is gone
  }
}

// a FRESH context: this spec must never ride (or risk) the shared admin session
test.use({ storageState: { cookies: [], origins: [] } });

test.beforeEach(async () => {
  test.skip(
    !isLocal(),
    "2FA enrolment creates and deletes a login — local only, never production",
  );

  // self-heal: a previous crashed run must not leave the fixture user behind
  await destroyDedicatedUser();

  const admin = serviceClient();
  const { orgId } = await fixtureProfile(admin);
  const { data: created, error } = await admin.auth.admin.createUser({
    email: MFA_USER_EMAIL,
    password: MFA_USER_PASSWORD,
    email_confirm: true,
  });
  expect(error).toBeNull();
  expect(created?.user).toBeTruthy();
  const { error: profErr } = await admin.from("profiles").insert({
    id: created!.user!.id,
    org_id: orgId,
    role: "agent",
    full_name: "MFA Spec User",
    email: MFA_USER_EMAIL,
  });
  expect(profErr).toBeNull();
});

// belt and braces — the user goes away even when the test throws mid-flow
test.afterEach(async () => {
  if (!isLocal()) return;
  await destroyDedicatedUser();
});

// runs the whole enrol → sign out → challenge → sign in cycle in one test so
// the fixture user's lifecycle stays inside one test's setup/teardown
test("password alone stops working once a factor is enrolled", async ({ page }) => {
  // ---------- sign in factor-less ----------
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(MFA_USER_EMAIL);
  await page.getByLabel(/password/i).fill(MFA_USER_PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();
  // under mandatory mode the proxy routes a factor-less session to /security
  // to enrol; under opt-in mode the login lands on /dashboard — both correct
  await page.waitForURL(/\/(security|dashboard)/, { timeout: opTimeout(30_000) });

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
  // Cookie-clear rather than the Log out button, kept from the old version on
  // principle even though this user shares a session with nobody: signOut()
  // defaults to GLOBAL scope and this spec should never model the pattern
  // that once took 27 tests down.
  await page.context().clearCookies();
  await page.goto("/login");
  await expect(page).toHaveURL(/\/login/);

  // ---------- password alone is no longer enough ----------
  await page.getByLabel(/email/i).fill(MFA_USER_EMAIL);
  await page.getByLabel(/password/i).fill(MFA_USER_PASSWORD);
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
  await expect(page).toHaveURL(/\/dashboard/, { timeout: opTimeout(20_000) });
});

// The SEC-03 story proper: a freshly invited, factor-less user sheds the
// temp password BEFORE enrolling 2FA. This is the exact path the 2026-09-01
// post-audit review found crashing — changePassword read the profile through
// RLS, and since 0059 an aal1 session reads nothing, so the one flow the
// /security copy tells a new hire to do first ("replace it now — whoever
// invited you has seen it") threw instead of saving. Pinned here so the
// aal1 path can never regress silently again.
test("a factor-less user can shed the invite-time password before enrolling", async ({
  page,
}) => {
  const NEW_PASSWORD = "mfa-spec-rotated-99";

  // sign in with the "invite-time" password; mandatory mode parks us on /security
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(MFA_USER_EMAIL);
  await page.getByLabel(/password/i).fill(MFA_USER_PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();
  await page.waitForURL(/\/(security|dashboard)/, { timeout: opTimeout(30_000) });
  await page.goto("/security", { waitUntil: "networkidle" });

  // change the password at aal1, factor-less — this used to crash server-side
  await page.getByLabel(/^new password$/i).fill(NEW_PASSWORD);
  await page.getByLabel(/repeat it/i).fill(NEW_PASSWORD);
  await page.getByRole("button", { name: /change password/i }).click();
  await expect(page.getByText(/^password changed$/i)).toBeVisible({
    timeout: opTimeout(15_000),
  });

  // the mutation is evented even at aal1 (the write rides the service role)
  const admin = serviceClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("id")
    .eq("email", MFA_USER_EMAIL)
    .single();
  const { data: events } = await admin
    .from("events")
    .select("payload")
    .eq("entity_id", profile!.id)
    .eq("event_type", "password_changed");
  expect(events, "password_changed must be logged").toHaveLength(1);
  expect(events![0].payload, "the payload must never carry the credential").toEqual({});

  // ---------- the old password is dead, the new one works ----------
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(MFA_USER_EMAIL);
  await page.getByLabel(/password/i).fill(MFA_USER_PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();
  await expect(page.getByText(/invalid email or password/i)).toBeVisible({
    timeout: opTimeout(15_000),
  });

  // the form clears itself on a failed attempt — refill BOTH fields
  await page.getByLabel(/email/i).fill(MFA_USER_EMAIL);
  await page.getByLabel(/password/i).fill(NEW_PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();
  await page.waitForURL(/\/(security|dashboard)/, { timeout: opTimeout(30_000) });
});
