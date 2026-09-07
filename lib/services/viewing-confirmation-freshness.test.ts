import { describe, expect, it, vi } from "vitest";
import { fakeClient } from "@/lib/testing/fake-client";

/*
 * Two clients, on purpose. The document is read as the CALLER — they are
 * looking at their own viewing's page. The reschedule is read as the SYSTEM,
 * because `events_select` (0063) admits only an admin or the actor who wrote
 * the row: an admin rescheduling an agent's viewing writes an event that agent
 * cannot see, and asking on their client would answer "never rescheduled" for
 * exactly the person about to send the stale sheet.
 */
const adminFake = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => adminFake.client }));

const { confirmationFreshness, isStale } = await import("./viewing-confirmation-freshness");

/**
 * A filed viewing confirmation names the time it was issued for. Rescheduling
 * the viewing does not — and must not — rewrite it: the PDF is a record of what
 * was sent, and its digest is chained into the event log.
 *
 * So the document stays and the UI is told it is out of date, rather than the
 * record being altered or withheld. This is the test of "is it out of date".
 */

const DOC = "2026-09-07T10:00:00.000Z";

describe("isStale", () => {
  it("is stale when the viewing moved after the confirmation was filed", () => {
    expect(isStale(DOC, "2026-09-07T11:00:00.000Z")).toBe(true);
  });

  it("is fresh when the confirmation was filed after the move", () => {
    // the ordinary fix: the agent rescheduled, then regenerated
    expect(isStale("2026-09-07T11:00:00.000Z", DOC)).toBe(false);
  });

  it("is fresh when the viewing has never been rescheduled", () => {
    expect(isStale(DOC, null)).toBe(false);
  });

  it("is fresh when there is no document — nothing to be stale", () => {
    expect(isStale(null, "2026-09-07T11:00:00.000Z")).toBe(false);
  });

  it("compares instants, not strings — a later time in another offset still wins", () => {
    // "2026-09-07T09:30:00-01:00" is 10:30Z, later than the 10:00Z document,
    // but sorts BEFORE it as text. A string comparison would call this fresh.
    expect(isStale(DOC, "2026-09-07T09:30:00-01:00")).toBe(true);
  });
});

describe("confirmationFreshness", () => {
  it("reports no document when none is filed, without asking about reschedules", async () => {
    const events = fakeClient({});
    adminFake.client = events.client;
    const fake = fakeClient({ documents: [{ data: null, error: null }] });
    const res = await confirmationFreshness(fake.client as never, "v1");
    expect(res).toEqual({ hasDocument: false, stale: false, filedTitle: null });
    expect(events.served.events ?? 0, "no second query when there is nothing to judge").toBe(0);
  });

  it("flags the filed sheet when a reschedule came after it, and hands back its title", async () => {
    const events = fakeClient({ events: [{ data: { occurred_at: "2026-09-07T11:00:00.000Z" }, error: null }] });
    adminFake.client = events.client;
    const fake = fakeClient({ documents: [
        {
          data: { created_at: DOC, title: "Viewing confirmation — PAF0001 — 7 Sept 2026, 10:00" },
          error: null,
        },
      ] });
    const res = await confirmationFreshness(fake.client as never, "v1");
    expect(res.hasDocument).toBe(true);
    expect(res.stale).toBe(true);
    expect(
      res.filedTitle,
      "the title names the time it was issued for — shown so the agent sees which sheet is wrong",
    ).toContain("10:00");
  });

  it("does not flag one filed after the reschedule", async () => {
    const events = fakeClient({ events: [{ data: { occurred_at: "2026-09-07T11:00:00.000Z" }, error: null }] });
    adminFake.client = events.client;
    const fake = fakeClient({ documents: [{ data: { created_at: "2026-09-07T12:00:00.000Z", title: "t" }, error: null }] });
    expect((await confirmationFreshness(fake.client as never, "v1")).stale).toBe(false);
  });

  it("reads the NEWEST of each, descending", async () => {
    // Both queries must order descending and take one — a viewing may carry
    // several confirmations and several reschedules, and only the last of each
    // decides the answer.
    const events = fakeClient({ events: [{ data: { occurred_at: "2026-09-07T11:00:00.000Z" }, error: null }] });
    adminFake.client = events.client;
    const fake = fakeClient({ documents: [{ data: { created_at: DOC, title: "t" }, error: null }] });
    await confirmationFreshness(fake.client as never, "v1");
    expect(fake.argsOf("documents", "order")).toEqual([["created_at", { ascending: false }]]);
    expect(events.argsOf("events", "order")).toEqual([["occurred_at", { ascending: false }]]);
    expect(fake.argsOf("documents", "limit")).toEqual([[1]]);
    expect(events.argsOf("events", "limit")).toEqual([[1]]);
  });

  it("asks about the reschedule as the SYSTEM, not as the caller", async () => {
    /*
     * THE DEFECT THIS CLOSES. `events_select` (0063) admits an admin, or the
     * actor who wrote the row, and nothing else. An admin rescheduling an
     * agent's viewing writes an event that agent cannot read — so on the
     * caller's client the question "has this moved?" answers "no" for exactly
     * the person about to send the outdated sheet.
     *
     * Whether a viewing has moved is a fact about the viewing, not about who
     * is asking.
     */
    const events = fakeClient({ events: [{ data: { occurred_at: "2026-09-07T11:00:00.000Z" }, error: null }] });
    adminFake.client = events.client;
    const caller = fakeClient({
      documents: [{ data: { created_at: DOC, title: "t", org_id: "org-1" }, error: null }],
    });

    expect((await confirmationFreshness(caller.client as never, "v1")).stale).toBe(true);
    expect(events.served.events, "the system client answered it").toBe(1);
    expect(
      caller.served.events ?? 0,
      "the caller's client, whose policy hides another actor's event, was never asked",
    ).toBe(0);
  });

  it("scopes the reschedule read by org — the admin client has no RLS to do it", async () => {
    const events = fakeClient({ events: [{ data: null, error: null }] });
    adminFake.client = events.client;
    const caller = fakeClient({
      documents: [{ data: { created_at: DOC, title: "t", org_id: "org-1" }, error: null }],
    });
    await confirmationFreshness(caller.client as never, "v1");
    expect(events.argsOf("events", "eq")).toEqual(
      expect.arrayContaining([["org_id", "org-1"]]),
    );
    // and the org_id it uses comes from the document the caller could read
    expect(caller.argsOf("documents", "select")).toEqual([["created_at, title, org_id"]]);
  });

  it("asks the events table for `rescheduled` on THIS viewing", async () => {
    const events = fakeClient({ events: [{ data: null, error: null }] });
    adminFake.client = events.client;
    const fake = fakeClient({ documents: [{ data: { created_at: DOC, title: "t" }, error: null }] });
    await confirmationFreshness(fake.client as never, "v1");
    expect(events.argsOf("events", "eq")).toEqual(
      expect.arrayContaining([
        ["entity_type", "viewing"],
        ["entity_id", "v1"],
        ["event_type", "rescheduled"],
      ]),
    );
  });
});
