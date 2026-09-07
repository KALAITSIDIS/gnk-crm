import { describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * `updateViewingStatus` when the UPDATE writes nothing.
 *
 * The app guard admits an admin, or whoever is the viewing's `agent_id`. The
 * row policy is narrower: admin, or an agent on their own viewing — the ROLE
 * matters there and not in the guard. So a listing manager who has been set as
 * a viewing's agent passes the guard and is then filtered out by the policy,
 * which refuses an UPDATE by matching zero rows with NO error (measured in
 * supabase/tests/listing-manager-silent-writes.test.ts).
 *
 * Until 2026-09-07 the action did not look at what came back. It returned
 * success and wrote a `status_changed` event, so the viewing stayed
 * `scheduled` while the timeline said it had been completed — the log
 * disagreeing with the row it describes.
 *
 * The compare-and-set also closes a second hole: two people closing the same
 * viewing could both log a transition out of `scheduled`.
 */

const state = vi.hoisted(() => ({ client: null as unknown, role: "listing_manager" as string }));
// Typed through the generic, not through named parameters: a no-arg vi.fn()
// gives an empty call tuple and tsc refuses `logEvent.mock.calls[0][1]`.
const logEvent = vi.hoisted(() =>
  vi.fn<(client: unknown, event: Record<string, unknown>) => Promise<void>>(async () => {}),
);

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "actor-1", orgId: "org-1", role: state.role }),
}));
vi.mock("@/lib/services/events", () => ({ logEvent }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { updateViewingStatus } = await import("@/lib/actions/viewings");

/** A scheduled viewing whose agent IS the actor — so the app guard lets them through. */
const viewing = (over: Record<string, unknown> = {}) => ({
  id: "viewing-1",
  org_id: "org-1",
  agent_id: "actor-1",
  status: "scheduled",
  property_id: "prop-1",
  ...over,
});

function setup(pages: FakePage[]) {
  const fake = fakeClient({ viewings: pages });
  state.client = fake.client;
  logEvent.mockClear();
  return fake;
}

describe("updateViewingStatus proves its write before it logs one", () => {
  it("reports the refusal instead of success when the policy filtered it away", async () => {
    setup([
      { data: viewing(), error: null }, // the read
      { data: [], error: null }, // the UPDATE — zero rows, no error
    ]);
    const res = await updateViewingStatus("viewing-1", "completed");
    expect(res.error, "the desk is told, rather than shown a success").toMatch(/refused/i);
    expect(
      logEvent,
      "and no status_changed event for a status that did not change",
    ).not.toHaveBeenCalled();
  });

  it("logs exactly once when the write lands", async () => {
    setup([
      { data: viewing(), error: null },
      { data: [{ id: "viewing-1" }], error: null },
    ]);
    const res = await updateViewingStatus("viewing-1", "completed");
    expect(res.error).toBeNull();
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls[0][1]).toMatchObject({
      eventType: "status_changed",
      payload: { from: "scheduled", to: "completed" },
    });
  });

  it("targets only a still-scheduled row, so two closers cannot both log the move", async () => {
    const fake = setup([
      { data: viewing(), error: null },
      { data: [{ id: "viewing-1" }], error: null },
    ]);
    await updateViewingStatus("viewing-1", "no_show");
    expect(
      fake.argsOf("viewings", "eq"),
      "compare-and-set: the update names the status it expects to find",
    ).toEqual(expect.arrayContaining([["status", "scheduled"]]));
  });

  it("still refuses a viewing that is not the caller's, before any write", async () => {
    // The pre-existing guard must survive the change.
    setup([{ data: viewing({ agent_id: "someone-else" }), error: null }]);
    const res = await updateViewingStatus("viewing-1", "cancelled");
    expect(res.error).toMatch(/only update your own viewings/i);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("an admin's landing write is unaffected", async () => {
    state.role = "admin";
    setup([
      { data: viewing({ agent_id: "someone-else" }), error: null },
      { data: [{ id: "viewing-1" }], error: null },
    ]);
    const res = await updateViewingStatus("viewing-1", "completed");
    expect(res.error).toBeNull();
    expect(logEvent).toHaveBeenCalledTimes(1);
    state.role = "listing_manager";
  });
});
