import { describe, expect, it } from "vitest";
import { sortStranded, strandedReason, type StrandedTask } from "./stranded-tasks";

const task = (over: Partial<StrandedTask>): StrandedTask => ({
  id: "t1",
  title: "Task",
  dueAt: null,
  assigneeId: null,
  assigneeName: null,
  reason: "unassigned",
  isAuto: false,
  ...over,
});

describe("strandedReason", () => {
  it("separates the two invisibilities", () => {
    // They read differently in the UI — a deactivated row can name who held it,
    // an unassigned one has nobody to name — so the distinction has to survive
    // the query rather than being re-derived from a null name.
    expect(strandedReason({ is_active: false })).toBe("deactivated");
    expect(strandedReason(null)).toBe("unassigned");
    expect(strandedReason(undefined)).toBe("unassigned");
  });
});

describe("sortStranded", () => {
  it("puts the soonest due first and undated last", () => {
    const rows = [
      task({ id: "none", title: "No date" }),
      task({ id: "late", title: "Later", dueAt: "2026-09-01T00:00:00Z" }),
      task({ id: "soon", title: "Sooner", dueAt: "2026-08-01T00:00:00Z" }),
    ];
    expect(sortStranded(rows).map((r) => r.id)).toEqual(["soon", "late", "none"]);
  });

  it("breaks ties on title so the order is stable between renders", () => {
    const rows = [
      task({ id: "b", title: "Beta", dueAt: "2026-08-01T00:00:00Z" }),
      task({ id: "a", title: "Alpha", dueAt: "2026-08-01T00:00:00Z" }),
    ];
    expect(sortStranded(rows).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("does not mutate its input", () => {
    // The page passes the fetched array straight through; an in-place sort would
    // reorder whatever else happened to hold a reference.
    const rows = [
      task({ id: "late", dueAt: "2026-09-01T00:00:00Z" }),
      task({ id: "soon", dueAt: "2026-08-01T00:00:00Z" }),
    ];
    sortStranded(rows);
    expect(rows.map((r) => r.id)).toEqual(["late", "soon"]);
  });

  it("orders undated rows among themselves by title rather than arbitrarily", () => {
    const rows = [task({ id: "z", title: "Zeta" }), task({ id: "a", title: "Alpha" })];
    expect(sortStranded(rows).map((r) => r.id)).toEqual(["a", "z"]);
  });
});
