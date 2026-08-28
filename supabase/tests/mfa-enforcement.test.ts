/**
 * C2 — DB-level 2FA enforcement.
 * Requires the local Supabase stack. Run: npm run test:rls
 *
 * Uses DEDICATED per-run users, created with `enrolFactor: false` because this
 * file is about factor states themselves.
 *
 * The old warning here — "never enrol a factor on a shared fixture user" — was
 * true while fixtures were password-only. It is now inverted: `createTestUser`
 * enrols by default and hands back an aal2 client, so the suite passes whether
 * or not `mfa_satisfied()` still has its opt-in arm. What must never happen is
 * a fixture left at aal1 WITH a verified factor; that is this file's
 * `factoredAal1`, built on purpose and nowhere else.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { enrolAndVerify } from "@/lib/testing/mfa";
import { MFA_REQUIRED } from "@/lib/constants/mfa";
import {
  ORG_A,
  TEST_PASSWORD,
  anonClient,
  createTestUser,
  ensureTestOrg,
  serviceClient,
  type TestUser,
} from "./helpers";

const run = Date.now().toString(36);
const svc = serviceClient();


/** A FRESH password-only session for an existing user — aal1 even if they have
 *  a verified factor. This is the stolen-token shape the policy must stop. */
async function signInAal1(email: string): Promise<SupabaseClient> {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({
    email,
    password: TEST_PASSWORD,
  });
  if (error) throw new Error(`signIn ${email}: ${error.message}`);
  return client;
}

let factored: TestUser; // has a verified factor; its client is aal2
let factoredAal1: SupabaseClient; // same user, password-only session
let plain: TestUser; // no factor at all — must stay unaffected
let halfEnrolled: TestUser; // enrolled but never verified — must NOT be gated

beforeAll(async () => {
  await ensureTestOrg(svc, ORG_A, "Test Org A", "test-org-a");

  [factored, plain, halfEnrolled] = await Promise.all([
    // `enrolFactor: false` on all three: this file is ABOUT factor states, so
    // the fixtures must arrive with none and have them applied deliberately
    // below. The default (enrol, reach aal2) would delete the thing under test.
    createTestUser(svc, `mfa-on-${run}@test.local`, "agent", ORG_A, { enrolFactor: false }),
    createTestUser(svc, `mfa-off-${run}@test.local`, "agent", ORG_A, { enrolFactor: false }),
    createTestUser(svc, `mfa-half-${run}@test.local`, "agent", ORG_A, { enrolFactor: false }),
  ]);

  await enrolAndVerify(factored.client);
  factoredAal1 = await signInAal1(factored.email);

  // Deliberately enrol WITHOUT verifying: this is the "closed the enrolment
  // tab" state the predicate's status='verified' filter exists to protect.
  const { error: halfErr } = await halfEnrolled.client.auth.mfa.enroll({
    factorType: "totp",
  });
  if (halfErr) throw new Error(`half enroll: ${halfErr.message}`);
});

describe("mfa_satisfied() — the aal claim", () => {
  it("is false for a password-only session when the user HAS a verified factor", async () => {
    const { data, error } = await factoredAal1.rpc("mfa_satisfied");
    expect(error).toBeNull();
    expect(data).toBe(false);
  });

  // If the access token did not carry `aal`, coalesce would read 'aal1' and
  // this would be false — which is exactly the failure that would lock out
  // every enrolled user in production. This assertion IS the claim check.
  it("is true for the same user once the TOTP challenge is passed", async () => {
    const { data, error } = await factored.client.rpc("mfa_satisfied");
    expect(error).toBeNull();
    expect(data).toBe(true);
  });

  /**
   * MODE-DEPENDENT, AND DELIBERATELY KEYED TO `MFA_REQUIRED`.
   *
   * A user with no factor is the whole difference between opt-in and mandatory
   * 2FA, so this assertion has to flip with the policy rather than be deleted
   * when it changes. Keying it to the app's own constant also PINS THE TWO
   * HALVES TOGETHER: flip `MFA_REQUIRED` without shipping the migration that
   * drops `mfa_satisfied()`'s opt-in arm — or the reverse — and this fails.
   * A browser gate and a database rule disagreeing is the failure that would
   * otherwise be discovered by a user who cannot read their own data.
   */
  it(`is ${!MFA_REQUIRED} for a user with no factor — the ${MFA_REQUIRED ? "mandatory rule" : "opt-in template"}`, async () => {
    const { data, error } = await plain.client.rpc("mfa_satisfied");
    expect(error).toBeNull();
    expect(data).toBe(!MFA_REQUIRED);
  });

  // Regression guard for the predicate's headline trap: if it ever checks
  // "has any factor" instead of "has a VERIFIED factor", this user gets
  // locked out of everything and this test is the only thing that notices.
  it(`is ${!MFA_REQUIRED} for a user with an UNVERIFIED factor — the abandoned-enrolment trap`, async () => {
    const { data, error } = await halfEnrolled.client.rpc("mfa_satisfied");
    expect(error).toBeNull();
    // Under the opt-in rule this must be TRUE, and the comment above says why:
    // matching "has any factor" instead of "has a VERIFIED factor" locks out
    // anyone who closed the enrolment tab.
    //
    // Under the mandatory rule it is false for a plainer reason — the session
    // is aal1 — and the trap moves rather than disappearing: such a user must
    // still be able to REACH enrolment, which is the proxy's job
    // (`/security` is exempt in proxy.ts), not this predicate's.
    expect(data).toBe(!MFA_REQUIRED);
  });

  // The revoke is the dangerous line (a security definer function is
  // anon-executable by default — 0021's scar). Without this, dropping it
  // later would not fail a single test.
  it("is not callable by the anon role at all", async () => {
    const { error } = await anonClient().rpc("mfa_satisfied");
    expect(error).not.toBeNull();
  });
});

describe("require_aal2 coverage", () => {
  // The per-table pattern gets forgotten — migration 0021 is this repo's own
  // proof (HANDOFF §4.3). This guard is why the explicit approach is safe: a
  // new RLS table without the policy fails CI instead of shipping ungated.
  it("every RLS-enabled table in public carries the policy", async () => {
    const { data, error } = await svc.rpc("rls_aal2_coverage");
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("is not executable by an ordinary authenticated session", async () => {
    const { error } = await plain.client.rpc("rls_aal2_coverage");
    expect(error).not.toBeNull();
    // Must fail because it is REVOKED, not because it is missing: a dropped
    // function would also error, and this assertion would pass while proving
    // nothing. PostgREST maps a permission failure to 42501.
    expect(error?.code, `unexpected failure: ${error?.message}`).toBe("42501");
  });
});

describe("require_aal2 behaviour", () => {
  it("an aal1 session with a verified factor reads nothing", async () => {
    for (const table of ["contacts", "events", "cyprus_config"]) {
      const { data, error } = await factoredAal1.from(table).select("*").limit(5);
      expect(error, `${table} should not error, just return nothing`).toBeNull();
      expect(data, `${table} leaked rows to an aal1 session`).toEqual([]);
    }
  });

  it("an aal1 session with a verified factor cannot write", async () => {
    const { error } = await factoredAal1
      .from("contacts")
      .insert({ org_id: ORG_A, first_name: `blocked-${run}` });
    expect(error).not.toBeNull();
  });

  it("the same user at aal2 can read and write", async () => {
    const { error: insErr } = await factored.client
      .from("contacts")
      .insert({ org_id: ORG_A, first_name: `allowed-${run}` });
    expect(insErr).toBeNull();

    const { data, error } = await factored.client
      .from("contacts")
      .select("first_name")
      .eq("first_name", `allowed-${run}`);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  /**
   * The behavioural half of the same switch.
   *
   * Opt-in: an unfactored user is completely unaffected — that is what made an
   * unfactored admin the lockout safety net.
   *
   * Mandatory: that safety net is GONE BY DESIGN, and this asserts it is really
   * gone rather than merely intended. `require_aal2` is RESTRICTIVE, so the
   * refusal lands on reads AND writes; both are checked, because a rule that
   * only stopped writes would leak every row to a password-only session.
   */
  it(`a user with NO factor is ${MFA_REQUIRED ? "refused everything" : "completely unaffected"}`, async () => {
    const { error: insErr } = await plain.client
      .from("contacts")
      .insert({ org_id: ORG_A, first_name: `plain-${run}` });

    const { data, error } = await plain.client.from("contacts").select("id").limit(1);

    if (MFA_REQUIRED) {
      expect(insErr).not.toBeNull();
      expect(insErr?.message).toMatch(/require_aal2/);
      // A blocked SELECT under RLS is an empty result, not an error.
      expect(error).toBeNull();
      expect(data ?? []).toHaveLength(0);
    } else {
      expect(insErr).toBeNull();
      expect(error).toBeNull();
      expect(data?.length).toBeGreaterThan(0);
    }
  });

  it("service_role still bypasses everything — the cron path", async () => {
    const { data, error } = await svc.from("events").select("id").limit(1);
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });
});
