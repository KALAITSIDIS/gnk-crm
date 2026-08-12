/**
 * Guard for migration 0030. Requires the local Supabase stack.
 *
 * On the 7 paginated list tables, every current_org_id() / current_role_gnk()
 * call must sit inside a `(select …)` wrapper so Postgres evaluates it once per
 * statement instead of once per row (counted 2026-08-11: 21 calls vs 1 on a
 * 20-row scan). A policy written the old way on one of these tables regresses
 * that silently — this test is what notices.
 *
 * Scoped ON PURPOSE to contacts, deals, events, leads, properties, tasks and
 * viewings. 62 other permissive policies are deliberately left bare; asserting
 * globally would fail on all of them. That list lives in the guard functions in
 * migration 0030 and is NOT duplicated here — a second copy in TypeScript would
 * enforce nothing and would drift.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ORG_A, createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";

const svc = serviceClient();
const run = Date.now().toString(36);

let plain: TestUser;

beforeAll(async () => {
  await ensureTestOrg(svc, ORG_A, "Test Org A", "test-org-a");
  plain = await createTestUser(svc, `rls-hoist-${run}@test.local`, "agent", ORG_A);
});

describe("0030 — RLS helpers stay hoisted on the list tables", () => {
  it("no bare helper call remains on any hot table", async () => {
    const { data, error } = await svc.rpc("rls_bare_helper_calls");
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  // Not a restatement of the test above: that one proves nothing is BARE, this
  // proves the hoist is actually PRESENT. A migration that dropped all 24
  // policies and recreated none would satisfy "no bare calls" perfectly.
  it("all 24 policies on those tables are hoisted", async () => {
    const { data, error } = await svc.rpc("rls_hoisted_policy_count");
    expect(error).toBeNull();
    expect(data).toBe(24);
  });

  it.each(["rls_bare_helper_calls", "rls_hoisted_policy_count"])(
    "%s is not executable by an ordinary authenticated session",
    async (fn) => {
      const { error } = await plain.client.rpc(fn);
      expect(error).not.toBeNull();
      // Must fail because it is REVOKED, not because it is missing: a dropped
      // function would also error, and this assertion would pass while proving
      // nothing. PostgREST maps a permission failure to 42501.
      expect(error?.code, `unexpected failure: ${error?.message}`).toBe("42501");
    },
  );
});
