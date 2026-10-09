import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * applyUnitType around `apply_unit_type` (0142). The DATABASE decides what is
 * written — supabase/tests/unit-type-apply-actions.test.ts drives this same
 * action against a real stack and pins every rule, race and rollback. This
 * file pins what the action does with the answer:
 *
 * - the form becomes the function's arguments, and nothing else — no read, no
 *   write, no event of its own (the old action's PATCH loop and logEvents);
 * - a committed answer (`applied`, or `replayed`) refreshes the pages, and a
 *   refresh that throws never turns the commit into an error;
 * - it never throws, and says "nothing was changed" only when the error proves
 *   the transaction rolled back; otherwise "could not confirm", flagged
 *   `unconfirmed` and WITHOUT a refresh, so the form re-sends the same
 *   submission.
 */
const state = vi.hoisted(() => ({
  rpc: vi.fn<(name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>>(),
  from: vi.fn(),
  createClientThrows: false,
}));
const revalidatePath = vi.hoisted(() => vi.fn());
const captureMessage = vi.hoisted(() => vi.fn());
const logEvents = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (state.createClientThrows) throw new Error("no cookies");
    return { rpc: state.rpc, from: state.from };
  },
}));
vi.mock("@/lib/services/auth", () => ({ getCurrentProfile: vi.fn() }));
vi.mock("@/lib/services/events", () => ({ logEvent: vi.fn(), logEvents }));
vi.mock("@sentry/nextjs", () => ({ captureMessage }));
vi.mock("next/cache", () => ({ revalidatePath }));

const { applyUnitType } = await import("@/lib/actions/units");
const { UNIT_TYPE_BUSY, UNIT_TYPE_NOTHING_CHANGED, UNIT_TYPE_OUT_OF_DATE, UNIT_TYPE_UNCONFIRMED } = await import(
  "@/lib/validators/unit-types"
);

const PROJECT = "3b2a1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d";
const TYPE = "6e5d4c3b-2a1f-4e0d-9c8b-7a6f5e4d3c2b";
const OP = "4c3b2a1d-0e9f-4b8a-9d7c-6f5e4d3c2b1a";

function apply(fields: Record<string, string | null> = {}) {
  const base: Record<string, string> = { project_id: PROJECT, unit_type_id: TYPE, block: "", operation_id: OP };
  const fd = new FormData();
  for (const [k, v] of Object.entries({ ...base, ...fields })) if (v !== null) fd.set(k, v);
  return applyUnitType({ error: null, savedAt: null }, fd);
}

const answer = (result: "applied" | "replayed") => ({
  data: { result, operation_id: OP, project_id: PROJECT, unit_type: "A1", units: 4, price_changed: 3 },
  error: null,
});

beforeEach(() => {
  state.rpc.mockReset();
  state.from.mockReset();
  state.createClientThrows = false;
  revalidatePath.mockReset();
  captureMessage.mockReset();
  logEvents.mockReset();
});

describe("the form becomes the function's arguments", () => {
  it("all units: the ids and the operation id, the block left out", async () => {
    state.rpc.mockResolvedValueOnce(answer("applied"));
    await apply();
    expect(state.rpc).toHaveBeenCalledTimes(1);
    expect(state.rpc).toHaveBeenCalledWith("apply_unit_type", {
      p_project_id: PROJECT,
      p_unit_type_id: TYPE,
      p_operation_id: OP,
      p_block: undefined,
    });
    // nothing read or written around the function — the old PATCH loop and its
    // after-the-fact logEvents are gone
    expect(state.from).not.toHaveBeenCalled();
    expect(logEvents).not.toHaveBeenCalled();
  });

  it("one block: passed as typed", async () => {
    state.rpc.mockResolvedValueOnce(answer("applied"));
    await apply({ block: "A" });
    expect(state.rpc.mock.calls[0]![1]).toMatchObject({ p_block: "A" });
  });

  it("a form older than 0142 — no operation id — is refused before any call", async () => {
    const r = await apply({ operation_id: null });
    expect(r).toEqual({ error: UNIT_TYPE_OUT_OF_DATE, savedAt: null });
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("ids that are not ids, or an over-long block, are refused before any call", async () => {
    expect((await apply({ project_id: "PAF0001" })).error).toBe("Missing project or type");
    expect((await apply({ unit_type_id: null })).error).toBe("Missing project or type");
    expect((await apply({ block: "x".repeat(21) })).error).toBe("No units in that scope");
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("what each answer becomes", () => {
  it("applied: saved, not a replay, the pages refreshed", async () => {
    state.rpc.mockResolvedValueOnce(answer("applied"));
    const r = await apply();
    expect(r.error).toBeNull();
    expect(r.savedAt).toEqual(expect.any(Number));
    expect(r.replayed).toBe(false);
    expect(revalidatePath.mock.calls.map((c) => c[0])).toEqual([`/properties/${PROJECT}/units`, "/properties"]);
  });

  it("replayed: saved, marked as a replay, the pages refreshed", async () => {
    state.rpc.mockResolvedValueOnce(answer("replayed"));
    const r = await apply();
    expect(r.error).toBeNull();
    expect(r.replayed).toBe(true);
    expect(revalidatePath).toHaveBeenCalledTimes(2);
  });

  it("a refresh that throws never turns a committed stamp into an error", async () => {
    state.rpc.mockResolvedValueOnce(answer("applied"));
    revalidatePath.mockImplementation(() => {
      throw new Error("static generation store missing");
    });
    const r = await apply();
    expect(r.error).toBeNull();
    expect(r.savedAt).toEqual(expect.any(Number));
    expect(r.unconfirmed).toBeUndefined();
  });
});

describe("what each failure becomes — and the action never throws", () => {
  const cases: Array<[string, () => void, string, boolean]> = [
    ["the function's own refusal (P0001)", () => state.rpc.mockResolvedValueOnce({ data: null, error: { code: "P0001", message: "Only admins and listing managers manage units." } }), "Only admins and listing managers manage units.", false],
    ["a lock wait past the function's lock_timeout (55P03)", () => state.rpc.mockResolvedValueOnce({ data: null, error: { code: "55P03", message: "canceling statement due to lock timeout" } }), UNIT_TYPE_BUSY, false],
    ["a deadlock broken against this side (40P01)", () => state.rpc.mockResolvedValueOnce({ data: null, error: { code: "40P01", message: "deadlock detected" } }), UNIT_TYPE_BUSY, false],
    ["a CHECK the stamp broke (23514, rolled back)", () => state.rpc.mockResolvedValueOnce({ data: null, error: { code: "23514", message: "violates check constraint" } }), UNIT_TYPE_NOTHING_CHANGED, false],
    ["no permission (42501)", () => state.rpc.mockResolvedValueOnce({ data: null, error: { code: "42501", message: "permission denied" } }), UNIT_TYPE_NOTHING_CHANGED, false],
    ["a missing function (PGRST202, the database rolled back first)", () => state.rpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "not found" } }), UNIT_TYPE_NOTHING_CHANGED, false],
    ["a statement timeout, which can be reported for a COMMIT that went through (57014)", () => state.rpc.mockResolvedValueOnce({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }), UNIT_TYPE_UNCONFIRMED, true],
    ["an internal error (XX000)", () => state.rpc.mockResolvedValueOnce({ data: null, error: { code: "XX000", message: "internal error" } }), UNIT_TYPE_UNCONFIRMED, true],
    ["a network failure (no code)", () => state.rpc.mockResolvedValueOnce({ data: null, error: { code: "", message: "TypeError: fetch failed" } }), UNIT_TYPE_UNCONFIRMED, true],
    ["a connection lost around the commit (08006)", () => state.rpc.mockResolvedValueOnce({ data: null, error: { code: "08006", message: "connection failure" } }), UNIT_TYPE_UNCONFIRMED, true],
    ["a response built after the commit (PGRST111)", () => state.rpc.mockResolvedValueOnce({ data: null, error: { code: "PGRST111", message: "invalid response header" } }), UNIT_TYPE_UNCONFIRMED, true],
    ["a call that throws", () => state.rpc.mockRejectedValueOnce(new Error("boom")), UNIT_TYPE_UNCONFIRMED, true],
    ["an unreadable answer", () => state.rpc.mockResolvedValueOnce({ data: { result: "stale" }, error: null }), UNIT_TYPE_UNCONFIRMED, true],
    ["an empty answer", () => state.rpc.mockResolvedValueOnce({ data: null, error: null }), UNIT_TYPE_UNCONFIRMED, true],
    ["no client", () => (state.createClientThrows = true), UNIT_TYPE_NOTHING_CHANGED, false],
  ];
  for (const [label, arrange, text, unconfirmed] of cases) {
    it(label, async () => {
      arrange();
      const r = await apply();
      // an unknown outcome is flagged so the form keeps the submission's id;
      // the page is NOT redrawn, so the next press sends the same submission.
      // A lock wait is flagged `busy`: definite for THIS request, but a form
      // re-sending an unknown submission keeps it unknown (sendPinned)
      const busy = text === UNIT_TYPE_BUSY ? { busy: true } : {};
      expect(r).toEqual(unconfirmed ? { error: text, savedAt: null, unconfirmed: true } : { error: text, savedAt: null, ...busy });
      expect(revalidatePath).not.toHaveBeenCalled();
      expect(logEvents).not.toHaveBeenCalled();
    });
  }

  it("never says 'nothing was changed' for an outcome it cannot prove", async () => {
    for (const code of ["57014", "XX000", "", "08006", "53300", "PGRST000", "PGRST001"]) {
      state.rpc.mockResolvedValueOnce({ data: null, error: { code, message: "?" } });
      const r = await apply();
      expect(r.error, code).toBe(UNIT_TYPE_UNCONFIRMED);
      expect(r.unconfirmed, code).toBe(true);
    }
  });
});
