import { describe, expect, it, vi } from "vitest";
import { fakeClient } from "@/lib/testing/fake-client";

/**
 * The project velocity QUERY. The arithmetic it feeds is pinned separately in
 * lib/services/sales-velocity.test.ts; this file is about which client answers
 * "when did each unit sell".
 *
 * `events_select` (0063) shows a non-admin only the rows they authored, so on
 * the caller's client that question silently became "when did each unit sell BY
 * MY HAND". A unit a colleague marked sold had no visible sale date, and the
 * card reported a different velocity to every person who opened it. A metric
 * that varies by reader is worse than a missing one: it looks like an answer.
 */

const admin = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin.client }));

const { fetchProjectVelocity } = await import("./sales-velocity");

const unit = (id: string, status: string) => ({
  id,
  status,
  asking_price: 300000,
  org_id: "org-1",
});

describe("fetchProjectVelocity", () => {
  it("asks the SYSTEM for the sale dates, not the caller", async () => {
    const events = fakeClient({
      events: [
        {
          data: [
            {
              entity_id: "u1",
              event_type: "status_changed",
              occurred_at: "2026-06-01T10:00:00Z",
              payload: { to: "sold" },
            },
          ],
          error: null,
        },
      ],
    });
    admin.client = events.client;
    const caller = fakeClient({ properties: [{ data: [unit("u1", "sold")], error: null }] });

    await fetchProjectVelocity(caller.client as never, "proj-1", new Date("2026-09-07T00:00:00Z"));

    expect(events.served.events, "the system answered it").toBe(1);
    expect(
      caller.served.events ?? 0,
      "the caller's client, which would have shown only their own status changes, was never asked",
    ).toBe(0);
  });

  it("scopes the event read by org — the admin client has no RLS to do it", async () => {
    const events = fakeClient({ events: [{ data: [], error: null }] });
    admin.client = events.client;
    const caller = fakeClient({ properties: [{ data: [unit("u1", "sold")], error: null }] });

    await fetchProjectVelocity(caller.client as never, "proj-1", new Date("2026-09-07T00:00:00Z"));
    expect(events.argsOf("events", "eq")).toEqual(
      expect.arrayContaining([
        ["org_id", "org-1"],
        ["entity_type", "property"],
      ]),
    );
    // and the ids are the ones the CALLER read
    expect(events.argsOf("events", "in")).toEqual(
      expect.arrayContaining([["entity_id", ["u1"]]]),
    );
  });

  it("asks nothing when the project has no sold units", async () => {
    const events = fakeClient({});
    admin.client = events.client;
    const caller = fakeClient({ properties: [{ data: [unit("u1", "available")], error: null }] });

    const res = await fetchProjectVelocity(
      caller.client as never,
      "proj-1",
      new Date("2026-09-07T00:00:00Z"),
    );
    expect(events.served.events ?? 0).toBe(0);
    expect(res).toBeTruthy();
  });

  it("an empty project returns before it needs an org at all", async () => {
    const events = fakeClient({});
    admin.client = events.client;
    const caller = fakeClient({ properties: [{ data: [], error: null }] });

    const res = await fetchProjectVelocity(
      caller.client as never,
      "proj-1",
      new Date("2026-09-07T00:00:00Z"),
    );
    expect(events.served.events ?? 0).toBe(0);
    expect(res).toBeTruthy();
  });

  it("refuses to query when the unit rows carry no org — the refactor hazard", async () => {
    /*
     * `org_id` is NOT NULL, so this cannot arrive from the database. It can
     * arrive from a SELECT that stopped asking for the column — and then the
     * service-role read would go out as `org_id = undefined` with no boundary
     * at all. The guard exists for that edit, so the test constructs that edit
     * rather than a state the schema allows.
     *
     * Written after a mutation run showed the previous test for this branch
     * returned earlier and never reached it.
     */
    const events = fakeClient({});
    admin.client = events.client;
    const caller = fakeClient({
      properties: [
        { data: [{ id: "u1", status: "sold", asking_price: 300000 }], error: null },
      ],
    });

    const res = await fetchProjectVelocity(
      caller.client as never,
      "proj-1",
      new Date("2026-09-07T00:00:00Z"),
    );
    expect(
      events.served.events ?? 0,
      "no org to scope by means no query — loudly nothing, never quietly everything",
    ).toBe(0);
    expect(res).toBeTruthy();
  });

  it("a failed event read still throws — a velocity computed from nothing is a lie", async () => {
    const events = fakeClient({ events: [{ data: null, error: { message: "statement timeout" } }] });
    admin.client = events.client;
    const caller = fakeClient({ properties: [{ data: [unit("u1", "sold")], error: null }] });

    await expect(
      fetchProjectVelocity(caller.client as never, "proj-1", new Date("2026-09-07T00:00:00Z")),
    ).rejects.toThrow(/Velocity event query failed/);
  });
});
