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

/** Timestamps as PostgREST serialises a deal's updated_at (microseconds, offset). */
const T1 = "2026-10-14T09:00:00.123456+00:00";
const T2 = "2026-10-14T09:00:00.654321+00:00";

/** A written row, as PostgREST answers a predicated PATCH with `select=id`. */
const WROTE = { data: [{ id: "d1" }], error: null };
/** A predicated PATCH that matched nothing: RLS, or the row moved. */
const ZERO_ROWS = { data: [], error: null };

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
    updated_at: T1,
  };

  it("reads mandates as the system, scoped to the deal's org", async () => {
    const svc = fakeClient({ mandates: [{ data: [{ id: "m1" }], error: null }] });
    admin.client = svc.client;
    const caller = fakeClient({
      deals: [{ data: dealRow, error: null }, WROTE],
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
      deals: [{ data: dealRow, error: null }, WROTE],
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

describe("recomputeDealHealth writes only over the row it read (T-deal-health-race)", () => {
  /*
   * `deals.health` carries one key a person types — `budget_confirmed`, saved by
   * updateDealSection(section='health') — next to the two this function derives
   * (`factors`, `computed_at`). The recompute reads the deal, computes, and
   * writes `health: {...whatItRead, factors, computed_at}` with the score. With
   * no guard, a recompute that read BEFORE a budget save and wrote AFTER it put
   * the old flag back for good: 25 points gone, while the event log said the
   * flag had changed. Preserving the flag alone would not do either — the score
   * and the budget factor written would still be computed from the old one.
   *
   * So the write is predicated on the row's own `updated_at` as it was read
   * (`deals_updated`, BEFORE UPDATE, stamps now() on EVERY update of deals —
   * any column, any role), with `select=id` to learn whether a row was written.
   * Zero rows is RLS or a moved row: the next read says which. Not visible ⇒
   * stop. Same timestamp ⇒ RLS refused the UPDATE (a listing manager, a
   * non-owner) — stop, as it always silently did. Moved ⇒ read, compute and
   * write again, once: two attempts in all. It never throws (its callers have
   * already committed and logged) and writes no event (derived state, T3.3).
   *
   * These deals carry no property and no buyer, so `deals` is the only table
   * the recompute touches and its pages are, in order: read, write, read, write.
   * supabase/tests/deal-health-race.test.ts forces the same race on the real
   * stack, through PostgREST and the trigger.
   */
  const dealAt = (updatedAt: string, health: Record<string, unknown> = {}) => ({
    data: {
      id: "d1",
      org_id: "org-1",
      health,
      buyer_contact_id: null,
      property_id: null,
      last_activity_at: null,
      updated_at: updatedAt,
    },
    error: null,
  });
  const updates = (caller: ReturnType<typeof fakeClient>) =>
    caller
      .argsOf("deals", "update")
      .map(([row]) => row as { health_score: number; health: Record<string, unknown> });
  /** the `updated_at` each write was predicated on, in order */
  const guards = (caller: ReturnType<typeof fakeClient>) =>
    caller
      .argsOf("deals", "eq")
      .filter(([col]) => col === "updated_at")
      .map(([, v]) => v);

  it("the write carries the guard: id AND the updated_at it read, and selects the written id", async () => {
    const caller = fakeClient({ deals: [dealAt(T1), WROTE] });

    await recomputeDealHealth(caller.client as never, "d1");

    expect(guards(caller), "predicated on the timestamp PostgREST served, verbatim").toEqual([T1]);
    expect(caller.argsOf("deals", "eq")).toContainEqual(["id", "d1"]);
    expect(
      caller.argsOf("deals", "select"),
      "select=id on the PATCH — without it the answer cannot say whether a row was written",
    ).toContainEqual(["id"]);
    expect(String(caller.argsOf("deals", "select")[0]?.[0]), "the read takes updated_at").toContain(
      "updated_at",
    );
  });

  it("an uncontended write is made once: one read, one write, no re-read", async () => {
    const caller = fakeClient({ deals: [dealAt(T1, { budget_confirmed: true }), WROTE] });

    await recomputeDealHealth(caller.client as never, "d1");

    expect(caller.served.deals).toBe(2);
    expect(updates(caller)).toHaveLength(1);
    const [w] = updates(caller);
    expect(w?.health_score).toBe(25);
    expect(w?.health.budget_confirmed).toBe(true);
  });

  it("a zero-row answer on a MOVED row triggers exactly one re-read and a recompute from it", async () => {
    // read at T1 without the flag; the write loses; the row now says T2 with the flag
    const caller = fakeClient({
      deals: [dealAt(T1), ZERO_ROWS, dealAt(T2, { budget_confirmed: true }), WROTE],
    });

    await recomputeDealHealth(caller.client as never, "d1");

    expect(caller.served.deals, "read, write, re-read, write — and nothing after").toBe(4);
    expect(guards(caller), "each write predicated on its own read").toEqual([T1, T2]);
    const [, retry] = updates(caller);
    expect(retry?.health.budget_confirmed, "the flag the budget save wrote survives").toBe(true);
    expect(retry?.health_score, "and the score is computed FROM it, not from the first read").toBe(
      25,
    );
    const budget = (retry?.health.factors as { key: string; points: number }[]).find(
      (f) => f.key === "budget",
    );
    expect(budget?.points).toBe(25);
  });

  it("a second zero-row answer stops without throwing: two attempts, no third read", async () => {
    const caller = fakeClient({
      deals: [dealAt(T1), ZERO_ROWS, dealAt(T2), ZERO_ROWS, dealAt("2026-10-14T09:00:01+00:00")],
    });

    await expect(recomputeDealHealth(caller.client as never, "d1")).resolves.toBeUndefined();

    expect(caller.served.deals, "read, write, read, write — the bound is two attempts").toBe(4);
    expect(guards(caller)).toEqual([T1, T2]);
  });

  it("an RLS-invisible deal on the re-read stops: no compute, no second write, no throw", async () => {
    const caller = fakeClient({
      deals: [dealAt(T1), ZERO_ROWS, { data: null, error: null }, WROTE],
    });

    await expect(recomputeDealHealth(caller.client as never, "d1")).resolves.toBeUndefined();

    expect(caller.served.deals, "read, write, re-read — then nothing").toBe(3);
    expect(updates(caller)).toHaveLength(1);
  });

  it("a row that did NOT move is RLS refusing the UPDATE (listing manager, non-owner): one re-read, then stop", async () => {
    const caller = fakeClient({ deals: [dealAt(T1), ZERO_ROWS, dealAt(T1), WROTE] });

    await expect(recomputeDealHealth(caller.client as never, "d1")).resolves.toBeUndefined();

    expect(caller.served.deals, "read, write, re-read — no retry of a refused write").toBe(3);
    expect(updates(caller)).toHaveLength(1);
  });

  it("an errored write is not taken as written: the re-read decides, and nothing throws", async () => {
    // a code is not a refusal: an answer lost after the commit looks like this
    // too. Here the re-read finds the row moved (by that very write, or by
    // anyone) and the retry recomputes over what it finds
    const caller = fakeClient({
      deals: [dealAt(T1), { data: null, error: { message: "fetch failed" } }, dealAt(T2), WROTE],
    });

    await expect(recomputeDealHealth(caller.client as never, "d1")).resolves.toBeUndefined();

    expect(caller.served.deals).toBe(4);
    expect(guards(caller)).toEqual([T1, T2]);
  });

  it("a deal it cannot see is never written", async () => {
    const caller = fakeClient({ deals: [{ data: null, error: null }] });

    await recomputeDealHealth(caller.client as never, "d1");

    expect(caller.served.deals).toBe(1);
    expect(updates(caller)).toHaveLength(0);
  });
});
