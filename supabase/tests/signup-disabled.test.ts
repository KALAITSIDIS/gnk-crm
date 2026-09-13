/**
 * Public sign-up is closed (audit 2026-09-13, SEC-02).
 * Requires the local Supabase stack. Run: npm run test:rls
 *
 * The application never calls `auth.signUp`: every account is created by an
 * admin through `auth.admin.createUser` (lib/actions/settings.ts, inviteUser).
 * Yet the hosted project answered `disable_signup: false` on 2026-09-13, so
 * anyone holding the publishable key — which every browser that loads the CRM
 * holds — could create an account. No `profiles` row is provisioned for such a
 * user, so `current_org_id()` returns null and RLS denies everything; the door
 * was closed by the null semantics of two helper functions rather than by a
 * setting. This test pins the setting.
 *
 * The local stack reads `[auth] enable_signup` from supabase/config.toml; the
 * hosted project carries the same value in its Auth configuration
 * (`disable_signup: true`, set through the Management API on 2026-09-13 and
 * visible to anyone at GET /auth/v1/settings). Two places, one meaning, and
 * this is the test that notices when they drift apart — on the local half.
 * The hosted half is checked by `scripts/backup/verify-restore.sql`'s posture
 * pins only indirectly, so re-read /auth/v1/settings after any dashboard work.
 */
import { describe, expect, it } from "vitest";
import { anonClient, serviceClient } from "./helpers";

const run = Date.now().toString(36);

describe("public sign-up is closed", () => {
  it("anon signUp is refused and creates no auth user", async () => {
    const email = `signup-probe-${run}@example.invalid`;
    const anon = anonClient();

    const { data, error } = await anon.auth.signUp({
      email,
      password: `probe-${run}-long-enough-password`,
    });

    expect(error, "signUp must return an error when sign-ups are disabled").not.toBeNull();
    expect(error?.message ?? "").toMatch(/signup|sign up|sign-up|not allowed|disabled/i);
    expect(data.user).toBeNull();
    expect(data.session).toBeNull();

    // Belt and braces: the refusal must be real, not a masked success. The
    // service role can list auth users; the probe address must not be there.
    const svc = serviceClient();
    const { data: page, error: listErr } = await svc.auth.admin.listUsers({ perPage: 1000 });
    expect(listErr).toBeNull();
    expect(page.users.some((u) => u.email === email)).toBe(false);
  });
});
