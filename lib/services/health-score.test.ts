import { describe, expect, it, vi } from "vitest";
import { computeHealth, type HealthInputs } from "./health-score";
import { fakeClient } from "@/lib/testing/fake-client";

const admin = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin.client }));

const { recomputeDealHealth } = await import("./health-score");

const NOW = new Date("2026-07-11T12:00:00Z");

const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

const base: HealthInputs = {
  budgetConfirmed: false,
  buyerKycPct: 0,
  titleDeedKnown: false,
  mandateActive: false,
  lastActivityAt: null,
};

describe("computeHealth", () => {
  it("scores 0 with nothing met and 100 with everything met", () => {
    expect(computeHealth(base, NOW).score).toBe(0);
    expect(
      computeHealth(
        {
          budgetConfirmed: true,
          buyerKycPct: 100,
          titleDeedKnown: true,
          mandateActive: true,
          lastActivityAt: daysAgo(0),
        },
        NOW,
      ).score,
    ).toBe(100);
  });

  // Playbook T3.3 acceptance: activity decay at 7 / 14 days
  it("decays activity: full 30 through day 7, 15 through day 14, then 0", () => {
    const at = (days: number) =>
      computeHealth({ ...base, lastActivityAt: daysAgo(days) }, NOW).score;
    expect(at(0)).toBe(30);
    expect(at(6.9)).toBe(30);
    expect(at(7)).toBe(30); // ≤7d full (doc 02 §C5)
    expect(at(7.1)).toBe(15);
    expect(at(14)).toBe(15); // ≤14d partial
    expect(at(14.1)).toBe(0);
    expect(at(30)).toBe(0);
    expect(computeHealth({ ...base, lastActivityAt: null }, NOW).score).toBe(0);
  });

  // Playbook T3.3 acceptance: logging a conversation raises the score
  it("raises the score when activity lands now (conversation logged)", () => {
    const stale = computeHealth({ ...base, lastActivityAt: daysAgo(20) }, NOW).score;
    const fresh = computeHealth({ ...base, lastActivityAt: daysAgo(0) }, NOW).score;
    expect(stale).toBe(0);
    expect(fresh).toBe(30);
    expect(fresh).toBeGreaterThan(stale);
  });

  it("awards KYC only at ≥50% and treats a missing buyer as unmet", () => {
    const kyc = (pct: number | null) => computeHealth({ ...base, buyerKycPct: pct }, NOW).score;
    expect(kyc(50)).toBe(15);
    expect(kyc(100)).toBe(15);
    expect(kyc(33)).toBe(0);
    expect(kyc(null)).toBe(0);
  });

  it("weights budget 25, title deed 15, mandate 15", () => {
    expect(computeHealth({ ...base, budgetConfirmed: true }, NOW).score).toBe(25);
    expect(computeHealth({ ...base, titleDeedKnown: true }, NOW).score).toBe(15);
    expect(computeHealth({ ...base, mandateActive: true }, NOW).score).toBe(15);
    expect(
      computeHealth({ ...base, titleDeedKnown: null, mandateActive: null }, NOW).score,
    ).toBe(0);
  });

  it("returns a five-factor breakdown whose points sum to the score", () => {
    const result = computeHealth(
      {
        budgetConfirmed: true,
        buyerKycPct: 67,
        titleDeedKnown: false,
        mandateActive: true,
        lastActivityAt: daysAgo(10),
      },
      NOW,
    );
    expect(result.factors).toHaveLength(5);
    expect(result.factors.reduce((s, f) => s + f.points, 0)).toBe(result.score);
    expect(result.score).toBe(25 + 15 + 0 + 15 + 15);
    const activity = result.factors.find((f) => f.key === "activity");
    expect(activity?.detail).toBe("10d since last activity");
  });
});

describe("recomputeDealHealth asks the SYSTEM whether the property has a mandate", () => {
  /*
   * "Does this property have an active mandate" is a fact about the PROPERTY,
   * and the score built from it is STORED — `deals.health_score` plus the
   * `health.factors` snapshot that the deal page and every kanban card render to
   * everyone, admins included. A stored number must not depend on who last saved.
   *
   * On the caller's client it did. `mandates_insert` is admin-only, so
   * `created_by` is always an admin and the agent arm `created_by = auth.uid()`
   * can never fire; the only arm left is `properties.assigned_agent_id =
   * auth.uid()`. Nothing in `deals_update_agent` ties a deal's agent to the
   * property's assigned agent — so a buyer-side agent saving their own deal on a
   * colleague's listing read zero mandates and persisted the 15-point factor as
   * "none active", until someone who could see it saved and flipped it back.
   *
   * Measured through real PostgREST with minted role JWTs, on one mandated
   * property: admin 1 row, assigned agent 1 row, OTHER AGENT 0 rows — on the base
   * table AND through `mandates_safe`, which keeps the same agent arm. The view
   * closes the listing-manager half only, and listing managers have no UPDATE on
   * deals at all, so the view is not the fix here. Only the system can answer it.
   */
  const dealRow = {
    id: "d1",
    org_id: "org-1",
    health: {},
    buyer_contact_id: null,
    property_id: "p1",
    last_activity_at: null,
  };

  it("reads mandates as the system, scoped to the deal's org", async () => {
    const svc = fakeClient({ mandates: [{ data: [{ id: "m1" }], error: null }] });
    admin.client = svc.client;
    const caller = fakeClient({
      deals: [{ data: dealRow, error: null }, { data: null, error: null }],
      properties: [{ data: { title_deed_status: "separate" }, error: null }],
    });

    await recomputeDealHealth(caller.client as never, "d1");

    expect(svc.served.mandates, "the system answered it").toBe(1);
    expect(
      caller.served.mandates ?? 0,
      "the caller's client, whose answer depends on which listing is theirs, was never asked",
    ).toBe(0);
    expect(svc.argsOf("mandates", "eq")).toEqual(
      expect.arrayContaining([
        ["org_id", "org-1"],
        ["property_id", "p1"],
        ["status", "active"],
      ]),
    );
  });

  it("scores the mandate factor from what the system found, not from the reader", async () => {
    const svc = fakeClient({ mandates: [{ data: [{ id: "m1" }], error: null }] });
    admin.client = svc.client;
    const caller = fakeClient({
      deals: [{ data: dealRow, error: null }, { data: null, error: null }],
      properties: [{ data: { title_deed_status: "unknown" }, error: null }],
    });

    await recomputeDealHealth(caller.client as never, "d1");

    const [update] = caller.argsOf("deals", "update");
    const written = update[0] as { health_score: number; health: { factors: unknown } };
    const factors = written.health.factors as { key: string; points: number }[];
    const mandate = factors.find((f) => f.key === "mandate");
    expect(mandate?.points, "15 points that used to vanish for a non-assigned agent").toBe(15);
  });
});
