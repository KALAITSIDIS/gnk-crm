import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";

/**
 * Releasing (or otherwise settling) a reservation stores the typed release
 * reason on the RESERVATION ROW and logs the act — which hold, from which
 * status to which — never the reason itself (audit SEC-03, DECISIONS
 * T-reservation-release-reason-shape).
 *
 * The reason is free text an agent types, up to 300 characters ("buyer's mother
 * fell ill, Elena will call back"). Until this change `transitionReservation`
 * copied it into the hash-chained `reservation_status_changed` event on the
 * property, and printed it on the property's Activity tab, the admin feed and
 * a property-scoped commission evidence report — one buyer's reason on a
 * report about another. Worse, the ROW dropped a reason posted with a live
 * target (`confirmed`) while the EVENT kept it: text the chain held and no row
 * ever did. The row is where the reason belongs; the Reservation tab's "Earlier
 * holds" prints it from there.
 *
 * The real action calls the real `logEvent`; the assertions read the row that
 * reached `events.insert` — the exact bytes the chain would hash.
 */

const state = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));
// completeLiveHoldChecks (a settled hold closes its prompt) asks the system client
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.client }));
vi.mock("@/lib/services/auth", () => ({
  getCurrentProfile: async () => ({ id: "agent-1", orgId: "org-1", role: "agent" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { transitionReservation } = await import("@/lib/actions/reservations");

const RES_ID = "3c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e01";
const PROPERTY_ID = "3c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e02";
// synthetic: a name, a phone number and an e-mail — none may reach the chain
const REASON = "Elena Hadjipetrou's mother fell ill, call 99 777 888 or elena.h@example.invalid";
const WORDS = ["Elena", "Hadjipetrou", "mother", "99 777 888", "elena.h", "example.invalid"];

const held = (status = "held"): FakePage => ({
  data: { id: RES_ID, property_id: PROPERTY_ID, status, deal_id: null },
  error: null,
});
const updatedOne: FakePage = { data: [{ id: RES_ID }], error: null };

function transition(to: string, reason: string | null, reservations: FakePage[], extra: Record<string, FakePage[]> = {}) {
  const fake = fakeClient({ reservations, ...extra });
  state.client = fake.client;
  const fd = new FormData();
  fd.set("reservation_id", RES_ID);
  fd.set("to", to);
  if (reason !== null) fd.set("release_reason", reason);
  return { fake, result: transitionReservation({ error: null, savedAt: null } as never, fd) };
}

const inserted = (fake: ReturnType<typeof fakeClient>) =>
  fake.argsOf("events", "insert").map((args) => args[0] as Record<string, unknown>);
const statusChanged = (fake: ReturnType<typeof fakeClient>) =>
  inserted(fake).filter((r) => r.event_type === "reservation_status_changed");

beforeEach(() => {
  state.client = null;
});

describe("transitionReservation keeps the release reason on the row, not in the chain", () => {
  it("release: the row gets the status and the typed reason, conditional on the status it read", async () => {
    const { fake, result } = transition("released", REASON, [held(), updatedOne]);
    expect((await result).error).toBeNull();
    const [patch] = fake.argsOf("reservations", "update")[0] as [Record<string, unknown>];
    expect(patch).toMatchObject({ status: "released", release_reason: REASON });
    expect(typeof patch.released_at).toBe("string");
    // race-safe precondition folded into the write, unchanged
    expect(fake.argsOf("reservations", "eq")).toEqual(
      expect.arrayContaining([
        ["id", RES_ID],
        ["status", "held"],
      ]),
    );
  });

  it("release: ONE status event on the property, naming the hold and the move only", async () => {
    const { fake, result } = transition("released", REASON, [held(), updatedOne]);
    expect((await result).error).toBeNull();
    const rows = statusChanged(fake);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      org_id: "org-1",
      actor_id: "agent-1",
      entity_type: "property",
      entity_id: PROPERTY_ID,
    });
    expect(rows[0].payload).toEqual({ reservation_id: RES_ID, from: "held", to: "released" });
  });

  it("a reason posted with a LIVE target reaches neither the row nor the chain", async () => {
    // the UI sends a reason only with Release, but a form can post anything;
    // the row always dropped it here, and the event used to keep it
    const { fake, result } = transition("confirmed", REASON, [held(), updatedOne]);
    expect((await result).error).toBeNull();
    const [patch] = fake.argsOf("reservations", "update")[0] as [Record<string, unknown>];
    expect(patch.release_reason).toBeNull();
    expect(statusChanged(fake)[0].payload).toEqual({ reservation_id: RES_ID, from: "held", to: "confirmed" });
  });

  it("a release without a reason logs the same shape — no `reason` key at all", async () => {
    const { fake, result } = transition("released", null, [held("confirmed"), updatedOne]);
    expect((await result).error).toBeNull();
    expect(statusChanged(fake)[0].payload).toEqual({ reservation_id: RES_ID, from: "confirmed", to: "released" });
  });

  it("converted: the same shape (a sold listing raises no prompt)", async () => {
    const { fake, result } = transition("converted", REASON, [held(), updatedOne], {
      properties: [{ data: { id: PROPERTY_ID, reference: "PAF0999", status: "sold" }, error: null }],
    });
    expect((await result).error).toBeNull();
    expect(statusChanged(fake)[0].payload).toEqual({ reservation_id: RES_ID, from: "held", to: "converted" });
  });

  it("puts none of the reason's words in ANY event row it writes, whatever the target", async () => {
    for (const to of ["released", "confirmed", "expired"]) {
      const { fake, result } = transition(to, REASON, [held(), updatedOne]);
      expect((await result).error).toBeNull();
      const text = JSON.stringify(inserted(fake));
      expect(WORDS.filter((w) => text.includes(w)), `a release reason reached the chain (${to})`).toEqual([]);
    }
  });

  it("a reservation that changed underneath (0 rows) logs no phantom event", async () => {
    const { fake, result } = transition("released", REASON, [held(), { data: [], error: null }]);
    expect((await result).error).toMatch(/changed underneath/);
    expect(inserted(fake)).toEqual([]);
  });

  it("a final reservation is refused before anything is written or logged", async () => {
    const { fake, result } = transition("released", REASON, [held("released")]);
    expect((await result).error).toMatch(/final/);
    expect(fake.argsOf("reservations", "update")).toEqual([]);
    expect(inserted(fake)).toEqual([]);
  });
});
