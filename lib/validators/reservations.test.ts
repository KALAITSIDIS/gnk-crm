import { describe, expect, it } from "vitest";
import {
  RESERVATION_TRANSITIONS,
  createReservationSchema,
  cyprusEndOfDay,
  isLiveReservation,
} from "./reservations";

describe("cyprusEndOfDay", () => {
  it("uses the REAL Cyprus offset, which changes with DST", () => {
    // THE BUG THIS GUARDS. The first version hardcoded +03:00, which is right
    // in summer and an hour wrong every winter — Cyprus is EET (UTC+2) outside
    // DST. A hold "until 15 January" would then have lapsed at 22:59 local.
    expect(cyprusEndOfDay("2026-01-15").toISOString()).toBe("2026-01-15T21:59:59.000Z"); // EET, +2
    expect(cyprusEndOfDay("2026-07-15").toISOString()).toBe("2026-07-15T20:59:59.000Z"); // EEST, +3
  });

  it("keeps a hold alive through the whole of its final local day", () => {
    // "until Friday" must not lapse on Thursday evening Cyprus time.
    const end = cyprusEndOfDay("2026-07-15");
    const fridayEvening = new Date("2026-07-15T20:00:00.000Z"); // 23:00 Cyprus
    expect(end.getTime()).toBeGreaterThan(fridayEvening.getTime());
  });
});

describe("RESERVATION_TRANSITIONS", () => {
  it("gives terminal states no way out", () => {
    // Mirrors OFFER_TRANSITIONS: a decided offer is never reopened, and a
    // lapsed hold is not either — take a new one, the old row stays history.
    for (const terminal of ["expired", "released", "converted"] as const) {
      expect(RESERVATION_TRANSITIONS[terminal], `${terminal} must be terminal`).toEqual([]);
    }
  });

  it("lets a live hold be confirmed, released, expired or converted", () => {
    expect(RESERVATION_TRANSITIONS.held).toContain("confirmed");
    expect(RESERVATION_TRANSITIONS.held).toContain("released");
    expect(RESERVATION_TRANSITIONS.confirmed).toContain("converted");
    // but never back to held — that would have to dodge the unique index, and
    // the property may have been re-reserved meanwhile
    expect(RESERVATION_TRANSITIONS.confirmed).not.toContain("held");
  });

  it("agrees with isLiveReservation about which states occupy a property", () => {
    // The index indexes `held` and `confirmed`. If this drifts, the UI would
    // show a property as free while the database refuses a new hold on it.
    expect(isLiveReservation("held")).toBe(true);
    expect(isLiveReservation("confirmed")).toBe(true);
    for (const dead of ["expired", "released", "converted"] as const) {
      expect(isLiveReservation(dead), `${dead} must not occupy the property`).toBe(false);
    }
  });
});

describe("createReservationSchema", () => {
  const PROP = "11111111-1111-4111-8111-111111111111";
  const base = { property_id: PROP, expires_on: "2026-09-30" };

  it("keeps a blank deposit unset rather than making it zero", () => {
    const r = createReservationSchema.safeParse({ ...base, amount: "" });
    expect(r.success).toBe(true);
    expect(r.data!.amount).toBeUndefined();
  });

  it("accepts a real deposit and rejects a negative one", () => {
    expect(createReservationSchema.safeParse({ ...base, amount: "5000" }).data!.amount).toBe(5000);
    expect(createReservationSchema.safeParse({ ...base, amount: "-1" }).success).toBe(false);
  });

  it("requires a property and an expiry date -- a hold with no end is not a hold", () => {
    expect(createReservationSchema.safeParse({ property_id: PROP }).success).toBe(false);
    expect(createReservationSchema.safeParse({ expires_on: "2026-09-30" }).success).toBe(false);
  });

  it("rejects a malformed date rather than coercing it", () => {
    expect(createReservationSchema.safeParse({ ...base, expires_on: "30/09/2026" }).success).toBe(
      false,
    );
    expect(createReservationSchema.safeParse({ ...base, expires_on: "2026-13-45" }).success).toBe(
      false,
    );
  });
});
