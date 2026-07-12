import { describe, expect, it } from "vitest";
import { utcToDatetimeLocal, zonedParts, zonedWallClockToUtc } from "./tz";

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
