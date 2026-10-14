import { beforeEach, describe, expect, it, vi } from "vitest";
import { MOVE_NOT_MOVED_TEXT, MOVE_UNCONFIRMED_TEXT } from "@/lib/services/pipeline-move";

/**
 * What `moveDealToStage` says when the move_deal_to_stage RPC (0131) fails
 * (T-malformed-ids; BACKLOG "External audit — 2026-10-14").
 *
 * Before: `if (error) return { error: error.message }` — Postgres' own text
 * for every failure ("invalid input syntax for type uuid", "permission denied
 * for function …", a gateway's words), and the catch handed back whatever a
 * throw said. Now:
 * - P0001 is the function's own `raise exception` ("Deal not found", "Deal is
 *   already won — closed deals do not move stages", "You do not have
 *   permission to move this deal", …): its words are the user-facing
 *   contract and are shown as written;
 * - any other code that certainly rolled back (`certainlyRolledBack`, the
 *   house allowlist) says plainly that the deal was not moved;
 * - everything else — no code, a connection class, a code nobody classified,
 *   a number from a gateway, a throw — is an UNKNOWN outcome: it may have
 *   committed, so it is never "nothing changed", and it is flagged
 *   `unconfirmed` so the board keeps it on screen (lib/services/pipeline-move.ts).
 */

const state = vi.hoisted(() => ({
  rpc: null as null | { error: { code?: unknown; message: string } | null },
  createThrows: false,
  rpcCalls: [] as unknown[][],
}));
const recomputeDealHealth = vi.hoisted(() => vi.fn(async () => {}));
const revalidatePath = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (state.createThrows) throw new Error("cookies() was called outside a request scope");
    return {
      rpc: async (...args: unknown[]) => {
        state.rpcCalls.push(args);
        return { data: null, ...state.rpc };
      },
    };
  },
}));
vi.mock("@/lib/services/health-score", () => ({ recomputeDealHealth }));
vi.mock("next/cache", () => ({ revalidatePath }));

const { moveDealToStage } = await import("@/lib/actions/deals");

const DEAL = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c01";
const STAGE = "00000000-0000-0000-0000-000000000001";

const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

beforeEach(() => {
  consoleError.mockClear();
  state.rpc = { error: null };
  state.createThrows = false;
  state.rpcCalls = [];
  recomputeDealHealth.mockClear();
  revalidatePath.mockClear();
});

const fail = (code: unknown, message: string) => {
  state.rpc = { error: { code, message } };
};

describe("moveDealToStage answers in the RPC's own words, or in ours — never in Postgres'", () => {
  it("a move that landed: recomputed, revalidated, no error", async () => {
    expect(await moveDealToStage(DEAL, STAGE)).toEqual({ error: null });
    expect(state.rpcCalls).toEqual([["move_deal_to_stage", { p_deal_id: DEAL, p_stage_id: STAGE }]]);
    expect(recomputeDealHealth).toHaveBeenCalledTimes(1);
    expect(revalidatePath).toHaveBeenCalledWith("/pipeline");
  });

  it("P0001 — the function's own refusals — are shown exactly as written", async () => {
    for (const words of [
      "Deal not found",
      "Deal is already won — closed deals do not move stages",
      "Stage not found",
      "Stage belongs to another deal type",
      "Use the deal page to mark this deal won (guarded flow)",
      "You do not have permission to move this deal",
    ]) {
      fail("P0001", words);
      expect(await moveDealToStage(DEAL, STAGE)).toEqual({ error: words });
    }
    expect(revalidatePath, "a refusal does not revalidate (the board refreshes itself)").not.toHaveBeenCalled();
  });

  it("any other code that certainly rolled back: 'not moved', never the database's text", async () => {
    for (const [code, raw] of [
      ["22P02", 'invalid input syntax for type uuid: "x"'],
      ["42501", "permission denied for function move_deal_to_stage"],
      ["40P01", "deadlock detected"],
      ["PGRST202", "Could not find the function public.move_deal_to_stage(p_deal_id, p_stage_id) in the schema cache"],
      ["PGRST301", "JWT expired"],
    ] as const) {
      fail(code, raw);
      const answer = await moveDealToStage(DEAL, STAGE);
      expect(answer, code).toEqual({ error: MOVE_NOT_MOVED_TEXT });
      expect(answer.error).not.toContain(raw);
    }
  });

  it("a P0001 with no words is still certainly refused — said plainly", async () => {
    fail("P0001", "");
    expect(await moveDealToStage(DEAL, STAGE)).toEqual({ error: MOVE_NOT_MOVED_TEXT });
  });

  it("an answer that may follow a commit is UNKNOWN: flagged, never 'not moved', never raw", async () => {
    for (const [code, raw] of [
      ["", "TypeError: fetch failed"], // postgrest-js: a network failure resolves as an error with no code
      [undefined, "<html>502 Bad Gateway</html>"],
      ["08006", "connection failure"],
      ["57014", "canceling statement due to statement timeout"],
      ["40003", "statement completion unknown"],
      ["PGRST000", "Could not connect with the database"],
      ["PGRST999", "a code nobody has classified"],
      [42501, "a gateway body's NUMBER is not PostgREST's code"],
    ] as const) {
      fail(code, raw);
      const answer = await moveDealToStage(DEAL, STAGE);
      expect(answer, String(code)).toEqual({ error: MOVE_UNCONFIRMED_TEXT, unconfirmed: true });
    }
    expect(MOVE_UNCONFIRMED_TEXT).not.toMatch(/not (been )?moved|nothing (was )?changed/i);
  });

  it("a throw is UNKNOWN too — the RPC may have run — and its message is not shown, only logged", async () => {
    state.createThrows = true;
    expect(await moveDealToStage(DEAL, STAGE)).toEqual({ error: MOVE_UNCONFIRMED_TEXT, unconfirmed: true });
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it("a throw AFTER the move committed (the health recompute) is not 'not moved' either", async () => {
    recomputeDealHealth.mockImplementationOnce(async () => {
      throw new Error("supabaseKey is required.");
    });
    expect(await moveDealToStage(DEAL, STAGE)).toEqual({ error: MOVE_UNCONFIRMED_TEXT, unconfirmed: true });
  });
});
