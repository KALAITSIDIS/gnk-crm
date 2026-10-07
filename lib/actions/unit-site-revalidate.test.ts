import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * The unit actions tell the marketing site, after the commit (T-unit-site-revalidate).
 *
 * A unit that is `public` and `available` is a listing of its own on the
 * site — its own card on the home page and the list, its own page at
 * /properties/<reference> (public_listings, 0088). Until this change the
 * three unit actions that move what such a page shows — a status change, a
 * bulk reprice, a unit-type stamp — refreshed the CRM's pages and never the
 * site's, so a unit SOLD in the CRM stayed for sale on the site until the
 * site's own timers caught up (up to the hour of next.config.ts expireTime on
 * a quiet page).
 *
 * The REAL notifier is in the chain (lib/services/site-revalidate.ts) with a
 * url and key set, and `fetch` is the spy: a knock the action sends is SEEN,
 * one it forgets is a test failure, and a site that fails cannot reach the
 * action's answer. What is pinned:
 *
 *  - one status change of a PUBLISHED unit: one knock naming its reference —
 *    whichever way the status moves, sold and reserved included (a page that
 *    is leaving the site has to be rebuilt as much as one arriving);
 *  - a bulk change (reprice, unit type): ONE knock asking for every listing
 *    page, whatever the number of units — no reference, nothing private, no
 *    request per unit;
 *  - nothing is sent for a write that definitely did not commit, or whose
 *    commit is unknown (the form re-sends that submission, and the replay
 *    knocks); a confirmed replay knocks again, writing nothing;
 *  - a private or archived unit is never announced;
 *  - the knock is scheduled straight after the commit: a status change's
 *    timeline line and follow-up can THROW after it and cannot swallow it, and
 *    a bulk change's alert and page refreshes (which catch their own
 *    failures) are not conditions of it; a site that is down never turns the
 *    save into an error.
 */
const state = vi.hoisted(() => ({
  caller: null as unknown,
  role: "admin" as string,
}));
const logEvent = vi.hoisted(() => vi.fn(async () => {}));
const completeListingStatusChecks = vi.hoisted(() => vi.fn(async () => 0));
const raiseBulkPriceDropAlert = vi.hoisted(() =>
  vi.fn(async () => ({ newlyMatching: 0, taskCreated: false, unitsAffected: 0 })),
);
const revalidatePath = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.caller }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "u-1", orgId: "org-1", role: state.role }),
}));
vi.mock("@/lib/services/events", () => ({ logEvent, logEvents: vi.fn() }));
vi.mock("@/lib/services/followup-tasks", () => ({ completeListingStatusChecks }));
vi.mock("@/lib/services/match-alerts", () => ({ raiseBulkPriceDropAlert }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn() }));
// Deliberately NOT mocked: @/lib/services/site-revalidate. That is the point.

const { updateUnitStatus, applyPriceUplift, createPriceListVersion, applyUnitType } = await import(
  "@/lib/actions/units"
);
const { resetSiteRevalidateLatch } = await import("@/lib/services/site-revalidate");

const OLD = { ...process.env };
const SITE = "https://site.example/api/revalidate";
const UNIT = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const PARENT = "3b2a1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d";
const PROJECT = PARENT;
const TYPE = "6e5d4c3b-2a1f-4e0d-9c8b-7a6f5e4d3c2b";
const OP = "4c3b2a1d-0e9f-4b8a-9d7c-6f5e4d3c2b1a";
const U1 = "5d4c3b2a-1f0e-4c9b-8a7d-6e5f4d3c2b1a";
const EVERY_LISTING = { scope: "listings" };

/** Every knock sent, decoded — and what the fake database had been asked to write when it went out. */
let knocks: Array<{ url: string; key: string | undefined; body: Record<string, unknown>; writesBefore: number }>;
let site: { mode: "ok" | "down" | "500" };
let writes: () => number;

beforeEach(() => {
  vi.restoreAllMocks();
  resetSiteRevalidateLatch();
  process.env = { ...OLD, SITE_REVALIDATE_URL: SITE, SITE_REVALIDATE_KEY: "k-secret" };
  state.role = "admin";
  logEvent.mockReset().mockResolvedValue(undefined);
  completeListingStatusChecks.mockReset().mockResolvedValue(0);
  raiseBulkPriceDropAlert.mockClear();
  revalidatePath.mockReset();
  knocks = [];
  site = { mode: "ok" };
  writes = () => 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    knocks.push({
      url: String(input),
      key: headers["x-gnk-revalidate-key"],
      body: JSON.parse(String(init?.body ?? "null")) as Record<string, unknown>,
      writesBefore: writes(),
    });
    if (site.mode === "down") throw new TypeError("fetch failed");
    if (site.mode === "500") return new Response("nope", { status: 500 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
});

/** The knock is fire-and-forget (after(), or inline outside a request); give it a tick to land. */
const settle = () => new Promise((r) => setTimeout(r, 10));

/* ------------------------------------------------------------------ */
/* updateUnitStatus                                                    */
/* ------------------------------------------------------------------ */

type UnitRow = { reference: string; status: string; visibility: string };

/** The unit as read first, then the update's row-count proof as the database answers it. */
function unitHarness(unit: UnitRow | null, update: FakePage = { data: [{ id: UNIT, reference: unit?.reference, visibility: unit?.visibility }], error: null }) {
  const caller = fakeClient({
    properties: [
      { data: unit ? { id: UNIT, org_id: "org-1", parent_id: PARENT, ...unit } : null, error: null },
      update,
    ],
  });
  state.caller = caller.client;
  writes = () => caller.argsOf("properties", "update").length;
  return caller;
}

const PUBLISHED = { reference: "PAF0007-B203", visibility: "public" };

describe("updateUnitStatus — a published unit's page is rebuilt whichever way its status moves", () => {
  it("available → sold: saved, and ONE knock naming the unit, sent after the write", async () => {
    const caller = unitHarness({ ...PUBLISHED, status: "available" });
    await expect(updateUnitStatus(UNIT, "sold")).resolves.toEqual({ error: null });
    await settle();
    expect(caller.argsOf("properties", "update")).toEqual([[{ status: "sold" }]]);
    expect(knocks).toHaveLength(1);
    expect(knocks[0]).toMatchObject({ url: SITE, key: "k-secret", body: { reference: "PAF0007-B203" } });
    expect(knocks[0]!.writesBefore, "the knock follows the write").toBe(1);
  });

  for (const to of ["reserved", "under_offer", "withdrawn", "rented", "draft"]) {
    it(`available → ${to}: the page that is leaving the site is rebuilt too`, async () => {
      unitHarness({ ...PUBLISHED, status: "available" });
      await expect(updateUnitStatus(UNIT, to)).resolves.toEqual({ error: null });
      await settle();
      expect(knocks.map((k) => k.body)).toEqual([{ reference: "PAF0007-B203" }]);
    });
  }

  it("sold → available (an admin's audited regression): the unit returns to the site, and the site is told", async () => {
    unitHarness({ ...PUBLISHED, status: "sold" });
    await expect(updateUnitStatus(UNIT, "available")).resolves.toEqual({ error: null });
    await settle();
    expect(knocks.map((k) => k.body)).toEqual([{ reference: "PAF0007-B203" }]);
  });

  it("the visibility the WRITE returned decides — a unit published in the meantime is announced", async () => {
    unitHarness(
      { reference: "PAF0007-B204", visibility: "private", status: "available" },
      { data: [{ id: UNIT, reference: "PAF0007-B204", visibility: "public" }], error: null },
    );
    await updateUnitStatus(UNIT, "sold");
    await settle();
    expect(knocks.map((k) => k.body)).toEqual([{ reference: "PAF0007-B204" }]);
  });

  for (const visibility of ["private", "archived"]) {
    it(`a ${visibility} unit: saved, and the site is never told about it`, async () => {
      const caller = unitHarness({ reference: "PAF0007-B205", visibility, status: "available" });
      await expect(updateUnitStatus(UNIT, "sold")).resolves.toEqual({ error: null });
      await settle();
      expect(caller.argsOf("properties", "update")).toHaveLength(1);
      expect(knocks).toEqual([]);
    });
  }

  it("a reference the site cannot take as a path (a typed block in lower case): every listing page instead, never dropped", async () => {
    unitHarness({ reference: "PAF0007-b 2/03", visibility: "public", status: "available" });
    await updateUnitStatus(UNIT, "sold");
    await settle();
    expect(knocks.map((k) => k.body)).toEqual([EVERY_LISTING]);
  });

  describe("a write that definitely did not happen sends nothing", () => {
    it("an invalid status", async () => {
      unitHarness({ ...PUBLISHED, status: "available" });
      expect((await updateUnitStatus(UNIT, "gone")).error).toMatch(/Invalid status/);
      await settle();
      expect(knocks).toEqual([]);
    });

    it("no such unit (or not the caller's to read)", async () => {
      unitHarness(null);
      expect((await updateUnitStatus(UNIT, "sold")).error).toBe("Unit not found");
      await settle();
      expect(knocks).toEqual([]);
    });

    it("a listing manager may not move a sold unit back to market", async () => {
      state.role = "listing_manager";
      const caller = unitHarness({ ...PUBLISHED, status: "sold" });
      expect((await updateUnitStatus(UNIT, "available")).error).toMatch(/Only an admin/);
      await settle();
      expect(caller.argsOf("properties", "update")).toEqual([]);
      expect(knocks).toEqual([]);
    });

    it("the update returns an error", async () => {
      unitHarness({ ...PUBLISHED, status: "available" }, { data: null, error: { code: "23514", message: "check" } });
      expect((await updateUnitStatus(UNIT, "sold")).error).toBe("check");
      await settle();
      expect(knocks).toEqual([]);
    });

    it("RLS filters the update to zero rows", async () => {
      unitHarness({ ...PUBLISHED, status: "available" }, { data: [], error: null });
      expect((await updateUnitStatus(UNIT, "sold")).error).toMatch(/Status not changed/);
      await settle();
      expect(knocks).toEqual([]);
    });
  });

  it("a press that repeats a committed change (its answer lost): no write, no event — the knock is sent again", async () => {
    const caller = unitHarness({ ...PUBLISHED, status: "sold" });
    await expect(updateUnitStatus(UNIT, "sold")).resolves.toEqual({ error: null });
    await settle();
    expect(caller.argsOf("properties", "update")).toEqual([]);
    expect(logEvent).not.toHaveBeenCalled();
    expect(knocks.map((k) => k.body)).toEqual([{ reference: "PAF0007-B203" }]);
  });

  it("…and the same repeat on a private unit stays silent", async () => {
    unitHarness({ reference: "PAF0007-B205", visibility: "private", status: "sold" });
    await updateUnitStatus(UNIT, "sold");
    await settle();
    expect(knocks).toEqual([]);
  });

  it("the timeline write throws AFTER the commit: the knock was already on its way", async () => {
    unitHarness({ ...PUBLISHED, status: "available" });
    logEvent.mockRejectedValueOnce(new Error("logEvent failed (property.status_changed): boom"));
    await updateUnitStatus(UNIT, "sold").catch(() => undefined);
    await settle();
    expect(knocks.map((k) => k.body)).toEqual([{ reference: "PAF0007-B203" }]);
  });

  it("the follow-up task step throws AFTER the commit: the knock was already on its way", async () => {
    unitHarness({ ...PUBLISHED, status: "available" });
    completeListingStatusChecks.mockRejectedValueOnce(new Error("tasks: boom"));
    await updateUnitStatus(UNIT, "sold").catch(() => undefined);
    await settle();
    expect(knocks.map((k) => k.body)).toEqual([{ reference: "PAF0007-B203" }]);
  });

  for (const mode of ["down", "500"] as const) {
    it(`the site is ${mode === "down" ? "unreachable" : "answering 500"}: the status change is still reported saved`, async () => {
      site.mode = mode;
      unitHarness({ ...PUBLISHED, status: "available" });
      await expect(updateUnitStatus(UNIT, "sold")).resolves.toEqual({ error: null });
      await settle();
      expect(knocks).toHaveLength(1);
    });
  }
});

/* ------------------------------------------------------------------ */
/* applyPriceUplift / createPriceListVersion (0141)                    */
/* ------------------------------------------------------------------ */

type Answer = { data: unknown; error: unknown };

/** A client whose rpc answers once, and whose project read (the bulk alert's) answers as given. */
function rpcHarness(answer: Answer | (() => Promise<Answer>), projectRead: FakePage = { data: { id: PROJECT, reference: "PAF0007", assigned_agent_id: null }, error: null }) {
  const rpc = vi.fn(typeof answer === "function" ? answer : async () => answer);
  const reads = fakeClient({ properties: [projectRead] });
  state.caller = { rpc, from: reads.client.from };
  writes = () => rpc.mock.calls.length;
  return rpc;
}

function uplift() {
  const fd = new FormData();
  for (const [k, v] of Object.entries({
    project_id: PROJECT,
    block: "",
    mode: "percent",
    amount: "3",
    notes: "",
    operation_id: OP,
    expected: JSON.stringify([{ id: U1, price: 250000 }]),
  }))
    fd.set(k, v);
  return applyPriceUplift({ error: null, savedAt: null }, fd);
}

const reprice = (result: "applied" | "replayed", changes = [{ id: U1, reference: "PAF0007-A1", from: 250000, to: 257500 }]) => ({
  data: {
    result,
    kind: "reprice",
    project_id: PROJECT,
    org_id: "org-1",
    actor_id: "u-1",
    version: 4,
    units: changes.length,
    changed: changes.length,
    changes,
  },
  error: null,
});

describe("applyPriceUplift — a committed reprice rebuilds every listing page, in one knock", () => {
  it("applied: saved, and ONE knock for every listing page — no reference, nothing private", async () => {
    rpcHarness(reprice("applied"));
    const r = await uplift();
    expect(r.error).toBeNull();
    await settle();
    expect(knocks).toHaveLength(1);
    expect(knocks[0]!.body, "the whole body: a scope, and nothing a unit could leak through").toEqual(EVERY_LISTING);
    expect(knocks[0]!.writesBefore, "after the database answered").toBe(1);
  });

  it("replayed (the committing request lost its answer): the knock is repeated, nothing is written again", async () => {
    const rpc = rpcHarness(reprice("replayed"));
    const r = await uplift();
    expect(r).toMatchObject({ error: null, replayed: true });
    await settle();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(knocks.map((k) => k.body)).toEqual([EVERY_LISTING]);
  });

  it("a thousand units: still exactly one request — the knock does not grow with the scope", async () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      reference: `PAF0007-A${i}`,
      from: 100000 + i * 100,
      to: 103000 + i * 100,
    }));
    rpcHarness(reprice("applied", many));
    await uplift();
    await settle();
    expect(knocks.map((k) => k.body)).toEqual([EVERY_LISTING]);
  });

  it("stale (the prices moved since the preview): nothing written, nothing sent", async () => {
    rpcHarness({ data: { result: "stale", kind: "reprice", project_id: PROJECT, operation_id: OP }, error: null });
    expect((await uplift()).error).not.toBeNull();
    await settle();
    expect(knocks).toEqual([]);
  });

  const definite: Array<[string, Answer]> = [
    ["the function's own refusal (P0001)", { data: null, error: { code: "P0001", message: "Only admins and listing managers manage price lists." } }],
    ["a lock wait past lock_timeout (55P03)", { data: null, error: { code: "55P03", message: "lock timeout" } }],
    ["a CHECK that rolled it back (23514)", { data: null, error: { code: "23514", message: "check" } }],
  ];
  for (const [what, answer] of definite) {
    it(`${what}: nothing committed, nothing sent`, async () => {
      rpcHarness(answer);
      expect((await uplift()).error).not.toBeNull();
      await settle();
      expect(knocks).toEqual([]);
    });
  }

  const unknown: Array<[string, () => Promise<Answer>]> = [
    ["the request threw", async () => { throw new TypeError("fetch failed"); }],
    ["a gateway error that proves nothing (PGRST000)", async () => ({ data: null, error: { code: "PGRST000", message: "gateway" } })],
    ["an answer that cannot be read", async () => ({ data: { result: "applied" }, error: null })],
  ];
  for (const [what, answer] of unknown) {
    it(`${what}: the outcome is unknown — no knock; the form re-sends and the replay knocks`, async () => {
      rpcHarness(answer);
      expect(await uplift()).toMatchObject({ unconfirmed: true });
      await settle();
      expect(knocks).toEqual([]);
    });
  }

  it("the bulk price-drop alert fails after the commit: saved, and knocked — the knock never waits on the alert", async () => {
    rpcHarness(reprice("applied"), { data: null, error: { code: "XX000", message: "project read failed" } });
    const r = await uplift();
    expect(r.error).toBeNull();
    await settle();
    expect(raiseBulkPriceDropAlert).not.toHaveBeenCalled();
    expect(knocks.map((k) => k.body)).toEqual([EVERY_LISTING]);
  });

  it("a page refresh that throws after the commit: saved, and knocked — the knock never waits on the refresh", async () => {
    rpcHarness(reprice("applied"));
    revalidatePath.mockImplementation(() => {
      throw new Error("static generation store missing");
    });
    expect((await uplift()).error).toBeNull();
    await settle();
    expect(knocks.map((k) => k.body)).toEqual([EVERY_LISTING]);
  });

  for (const mode of ["down", "500"] as const) {
    it(`the site is ${mode === "down" ? "unreachable" : "answering 500"}: the reprice is still reported saved`, async () => {
      site.mode = mode;
      rpcHarness(reprice("applied"));
      const r = await uplift();
      expect(r.error).toBeNull();
      expect(r.unconfirmed).toBeUndefined();
      await settle();
      expect(knocks).toHaveLength(1);
    });
  }
});

describe("createPriceListVersion — a snapshot moves no price, and the site is not told", () => {
  it("applied snapshot: saved, no knock", async () => {
    rpcHarness({ data: { result: "applied", kind: "snapshot", project_id: PROJECT, version: 5, units: 3 }, error: null });
    const fd = new FormData();
    for (const [k, v] of Object.entries({ project_id: PROJECT, notes: "", operation_id: OP })) fd.set(k, v);
    expect((await createPriceListVersion({ error: null, savedAt: null }, fd)).error).toBeNull();
    await settle();
    expect(knocks).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* applyUnitType (0142)                                                */
/* ------------------------------------------------------------------ */

function stamp() {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ project_id: PROJECT, unit_type_id: TYPE, block: "", operation_id: OP })) fd.set(k, v);
  return applyUnitType({ error: null, savedAt: null }, fd);
}
const stamped = (result: "applied" | "replayed") => ({
  data: { result, operation_id: OP, project_id: PROJECT, unit_type: "A1", units: 4, price_changed: 3 },
  error: null,
});

describe("applyUnitType — a committed stamp rebuilds every listing page, in one knock", () => {
  it("applied: saved, and ONE knock for every listing page", async () => {
    rpcHarness(stamped("applied"));
    expect((await stamp()).error).toBeNull();
    await settle();
    expect(knocks).toHaveLength(1);
    expect(knocks[0]!.body).toEqual(EVERY_LISTING);
    expect(knocks[0]!.writesBefore).toBe(1);
  });

  it("replayed: the knock is repeated, nothing is written again", async () => {
    const rpc = rpcHarness(stamped("replayed"));
    expect(await stamp()).toMatchObject({ error: null, replayed: true });
    await settle();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(knocks.map((k) => k.body)).toEqual([EVERY_LISTING]);
  });

  const definite: Array<[string, Answer]> = [
    ["the function's own refusal (P0001)", { data: null, error: { code: "P0001", message: "Only admins and listing managers manage units." } }],
    ["busy (55P03)", { data: null, error: { code: "55P03", message: "lock timeout" } }],
    ["a deadlock broken against this side (40P01)", { data: null, error: { code: "40P01", message: "deadlock" } }],
    ["rolled back (23514)", { data: null, error: { code: "23514", message: "check" } }],
  ];
  for (const [what, answer] of definite) {
    it(`${what}: nothing committed, nothing sent`, async () => {
      rpcHarness(answer);
      expect((await stamp()).error).not.toBeNull();
      await settle();
      expect(knocks).toEqual([]);
    });
  }

  const unknown: Array<[string, () => Promise<Answer>]> = [
    ["the request threw", async () => { throw new TypeError("fetch failed"); }],
    ["a gateway error that proves nothing (PGRST000)", async () => ({ data: null, error: { code: "PGRST000", message: "gateway" } })],
    ["an answer that cannot be read", async () => ({ data: { result: "applied" }, error: null })],
  ];
  for (const [what, answer] of unknown) {
    it(`${what}: unknown — no knock until the replay`, async () => {
      rpcHarness(answer);
      expect(await stamp()).toMatchObject({ unconfirmed: true });
      await settle();
      expect(knocks).toEqual([]);
    });
  }

  it("a page refresh that throws after the commit: saved, and knocked — the knock never waits on the refresh", async () => {
    rpcHarness(stamped("applied"));
    revalidatePath.mockImplementation(() => {
      throw new Error("static generation store missing");
    });
    expect((await stamp()).error).toBeNull();
    await settle();
    expect(knocks.map((k) => k.body)).toEqual([EVERY_LISTING]);
  });

  for (const mode of ["down", "500"] as const) {
    it(`the site is ${mode === "down" ? "unreachable" : "answering 500"}: the stamp is still reported saved`, async () => {
      site.mode = mode;
      rpcHarness(stamped("applied"));
      const r = await stamp();
      expect(r.error).toBeNull();
      expect(r.unconfirmed).toBeUndefined();
      await settle();
      expect(knocks).toHaveLength(1);
    });
  }
});
