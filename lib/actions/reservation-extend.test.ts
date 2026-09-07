import { describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * "Extend" must extend.
 *
 * The only date check was "not in the past", so a hold expiring in January
 * could be moved to next week: the write succeeded, the buyer silently lost
 * weeks of a contractual hold, and the timeline recorded it as
 * `reservation_extended` with `from` LATER than `to`.
 *
 * A control labelled Extend that shortens a hold is a defect on its own; a log
 * that then calls the shortening an extension is the part that outlives it,
 * because the timeline is what anyone reads back afterwards.
 *
 * `extendReservation` had no test of any kind before this.
 */

const state = vi.hoisted(() => ({ client: null as unknown }));
// Typed through the generic so `logEvent.mock.calls[0][1]` is reachable.
const logEvent = vi.hoisted(() =>
  vi.fn<(client: unknown, event: Record<string, unknown>) => Promise<void>>(async () => {}),
);

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "actor-1", orgId: "org-1", role: "admin" }),
}));
vi.mock("@/lib/services/events", () => ({ logEvent }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { extendReservation } = await import("@/lib/actions/reservations");

/** A live hold that runs to the end of 2027. */
const held = (over: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  property_id: "prop-1",
  status: "held",
  expires_at: new Date(Date.UTC(2027, 11, 31, 21, 59, 59)).toISOString(),
  ...over,
});

const form = (expiresOn: string) => {
  const fd = new FormData();
  fd.set("reservation_id", "11111111-1111-4111-8111-111111111111");
  fd.set("expires_on", expiresOn);
  return fd;
};

function setup(pages: FakePage[]) {
  const fake = fakeClient({ reservations: pages });
  state.client = fake.client;
  logEvent.mockClear();
  return fake;
}

describe("extendReservation", () => {
  it("refuses a date that is in the future but EARLIER than the current expiry", async () => {
    const fake = setup([{ data: held(), error: null }]);
    const res = await extendReservation({ error: null, savedAt: null }, form("2027-06-01"));
    expect(res.error).toMatch(/not later than the current expiry/i);
    expect(fake.argsOf("reservations", "update"), "and nothing was written").toHaveLength(0);
    expect(
      logEvent,
      "no reservation_extended for a hold that was not extended",
    ).not.toHaveBeenCalled();
  });

  it("refuses the SAME date too — an extension of nothing is not an extension", async () => {
    setup([{ data: held(), error: null }]);
    const res = await extendReservation({ error: null, savedAt: null }, form("2027-12-31"));
    expect(res.error).toMatch(/not later than the current expiry/i);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("still refuses a date already past, with its own message", async () => {
    setup([{ data: held(), error: null }]);
    const res = await extendReservation({ error: null, savedAt: null }, form("2020-01-01"));
    expect(res.error).toMatch(/already passed/i);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it("extends, and the event reads from-earlier to-later", async () => {
    setup([
      { data: held(), error: null },
      { data: [{ id: "res-1" }], error: null },
    ]);
    const res = await extendReservation({ error: null, savedAt: null }, form("2028-03-31"));
    expect(res.error).toBeNull();
    expect(logEvent).toHaveBeenCalledTimes(1);

    const payload = (logEvent.mock.calls[0][1] as { payload: { from: string; to: string } }).payload;
    expect(
      new Date(payload.to).getTime(),
      "the direction the word 'extended' promises",
    ).toBeGreaterThan(new Date(payload.from).getTime());
  });

  it("extends a hold with no expiry recorded, rather than refusing on a null", async () => {
    // `expires_at` is NOT NULL in the schema, but the read is typed nullable and
    // a comparison against null must not become a silent refusal.
    setup([
      { data: held({ expires_at: null }), error: null },
      { data: [{ id: "res-1" }], error: null },
    ]);
    const res = await extendReservation({ error: null, savedAt: null }, form("2028-03-31"));
    expect(res.error).toBeNull();
    expect(logEvent).toHaveBeenCalledTimes(1);
  });
});
