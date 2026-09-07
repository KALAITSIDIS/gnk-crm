import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient } from "@/lib/testing/fake-client";

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

const { completeListingStatusChecks } = await import("./followup-tasks");

const params = {
  propertyId: "prop-1",
  orgId: "org-1",
  actorId: "actor-1",
  newStatus: "sold",
};

describe("completeListingStatusChecks", () => {
  beforeEach(() => logEvent.mockClear());

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
