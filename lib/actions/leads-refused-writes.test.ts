import { describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * What these actions do when the UPDATE writes NOTHING.
 *
 * Zero rows means one of two very different things. Either a concurrent stamp
 * won the race — legitimate, and the winner's event covers it — or the row
 * policy filtered the write away, because RLS refuses an UPDATE by matching
 * zero rows with NO error (measured in
 * supabase/tests/listing-manager-silent-writes.test.ts: `error: null`,
 * `data: []`, row unchanged).
 *
 * Both actions used to read that as the race unconditionally. `markContacted`
 * returned success, so the UI toasted "Marked contacted" over a lead that never
 * moved; `markCalled` went further and wrote a `called` event against a lead
 * whose `first_call_at` was still null — a phone call in the timeline that
 * nobody made.
 *
 * The tests below are about the branch, not the role: they feed a zero-row
 * result and check what the action concludes. That is the whole behaviour, and
 * it is unreachable from the e2e suite, which signs in as an admin — for whom
 * the policy never filters anything.
 */

const state = vi.hoisted(() => ({ client: null as unknown }));
// Typed through the generic, not through named parameters: a no-arg vi.fn()
// gives an empty call tuple and tsc refuses `logEvent.mock.calls[0][1]`.
const logEvent = vi.hoisted(() =>
  vi.fn<(client: unknown, event: Record<string, unknown>) => Promise<void>>(async () => {}),
);

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "actor-1", orgId: "org-1", role: "listing_manager" }),
}));
vi.mock("@/lib/services/events", () => ({ logEvent }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { markContacted, markCalled } = await import("@/lib/actions/leads");

/** An open, unassigned lead — the shape the UI offers to everyone. */
const lead = (over: Record<string, unknown> = {}) => ({
  id: "lead-1",
  org_id: "org-1",
  status: "new",
  assigned_agent_id: null,
  first_response_at: null,
  first_call_at: null,
  ...over,
});

function setup(pages: FakePage[]) {
  const fake = fakeClient({ leads: pages });
  state.client = fake.client;
  logEvent.mockClear();
  return fake;
}

describe("markContacted", () => {
  it("refuses when the update wrote nothing and the stamp is still unset", async () => {
    setup([
      { data: lead(), error: null }, // getLead
      { data: [], error: null }, // the UPDATE — filtered away
      { data: { first_response_at: null }, error: null }, // the re-read: nobody stamped it
    ]);
    await expect(markContacted("lead-1")).rejects.toThrow(/refused/i);
    expect(logEvent, "no event for a write that did not happen").not.toHaveBeenCalled();
  });

  it("still backs off silently when someone else won the stamp race", async () => {
    // The behaviour that must SURVIVE the fix: a genuine race is not an error,
    // and the winner's event already covers it.
    setup([
      { data: lead(), error: null },
      { data: [], error: null },
      { data: { first_response_at: "2026-09-07T10:00:00Z" }, error: null }, // someone did
    ]);
    await expect(markContacted("lead-1")).resolves.toBeUndefined();
    expect(logEvent, "the winner already logged it").not.toHaveBeenCalled();
  });

  it("logs when the write lands", async () => {
    setup([
      { data: lead(), error: null },
      { data: [{ id: "lead-1" }], error: null },
    ]);
    await markContacted("lead-1");
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls[0][1]).toMatchObject({ eventType: "contacted" });
  });
});

describe("markCalled", () => {
  it("does not log a phantom call when the update wrote nothing", async () => {
    setup([
      { data: lead(), error: null },
      { data: [], error: null },
      { data: { first_call_at: null }, error: null }, // nobody stamped it
    ]);
    await expect(markCalled("lead-1")).rejects.toThrow(/refused/i);
    expect(
      logEvent,
      "THE DEFECT: a `called` event against a lead whose first_call_at is still null",
    ).not.toHaveBeenCalled();
  });

  it("logs a repeat call when another actor won the first-call stamp", async () => {
    setup([
      { data: lead(), error: null },
      { data: [], error: null },
      { data: { first_call_at: "2026-09-07T10:00:00Z" }, error: null },
    ]);
    await markCalled("lead-1");
    expect(logEvent, "the call happened; it just was not the first").toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls[0][1]).toMatchObject({ eventType: "called" });
  });

  it("logs when the write lands", async () => {
    setup([
      { data: lead(), error: null },
      { data: [{ id: "lead-1" }], error: null },
    ]);
    await markCalled("lead-1");
    expect(logEvent).toHaveBeenCalledTimes(1);
  });
});
