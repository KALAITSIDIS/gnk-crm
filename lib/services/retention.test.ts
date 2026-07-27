import { describe, expect, it } from "vitest";
import {
  RETENTION_DUE_SOON_DAYS,
  classifyRetention,
  daysUntilRetentionEnds,
  summarizeRetention,
  type RetentionRow,
} from "./retention";

describe("daysUntilRetentionEnds", () => {
  it("counts whole days between two Cyprus day keys", () => {
    expect(daysUntilRetentionEnds("2031-07-21", "2031-07-21")).toBe(0);
    expect(daysUntilRetentionEnds("2031-07-22", "2031-07-21")).toBe(1);
    expect(daysUntilRetentionEnds("2031-07-20", "2031-07-21")).toBe(-1);
  });

  it("spans months and leap years without drift", () => {
    expect(daysUntilRetentionEnds("2032-03-01", "2032-02-28")).toBe(2); // 2032 is a leap year
    expect(daysUntilRetentionEnds("2027-01-01", "2026-12-31")).toBe(1);
  });
});

describe("classifyRetention", () => {
  it("is expired on and after the retention date — the duty has run", () => {
    // The AML duty is "5 years past the relationship"; on the stored date the
    // obligation has been served, so the files may be purged that day.
    expect(classifyRetention("2031-07-21", "2031-07-21")).toBe("expired");
    expect(classifyRetention("2031-07-21", "2031-07-22")).toBe("expired");
  });

  it("warns while the end is inside the notice window", () => {
    expect(classifyRetention("2031-07-21", "2031-07-20")).toBe("due_soon");
    expect(classifyRetention("2031-07-21", "2031-05-01")).toBe("due_soon");
  });

  it("is simply retained beyond the notice window", () => {
    expect(classifyRetention("2031-07-21", "2026-07-24")).toBe("retained");
  });

  it("puts the notice-window boundary in due_soon, one day earlier in retained", () => {
    const boundary = "2031-04-22"; // exactly RETENTION_DUE_SOON_DAYS before
    expect(daysUntilRetentionEnds("2031-07-21", boundary)).toBe(RETENTION_DUE_SOON_DAYS);
    expect(classifyRetention("2031-07-21", boundary)).toBe("due_soon");
    expect(classifyRetention("2031-07-21", "2031-04-21")).toBe("retained");
  });
});

describe("summarizeRetention", () => {
  const rows: RetentionRow[] = [
    { id: "a", displayName: "Later", retentionUntil: "2031-07-21" },
    { id: "b", displayName: "Lapsed", retentionUntil: "2026-01-01" },
    { id: "c", displayName: "Soon", retentionUntil: "2026-09-01" },
  ];

  it("sorts soonest-first so the actionable rows lead", () => {
    const out = summarizeRetention(rows, "2026-07-24");
    expect(out.map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("tags each row with its status and remaining days", () => {
    const out = summarizeRetention(rows, "2026-07-24");
    expect(out[0]).toMatchObject({ id: "b", status: "expired" });
    expect(out[1]).toMatchObject({ id: "c", status: "due_soon" });
    expect(out[2]).toMatchObject({ id: "a", status: "retained" });
    expect(out[0].daysRemaining).toBeLessThan(0);
  });

  it("returns an empty list unchanged", () => {
    expect(summarizeRetention([], "2026-07-24")).toEqual([]);
  });
});
