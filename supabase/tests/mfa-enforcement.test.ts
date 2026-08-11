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

beforeAll(async () => {
  await ensureTestOrg(svc, ORG_A, "Test Org A", "test-org-a");

  [factored, plain] = await Promise.all([
    createTestUser(svc, `mfa-on-${run}@test.local`, "agent", ORG_A),
    createTestUser(svc, `mfa-off-${run}@test.local`, "agent", ORG_A),
  ]);

  await enrolAndVerify(factored);
  factoredAal1 = await signInAal1(factored.email);
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
});
