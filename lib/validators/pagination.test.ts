import { describe, expect, it } from "vitest";
import {
  LIST_PAGE_SIZE,
  isRangeBeyondEnd,
  pageRange,
  pageSchema,
  totalPages,
} from "./pagination";

describe("pageSchema", () => {
  it("defaults to page 1 when absent", () => {
    expect(pageSchema.parse(undefined)).toBe(1);
  });

  it("coerces the string a query param actually gives us", () => {
    expect(pageSchema.parse("3")).toBe(3);
  });

  /**
   * `?page=` is user-editable, so every junk value must land on page 1 rather
   * than throwing — an unparseable page must never take down a list screen.
   */
  it("falls back to page 1 for junk instead of throwing", () => {
    for (const junk of ["0", "-4", "abc", "", "1.5", "NaN", "1e999", null]) {
      expect(pageSchema.parse(junk), `page=${junk}`).toBe(1);
    }
  });
});

describe("pageRange", () => {
  it("page 1 starts at row 0 and is inclusive of both bounds", () => {
    // Supabase .range() is INCLUSIVE at both ends: 0..24 is 25 rows.
    expect(pageRange(1, 25)).toEqual({ from: 0, to: 24 });
  });

  it("advances by exactly one page with no gap or overlap", () => {
    const p1 = pageRange(1, 25);
    const p2 = pageRange(2, 25);
    expect(p2.from).toBe(p1.to + 1);
    expect(p2).toEqual({ from: 25, to: 49 });
  });

  it("spans exactly `size` rows on every page", () => {
    for (let page = 1; page <= 10; page++) {
      const { from, to } = pageRange(page, 25);
      expect(to - from + 1).toBe(25);
    }
  });

  it("treats a nonsensical page as the first page", () => {
    expect(pageRange(0, 25)).toEqual({ from: 0, to: 24 });
    expect(pageRange(-2, 25)).toEqual({ from: 0, to: 24 });
  });

  it("uses the shared default size", () => {
    expect(pageRange(2)).toEqual({ from: LIST_PAGE_SIZE, to: LIST_PAGE_SIZE * 2 - 1 });
  });
});

describe("totalPages", () => {
  it("is 1 for an empty list, so the UI never renders 'page 1 of 0'", () => {
    expect(totalPages(0, 25)).toBe(1);
  });

  it("does not add an empty trailing page on an exact multiple", () => {
    expect(totalPages(25, 25)).toBe(1);
    expect(totalPages(50, 25)).toBe(2);
  });

  it("rounds a partial page up", () => {
    expect(totalPages(26, 25)).toBe(2);
    expect(totalPages(437, 25)).toBe(18); // the worked example from PERF-2
  });
});

describe("isRangeBeyondEnd", () => {
  /**
   * PostgREST answers a range starting past the end of the result set with
   * PGRST103. That is a navigational dead end (a stale ?page=), not a failure
   * — the page must render an empty state, not throw to the error boundary.
   */
  it("recognises the PostgREST out-of-range code", () => {
    expect(isRangeBeyondEnd({ code: "PGRST103" })).toBe(true);
  });

  it("does not swallow real errors", () => {
    expect(isRangeBeyondEnd({ code: "42501" })).toBe(false); // insufficient privilege
    expect(isRangeBeyondEnd({ code: "PGRST116" })).toBe(false);
    expect(isRangeBeyondEnd(null)).toBe(false);
    expect(isRangeBeyondEnd(undefined)).toBe(false);
    expect(isRangeBeyondEnd({})).toBe(false);
  });
});
