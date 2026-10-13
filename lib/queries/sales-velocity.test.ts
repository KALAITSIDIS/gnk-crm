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

    // fetchAll: the page that held the row, then the empty page that ends the read
    expect(events.served.events, "the system answered it").toBe(2);
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
    ).rejects.toThrow(/Query failed \(velocity events\): statement timeout/);
  });

  /*
   * T-velocity-id-lists: every sold unit's id in one URL answered 414 past
   * about 204 sold units, and the whole units page fell over. The ids now go out
   * in slices, each slice's read paged.
   */
  it("asks about the sold units in bounded slices, each read paged and ordered uniquely", async () => {
    const events = fakeClient({});
    admin.client = events.client;
    const sold = Array.from({ length: 250 }, (_, i) => unit(`u${i}`, "sold"));
    const caller = fakeClient({ properties: [{ data: sold, error: null }] });

    await fetchProjectVelocity(caller.client as never, "proj-1", new Date("2026-09-07T00:00:00Z"));
    const slices = events
      .argsOf("events", "in")
      .filter((a) => a[0] === "entity_id")
      .map((a) => a[1] as string[]);
    expect(slices.map((s) => s.length)).toEqual([100, 100, 50]);
    expect(slices.flat(), "every sold unit asked about, once").toEqual(sold.map((u) => u.id));
    expect(events.argsOf("events", "range")).toEqual([[0, 999], [0, 999], [0, 999]]);
    expect(events.argsOf("events", "order")).toEqual([
      ["occurred_at", { ascending: true }],
      ["id"],
      ["occurred_at", { ascending: true }],
      ["id"],
      ["occurred_at", { ascending: true }],
      ["id"],
    ]);
    // every slice carries the organisation: the admin client has no RLS, so a
    // slice without it would read every organisation's events for those ids
    expect(events.argsOf("events", "eq").filter((a) => a[0] === "org_id")).toEqual([
      ["org_id", "org-1"],
      ["org_id", "org-1"],
      ["org_id", "org-1"],
    ]);
    // the units themselves are read page by page too — the rows, then the empty
    // page that ends the read — each page over the same unique order
    expect(caller.argsOf("properties", "range")).toEqual([[0, 999], [250, 1249]]);
    expect(caller.argsOf("properties", "order")).toEqual([["id"], ["id"]]);
  });

  it("a failed unit read throws, and nothing is asked of the system", async () => {
    const events = fakeClient({});
    admin.client = events.client;
    const caller = fakeClient({
      properties: [{ data: null, error: { message: "statement timeout" } }],
    });

    await expect(
      fetchProjectVelocity(caller.client as never, "proj-1", new Date("2026-09-07T00:00:00Z")),
    ).rejects.toThrow(/Query failed \(velocity units\): statement timeout/);
    expect(events.served.events ?? 0).toBe(0);
  });

  it("a unit repeated across two pages counts once", async () => {
    /*
     * Offset pages are separate snapshots: a unit inserted between them shifts
     * the next page, which repeats the last row already read. The review
     * measured it on the real stack — 201 units, 2 sold, over 200 and 1.
     */
    const events = fakeClient({});
    admin.client = events.client;
    const caller = fakeClient({
      properties: [
        { data: [unit("u1", "available"), unit("u2", "sold")], error: null },
        { data: [unit("u2", "sold")], error: null },
      ],
    });

    const res = await fetchProjectVelocity(
      caller.client as never,
      "proj-1",
      new Date("2026-09-07T00:00:00Z"),
    );
    expect(res.totalUnits).toBe(2);
    expect(res.soldTotal).toBe(1);
    expect(res.byStatus).toEqual({ available: 1, sold: 1 });
    expect(events.argsOf("events", "in")).toEqual(
      expect.arrayContaining([["entity_id", ["u2"]]]),
    );
  });
});
