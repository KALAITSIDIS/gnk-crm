import { beforeEach, describe, expect, it, vi } from "vitest";
import { HEALTH_WEIGHTS, computeHealth, type HealthInputs } from "./health-score";
import { KYC_ITEMS } from "@/lib/constants/checklists";
import { fakeClient } from "@/lib/testing/fake-client";

/** the service-role client createAdminClient hands out, how many were built, and an optional throw */
const admin = vi.hoisted(() => ({ client: null as unknown, built: 0, throws: null as Error | null }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    admin.built += 1;
    if (admin.throws) throw admin.throws;
    return admin.client;
  },
}));
const sentry = vi.hoisted(() => ({ captureMessage: vi.fn() }));
vi.mock("@sentry/nextjs", () => sentry);

beforeEach(() => {
  admin.client = null;
  admin.built = 0;
  admin.throws = null;
  sentry.captureMessage.mockReset();
});

const { recomputeDealHealth, recomputeDealsFor } = await import("./health-score");

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
   * the recompute touches and its pages are, in order: read, write, read, write
   * — except the one case that pins that a retry reads the buyer's KYC, the
   * title deed and the mandate AGAIN, rather than scoring the first attempt's.
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
  /**
   * Each PATCH's OWN builder calls, from its `update` to the `select` that
   * ends it. The flat `eq` list of the table cannot say which chain a filter
   * belongs to: the READ filters on the id too, so a write that lost its id
   * filter passed an assertion made over both (review, 2026-10-14). Predicated
   * on a timestamp alone, the write would land this deal's `health` — its
   * budget flag included — and score on every deal the caller may update that
   * shares the timestamp, and one multi-row UPDATE (mergeContacts' repoint)
   * stamps one now() on all of its rows.
   */
  const writeChains = (caller: ReturnType<typeof fakeClient>) => {
    const chains: { method: string; args: unknown[] }[][] = [];
    let open: { method: string; args: unknown[] }[] | null = null;
    for (const c of caller.calls) {
      if (c.table !== "deals") continue;
      if (c.method === "update") {
        open = [];
        chains.push(open);
      }
      if (!open) continue;
      open.push({ method: c.method, args: c.args });
      if (c.method === "select") open = null;
    }
    return chains;
  };
  /** the filters chained onto each write, in order */
  const writeFilters = (caller: ReturnType<typeof fakeClient>) =>
    writeChains(caller).map((chain) => chain.filter((c) => c.method === "eq").map((c) => c.args));
  /** the `updated_at` each write was predicated on, in order */
  const guards = (caller: ReturnType<typeof fakeClient>) =>
    writeFilters(caller).map((eqs) => eqs.find(([col]) => col === "updated_at")?.[1]);

  it("the write carries the guard: id AND the updated_at it read, and selects the written id", async () => {
    const caller = fakeClient({ deals: [dealAt(T1), WROTE] });

    await recomputeDealHealth(caller.client as never, "d1");

    expect(guards(caller), "predicated on the timestamp PostgREST served, verbatim").toEqual([T1]);
    const [write] = writeChains(caller);
    expect(
      write?.filter((c) => c.method === "eq").map((c) => c.args),
      "the PATCH itself names THIS deal — not only the read before it — and the updated_at it read",
    ).toEqual(
      expect.arrayContaining([
        ["id", "d1"],
        ["updated_at", T1],
      ]),
    );
    expect(
      write?.find((c) => c.method === "select")?.args,
      "select=id on the PATCH — without it the answer cannot say whether a row was written",
    ).toEqual(["id"]);
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
    expect(
      writeFilters(caller).map((eqs) => eqs.filter(([col]) => col === "id")),
      "and each names this deal",
    ).toEqual([[["id", "d1"]], [["id", "d1"]]]);
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

  it("a retry reads the OTHER tables again: buyer KYC, title deed and mandate come from the second attempt", async () => {
    // The row moved because something changed; it may have been the buyer's
    // KYC, the title deed or the mandate, saved by a mutation whose own
    // recompute this one is now racing. A retry that re-read the deal but
    // scored the first attempt's other-table inputs would write, over a fresh
    // updated_at, a factor older than the save that moved the row.
    const svc = fakeClient({
      mandates: [
        { data: [], error: null },
        { data: [{ id: "m1" }], error: null },
      ],
    });
    admin.client = svc.client;
    const linked = (updatedAt: string) => ({
      data: { ...dealAt(updatedAt).data, buyer_contact_id: "c1", property_id: "p1" },
      error: null,
    });
    /** a buyer with the first `done` KYC items ticked (3 of 6 = 50%, the bar) */
    const buyer = (done: number) => ({
      data: {
        kyc: Object.fromEntries(KYC_ITEMS.slice(0, done).map(([key]) => [key, { done: true }])),
      },
      error: null,
    });
    const caller = fakeClient({
      deals: [linked(T1), ZERO_ROWS, linked(T2), WROTE],
      contacts: [buyer(0), buyer(3)],
      properties: [
        { data: { title_deed_status: "unknown" }, error: null },
        { data: { title_deed_status: "separate" }, error: null },
      ],
    });

    await recomputeDealHealth(caller.client as never, "d1");

    expect(caller.served.contacts, "the buyer's KYC, read again for the retry").toBe(2);
    expect(caller.served.properties, "the title deed, read again").toBe(2);
    expect(svc.served.mandates, "the mandate, asked again").toBe(2);
    const points = (w: { health: Record<string, unknown> } | undefined) =>
      Object.fromEntries(
        (w?.health.factors as { key: string; points: number }[]).map((f) => [f.key, f.points]),
      );
    const [first, retry] = updates(caller);
    expect(points(first), "what the first attempt read").toMatchObject({
      kyc: 0,
      title_deed: 0,
      mandate: 0,
    });
    expect(points(retry), "the retry scores what IT read").toMatchObject({
      kyc: HEALTH_WEIGHTS.kyc,
      title_deed: HEALTH_WEIGHTS.title_deed,
      mandate: HEALTH_WEIGHTS.mandate,
    });
    expect(retry?.health_score).toBe(
      HEALTH_WEIGHTS.kyc + HEALTH_WEIGHTS.title_deed + HEALTH_WEIGHTS.mandate,
    );
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

describe("recomputeDealsFor fans out AS THE SYSTEM, inside the saved row's organisation (T-lm-health-recompute)", () => {
  /*
   * A property's title deed and a buyer's KYC are deal-health factors, so a
   * legal save, a KYC save and a mandate change recompute every open deal on
   * the property / of the buyer. On the caller's session that depended on who
   * saved: a listing manager may update the property but no deal (deals_update
   * has no listing-manager arm, so the PATCH matched 0 rows silently), and the
   * property's assigned agent never even selected a deal another agent owns.
   *
   * The operator's decision (BACKLOG "External audit — 2026-10-14"): recompute
   * as the system, with an explicit organisation boundary. The boundary is the
   * org of the row the caller just saved, read on the CALLER'S client (RLS),
   * never on the admin one; every query the system then sends — the selection,
   * each deal's read, its other-table reads and its write — carries it, because
   * the service role has no RLS to do it. supabase/tests/deal-health-fan-out.test.ts
   * runs it on the real stack, with a second organisation and planted links.
   */
  const ORG = "org-b";
  const T1x = "2026-10-15T09:00:00.123456+00:00";
  const T2x = "2026-10-15T09:00:00.654321+00:00";

  const systemDeal = (id: string, extra: Record<string, unknown> = {}, updatedAt = T1x) => ({
    data: {
      id,
      org_id: ORG,
      health: {},
      buyer_contact_id: null,
      property_id: null,
      last_activity_at: null,
      updated_at: updatedAt,
      ...extra,
    },
    error: null,
  });
  const ids = (...list: string[]) => ({ data: list.map((id) => ({ id })), error: null });
  const wrote = (id: string) => ({ data: [{ id }], error: null });
  const anchor = (org: string | null) => ({ data: org === null ? null : { org_id: org }, error: null });

  type Call = { method: string; args: unknown[] };
  /** The builder calls of each query on `table`, one array per query (a write ends at its own `select`). */
  const chains = (fake: ReturnType<typeof fakeClient>, table: string) => {
    const out: Call[][] = [];
    let inWrite = false;
    for (const c of fake.calls) {
      if (c.table !== table) continue;
      if (c.method === "select" && inWrite) {
        out[out.length - 1]!.push({ method: c.method, args: c.args });
        inWrite = false;
        continue;
      }
      if (c.method === "select" || c.method === "update") {
        out.push([]);
        inWrite = c.method === "update";
      }
      out[out.length - 1]?.push({ method: c.method, args: c.args });
    }
    return out;
  };
  const eqs = (chain: Call[] | undefined) =>
    (chain ?? []).filter((c) => c.method === "eq").map((c) => c.args);
  const writesOf = (fake: ReturnType<typeof fakeClient>) =>
    chains(fake, "deals").filter((c) => c[0]?.method === "update");
  const reports = () =>
    sentry.captureMessage.mock.calls.map(
      ([message, ctx]) => [message, (ctx as { tags: Record<string, string> }).tags] as const,
    );
  const failed = (step: string, code: string) =>
    ["[health] deal fan-out failed", { operation: "health.fan_out", step, code }] as const;

  it("reads the anchor's org on the CALLER'S client, then selects, reads and writes on ONE system client, every query bound to that org", async () => {
    const session = fakeClient({ properties: [anchor(ORG)] });
    const svc = fakeClient({
      deals: [ids("d1"), systemDeal("d1", { property_id: "p1" }), wrote("d1")],
      properties: [{ data: { title_deed_status: "separate" }, error: null }],
      mandates: [{ data: [], error: null }],
    });
    admin.client = svc.client;

    await recomputeDealsFor(session.client as never, { propertyId: "p1" });

    // the caller's client: the anchor's org, under RLS — and nothing on deals
    expect(session.argsOf("properties", "select")).toEqual([["org_id"]]);
    expect(session.argsOf("properties", "eq")).toEqual([["id", "p1"]]);
    expect(session.served.deals ?? 0, "the caller's session never touches deals").toBe(0);
    expect(session.served.mandates ?? 0).toBe(0);
    // the system: built once, for the whole fan-out
    expect(admin.built, "one service-role client").toBe(1);
    const [selection, read, write] = chains(svc, "deals");
    expect(eqs(selection), "the selection: this org's OPEN deals on this property").toEqual(
      expect.arrayContaining([
        ["org_id", ORG],
        ["status", "open"],
        ["property_id", "p1"],
      ]),
    );
    expect(eqs(read), "each deal's read names it AND the org").toEqual(
      expect.arrayContaining([
        ["id", "d1"],
        ["org_id", ORG],
      ]),
    );
    expect(eqs(write), "the write: the deal, the org, and the updated_at it read").toEqual(
      expect.arrayContaining([
        ["id", "d1"],
        ["org_id", ORG],
        ["updated_at", T1x],
      ]),
    );
    expect(write?.at(-1), "select=id: the answer says whether a row was written").toEqual({
      method: "select",
      args: ["id"],
    });
    const payload = write?.[0]?.args[0] as Record<string, unknown>;
    expect(Object.keys(payload).sort(), "derived columns only").toEqual(["health", "health_score"]);
    // the other tables, on the same system client, bound to the deal's org
    expect(svc.argsOf("properties", "eq")).toEqual(
      expect.arrayContaining([
        ["id", "p1"],
        ["org_id", ORG],
      ]),
    );
    expect(svc.argsOf("mandates", "eq")).toEqual(expect.arrayContaining([["org_id", ORG]]));
    const factors = (payload.health as { factors: { key: string; points: number }[] }).factors;
    expect(factors.find((f) => f.key === "title_deed")?.points).toBe(HEALTH_WEIGHTS.title_deed);
    expect(reports()).toEqual([]);
  });

  it("the mandate factor on the system path: asked once on the fan-out's own client, inside the deal's org, and an active mandate scores", async () => {
    // The factor setMandateStatus / saveMandate fan out to refresh
    // (mandates.ts recomputeScores). Every other fan-out case here scripts no
    // mandate, so a system path that never scored one — or asked with a
    // filter or a limit that finds none — passed them all (review, 2026-10-15).
    const session = fakeClient({ properties: [anchor(ORG)] });
    const svc = fakeClient({
      deals: [ids("d1"), systemDeal("d1", { property_id: "p1" }), wrote("d1")],
      properties: [{ data: { title_deed_status: "unknown" }, error: null }],
      mandates: [{ data: [{ id: "m1" }], error: null }],
    });
    admin.client = svc.client;

    await recomputeDealsFor(session.client as never, { propertyId: "p1" });

    expect(admin.built, "the fan-out's own system client, not a second one").toBe(1);
    expect(svc.served.mandates, "asked once, as the system").toBe(1);
    expect(session.served.mandates ?? 0, "never on the caller's client").toBe(0);
    expect(svc.argsOf("mandates", "eq"), "this org's ACTIVE mandates on this property — nothing else").toEqual([
      ["org_id", ORG],
      ["property_id", "p1"],
      ["status", "active"],
    ]);
    expect(svc.argsOf("mandates", "limit"), "one row answers the question").toEqual([[1]]);
    const [write] = writesOf(svc);
    const payload = write?.[0]?.args[0] as {
      health_score: number;
      health: { factors: { key: string; points: number; detail: string }[] };
    };
    expect(payload.health.factors.find((f) => f.key === "mandate")).toMatchObject({
      points: HEALTH_WEIGHTS.mandate,
      detail: "active",
    });
    expect(payload.health_score, "the mandate alone: no budget, title deed unknown, no activity").toBe(
      HEALTH_WEIGHTS.mandate,
    );
    expect(reports()).toEqual([]);
  });

  it("a buyer anchor: the contact's org on the caller's client, the buyer's deals and KYC read as the system inside it", async () => {
    const session = fakeClient({ contacts: [anchor(ORG)] });
    const svc = fakeClient({
      deals: [
        ids("d1", "d2"),
        systemDeal("d1", { buyer_contact_id: "c1" }),
        wrote("d1"),
        systemDeal("d2", { buyer_contact_id: "c1" }),
        wrote("d2"),
      ],
      contacts: [
        { data: { kyc: {} }, error: null },
        { data: { kyc: {} }, error: null },
      ],
    });
    admin.client = svc.client;

    await recomputeDealsFor(session.client as never, { buyerContactId: "c1" });

    expect(session.argsOf("contacts", "eq")).toEqual([["id", "c1"]]);
    expect(session.served.deals ?? 0).toBe(0);
    expect(eqs(chains(svc, "deals")[0])).toEqual(
      expect.arrayContaining([
        ["org_id", ORG],
        ["status", "open"],
        ["buyer_contact_id", "c1"],
      ]),
    );
    expect(writesOf(svc), "both deals written").toHaveLength(2);
    expect(svc.argsOf("contacts", "eq"), "the buyer's KYC, bound to the deal's org").toEqual([
      ["id", "c1"],
      ["org_id", ORG],
      ["id", "c1"],
      ["org_id", ORG],
    ]);
    expect(admin.built).toBe(1);
  });

  it("an anchor the caller cannot see fans out NOTHING: no system client, reported", async () => {
    const session = fakeClient({ properties: [anchor(null)] });

    await expect(
      recomputeDealsFor(session.client as never, { propertyId: "p-other-org" }),
    ).resolves.toBeUndefined();

    expect(admin.built, "the service role is never reached").toBe(0);
    expect(reports()).toEqual([failed("anchor", "not_visible")]);
  });

  it("an anchor read that errors fans out nothing, and is reported in shape only", async () => {
    const session = fakeClient({
      contacts: [{ data: null, error: { message: "secret detail", code: "PGRST301" } }],
    });

    await expect(
      recomputeDealsFor(session.client as never, { buyerContactId: "c1" }),
    ).resolves.toBeUndefined();

    expect(admin.built).toBe(0);
    expect(reports()).toEqual([failed("anchor", "PGRST301")]);
    expect(JSON.stringify(sentry.captureMessage.mock.calls), "never the database's words").not.toContain(
      "secret",
    );
  });

  it("never throws into its caller: a service-role client that cannot be built is reported", async () => {
    const session = fakeClient({ properties: [anchor(ORG)] });
    admin.throws = new TypeError("supabaseKey is required.");

    await expect(
      recomputeDealsFor(session.client as never, { propertyId: "p1" }),
    ).resolves.toBeUndefined();

    expect(reports()).toEqual([failed("client", "TypeError")]);
  });

  it("never throws into its caller: a throw on the caller's own client is reported, nothing fans out", async () => {
    const session = {
      from: () => {
        throw new SyntaxError("fixture: the anchor read threw");
      },
    };

    await expect(
      recomputeDealsFor(session as never, { buyerContactId: "c1" }),
    ).resolves.toBeUndefined();

    expect(admin.built).toBe(0);
    expect(reports()).toEqual([failed("threw", "SyntaxError")]);
  });

  it("a selection that errors, or answers with no rows array, recomputes nothing and is reported", async () => {
    for (const [page, code] of [
      [{ data: null, error: { message: "x", code: "57014" } }, "57014"],
      [{ data: null, error: null }, "no_rows_array"],
    ] as const) {
      sentry.captureMessage.mockReset();
      const session = fakeClient({ properties: [anchor(ORG)] });
      const svc = fakeClient({ deals: [page] });
      admin.client = svc.client;

      await expect(
        recomputeDealsFor(session.client as never, { propertyId: "p1" }),
      ).resolves.toBeUndefined();

      expect(svc.served.deals, code).toBe(1);
      expect(reports(), code).toEqual([failed("select", code)]);
    }
  });

  it("keeps the race guard: a zero-row answer on a MOVED row is retried once from the re-read, and nothing is reported", async () => {
    const session = fakeClient({ properties: [anchor(ORG)] });
    const svc = fakeClient({
      deals: [
        ids("d1"),
        systemDeal("d1"),
        { data: [], error: null },
        systemDeal("d1", { health: { budget_confirmed: true } }, T2x),
        wrote("d1"),
      ],
    });
    admin.client = svc.client;

    await recomputeDealsFor(session.client as never, { propertyId: "p1" });

    const writes = writesOf(svc);
    expect(writes.map((w) => eqs(w).find(([col]) => col === "updated_at")?.[1])).toEqual([T1x, T2x]);
    const retry = writes[1]?.[0]?.args[0] as { health_score: number; health: Record<string, unknown> };
    expect(retry.health.budget_confirmed).toBe(true);
    expect(retry.health_score).toBe(HEALTH_WEIGHTS.budget);
    expect(reports()).toEqual([]);
  });

  it("a write that lands nowhere on an UNMOVED row is not RLS here — reported, and the next deal is still recomputed", async () => {
    const session = fakeClient({ properties: [anchor(ORG)] });
    const svc = fakeClient({
      deals: [
        ids("d1", "d2"),
        systemDeal("d1"),
        { data: null, error: { message: "boom", code: "08006" } },
        systemDeal("d1"),
        systemDeal("d2"),
        wrote("d2"),
      ],
    });
    admin.client = svc.client;

    await expect(
      recomputeDealsFor(session.client as never, { propertyId: "p1" }),
    ).resolves.toBeUndefined();

    expect(reports()).toEqual([failed("write", "08006")]);
    expect(
      writesOf(svc).map((w) => eqs(w).find(([col]) => col === "id")?.[1]),
      "d1 once (no retry of an unmoved row), then d2",
    ).toEqual(["d1", "d2"]);
  });

  it("a deal read that errors writes nothing for that deal, is reported, and the next deal is still recomputed", async () => {
    const session = fakeClient({ properties: [anchor(ORG)] });
    const svc = fakeClient({
      deals: [
        ids("d1", "d2"),
        { data: null, error: { message: "canceling statement", code: "57014" } },
        systemDeal("d2"),
        wrote("d2"),
      ],
    });
    admin.client = svc.client;

    await expect(
      recomputeDealsFor(session.client as never, { propertyId: "p1" }),
    ).resolves.toBeUndefined();

    expect(reports()).toEqual([failed("deal_read", "57014")]);
    expect(writesOf(svc).map((w) => eqs(w).find(([col]) => col === "id")?.[1])).toEqual(["d2"]);
  });

  it("one deal's recompute throwing does not stop the others, and is reported", async () => {
    const session = fakeClient({ properties: [anchor(ORG)] });
    const svc = fakeClient({
      deals: [ids("d1", "d2"), systemDeal("d1", { buyer_contact_id: "c1" }), systemDeal("d2"), wrote("d2")],
    });
    let thrown = false;
    admin.client = {
      from: (table: string) => {
        if (table === "contacts" && !thrown) {
          thrown = true;
          throw new RangeError("fixture: the buyer read threw");
        }
        return svc.client.from(table);
      },
    };

    await expect(
      recomputeDealsFor(session.client as never, { propertyId: "p1" }),
    ).resolves.toBeUndefined();

    expect(reports()).toEqual([failed("recompute", "RangeError")]);
    expect(writesOf(svc).map((w) => eqs(w).find(([col]) => col === "id")?.[1])).toEqual(["d2"]);
  });

  it("the SESSION path (a deal action on its own deal) keeps RLS as its bound and stays silent on a refusal; its other-table reads now carry the deal's org too", async () => {
    const svc = fakeClient({ mandates: [{ data: [], error: null }] });
    admin.client = svc.client;
    const caller = fakeClient({
      deals: [
        systemDeal("d1", { property_id: "p1" }),
        { data: [], error: null },
        systemDeal("d1", { property_id: "p1" }),
      ],
      properties: [{ data: { title_deed_status: "unknown" }, error: null }],
    });

    await recomputeDealHealth(caller.client as never, "d1");

    const [read, write] = chains(caller, "deals");
    expect(eqs(read), "RLS bounds the session's read").toEqual([["id", "d1"]]);
    expect(eqs(write).map(([col]) => col)).toEqual(["id", "updated_at"]);
    expect(caller.argsOf("properties", "eq"), "its other-table reads carry the deal's org").toEqual([
      ["id", "p1"],
      ["org_id", ORG],
    ]);
    expect(admin.built, "the mandate read only").toBe(1);
    expect(reports(), "a refused session write is the silent no-op it always was").toEqual([]);
  });
});
