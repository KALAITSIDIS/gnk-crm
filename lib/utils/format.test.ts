import { describe, expect, it } from "vitest";
import { formatResponseMinutes } from "./format";

describe("formatResponseMinutes (0042)", () => {
  it("renders the three values verified on the dashboard", () => {
    // measured 2026-08-23 against a seeded spread of 1..9 and 600 minutes
    expect(formatResponseMinutes(64.5)).toBe("1h 5m"); // mean
    expect(formatResponseMinutes(5.5)).toBe("6m"); // median
    expect(formatResponseMinutes(68.0999999999998)).toBe("1h 8m"); // p90, as SQL returns it
  });

  it("renders a MISSING key as an em dash, not NaN", () => {
    // THE REGRESSION THIS FILE EXISTS FOR. Vercel deploys on push while
    // migrations are applied by hand, so production can briefly run this code
    // against a pre-0042 admin_dashboard_stats with no p50/p90 key. The first
    // version used `v === null`, so `undefined` reached Number() and the tile
    // rendered "NaNh NaNm".
    expect(formatResponseMinutes(undefined)).toBe("—");
    expect(formatResponseMinutes(null)).toBe("—");
    expect(formatResponseMinutes(Number.NaN)).toBe("—");
    expect(formatResponseMinutes(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("accepts the string numerics jsonb/postgrest can hand back", () => {
    expect(formatResponseMinutes("64.5")).toBe("1h 5m");
    expect(formatResponseMinutes("0")).toBe("0m");
    expect(formatResponseMinutes("not a number")).toBe("—");
  });

  it("rounds to whole minutes BEFORE splitting, so 1h 60m is impossible", () => {
    // 119.7 rounds to 120 -> "2h 0m". Splitting first gives floor(119.7/60)=1
    // and round(59.7)=60, i.e. "1h 60m" — the arithmetic this replaced.
    expect(formatResponseMinutes(119.7)).toBe("2h 0m");
    expect(formatResponseMinutes(59.7)).toBe("1h 0m");
  });

  it("handles the boundary and the zero case", () => {
    expect(formatResponseMinutes(0)).toBe("0m");
    expect(formatResponseMinutes(59)).toBe("59m");
    expect(formatResponseMinutes(60)).toBe("1h 0m");
    expect(formatResponseMinutes(61)).toBe("1h 1m");
  });

  it("treats a negative interval as no answer", () => {
    // 0042 filters these out in SQL, so this is belt-and-braces: a corrected
    // clock must never render as a negative duration if one ever reaches here.
    expect(formatResponseMinutes(-5)).toBe("—");
  });
});
