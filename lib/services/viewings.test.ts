import { describe, expect, it } from "vitest";
import {
  computeConflictIds,
  groupRouteStops,
  initialRouteOrder,
  intervalsOverlap,
} from "./viewings";

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

describe("initialRouteOrder", () => {
  const item = (id: string, startMinutes: number, routeDate: string | null, routeOrder: number | null) => ({
    id,
    startMinutes,
    routeDate,
    routeOrder,
  });

  it("keeps saved route order for the day ahead of unrouted stops", () => {
    const out = initialRouteOrder(
      [
        item("late-but-first", 900, "2026-07-20", 1),
        item("early-unrouted", 540, null, null),
        item("second", 600, "2026-07-20", 2),
      ],
      "2026-07-20",
    );
    expect(out.map((v) => v.id)).toEqual(["late-but-first", "second", "early-unrouted"]);
  });

  it("orders unrouted stops by start time", () => {
    const out = initialRouteOrder(
      [item("b", 720, null, null), item("a", 540, null, null)],
      "2026-07-20",
    );
    expect(out.map((v) => v.id)).toEqual(["a", "b"]);
  });

  it("ignores a route saved for a different date", () => {
    const out = initialRouteOrder(
      [item("stale-route", 900, "2026-07-19", 1), item("earlier", 540, null, null)],
      "2026-07-20",
    );
    expect(out.map((v) => v.id)).toEqual(["earlier", "stale-route"]);
  });

  it("does not mutate the input array", () => {
    const items = [item("b", 720, null, null), item("a", 540, null, null)];
    initialRouteOrder(items, "2026-07-20");
    expect(items[0].id).toBe("b");
  });
});

describe("groupRouteStops", () => {
  const stop = (id: string, agentName: string, routeOrder: number | null) => ({
    id,
    agentName,
    routeOrder,
  });

  it("groups stops by agent with groups in name order", () => {
    const out = groupRouteStops([
      stop("z1", "Zoe", 1),
      stop("a1", "Alex", 1),
    ]);
    expect(out.map((g) => g.agent)).toEqual(["Alex", "Zoe"]);
    expect(out[0].stops.map((s) => s.id)).toEqual(["a1"]);
    expect(out[1].stops.map((s) => s.id)).toEqual(["z1"]);
  });

  it("keeps each agent's own sequence when order numbers overlap", () => {
    // two agents both saved routes numbered 1..2 — must not interleave
    const out = groupRouteStops([
      stop("a1", "Alex", 1),
      stop("b1", "Beth", 1),
      stop("a2", "Alex", 2),
      stop("b2", "Beth", 2),
    ]);
    expect(out.map((g) => g.agent)).toEqual(["Alex", "Beth"]);
    expect(out[0].stops.map((s) => s.id)).toEqual(["a1", "a2"]);
    expect(out[1].stops.map((s) => s.id)).toEqual(["b1", "b2"]);
  });

  it("sorts within a group by route order with unrouted stops last", () => {
    const out = groupRouteStops([
      stop("unrouted", "Alex", null),
      stop("second", "Alex", 2),
      stop("first", "Alex", 1),
    ]);
    expect(out[0].stops.map((s) => s.id)).toEqual(["first", "second", "unrouted"]);
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
