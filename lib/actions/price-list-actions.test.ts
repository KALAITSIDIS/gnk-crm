import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * applyPriceUplift / createPriceListVersion around `record_price_list_version`
 * (0141). The DATABASE decides what is written — supabase/tests/
 * price-list-version.test.ts pins every rule, race and rollback on a real
 * stack, and price-uplift-actions.test.ts drives these same actions against
 * it. This file pins what the actions do with the answer:
 *
 * - the form becomes the function's arguments, and nothing else;
 * - the bulk price-drop alert runs for a committed reprice — `applied`, or a
 *   `replayed` one whose committing request may have lost its answer first —
 *   never for a stale answer, and its failure — or a failed page refresh —
 *   never turns a committed change into an error;
 * - they never throw, and say "nothing was changed" only when the error
 *   proves the transaction rolled back; otherwise "could not confirm",
 *   flagged `unconfirmed` and WITHOUT a refresh, so the form re-sends the same
 *   submission (review of T-price-uplift-atomic).
 */
const state = vi.hoisted(() => ({
  rpc: vi.fn<(name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>>(),
  projectRead: { data: { id: "p", reference: "PAF0007", assigned_agent_id: null } as unknown, error: null as unknown },
  createClientThrows: false,
}));
const revalidatePath = vi.hoisted(() => vi.fn());
const raiseBulkPriceDropAlert = vi.hoisted(() => vi.fn(async () => ({ newlyMatching: 0, taskCreated: false, unitsAffected: 0 })));
const captureMessage = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (state.createClientThrows) throw new Error("no cookies");
    return {
      rpc: state.rpc,
      from: () => ({ select: () => ({ eq: () => ({ single: async () => state.projectRead }) }) }),
    };
  },
}));
vi.mock("@/lib/services/match-alerts", () => ({ raiseBulkPriceDropAlert }));
vi.mock("@/lib/services/auth", () => ({ getCurrentProfile: vi.fn() }));
vi.mock("@/lib/services/events", () => ({ logEvent: vi.fn(), logEvents: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureMessage }));
vi.mock("next/cache", () => ({ revalidatePath }));

const { applyPriceUplift, createPriceListVersion } = await import("@/lib/actions/units");
const {
  PRICES_BUSY,
  PRICES_NOTHING_CHANGED,
  PRICES_OUT_OF_DATE,
  PRICES_STALE,
  PRICES_UNCONFIRMED,
} = await import("@/lib/validators/price-lists");

const PROJECT = "3b2a1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d";
const OP = "4c3b2a1d-0e9f-4b8a-9d7c-6f5e4d3c2b1a";
const U1 = "5d4c3b2a-1f0e-4c9b-8a7d-6e5f4d3c2b1a";

function uplift(fields: Record<string, string | null> = {}) {
  const base: Record<string, string> = {
    project_id: PROJECT,
    block: "",
    mode: "percent",
    amount: "3",
    notes: "",
    operation_id: OP,
    expected: JSON.stringify([{ id: U1, price: 250000 }]),
  };
  const fd = new FormData();
  for (const [k, v] of Object.entries({ ...base, ...fields })) if (v !== null) fd.set(k, v);
  return applyPriceUplift({ error: null, savedAt: null }, fd);
}
function snapshot(fields: Record<string, string | null> = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ project_id: PROJECT, notes: "", operation_id: OP, ...fields })) if (v !== null) fd.set(k, v);
  return createPriceListVersion({ error: null, savedAt: null }, fd);
}

const applied = (extra: Record<string, unknown> = {}) => ({
  data: {
    result: "applied",
    kind: "reprice",
    project_id: PROJECT,
    org_id: "org-1",
    actor_id: "user-1",
    version: 4,
    units: 1,
    changed: 1,
    changes: [{ id: U1, reference: "PAF0007-A1", from: 250000, to: 257500 }],
    ...extra,
  },
  error: null,
});

beforeEach(() => {
  state.rpc.mockReset();
  state.projectRead = { data: { id: PROJECT, reference: "PAF0007", assigned_agent_id: null }, error: null };
  state.createClientThrows = false;
  revalidatePath.mockReset();
  raiseBulkPriceDropAlert.mockClear();
  captureMessage.mockClear();
});

describe("the form becomes the function's arguments", () => {
  it("a reprice: every field, the block left out for 'all units', the note trimmed, the reviewed prices parsed", async () => {
    state.rpc.mockResolvedValueOnce(applied());
    await uplift({ notes: "  from 1 September  " });
    expect(state.rpc).toHaveBeenCalledTimes(1);
    expect(state.rpc).toHaveBeenCalledWith("record_price_list_version", {
      p_project_id: PROJECT,
      p_operation_id: OP,
      p_notes: "from 1 September",
      p_mode: "percent",
      p_amount: 3,
      p_block: undefined,
      p_expected: [{ id: U1, price: 250000 }],
    });
  });

  it("a plain version: no change at all", async () => {
    state.rpc.mockResolvedValueOnce(applied({ kind: "snapshot", changes: undefined, changed: undefined }));
    await snapshot({ notes: "" });
    expect(state.rpc).toHaveBeenCalledWith("record_price_list_version", {
      p_project_id: PROJECT,
      p_operation_id: OP,
      p_notes: undefined,
    });
  });

  it("a form older than 0141 — no operation id, no reviewed prices — is refused before any call", async () => {
    for (const r of [
      await uplift({ operation_id: null }),
      await uplift({ expected: null }),
      await uplift({ expected: "not json" }),
      await uplift({ expected: JSON.stringify([{ id: "U1", price: 1 }]) }),
      await snapshot({ operation_id: null }),
    ]) {
      expect(r).toEqual({ error: PRICES_OUT_OF_DATE, savedAt: null });
    }
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("zero and non-numbers are refused before any call", async () => {
    expect((await uplift({ amount: "0" })).error).toBe("Enter a change other than zero");
    expect((await uplift({ amount: "Infinity" })).error).toBeTruthy();
    expect((await uplift({ amount: "abc" })).error).toBeTruthy();
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("what each answer becomes", () => {
  it("applied: saved, the version, the alert with the committed changes, the pages refreshed", async () => {
    state.rpc.mockResolvedValueOnce(applied());
    const r = await uplift();
    expect(r).toMatchObject({ error: null, version: 4, replayed: false });
    expect(r.savedAt).toBeTypeOf("number");
    expect(raiseBulkPriceDropAlert).toHaveBeenCalledTimes(1);
    expect(raiseBulkPriceDropAlert).toHaveBeenCalledWith(expect.anything(), {
      orgId: "org-1",
      actorId: "user-1",
      project: { id: PROJECT, reference: "PAF0007", assigned_agent_id: null },
      changes: [{ id: U1, reference: "PAF0007-A1", from: 250000, to: 257500 }],
    });
    expect(revalidatePath).toHaveBeenCalledWith(`/properties/${PROJECT}/units`);
    expect(revalidatePath).toHaveBeenCalledWith("/properties");
  });

  it("replayed: saved, marked as a replay, and the alert raised from the changes the database read back", async () => {
    // the committing request may have lost its answer before its alert ran;
    // the alert's own guard (one open task per project) keeps a repeat quiet
    state.rpc.mockResolvedValueOnce(applied({ result: "replayed" }));
    const r = await uplift();
    expect(r).toMatchObject({ error: null, version: 4, replayed: true });
    expect(raiseBulkPriceDropAlert).toHaveBeenCalledTimes(1);
    expect(raiseBulkPriceDropAlert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ changes: [{ id: U1, reference: "PAF0007-A1", from: 250000, to: 257500 }] }),
    );
    expect(revalidatePath).toHaveBeenCalled();
  });

  it("stale: nothing was changed, the page redraws, no alert", async () => {
    state.rpc.mockResolvedValueOnce({ data: { result: "stale", kind: "reprice", project_id: PROJECT }, error: null });
    const r = await uplift();
    expect(r).toEqual({ error: PRICES_STALE, savedAt: null });
    expect(raiseBulkPriceDropAlert).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith(`/properties/${PROJECT}/units`);
  });

  it("an alert that fails, or a refresh that throws, never turns a committed change into an error", async () => {
    state.rpc.mockResolvedValueOnce(applied());
    raiseBulkPriceDropAlert.mockRejectedValueOnce(new Error("requirements read failed"));
    revalidatePath.mockImplementation(() => {
      throw new Error("no request scope");
    });
    const r = await uplift();
    expect(r).toMatchObject({ error: null, version: 4, replayed: false });
  });

  it("an answer without readable changes skips the alert and still reports the save", async () => {
    state.rpc.mockResolvedValueOnce(applied({ changes: [{ id: U1 }] }));
    expect(await uplift()).toMatchObject({ error: null, version: 4 });
    expect(raiseBulkPriceDropAlert).not.toHaveBeenCalled();
  });
});

describe("what each failure becomes — and the action never throws", () => {
  const cases: Array<[string, () => void, string, boolean]> = [
    ["the function's own refusal (P0001)", () => state.rpc.mockResolvedValueOnce({ data: null, error: { code: "P0001", message: "Only admins and listing managers manage price lists." } }), "Only admins and listing managers manage price lists.", false],
    ["a lock wait that timed out (55P03)", () => state.rpc.mockResolvedValueOnce({ data: null, error: { code: "55P03", message: "canceling statement due to lock timeout" } }), PRICES_BUSY, false],
    ["a deadlock broken against this side (40P01)", () => state.rpc.mockResolvedValueOnce({ data: null, error: { code: "40P01", message: "deadlock detected" } }), PRICES_BUSY, false],
    ["another SQLSTATE (rolled back)", () => state.rpc.mockResolvedValueOnce({ data: null, error: { code: "23505", message: "duplicate key" } }), PRICES_NOTHING_CHANGED, false],
    ["a missing function (PGRST202, the database rolled back first)", () => state.rpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "not found" } }), PRICES_NOTHING_CHANGED, false],
    ["a statement timeout, which can be reported for a COMMIT that went through (57014)", () => state.rpc.mockResolvedValueOnce({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }), PRICES_UNCONFIRMED, true],
    ["an internal error (XX000)", () => state.rpc.mockResolvedValueOnce({ data: null, error: { code: "XX000", message: "internal error" } }), PRICES_UNCONFIRMED, true],
    ["a network failure (no code)", () => state.rpc.mockResolvedValueOnce({ data: null, error: { code: "", message: "TypeError: fetch failed" } }), PRICES_UNCONFIRMED, true],
    ["a connection lost around the commit (08006)", () => state.rpc.mockResolvedValueOnce({ data: null, error: { code: "08006", message: "connection failure" } }), PRICES_UNCONFIRMED, true],
    ["a call that throws", () => state.rpc.mockRejectedValueOnce(new Error("boom")), PRICES_UNCONFIRMED, true],
    ["an unreadable answer", () => state.rpc.mockResolvedValueOnce({ data: { result: "closed" }, error: null }), PRICES_UNCONFIRMED, true],
    ["no client", () => (state.createClientThrows = true), PRICES_NOTHING_CHANGED, false],
  ];
  for (const [label, arrange, text, unconfirmed] of cases) {
    for (const [name, run] of [
      ["reprice", () => uplift()],
      ["snapshot", () => snapshot()],
    ] as const) {
      it(`${name}: ${label}`, async () => {
        arrange();
        const r = await run();
        // an unknown outcome is flagged so the form keeps the submission's id;
        // the page is NOT redrawn, so the next press sends the same submission
        expect(r).toEqual(unconfirmed ? { error: text, savedAt: null, unconfirmed: true } : { error: text, savedAt: null });
        expect(raiseBulkPriceDropAlert).not.toHaveBeenCalled();
        expect(revalidatePath).not.toHaveBeenCalled();
      });
    }
  }
});
