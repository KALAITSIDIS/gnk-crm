import { describe, expect, it } from "vitest";
import { utcToDatetimeLocal, zonedDateRangeToUtc, zonedParts, zonedWallClockToUtc } from "./tz";

// Cyprus DST 2026: EEST (UTC+3) from 29 Mar to 25 Oct, EET (UTC+2) otherwise.
describe("zonedWallClockToUtc", () => {
  it("treats a summer wall clock as UTC+3", () => {
    expect(zonedWallClockToUtc("2026-07-15T14:00").toISOString()).toBe("2026-07-15T11:00:00.000Z");
  });

  it("treats a winter wall clock as UTC+2", () => {
    expect(zonedWallClockToUtc("2026-01-15T14:00").toISOString()).toBe("2026-01-15T12:00:00.000Z");
  });

  it("accepts seconds and space separators", () => {
    expect(zonedWallClockToUtc("2026-07-15 09:30:00").toISOString()).toBe(
      "2026-07-15T06:30:00.000Z",
    );
  });

  it("rejects malformed input", () => {
    expect(() => zonedWallClockToUtc("nope")).toThrow();
  });
});

describe("utcToDatetimeLocal", () => {
  it("renders a UTC instant in Cyprus wall clock (summer)", () => {
    expect(utcToDatetimeLocal("2026-07-15T11:00:00.000Z")).toBe("2026-07-15T14:00");
  });

  it("renders a UTC instant in Cyprus wall clock (winter)", () => {
    expect(utcToDatetimeLocal("2026-01-15T12:00:00.000Z")).toBe("2026-01-15T14:00");
  });

  it("round-trips with zonedWallClockToUtc", () => {
    const wall = "2026-09-01T16:45";
    expect(utcToDatetimeLocal(zonedWallClockToUtc(wall))).toBe(wall);
  });
});

describe("zonedDateRangeToUtc", () => {
  it("maps an inclusive Cyprus date range to a half-open UTC interval (summer +3)", () => {
    expect(zonedDateRangeToUtc("2026-07-01", "2026-07-15")).toEqual({
      gte: "2026-06-30T21:00:00.000Z",
      lt: "2026-07-15T21:00:00.000Z",
    });
  });

  it("maps a winter range at UTC+2", () => {
    expect(zonedDateRangeToUtc("2026-01-15", "2026-01-15")).toEqual({
      gte: "2026-01-14T22:00:00.000Z",
      lt: "2026-01-15T22:00:00.000Z",
    });
  });

  it("crosses month and year boundaries when computing the exclusive end", () => {
    expect(zonedDateRangeToUtc(undefined, "2026-12-31").lt).toBe("2026-12-31T22:00:00.000Z");
  });

  it("leaves absent bounds open", () => {
    expect(zonedDateRangeToUtc("2026-07-01", undefined)).toEqual({
      gte: "2026-06-30T21:00:00.000Z",
      lt: undefined,
    });
    expect(zonedDateRangeToUtc(undefined, undefined)).toEqual({ gte: undefined, lt: undefined });
  });
});

describe("zonedParts", () => {
  it("buckets by Cyprus day and minutes past midnight", () => {
    // 23:30 UTC in summer is 02:30 the NEXT day in Cyprus
    expect(zonedParts("2026-07-15T23:30:00.000Z")).toEqual({
      dayKey: "2026-07-16",
      minutes: 150,
      timeLabel: "02:30",
    });
  });
});
