import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient } from "@/lib/testing/fake-client";
import { cyprusEndOfToday } from "@/lib/validators/reservations";

/**
 * Closing a `listing_status_check` prompt when the status it asked for is saved.
 *
 * The supersede used to run on the CALLER's client, and `tasks_update` is
 * assignee-scoped — admin, or `assignee_id = auth.uid()`. The prompt goes to
 * the deal's agent while anyone may set a listing to sold, so in the ordinary
 * case the update matched zero rows, logged nothing, and the prompt stayed open
 * having been obeyed. No error at any point. (Measured against a real database
 * in supabase/tests/listing-manager-silent-writes.test.ts.)
 *
 * It now runs as the system, which makes the org filter this file's other
 * subject: the admin client has no RLS, so a missing `org_id` clause would make
 * another organisation's property id reachable. That is the kind of thing a
 * comment cannot enforce.
 */

const admin = vi.hoisted(() => ({ client: null as unknown }));
const logEvent = vi.hoisted(() =>
  vi.fn<(client: unknown, event: Record<string, unknown>) => Promise<void>>(async () => {}),
);

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin.client }));
vi.mock("@/lib/services/events", () => ({ logEvent }));

const {
  completeListingStatusChecks,
  raiseLiveHoldCheck,
  completeLiveHoldChecks,
  LIVE_HOLD_TASK_KIND,
} = await import("./followup-tasks");

const params = {
  propertyId: "prop-1",
  orgId: "org-1",
  actorId: "actor-1",
  newStatus: "sold",
};

// file level, so BOTH describes get it — scoping this inside the first one let
// the second block inherit calls from the first and fail on the count.
beforeEach(() => logEvent.mockClear());

describe("completeListingStatusChecks", () => {

  it("scopes by org — the admin client has no RLS to do it", async () => {
    const svc = fakeClient({ tasks: [{ data: [{ id: "t1" }], error: null }] });
    admin.client = svc.client;
    const caller = fakeClient({ events: [{ data: null, error: null }] });

    await completeListingStatusChecks(caller.client as never, params);

    expect(
      svc.argsOf("tasks", "eq"),
      "without org_id, a property id from another organisation is reachable",
    ).toEqual(
      expect.arrayContaining([
        ["org_id", "org-1"],
        ["property_id", "prop-1"],
        ["kind", "listing_status_check"],
        ["is_done", false],
      ]),
    );
  });

  it("supersedes through the SYSTEM client, not the caller's", async () => {
    const svc = fakeClient({ tasks: [{ data: [{ id: "t1" }], error: null }] });
    admin.client = svc.client;
    const caller = fakeClient({ events: [{ data: null, error: null }] });

    const closed = await completeListingStatusChecks(caller.client as never, params);

    expect(closed, "the prompt is closed whoever saved the status").toBe(1);
    expect(svc.served.tasks, "the update went to the system client").toBe(1);
    expect(
      caller.served.tasks ?? 0,
      "and NOT to the caller's, whose policy would filter it to nothing",
    ).toBe(0);
  });

  it("still writes the supersede event as the ACTOR, not as the system", async () => {
    // The task closes by machine; the person who saved the status is who did it.
    const svc = fakeClient({ tasks: [{ data: [{ id: "t1" }], error: null }] });
    admin.client = svc.client;
    const caller = fakeClient({ events: [{ data: null, error: null }] });

    await completeListingStatusChecks(caller.client as never, params);

    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls[0][0], "the caller's client carries the event").toBe(caller.client);
    expect(logEvent.mock.calls[0][1]).toMatchObject({
      eventType: "superseded",
      entityType: "task",
      entityId: "t1",
      actorId: "actor-1",
    });
  });

  it("does nothing for a status that is still on-market", async () => {
    const svc = fakeClient({ tasks: [] });
    admin.client = svc.client;
    const caller = fakeClient({});

    const closed = await completeListingStatusChecks(caller.client as never, {
      ...params,
      newStatus: "available",
    });
    expect(closed).toBe(0);
    expect(svc.served.tasks ?? 0, "no write at all — the predicate did not hold").toBe(0);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("writes nothing when no prompt was open — idempotent by construction", async () => {
    const svc = fakeClient({ tasks: [{ data: [], error: null }] });
    admin.client = svc.client;
    const caller = fakeClient({});

    expect(await completeListingStatusChecks(caller.client as never, params)).toBe(0);
    expect(logEvent).not.toHaveBeenCalled();
  });
});

describe("raiseLiveHoldCheck — the won deal's other leftover", () => {
  const args = {
    propertyId: 'prop-1',
    orgId: 'org-1',
    actorId: 'actor-1',
    dealId: 'deal-1',
    assigneeId: 'agent-1',
    propertyReference: 'PAF0001',
  };

  it("says nothing when there is no live hold", async () => {
    const svc = fakeClient({ reservations: [{ data: null, error: null }] });
    admin.client = svc.client;
    const caller = fakeClient({});
    expect(await raiseLiveHoldCheck(caller.client as never, args)).toBe(0);
    expect(svc.served.tasks ?? 0, "it does not even ask about tasks").toBe(0);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("only counts a hold that is still LIVE", async () => {
    const svc = fakeClient({ reservations: [{ data: null, error: null }] });
    admin.client = svc.client;
    await raiseLiveHoldCheck(fakeClient({}).client as never, args);
    expect(svc.argsOf("reservations", "in")).toEqual([
      ["status", ["held", "confirmed"]],
    ]);
  });

  it("raises the prompt, links the reservation, and events it", async () => {
    const svc = fakeClient({
      reservations: [{ data: { id: "res-1" }, error: null }],
      tasks: [{ data: [], error: null }],
    });
    admin.client = svc.client;
    const caller = fakeClient({ tasks: [{ data: { id: "t1" }, error: null }] });

    expect(await raiseLiveHoldCheck(caller.client as never, args)).toBe(1);

    const [insert] = caller.argsOf("tasks", "insert");
    const row = insert[0] as Record<string, unknown>;
    expect(row.kind).toBe(LIVE_HOLD_TASK_KIND);
    expect(row.reservation_id, "the desk can open the hold from the task").toBe("res-1");
    expect(row.deal_id).toBe("deal-1");
    expect(row.title).toContain("PAF0001");
    expect(
      new Date(row.due_at as string).getTime(),
      "due end of day, not the instant it was raised",
    ).toBeGreaterThan(Date.now());

    // "and events it" — these belong to THIS test. Inserting the clock-frozen
    // case below left them stranded after its `finally`, so they still ran but
    // under a name that promised something else, while this test's name promised
    // an assertion it no longer made.
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls[0][1]).toMatchObject({
      eventType: "followup_task_created",
      entityType: "property",
      payload: { kind: LIVE_HOLD_TASK_KIND, reservation_id: "res-1" },
    });
  });

  /*
   * THE ASSERTION ABOVE CANNOT FAIL DURING WORKING HOURS, which a mutation run
   * proved: restoring the exact pre-fix expression
   * `cyprusEndOfDay(new Date().toISOString().slice(0, 10))` left all 16 tests
   * green at 13:05 Cyprus, because "greater than now" is only violated inside
   * the 00:00–03:00 window the fix exists for. A test that passes with the fix
   * removed is not covering the defect.
   *
   * So: freeze the clock INSIDE the window and compare against the helper's own
   * output rather than against `Date.now()`. Equality is what pins adoption —
   * the naive expression yields the previous Cyprus day's end here, three hours
   * in the past, and that is the whole bug.
   */
  it("is due end of the CYPRUS day, even when raised at 01:30 local", async () => {
    // 2026-07-15T22:30Z = 16 July 01:30 Cyprus (EEST, UTC+3). The UTC day is
    // still the 15th, so the pre-fix code stamped 15 July 23:59:59 Cyprus.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-15T22:30:00.000Z"));
    try {
      const svc = fakeClient({
        reservations: [{ data: { id: "res-1" }, error: null }],
        tasks: [{ data: [], error: null }],
      });
      admin.client = svc.client;
      const caller = fakeClient({ tasks: [{ data: { id: "t1" }, error: null }] });

      await raiseLiveHoldCheck(caller.client as never, args);

      const [insert] = caller.argsOf("tasks", "insert");
      const row = insert[0] as Record<string, unknown>;
      expect(row.due_at, "end of 16 July Cyprus, not of 15 July").toBe(
        cyprusEndOfToday(new Date("2026-07-15T22:30:00.000Z")).toISOString(),
      );
      expect(
        new Date(row.due_at as string).getTime(),
        "and therefore still in the future — never born overdue",
      ).toBeGreaterThan(Date.now());
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not raise a second one, and asks the DATABASE whether one is open", async () => {
    const svc = fakeClient({
      reservations: [{ data: { id: "res-1" }, error: null }],
      tasks: [{ data: [{ id: "already" }], error: null }],
    });
    admin.client = svc.client;
    const caller = fakeClient({});

    expect(await raiseLiveHoldCheck(caller.client as never, args)).toBe(0);
    expect(
      svc.argsOf("tasks", "eq"),
      "org-scoped explicitly — the admin client has no RLS to add it",
    ).toEqual(
      expect.arrayContaining([
        ["org_id", "org-1"],
        ["property_id", "prop-1"],
        ["kind", LIVE_HOLD_TASK_KIND],
        ["is_done", false],
      ]),
    );
    expect(caller.served.tasks ?? 0, "and nothing was inserted").toBe(0);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("never fails the win when the prompt cannot be filed", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const svc = fakeClient({
      reservations: [{ data: { id: "res-1" }, error: null }],
      tasks: [{ data: [], error: null }],
    });
    admin.client = svc.client;
    const caller = fakeClient({ tasks: [{ data: null, error: { message: "kind not registered" } }] });

    expect(
      await raiseLiveHoldCheck(caller.client as never, args),
      "the deal is won — a failed prompt must not undo that",
    ).toBe(0);
    expect(err, "but it is never silent").toHaveBeenCalledWith(
      "reservation_still_live task failed:",
      "kind not registered",
    );
    expect(logEvent).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("completeLiveHoldChecks — the prompt must not survive being obeyed", () => {
  const base = { reservationId: "res-1", orgId: "org-1", actorId: "actor-1" };

  it.each(["converted", "released", "expired"])(
    "closes the prompt when the hold becomes %s",
    async (newStatus) => {
      const svc = fakeClient({ tasks: [{ data: [{ id: "t1" }], error: null }] });
      admin.client = svc.client;
      const caller = fakeClient({});
      expect(await completeLiveHoldChecks(caller.client as never, { ...base, newStatus })).toBe(1);
      expect(logEvent).toHaveBeenCalledTimes(1);
      expect(logEvent.mock.calls[0][1]).toMatchObject({
        eventType: "superseded",
        entityType: "task",
        entityId: "t1",
      });
    },
  );

  it.each(["held", "confirmed"])("does nothing while the hold is still %s", async (newStatus) => {
    // `held → confirmed` is a step FORWARD in a live hold; the ask still stands.
    const svc = fakeClient({ tasks: [] });
    admin.client = svc.client;
    const caller = fakeClient({});
    expect(await completeLiveHoldChecks(caller.client as never, { ...base, newStatus })).toBe(0);
    expect(svc.served.tasks ?? 0, "not even a query").toBe(0);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("closes by RESERVATION and scopes by org, as the system", async () => {
    const svc = fakeClient({ tasks: [{ data: [], error: null }] });
    admin.client = svc.client;
    const caller = fakeClient({});
    await completeLiveHoldChecks(caller.client as never, { ...base, newStatus: "released" });
    expect(svc.argsOf("tasks", "eq")).toEqual(
      expect.arrayContaining([
        ["org_id", "org-1"],
        ["reservation_id", "res-1"],
        ["kind", LIVE_HOLD_TASK_KIND],
        ["is_done", false],
      ]),
    );
    expect(
      caller.served.tasks ?? 0,
      "tasks_update is assignee-scoped, and whoever settles the hold is often not the assignee",
    ).toBe(0);
  });
});
