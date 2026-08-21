import { describe, expect, it } from "vitest";
import { canRenew, resolveRenewalDates, toIsoDate } from "./mandate-renewal";

describe("resolveRenewalDates", () => {
  it("runs for the same NUMBER OF DAYS as the mandate it replaces", () => {
    // Jan 1 -> Jul 1 is 181 days, so the renewal is Jul 1 -> Dec 29. Day-count,
    // not calendar months: "six months" is not a fixed length, and month
    // arithmetic has its own edge (Jan 31 plus one month is a judgement call).
    // The duration is what the two parties actually agreed to last time.
    expect(
      resolveRenewalDates({ start_date: "2026-01-01", expiry_date: "2026-07-01" }, "2026-06-01"),
    ).toEqual({ start_date: "2026-07-01", expiry_date: "2026-12-29" });
  });

  it("starts when the old one ends, so the windows never overlap", () => {
    // renewing early must not produce two live windows over one property
    const r = resolveRenewalDates(
      { start_date: "2026-01-01", expiry_date: "2026-12-31" },
      "2026-03-15",
    );
    expect(r.start_date).toBe("2026-12-31");
  });

  it("starts today when the old one already lapsed — no back-dating", () => {
    // covering a gap nobody was under mandate for would be inventing history
    const r = resolveRenewalDates(
      { start_date: "2025-01-01", expiry_date: "2025-07-01" },
      "2026-08-21",
    );
    expect(r.start_date).toBe("2026-08-21");
    expect(r.expiry_date).toBe("2027-02-18"); // the same 181-day window, from today
  });

  it("keeps an open-ended mandate open-ended", () => {
    // there is no duration to copy; inventing an expiry would be worse
    expect(resolveRenewalDates({ start_date: "2026-01-01", expiry_date: null }, "2026-08-21"))
      .toEqual({ start_date: "2026-08-21", expiry_date: null });
  });

  it("stays open-ended when there is an expiry but no start to measure from", () => {
    expect(resolveRenewalDates({ start_date: null, expiry_date: "2026-12-31" }, "2026-08-21"))
      .toEqual({ start_date: "2026-12-31", expiry_date: null });
  });

  it("refuses to invent a window from a zero or inverted duration", () => {
    expect(
      resolveRenewalDates({ start_date: "2026-07-01", expiry_date: "2026-07-01" }, "2026-06-01")
        .expiry_date,
    ).toBeNull();
    expect(
      resolveRenewalDates({ start_date: "2026-12-01", expiry_date: "2026-01-01" }, "2026-06-01")
        .expiry_date,
    ).toBeNull();
  });

  it("always produces an expiry after its own start", () => {
    const cases = [
      { start_date: "2026-01-01", expiry_date: "2026-02-01" },
      { start_date: "2020-05-05", expiry_date: "2021-05-05" },
      { start_date: "2026-08-01", expiry_date: "2026-08-02" },
    ];
    for (const c of cases) {
      const r = resolveRenewalDates(c, "2026-08-21");
      if (r.expiry_date) expect(r.expiry_date > r.start_date).toBe(true);
    }
  });
});

describe("toIsoDate", () => {
  it("emits the YYYY-MM-DD shape the columns and date inputs use", () => {
    expect(toIsoDate(new Date("2026-08-21T13:45:00Z"))).toBe("2026-08-21");
  });
});

describe("canRenew", () => {
  it("allows renewing an active mandate — renewals are agreed before lapsing", () => {
    // the successor is a draft, so the one-active-per-property index still
    // forces the old one to be terminated before the new one goes live
    expect(canRenew("active")).toBe(true);
  });

  it("allows renewing an expired one", () => {
    expect(canRenew("expired")).toBe(true);
  });

  it("refuses a terminated one — that ended, it did not lapse", () => {
    expect(canRenew("terminated")).toBe(false);
  });

  it("refuses a draft — there is nothing to continue yet", () => {
    expect(canRenew("draft")).toBe(false);
  });
});
