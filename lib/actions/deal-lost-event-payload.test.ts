import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Marking a deal lost stores the typed reason on the DEAL ROW and logs the act
 * — which deal, that it was lost, and the lost stage's name — never the
 * reason itself (audit SEC-03, DECISIONS T-event-typed-text-shape).
 *
 * Since 0117 the whole close — the lock, the open-status check, the UPDATE and
 * the `lost` event — happens inside `close_deal`, in one transaction, and the
 * event's shape is pinned where it is built: supabase/tests/deal-close.test.ts
 * (`{ stage }` exactly, and not one word of the reason anywhere in the
 * organisation's chain). What THIS file pins is the action's side of that
 * contract: the reason leaves the action exactly once, as `p_lost_reason` to
 * `close_deal`, and the action writes nothing itself — no table, no event —
 * so there is no second path by which the words could reach the chain.
 *
 * The mocked client exposes `rpc` and nothing else: any `.from(...)` the
 * action attempted would throw here, and every test below would fail.
 */

const state = vi.hoisted(() => ({
  rpc: vi.fn<(name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>>(),
}));
const revalidatePath = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc: state.rpc }) }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "agent-1", orgId: "org-1", role: "agent" }),
}));
vi.mock("next/cache", () => ({ revalidatePath }));

const { markDealLost } = await import("@/lib/actions/deals");

const DEAL_ID = "9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e01";
// synthetic: a name, a phone number and an e-mail — none may reach the chain
const REASON =
  "Eleni Charalambous bought her cousin's villa instead; call 99 333 444 or eleni.c@example.invalid";

function markLost(reason = REASON) {
  const fd = new FormData();
  fd.set("deal_id", DEAL_ID);
  fd.set("lost_reason", reason);
  return markDealLost({ error: null, savedAt: null }, fd);
}

const closed = { result: "closed", status: "lost", deal_id: DEAL_ID, org_id: "org-1", stage: "Lost" };

beforeEach(() => {
  state.rpc.mockReset();
  revalidatePath.mockReset();
});

describe("markDealLost hands the reason to close_deal and writes nothing itself", () => {
  it("sends the trimmed reason as p_lost_reason, and only there", async () => {
    state.rpc.mockResolvedValue({ data: closed, error: null });
    const result = await markLost(`  ${REASON}  `);
    expect(result).toMatchObject({ error: null, notice: null });
    expect(result.savedAt).toEqual(expect.any(Number));
    expect(state.rpc).toHaveBeenCalledTimes(1);
    expect(state.rpc).toHaveBeenCalledWith("close_deal", {
      p_outcome: "lost",
      p_deal_id: DEAL_ID,
      p_lost_reason: REASON,
    });
  });

  it("revalidates the deal, the pipeline, the dashboard and the tasks the close supersedes", async () => {
    state.rpc.mockResolvedValue({ data: closed, error: null });
    await markLost();
    expect(revalidatePath.mock.calls.map((c) => c[0])).toEqual([
      `/deals/${DEAL_ID}`,
      "/pipeline",
      "/dashboard",
      "/tasks",
    ]);
  });

  it("a missing or too-short reason is refused before anything is asked of the database", async () => {
    for (const reason of ["  ", "ab"]) {
      const result = await markLost(reason);
      expect(result.error).toMatch(/reason/i);
      expect(result.savedAt).toBeNull();
    }
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it("a repeat of a Lost that already landed is not an error, and says nothing changed", async () => {
    state.rpc.mockResolvedValue({
      data: { result: "already_closed", status: "lost", deal_id: DEAL_ID },
      error: null,
    });
    const result = await markLost();
    expect(result.error).toBeNull();
    expect(result.savedAt).toEqual(expect.any(Number));
    expect(result.notice).toBe("This deal was already marked lost — nothing was changed.");
    expect(result.alreadyClosed, "the dialog must not announce a repeat as a fresh success").toBe(true);
  });

  it("a deal already WON answers conflict: an error, nothing saved", async () => {
    state.rpc.mockResolvedValue({
      data: { result: "conflict", status: "won", deal_id: DEAL_ID },
      error: null,
    });
    const result = await markLost();
    expect(result).toEqual({
      error: "This deal was already marked won — it was not marked lost.",
      savedAt: null,
      pageRefreshed: true,
    });
    // the page is refreshed so it shows the outcome that did commit
    expect(revalidatePath).toHaveBeenCalledWith(`/deals/${DEAL_ID}`);
  });

  it("the function's own refusal (P0001) is shown as it is", async () => {
    state.rpc.mockResolvedValue({ data: null, error: { code: "P0001", message: "Deal not found" } });
    expect(await markLost()).toEqual({ error: "Deal not found", savedAt: null });
  });

  it("an unknown answer says so — and, for a Lost, says nothing about a Won's reminders", async () => {
    state.rpc.mockResolvedValue({ data: null, error: { message: "TypeError: fetch failed", code: "" } });
    const result = await markLost();
    expect(result.error).toBe(
      "Could not confirm whether the deal was closed — reload the page to see its current state.",
    );
    expect(result.pageRefreshed).toBe(true);
    expect(revalidatePath).toHaveBeenCalledWith(`/deals/${DEAL_ID}`);
  });
});
