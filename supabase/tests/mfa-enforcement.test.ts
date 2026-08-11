/**
 * C2 — DB-level 2FA enforcement.
 * Requires the local Supabase stack. Run: npm run test:rls
 *
 * Uses DEDICATED per-run users. Never enrol a factor on a shared fixture user:
 * a verified factor gates that user's aal1 sessions, which would break every
 * other test in this suite.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { totp } from "@/lib/testing/totp";
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

/** Enrol TOTP and complete the challenge; the user's client becomes aal2. */
async function enrolAndVerify(user: TestUser): Promise<string> {
  const { data: enrolled, error: enrolErr } = await user.client.auth.mfa.enroll({
    factorType: "totp",
  });
  if (enrolErr) throw new Error(`enroll: ${enrolErr.message}`);

  const { data: ch, error: chErr } = await user.client.auth.mfa.challenge({
    factorId: enrolled.id,
  });
  if (chErr) throw new Error(`challenge: ${chErr.message}`);

  // Generate the code immediately before verify() to minimise the risk of
  // straddling a 30-second TOTP step boundary; GoTrue's clock-skew tolerance
  // covers whatever slack remains, so no retry loop is needed here.
  const { error: verifyErr } = await user.client.auth.mfa.verify({
    factorId: enrolled.id,
    challengeId: ch.id,
    code: totp(enrolled.totp.secret),
  });
  if (verifyErr) throw new Error(`verify: ${verifyErr.message}`);

  return enrolled.id;
}

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
    createTestUser(svc, `mfa-on-${run}@test.local`, "agent", ORG_A),
    createTestUser(svc, `mfa-off-${run}@test.local`, "agent", ORG_A),
    createTestUser(svc, `mfa-half-${run}@test.local`, "agent", ORG_A),
  ]);

  await enrolAndVerify(factored);
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

  it("is true for a user with no factor — the opt-in template", async () => {
    const { data, error } = await plain.client.rpc("mfa_satisfied");
    expect(error).toBeNull();
    expect(data).toBe(true);
  });

  // Regression guard for the predicate's headline trap: if it ever checks
  // "has any factor" instead of "has a VERIFIED factor", this user gets
  // locked out of everything and this test is the only thing that notices.
  it("is true for a user with an UNVERIFIED factor — the abandoned-enrolment trap", async () => {
    const { data, error } = await halfEnrolled.client.rpc("mfa_satisfied");
    expect(error).toBeNull();
    expect(data).toBe(true);
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
  });
});
