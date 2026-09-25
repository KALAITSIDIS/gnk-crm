import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * markDealWon around `close_deal` (0117). The DATABASE decides whether the
 * deal closes — supabase/tests/deal-close.test.ts pins every rule, race and
 * rollback on a real stack, and deal-close-actions.test.ts drives these same
 * actions against it. This file pins what the action does with the answer:
 *
 * - it sends the form as `close_deal`'s arguments and nothing else;
 * - it raises the Won asks ONLY when its own request committed the close
 *   (`closed`), never on `already_closed` / `conflict`, so a double submit or
 *   a competing close cannot raise them twice;
 * - a follow-up that fails AFTER the commit is a caveat on a success, never an
 *   error — the deal IS won — and the caveat says the TRUE thing: the reminder
 *   was not created (check by hand), or it was and only its timeline line is
 *   missing (tell an admin);
 * - it never throws, and it says "nothing was changed" only when the error
 *   proves the transaction rolled back.
 */

type Fake = ReturnType<typeof fakeClient>;
const state = vi.hoisted(() => ({
  rpc: vi.fn<(name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>>(),
  fake: null as unknown,
  adminFake: null as unknown,
  profile: vi.fn(async () => ({ id: "agent-1", orgId: "org-1", role: "agent" })),
}));
const revalidatePath = vi.hoisted(() => vi.fn());
const raiseLiveHoldCheck = vi.hoisted(() => vi.fn(async () => "not_needed"));
const recomputeDealHealth = vi.hoisted(() => vi.fn(async () => undefined));
const captureMessage = vi.hoisted(() => vi.fn());
const logEvent = vi.hoisted(() =>
  vi.fn<(client: unknown, params: Record<string, unknown>) => Promise<undefined>>(async () => undefined),
);

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ rpc: state.rpc, from: (t: string) => (state.fake as Fake).client.from(t) }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: (t: string) => (state.adminFake as Fake).client.from(t) }),
}));
vi.mock("@/lib/services/auth", () => ({ getCurrentProfile: state.profile }));
vi.mock("@/lib/services/events", () => ({ logEvent, logEvents: vi.fn() }));
vi.mock("@/lib/services/followup-tasks", () => ({ raiseLiveHoldCheck }));
vi.mock("@/lib/services/health-score", () => ({ recomputeDealHealth }));
vi.mock("@sentry/nextjs", () => ({ captureMessage }));
vi.mock("next/cache", () => ({ revalidatePath }));

const { markDealWon } = await import("@/lib/actions/deals");

const DEAL = "3b2a1c0d-9e8f-4a7b-8c6d-5e4f3a2b1c0d";
const PROP = "4c3b2a1d-0e9f-4b8a-9d7c-6f5e4d3c2b1a";
const NOTHING_CHANGED = "Could not close the deal — nothing was changed. Try again.";
const UNCONFIRMED = /^Could not confirm whether the deal was closed — reload the page/;

function won(fields: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set("deal_id", DEAL);
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return markDealWon({ error: null, savedAt: null }, fd);
}

function script(pages: Record<string, FakePage[]> = {}, adminPages: Record<string, FakePage[]> = {}) {
  state.fake = fakeClient(pages);
  state.adminFake = fakeClient(adminPages);
}
const fake = () => state.fake as Fake;
const adminFake = () => state.adminFake as Fake;

const closedAnswer = (extra: Record<string, unknown> = {}) => ({
  data: {
    result: "closed",
    status: "won",
    deal_id: DEAL,
    org_id: "org-1",
    agent_id: "agent-owner",
    override: false,
    final_value: 250000,
    stage: "Completed",
    ...extra,
  },
  error: null,
});

beforeEach(() => {
  state.rpc.mockReset();
  state.profile.mockReset();
  state.profile.mockResolvedValue({ id: "agent-1", orgId: "org-1", role: "agent" });
  revalidatePath.mockReset();
  raiseLiveHoldCheck.mockReset();
  raiseLiveHoldCheck.mockResolvedValue("not_needed");
  recomputeDealHealth.mockReset();
  recomputeDealHealth.mockResolvedValue(undefined);
  captureMessage.mockReset();
  logEvent.mockReset();
  logEvent.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
  script();
});

describe("the arguments", () => {
  it("a plain close sends the deal and override=false; a blank price is left to the offer", async () => {
    state.rpc.mockResolvedValue(closedAnswer());
    await won({ final_value: "" });
    expect(state.rpc).toHaveBeenCalledWith("close_deal", {
      p_outcome: "won",
      p_deal_id: DEAL,
      p_override: false,
    });
  });

  it("a typed price and the ticked override travel as they are", async () => {
    state.rpc.mockResolvedValue(closedAnswer({ override: true }));
    await won({ final_value: "248500.5", override: "on" });
    expect(state.rpc).toHaveBeenCalledWith("close_deal", {
      p_outcome: "won",
      p_deal_id: DEAL,
      p_override: true,
      p_final_value: 248500.5,
    });
  });

  it("a bad price is refused before the database is asked", async () => {
    const result = await won({ final_value: "-5" });
    expect(result.error).toMatch(/positive amount/);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("the answer", () => {
  it("closed, no listing: saved, health recomputed, no prompt", async () => {
    state.rpc.mockResolvedValue(closedAnswer());
    const result = await won();
    expect(result).toEqual({ error: null, savedAt: expect.any(Number), notice: null });
    expect(recomputeDealHealth).toHaveBeenCalledTimes(1);
    expect(raiseLiveHoldCheck).not.toHaveBeenCalled();
    expect(fake().argsOf("tasks", "insert")).toEqual([]);
  });

  it("already_closed: saved and flagged as a repeat, with a notice — and NO follow-up runs", async () => {
    state.rpc.mockResolvedValue({
      data: { result: "already_closed", status: "won", deal_id: DEAL },
      error: null,
    });
    const result = await won();
    expect(result.error).toBeNull();
    expect(result.savedAt).toEqual(expect.any(Number));
    expect(result.alreadyClosed).toBe(true);
    expect(result.pageRefreshed).toBe(true);
    expect(result.notice).toMatch(/^This deal was already marked won — nothing was changed\./);
    // a retry after an unconfirmed attempt must learn the reminders may be missing
    expect(result.notice).toMatch(/check the listing status and any live hold yourself/);
    expect(state.profile).not.toHaveBeenCalled();
    expect(recomputeDealHealth).not.toHaveBeenCalled();
    expect(raiseLiveHoldCheck).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith(`/deals/${DEAL}`);
  });

  it("conflict: an error naming the outcome that did commit — and NO follow-up runs", async () => {
    state.rpc.mockResolvedValue({
      data: { result: "conflict", status: "lost", deal_id: DEAL },
      error: null,
    });
    const result = await won();
    expect(result).toEqual({
      error: "This deal was already marked lost — it was not marked won.",
      savedAt: null,
      // the refused dialog may be gone with the refresh: the toast must stay
      pageRefreshed: true,
    });
    expect(recomputeDealHealth).not.toHaveBeenCalled();
    expect(raiseLiveHoldCheck).not.toHaveBeenCalled();
  });

  it("a refusal raised by the function is shown in its own words, and is not paged", async () => {
    state.rpc.mockResolvedValue({
      data: null,
      error: {
        code: "P0001",
        message: "Won requires an accepted offer — record one first, or ask an admin to override.",
      },
    });
    expect((await won()).error).toBe(
      "Won requires an accepted offer — record one first, or ask an admin to override.",
    );
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it("an error that proves the transaction rolled back: nothing was changed, the database's words stay out", async () => {
    for (const code of ["42501", "PGRST202", "PGRST301", "57014", "40P01", "PGRST003"]) {
      state.rpc.mockResolvedValue({
        data: null,
        error: { code, message: 'permission denied for table "deals" — internal detail' },
      });
      const result = await won();
      // nothing changed: no refresh, the dialog is still open and holds the message
      expect(result, code).toEqual({ error: NOTHING_CHANGED, savedAt: null });
    }
    // and a deploy-skew PGRST202 reaches a human, shape only
    expect(captureMessage).toHaveBeenCalledWith(
      "[deals] close failed",
      expect.objectContaining({ tags: { operation: "deals.close", code: "PGRST202" } }),
    );
    expect(JSON.stringify(captureMessage.mock.calls)).not.toContain("internal detail");
  });

  it("an answer that may or may not have committed is reported as unknown, never 'nothing changed'", async () => {
    const unknowns: Array<() => Promise<unknown>> = [
      async () => ({ data: null, error: { message: "TypeError: fetch failed", code: "" } }),
      async () => ({ data: null, error: { message: "<html>502 Bad Gateway</html>" } }),
      async () => ({ data: null, error: {} }),
      async () => ({ data: null, error: { code: "08006", message: "connection failure" } }),
      async () => ({ data: null, error: { code: "PGRST000", message: "could not connect" } }),
      async () => {
        throw new Error("socket hang up");
      },
      async () => ({ data: { unexpected: true }, error: null }),
      async () => ({ data: null, error: null }),
    ];
    for (const answer of unknowns) {
      state.rpc.mockImplementation(answer as never);
      revalidatePath.mockClear();
      const result = await won();
      expect(result.error).toMatch(UNCONFIRMED);
      expect(result.error).toMatch(/reminders may not have been created/);
      expect(result.savedAt).toBeNull();
      expect(result.pageRefreshed, "an unknown answer refreshes the page, so its toast must outlive the dialog").toBe(true);
      // the page is refreshed so it shows whichever way it went
      expect(revalidatePath).toHaveBeenCalledWith(`/deals/${DEAL}`);
    }
    expect(recomputeDealHealth).not.toHaveBeenCalled();
  });
});

describe("the follow-ups of a committed Won", () => {
  const onMarket: FakePage = { data: { id: PROP, reference: "PAF9001", status: "available" }, error: null };

  it("raises the listing prompt (assigned to the deal's agent) and the live-hold ask, once each", async () => {
    state.rpc.mockResolvedValue(closedAnswer({ property_id: PROP }));
    raiseLiveHoldCheck.mockResolvedValue("raised");
    script(
      { properties: [onMarket], tasks: [{ data: { id: "task-1" }, error: null }] },
      { tasks: [{ data: [], error: null }] },
    );
    const result = await won();
    expect(result).toEqual({ error: null, savedAt: expect.any(Number), notice: null });
    const [row] = fake().argsOf("tasks", "insert")[0] as [Record<string, unknown>];
    expect(row).toMatchObject({
      org_id: "org-1",
      kind: "listing_status_check",
      property_id: PROP,
      deal_id: DEAL,
      assignee_id: "agent-owner",
      created_by: "agent-1",
      title: "Deal won — update listing status: PAF9001",
    });
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls[0]![1]).toMatchObject({
      entityType: "property",
      entityId: PROP,
      eventType: "followup_task_created",
      payload: { kind: "listing_status_check", task_id: "task-1", deal_id: DEAL },
    });
    expect(raiseLiveHoldCheck).toHaveBeenCalledTimes(1);
    expect(raiseLiveHoldCheck).toHaveBeenCalledWith(expect.anything(), {
      propertyId: PROP,
      orgId: "org-1",
      actorId: "agent-1",
      dealId: DEAL,
      assigneeId: "agent-owner",
      propertyReference: "PAF9001",
    });
    // asked of the database with an explicit org, not of the reader
    expect(adminFake().argsOf("tasks", "eq")).toContainEqual(["org_id", "org-1"]);
    expect(revalidatePath).toHaveBeenCalledWith("/tasks");
  });

  it("an open prompt already on the listing is not raised again", async () => {
    state.rpc.mockResolvedValue(closedAnswer({ property_id: PROP }));
    script({ properties: [onMarket] }, { tasks: [{ data: [{ id: "existing" }], error: null }] });
    const result = await won();
    expect(fake().argsOf("tasks", "insert")).toEqual([]);
    expect(result.notice).toBeNull();
  });

  it("a prompt that cannot be created: the deal is won, the user is told to check by hand, Sentry gets the shape", async () => {
    state.rpc.mockResolvedValue(closedAnswer({ property_id: PROP }));
    script(
      {
        properties: [onMarket],
        tasks: [{ data: null, error: { code: "42501", message: "new row violates row-level security" } }],
      },
      { tasks: [{ data: [], error: null }] },
    );
    const result = await won();
    expect(result.error).toBeNull();
    expect(result.savedAt).toEqual(expect.any(Number));
    expect(result.notice).toBe(
      "Deal marked won. The reminder to update PAF9001's listing status may not have been created — " +
        "check the listing status and any live hold yourself.",
    );
    expect(captureMessage).toHaveBeenCalledWith(
      "[deals] won follow-up failed",
      expect.objectContaining({
        tags: { operation: "deals.won_followup", step: "listing_status_check", code: "42501" },
      }),
    );
    // shape only: the database's words never reach Sentry
    expect(JSON.stringify(captureMessage.mock.calls)).not.toContain("row-level security");
    // the sibling ask still runs
    expect(raiseLiveHoldCheck).toHaveBeenCalledTimes(1);
  });

  it("a failed dedupe READ is not treated as 'none open': nothing is inserted blind, the user is told", async () => {
    state.rpc.mockResolvedValue(closedAnswer({ property_id: PROP }));
    script({ properties: [onMarket] }, { tasks: [{ data: null, error: { code: "57014", message: "timeout" } }] });
    const result = await won();
    expect(fake().argsOf("tasks", "insert")).toEqual([]);
    expect(result.notice).toMatch(/listing status may not have been created/);
  });

  it("a task whose timeline entry fails EXISTS: the notice says so, and asks for an admin, not a duplicate", async () => {
    state.rpc.mockResolvedValue(closedAnswer({ property_id: PROP }));
    script(
      { properties: [onMarket], tasks: [{ data: { id: "task-1" }, error: null }] },
      { tasks: [{ data: [], error: null }] },
    );
    logEvent.mockRejectedValueOnce(new Error("logEvent failed (property.followup_task_created): refused"));
    const result = await won();
    expect(result.error).toBeNull();
    expect(result.notice).toBe(
      "Deal marked won. The reminder to update PAF9001's listing status was created, but its timeline " +
        "entry could not be recorded — tell an admin so the record can be completed.",
    );
  });

  it("the live-hold ask: not_raised and raised_unlogged each reach the user; a throw is not_raised", async () => {
    const sold: FakePage = { data: { id: PROP, reference: "PAF9001", status: "sold" }, error: null };
    for (const [outcome, text] of [
      ["not_raised", /settle the live hold on PAF9001 may not have been created/],
      ["raised_unlogged", /settle the live hold on PAF9001 was created, but its timeline entry/],
    ] as const) {
      state.rpc.mockResolvedValue(closedAnswer({ property_id: PROP }));
      script({ properties: [sold] });
      raiseLiveHoldCheck.mockResolvedValueOnce(outcome);
      expect((await won()).notice).toMatch(text);
    }
    state.rpc.mockResolvedValue(closedAnswer({ property_id: PROP }));
    script({ properties: [sold] });
    raiseLiveHoldCheck.mockRejectedValueOnce(new Error("import failed"));
    const result = await won();
    expect(result.error).toBeNull();
    expect(result.notice).toMatch(/settle the live hold on PAF9001 may not have been created/);
  });

  it("the profile cannot be read after the commit: still a won deal with a caveat", async () => {
    state.rpc.mockResolvedValue(closedAnswer({ property_id: PROP }));
    state.profile.mockRejectedValue(new Error("Not authenticated"));
    const result = await won();
    expect(result.error).toBeNull();
    expect(result.savedAt).toEqual(expect.any(Number));
    expect(result.notice).toMatch(/The reminders for the listing may not have been created/);
  });

  it("a health recompute that throws is paged, not put to the user", async () => {
    state.rpc.mockResolvedValue(closedAnswer());
    recomputeDealHealth.mockRejectedValue(new Error("boom"));
    const result = await won();
    expect(result).toEqual({ error: null, savedAt: expect.any(Number), notice: null });
    expect(captureMessage).toHaveBeenCalledWith(
      "[deals] won follow-up failed",
      expect.objectContaining({ tags: expect.objectContaining({ step: "health" }) }),
    );
  });

  it("a revalidation that throws after the commit does not turn the close into an error", async () => {
    state.rpc.mockResolvedValue(closedAnswer());
    revalidatePath.mockImplementation(() => {
      throw new Error("static generation store missing");
    });
    const result = await won();
    expect(result).toEqual({ error: null, savedAt: expect.any(Number), notice: null });
  });
});
