import { describe, expect, it } from "vitest";
import {
  WINDOW_DAYS_AHEAD,
  WINDOW_DAYS_BACK,
  addDayKey,
  calendarWindow,
  isRangeWithinWindow,
  parseDayKey,
  visibleRange,
  weekStartKey,
} from "./calendar-window";

describe("day-key arithmetic", () => {
  it("adds and subtracts days across month and year ends", () => {
    expect(addDayKey("2026-07-24", 1)).toBe("2026-07-25");
    expect(addDayKey("2026-07-31", 1)).toBe("2026-08-01");
    expect(addDayKey("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDayKey("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("handles the leap day", () => {
    expect(addDayKey("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDayKey("2028-02-29", 1)).toBe("2028-03-01");
  });

  it("does not drift across a DST boundary (operates at UTC noon)", () => {
    // Cyprus springs forward on the last Sunday of March.
    expect(addDayKey("2026-03-28", 1)).toBe("2026-03-29");
    expect(addDayKey("2026-03-29", 1)).toBe("2026-03-30");
  });

  it("finds the Monday that starts the week", () => {
    expect(weekStartKey("2026-07-24")).toBe("2026-07-20"); // Fri → Mon
    expect(weekStartKey("2026-07-20")).toBe("2026-07-20"); // Mon → itself
    expect(weekStartKey("2026-07-26")).toBe("2026-07-20"); // Sun → same week's Mon
  });
});

describe("parseDayKey", () => {
  it("accepts a well-formed key and rejects anything else", () => {
    expect(parseDayKey("2026-07-24", "2026-01-01")).toBe("2026-07-24");
    expect(parseDayKey(undefined, "2026-01-01")).toBe("2026-01-01");
    expect(parseDayKey("", "2026-01-01")).toBe("2026-01-01");
    expect(parseDayKey("not-a-date", "2026-01-01")).toBe("2026-01-01");
    expect(parseDayKey("2026-13-45", "2026-01-01")).toBe("2026-01-01"); // real calendar check
    expect(parseDayKey("2026-7-4", "2026-01-01")).toBe("2026-01-01"); // must be zero-padded
  });
});

describe("calendarWindow", () => {
  it("spans the configured range around the anchor, not around today", () => {
    const w = calendarWindow("2030-06-15");
    expect(w.fromKey).toBe(addDayKey("2030-06-15", -WINDOW_DAYS_BACK));
    expect(w.toKey).toBe(addDayKey("2030-06-15", WINDOW_DAYS_AHEAD));
  });
});

describe("visibleRange", () => {
  it("covers the anchor's Monday-start week in week view", () => {
    expect(visibleRange("2026-07-24", "week")).toEqual({
      fromKey: "2026-07-20",
      toKey: "2026-07-26",
    });
  });

  it("covers just the anchor in day and route view", () => {
    expect(visibleRange("2026-07-24", "day")).toEqual({
      fromKey: "2026-07-24",
      toKey: "2026-07-24",
    });
    expect(visibleRange("2026-07-24", "route")).toEqual({
      fromKey: "2026-07-24",
      toKey: "2026-07-24",
    });
  });

  it("covers the anchor's week in list view too (it reads forward from there)", () => {
    expect(visibleRange("2026-07-24", "list")).toEqual({
      fromKey: "2026-07-20",
      toKey: "2026-07-26",
    });
  });
});

describe("isRangeWithinWindow", () => {
  const window = calendarWindow("2026-07-24");

  it("is true for a range fully inside the loaded window", () => {
    expect(isRangeWithinWindow(visibleRange("2026-07-24", "week"), window)).toBe(true);
    expect(isRangeWithinWindow(visibleRange("2026-08-24", "week"), window)).toBe(true);
  });

  it("is false once the view steps past either edge — the refetch trigger", () => {
    // This is the whole point: beyond the loaded window the calendar would
    // otherwise render an empty week that looks like "no viewings".
    const farFuture = visibleRange(addDayKey("2026-07-24", WINDOW_DAYS_AHEAD + 3), "week");
    expect(isRangeWithinWindow(farFuture, window)).toBe(false);

    const farPast = visibleRange(addDayKey("2026-07-24", -(WINDOW_DAYS_BACK + 3)), "week");
    expect(isRangeWithinWindow(farPast, window)).toBe(false);
  });

  it("is false when the range merely straddles an edge, not only when fully outside", () => {
    // a week containing the last loaded day but extending past it
    const straddling = visibleRange(window.toKey, "week");
    expect(isRangeWithinWindow(straddling, window)).toBe(false);
  });
});
