import { describe, expect, it } from "vitest";
import { computeConflictIds, intervalsOverlap } from "./viewings";

const T = (h: number, m = 0) => Date.UTC(2026, 6, 15, h, m); // fixed July day

describe("intervalsOverlap", () => {
  it("detects overlap", () => {
    expect(intervalsOverlap(T(10), T(11), T(10, 30), T(11, 30))).toBe(true);
  });
  it("treats touching edges as non-overlapping (half-open)", () => {
    expect(intervalsOverlap(T(10), T(11), T(11), T(12))).toBe(false);
  });
  it("detects full containment", () => {
    expect(intervalsOverlap(T(10), T(12), T(10, 30), T(11))).toBe(true);
  });
});

describe("computeConflictIds", () => {
  it("flags both viewings when the same agent double-books", () => {
    const ids = computeConflictIds([
      { id: "a", agentId: "ag1", startMs: T(10), durationMin: 60 },
      { id: "b", agentId: "ag1", startMs: T(10, 30), durationMin: 30 },
    ]);
    expect(ids).toEqual(new Set(["a", "b"]));
  });

  it("does not flag overlaps across different agents", () => {
    const ids = computeConflictIds([
      { id: "a", agentId: "ag1", startMs: T(10), durationMin: 60 },
      { id: "b", agentId: "ag2", startMs: T(10, 30), durationMin: 60 },
    ]);
    expect(ids.size).toBe(0);
  });

  it("does not flag back-to-back viewings for one agent", () => {
    const ids = computeConflictIds([
      { id: "a", agentId: "ag1", startMs: T(10), durationMin: 30 },
      { id: "b", agentId: "ag1", startMs: T(10, 30), durationMin: 30 },
    ]);
    expect(ids.size).toBe(0);
  });

  it("flags every member of a 3-way pileup", () => {
    const ids = computeConflictIds([
      { id: "a", agentId: "ag1", startMs: T(10), durationMin: 120 },
      { id: "b", agentId: "ag1", startMs: T(10, 30), durationMin: 30 },
      { id: "c", agentId: "ag1", startMs: T(11), durationMin: 30 },
    ]);
    expect(ids).toEqual(new Set(["a", "b", "c"]));
  });
});
