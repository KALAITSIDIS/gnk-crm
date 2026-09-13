/**
 * The dashboard's "Listings by status" card counts live rows only (0093,
 * audit CRM-04).
 *
 * On 2026-09-13 the card read "available 16" while the org held 10 live rows
 * with that status: the other six were the archived PAF0005 phase and units,
 * which the properties list correctly hides. admin_dashboard_stats grouped
 * `properties` by status with no visibility predicate. An archived listing
 * keeps its last status — that is what restore needs — so the count has to
 * exclude by visibility, exactly as the list does.
 *
 * Requires the local Supabase stack. Run: npm run test:rls
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ORG_A, createTestUser, ensureTestOrg, serviceClient, type TestUser } from "./helpers";

const svc = serviceClient();
const run = Date.now().toString(36);
let admin: TestUser;
const ids: string[] = [];

async function availableCount(): Promise<number> {
  const args = { p_month_start: new Date().toISOString(), p_d7: new Date().toISOString(), p_d30: new Date().toISOString() };
  const { data, error } = await admin.client.rpc("admin_dashboard_stats", args);
  expect(error).toBeNull();
  const rows = ((data as { property_statuses?: Array<{ status: string; count: number }> }).property_statuses ?? []);
  return Number(rows.find((r) => r.status === "available")?.count ?? 0);
}

beforeAll(async () => {
  await ensureTestOrg(svc, ORG_A, "Test Org A", "test-org-a");
  admin = await createTestUser(svc, `dash-${run}@example.invalid`, "admin", ORG_A, { enrolFactor: true });
});

afterAll(async () => {
  if (ids.length) await svc.from("properties").delete().in("id", ids);
});

describe("admin_dashboard_stats.property_statuses", () => {
  it("counts a live listing and not an archived one with the same status", async () => {
    const before = await availableCount();

    const { data: live, error: e1 } = await svc
      .from("properties")
      .insert({ org_id: ORG_A, reference: `ZZDASH-L${run}`.slice(0, 20), property_type: "apartment", status: "available", visibility: "private" })
      .select("id")
      .single();
    if (e1) throw new Error(e1.message);
    ids.push(live.id);
    expect(await availableCount(), "a live private listing counts").toBe(before + 1);

    const { data: gone, error: e2 } = await svc
      .from("properties")
      .insert({ org_id: ORG_A, reference: `ZZDASH-A${run}`.slice(0, 20), property_type: "apartment", status: "available", visibility: "archived" })
      .select("id")
      .single();
    if (e2) throw new Error(e2.message);
    ids.push(gone.id);
    expect(await availableCount(), "an archived listing keeps its status but is not counted").toBe(before + 1);
  });
});
