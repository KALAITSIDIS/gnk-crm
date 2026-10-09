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
 *    is leaving the site has to be rebuilt as much as one arriving) — decided
 *    by the visibility set_unit_status answered (0143), and repeated on a
 *    replay or a unit already in that status;
 *  - a bulk change (reprice, unit type): ONE knock asking for every listing
 *    page, whatever the number of units — no reference, nothing private, no
 *    request per unit;
 *  - nothing is sent for a write that definitely did not commit, or whose
 *    commit is unknown (the form re-sends that submission, and the replay
 *    knocks); a confirmed replay knocks again, writing nothing;
 *  - a private or archived unit is never announced;
 *  - the knock is scheduled straight after the commit: a status change's
 *    follow-up can fail or THROW after it and cannot swallow it, and
 *    a bulk change's alert and page refreshes (which catch their own
 *    failures) are not conditions of it; a site that is down never turns the
 *    save into an error.
 */
const state = vi.hoisted(() => ({
  caller: null as unknown,
  role: "admin" as string,
}));
const logEvent = vi.hoisted(() => vi.fn(async () => {}));
const closeListingStatusChecks = vi.hoisted(() =>
  vi.fn<(client: unknown, params: unknown) => Promise<{ closed: number; failed: null | "open" | "unrecorded" }>>(
    async () => ({ closed: 0, failed: null }),
  ),
);
const raiseBulkPriceDropAlert = vi.hoisted(() =>
  vi.fn(async () => ({ newlyMatching: 0, taskCreated: false, unitsAffected: 0 })),
);
const revalidatePath = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.caller }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "u-1", orgId: "org-1", role: state.role }),
}));
vi.mock("@/lib/services/events", () => ({ logEvent, logEvents: vi.fn() }));
vi.mock("@/lib/services/followup-tasks", () => ({ closeListingStatusChecks }));
vi.mock("@/lib/services/match-alerts", () => ({ raiseBulkPriceDropAlert }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn() }));
// Deliberately NOT mocked: @/lib/services/site-revalidate. That is the point.

const { updateUnitStatus, applyPriceUplift, createPriceListVersion, applyUnitType } = await import(
  "@/lib/actions/units"
);
const { resetSiteRevalidateLatch } = await import("@/lib/services/site-revalidate");
const {
  UNIT_STATUS_BUSY,
  UNIT_STATUS_FOLLOW_UP_OPEN,
  UNIT_STATUS_FOLLOW_UP_UNRECORDED,
  UNIT_STATUS_NOTHING_CHANGED,
  UNIT_STATUS_UNCONFIRMED,
} = await import("@/lib/validators/unit-status");

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
  closeListingStatusChecks.mockReset().mockResolvedValue({ closed: 0, failed: null });
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
/* updateUnitStatus (0143: one transaction — set_unit_status)          */
/* ------------------------------------------------------------------ */

type StatusAnswer = { data: unknown; error: unknown };

/** A client whose set_unit_status answers once (or throws); `writes` counts the calls. */
function statusHarness(answer: StatusAnswer | (() => Promise<StatusAnswer>)) {
  const rpc = vi.fn(typeof answer === "function" ? answer : async () => answer);
  state.caller = { rpc };
  writes = () => rpc.mock.calls.length;
  return rpc;
}

const STATUS_OP = "7e6d5c4b-3a2f-4e1d-8c0b-9a8f7e6d5c4b";
const CHANGED_AT = "2026-10-08T09:00:00.123456+00:00";
const PUBLISHED = { reference: "PAF0007-B203", visibility: "public" };

/** What set_unit_status answers for a committed change (or its replay). */
const changed = (
  result: "applied" | "replayed",
  over: Partial<{ reference: string; visibility: string; from: string; to: string; status: string }> = {},
) => ({
  data: {
    result,
    operation_id: STATUS_OP,
    unit_id: UNIT,
    parent_id: PARENT,
    reference: PUBLISHED.reference,
    visibility: PUBLISHED.visibility,
    from: "available",
    to: "sold",
    status: over.to ?? "sold",
    regression: false,
    changed_at: CHANGED_AT,
    org_id: "org-1",
    actor_id: "u-1",
    ...over,
  },
  error: null,
});
const unchanged = (over: Partial<{ reference: string; visibility: string; status: string }> = {}) => ({
  data: { result: "unchanged", unit_id: UNIT, parent_id: PARENT, ...PUBLISHED, status: "sold", ...over },
  error: null,
});

const setStatus = (to = "sold", expected = "available", op = STATUS_OP) => updateUnitStatus(UNIT, to, expected, op);

describe("updateUnitStatus — a published unit's page is rebuilt whichever way its status moves", () => {
  it("available → sold: saved, and ONE knock naming the unit, sent after the database answered", async () => {
    const rpc = statusHarness(changed("applied"));
    const r = await setStatus();
    expect(r).toEqual({ error: null, savedAt: expect.any(Number) });
    await settle();
    expect(rpc.mock.calls).toEqual([
      ["set_unit_status", { p_unit_id: UNIT, p_status: "sold", p_expected: "available", p_operation_id: STATUS_OP }],
    ]);
    expect(knocks).toHaveLength(1);
    expect(knocks[0]).toMatchObject({ url: SITE, key: "k-secret", body: { reference: "PAF0007-B203" } });
    expect(knocks[0]!.writesBefore, "the knock follows the write").toBe(1);
  });

  for (const to of ["reserved", "under_offer", "withdrawn", "rented", "draft"]) {
    it(`available → ${to}: the page that is leaving the site is rebuilt too`, async () => {
      statusHarness(changed("applied", { to }));
      await expect(setStatus(to)).resolves.toMatchObject({ error: null });
      await settle();
      expect(knocks.map((k) => k.body)).toEqual([{ reference: "PAF0007-B203" }]);
    });
  }

  it("sold → available (an admin's audited regression): the unit returns to the site, and the site is told", async () => {
    statusHarness(changed("applied", { from: "sold", to: "available" }));
    await expect(setStatus("available", "sold")).resolves.toMatchObject({ error: null });
    await settle();
    expect(knocks.map((k) => k.body)).toEqual([{ reference: "PAF0007-B203" }]);
  });

  for (const visibility of ["private", "archived"]) {
    it(`a ${visibility} unit: saved, and the site is never told about it`, async () => {
      const rpc = statusHarness(changed("applied", { reference: "PAF0007-B205", visibility }));
      await expect(setStatus()).resolves.toMatchObject({ error: null });
      await settle();
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(knocks).toEqual([]);
    });
  }

  it("a reference the site cannot take as a path (a typed block in lower case): every listing page instead, never dropped", async () => {
    statusHarness(changed("applied", { reference: "PAF0007-b 2/03" }));
    await setStatus();
    await settle();
    expect(knocks.map((k) => k.body)).toEqual([EVERY_LISTING]);
  });

  it("a replay (the committing request lost its answer): the knock is sent again, nothing is written twice", async () => {
    const rpc = statusHarness(changed("replayed"));
    await expect(setStatus()).resolves.toEqual({ error: null, savedAt: expect.any(Number), replayed: true });
    await settle();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(knocks.map((k) => k.body)).toEqual([{ reference: "PAF0007-B203" }]);
  });

  it("a unit already in the asked status: nothing written — the knock is sent again; on a private unit, nothing", async () => {
    statusHarness(unchanged());
    await expect(setStatus()).resolves.toEqual({ error: null, savedAt: expect.any(Number), unchanged: true });
    await settle();
    expect(knocks.map((k) => k.body)).toEqual([{ reference: "PAF0007-B203" }]);
    expect(closeListingStatusChecks, "no change of its own, so no follow-up of its own").not.toHaveBeenCalled();

    knocks = [];
    statusHarness(unchanged({ reference: "PAF0007-B205", visibility: "private" }));
    await setStatus();
    await settle();
    expect(knocks).toEqual([]);
  });

  describe("a change that definitely did not happen sends nothing", () => {
    for (const [label, args] of [
      ["an invalid status", [UNIT, "gone", "available", STATUS_OP]],
      ["a unit id that is not an id", ["PAF0007", "sold", "available", STATUS_OP]],
      ["no expected status (a page older than 0143)", [UNIT, "sold", "", STATUS_OP]],
      ["no operation id", [UNIT, "sold", "available", ""]],
    ] as const) {
      it(`${label}: refused before the database is asked`, async () => {
        const rpc = statusHarness(changed("applied"));
        const r = await updateUnitStatus(...(args as unknown as [string, string, string, string]));
        expect(r.error).toBeTruthy();
        expect(r.unconfirmed ?? false).toBe(false);
        await settle();
        expect(rpc).not.toHaveBeenCalled();
        expect(knocks).toEqual([]);
      });
    }

    it("the function's own refusal (P0001) is said in its words", async () => {
      statusHarness({ data: null, error: { code: "P0001", message: "Only an admin can move a sold or rented unit back to market." } });
      expect(await setStatus("available", "sold")).toEqual({
        error: "Only an admin can move a sold or rented unit back to market.",
        savedAt: null,
      });
      await settle();
      expect(knocks).toEqual([]);
    });

    it("a statement-level error (23514), and the function missing (PGRST202 — the database rolled back first): nothing changed", async () => {
      for (const code of ["23514", "PGRST202"]) {
        statusHarness({ data: null, error: { code, message: "raw database words" } });
        expect(await setStatus()).toEqual({ error: UNIT_STATUS_NOTHING_CHANGED, savedAt: null });
      }
      await settle();
      expect(knocks).toEqual([]);
    });

    it("the unit's lock was held (55P03) or a deadlock was broken (40P01): busy — nothing written, try again", async () => {
      for (const code of ["55P03", "40P01"]) {
        statusHarness({ data: null, error: { code, message: "lock" } });
        expect(await setStatus()).toEqual({ error: UNIT_STATUS_BUSY, savedAt: null, busy: true });
      }
      await settle();
      expect(knocks).toEqual([]);
    });
  });

  it("a unit id sent in upper case: the database's lower-case answer is still about this unit", async () => {
    statusHarness(changed("applied"));
    expect(await updateUnitStatus(UNIT.toUpperCase(), "sold", "available", STATUS_OP)).toMatchObject({ error: null });
  });

  describe("an outcome that is not known sends nothing, and says so", () => {
    it("the request threw (the answer was lost after the database may have committed)", async () => {
      statusHarness(async () => {
        throw new TypeError("fetch failed");
      });
      expect(await setStatus()).toEqual({ error: UNIT_STATUS_UNCONFIRMED, savedAt: null, unconfirmed: true });
      await settle();
      expect(knocks).toEqual([]);
    });

    it("an error that can follow a commit (no code; 57014; 08006), never 'nothing changed'", async () => {
      for (const code of ["", "57014", "08006", undefined]) {
        statusHarness({ data: null, error: { code, message: "?" } });
        expect(await setStatus(), String(code)).toEqual({ error: UNIT_STATUS_UNCONFIRMED, savedAt: null, unconfirmed: true });
      }
      await settle();
      expect(knocks).toEqual([]);
    });

    it("an answer that is not about this unit, or not readable", async () => {
      for (const data of [null, {}, { ...changed("applied").data, unit_id: PARENT }, { ...changed("applied").data, actor_id: null }]) {
        statusHarness({ data, error: null });
        expect(await setStatus()).toEqual({ error: UNIT_STATUS_UNCONFIRMED, savedAt: null, unconfirmed: true });
      }
      await settle();
      expect(knocks).toEqual([]);
    });
  });

  describe("the follow-up after the commit: run on a change and on its replay, never a failure", () => {
    it("closes the checks the status satisfies — on applied AND on replayed, as the caller, in the caller's organisation", async () => {
      for (const result of ["applied", "replayed"] as const) {
        closeListingStatusChecks.mockClear();
        statusHarness(changed(result));
        await setStatus();
        expect(closeListingStatusChecks).toHaveBeenCalledTimes(1);
        expect(closeListingStatusChecks.mock.calls[0]![1]).toEqual({
          propertyId: UNIT,
          orgId: "org-1",
          actorId: "u-1",
          newStatus: "sold",
        });
      }
    });

    it("a replay of a change the unit no longer holds closes nothing — the status now, not a line, satisfies a check", async () => {
      statusHarness(changed("replayed", { status: "available" }));
      expect(await setStatus()).toEqual({ error: null, savedAt: expect.any(Number), replayed: true });
      expect(closeListingStatusChecks).not.toHaveBeenCalled();
    });

    for (const [failed, text] of [
      ["open", UNIT_STATUS_FOLLOW_UP_OPEN],
      ["unrecorded", UNIT_STATUS_FOLLOW_UP_UNRECORDED],
    ] as const) {
      it(`a follow-up left ${failed}: the change is saved, the notice says what is left, the knock went out`, async () => {
        statusHarness(changed("applied"));
        closeListingStatusChecks.mockResolvedValueOnce({ closed: 0, failed });
        expect(await setStatus()).toEqual({ error: null, savedAt: expect.any(Number), notice: text });
        await settle();
        expect(knocks.map((k) => k.body)).toEqual([{ reference: "PAF0007-B203" }]);
      });
    }

    it("the follow-up THROWS after the commit: still saved, with the notice; the knock was already on its way", async () => {
      statusHarness(changed("applied"));
      closeListingStatusChecks.mockRejectedValueOnce(new Error("no service key"));
      expect(await setStatus()).toEqual({ error: null, savedAt: expect.any(Number), notice: UNIT_STATUS_FOLLOW_UP_OPEN });
      await settle();
      expect(knocks.map((k) => k.body)).toEqual([{ reference: "PAF0007-B203" }]);
    });

    it("a page refresh that throws never turns the commit into an error", async () => {
      statusHarness(changed("applied"));
      revalidatePath.mockImplementation(() => {
        throw new Error("refresh");
      });
      expect(await setStatus()).toEqual({ error: null, savedAt: expect.any(Number) });
    });
  });

  for (const mode of ["down", "500"] as const) {
    it(`the site is ${mode === "down" ? "unreachable" : "answering 500"}: the status change is still reported saved`, async () => {
      site.mode = mode;
      statusHarness(changed("applied"));
      await expect(setStatus()).resolves.toEqual({ error: null, savedAt: expect.any(Number) });
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
