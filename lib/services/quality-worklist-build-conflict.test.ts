import { describe, expect, it } from "vitest";
import { buildWorklist, inheritsBuildConflict, type ScoredProperty } from "./quality-worklist";
import type { QualityScoreResult } from "./quality-score";

/**
 * The worklist names the listings whose build details contradict each other,
 * as it names the ones sharing a photograph: a group of its own, not a
 * category with points, because nothing is missing — something is wrong.
 *
 * F03: a unit that inherits its project's construction status or delivery
 * date (0035 inherited_fields) carries the project's contradiction. It is
 * grouped under the project — one row, fixed there, then synced from its
 * Units page — instead of one row per unit, each sending the desk to that
 * unit's Details tab.
 */
const DELIVERY_PASSED = "The delivery date has passed and the build is not recorded as finished.";
const OWN_YEAR = "Built in 2007, but the build is recorded as finishing — one of these is not true.";

const scored = (
  reference: string,
  warnings: QualityScoreResult["warnings"],
  lineage?: ScoredProperty["lineage"],
): ScoredProperty => ({
  property: { id: `id-${reference}`, reference, title: null, score: 85 },
  listing: { visibility: "private", status: "available", publishedAt: null },
  result: { score: 85, items: [], missing: [], essentialsMissing: [], warnings },
  ...(lineage ? { lineage } : {}),
});
const conflict = (label: string): QualityScoreResult["warnings"] => [
  { key: "build_conflict", label, references: [] },
];
const INHERITS = ["construction_status", "delivery_date", "features"];

describe("buildWorklist and build conflicts", () => {
  it("lists a listing whose score carries a build_conflict warning, with the warning's words", () => {
    const w = buildWorklist([
      scored("PAF0001", [{ key: "build_conflict", label: "Built in 2007, but recorded as finishing.", references: [] }]),
      scored("PAF0004", []),
    ]);
    expect(w.buildConflicts).toEqual([
      {
        property: { id: "id-PAF0001", reference: "PAF0001", title: null, score: 85 },
        label: "Built in 2007, but recorded as finishing.",
        inheritedFrom: null,
      },
    ]);
    expect(w.buildConflictGroups.map((g) => [g.source.property.reference, g.inheritedBy])).toEqual([["PAF0001", []]]);
  });

  it("leaves the shared-photo group as it was", () => {
    const w = buildWorklist([
      scored("PAF0002", [{ key: "shared_photo", label: "A photograph also appears on PAF0001", references: ["PAF0001"] }]),
    ]);
    expect(w.sharedPhotos).toHaveLength(1);
    expect(w.buildConflicts).toEqual([]);
    expect(w.buildConflictGroups).toEqual([]);
  });
});

describe("a contradiction inherited from a project is one row, under the project (F03)", () => {
  const project = scored("PAF0002", conflict(DELIVERY_PASSED), { parentId: null, inheritedFields: [] });
  const unit = (ref: string, over: Partial<NonNullable<ScoredProperty["lineage"]>> = {}, label = DELIVERY_PASSED) =>
    scored(ref, conflict(label), { parentId: "id-PAF0002", inheritedFields: INHERITS, ...over });

  it("groups PAF0002 and the six units carrying its contradiction: seven listings, one to correct", () => {
    const units = ["PAF0002-A1", "PAF0002-A2", "PAF0002-A3", "PAF0002-B1", "PAF0002-B2", "PAF0002-B3"].map((r) => unit(r));
    const w = buildWorklist([...units.reverse(), project]);
    // every listing still listed — the count is not lost
    expect(w.buildConflicts).toHaveLength(7);
    expect(w.buildConflicts.filter((c) => c.inheritedFrom?.reference === "PAF0002")).toHaveLength(6);
    expect(w.buildConflictGroups).toHaveLength(1);
    const [g] = w.buildConflictGroups;
    expect(g!.source.property.reference).toBe("PAF0002");
    expect(g!.source.inheritedFrom).toBeNull();
    expect(g!.inheritedBy.map((p) => p.reference)).toEqual([
      "PAF0002-A1",
      "PAF0002-A2",
      "PAF0002-A3",
      "PAF0002-B1",
      "PAF0002-B2",
      "PAF0002-B3",
    ]);
  });

  it("keeps a unit on its own when it no longer inherits the build columns (it was edited)", () => {
    const w = buildWorklist([project, unit("PAF0002-A1", { inheritedFields: ["features"] })]);
    expect(w.buildConflictGroups.map((g) => [g.source.property.reference, g.inheritedBy.length])).toEqual([
      ["PAF0002", 0],
      ["PAF0002-A1", 0],
    ]);
  });

  it("keeps a unit on its own when its contradiction is its own sentence (its own year built)", () => {
    const w = buildWorklist([project, unit("PAF0002-A1", {}, OWN_YEAR)]);
    expect(w.buildConflicts.find((c) => c.property.reference === "PAF0002-A1")!.inheritedFrom).toBeNull();
    expect(w.buildConflictGroups).toHaveLength(2);
  });

  it("keeps a unit on its own when its project declares nothing wrong", () => {
    const w = buildWorklist([scored("PAF0002", []), unit("PAF0002-A1")]);
    expect(w.buildConflicts.map((c) => [c.property.reference, c.inheritedFrom])).toEqual([["PAF0002-A1", null]]);
  });

  it("follows unit → phase → project, so a project's contradiction collects its phases' units", () => {
    const phase = scored("PAF0002-P1", conflict(DELIVERY_PASSED), { parentId: "id-PAF0002", inheritedFields: INHERITS });
    const deep = scored("PAF0002-P1-01", conflict(DELIVERY_PASSED), { parentId: "id-PAF0002-P1", inheritedFields: INHERITS });
    const w = buildWorklist([deep, phase, project]);
    expect(w.buildConflictGroups).toHaveLength(1);
    expect(w.buildConflictGroups[0]!.inheritedBy.map((p) => p.reference)).toEqual(["PAF0002-P1", "PAF0002-P1-01"]);
    expect(w.buildConflicts.find((c) => c.property.reference === "PAF0002-P1-01")!.inheritedFrom).toEqual({
      id: "id-PAF0002",
      reference: "PAF0002",
    });
  });

  it("never loses a row to a parent loop (no real data has one)", () => {
    const a = scored("LOOP-A", conflict(DELIVERY_PASSED), { parentId: "id-LOOP-B", inheritedFields: INHERITS });
    const b = scored("LOOP-B", conflict(DELIVERY_PASSED), { parentId: "id-LOOP-A", inheritedFields: INHERITS });
    const w = buildWorklist([a, b]);
    const listed = w.buildConflictGroups.flatMap((g) => [g.source.property.reference, ...g.inheritedBy.map((p) => p.reference)]);
    expect(listed.sort()).toEqual(["LOOP-A", "LOOP-B"]);
  });
});

describe("inheritsBuildConflict", () => {
  it("is true only for the same sentence AND an inherited build column", () => {
    expect(inheritsBuildConflict({ conflict: DELIVERY_PASSED, inheritedFields: ["delivery_date"] }, DELIVERY_PASSED)).toBe(true);
    expect(inheritsBuildConflict({ conflict: DELIVERY_PASSED, inheritedFields: ["construction_status"] }, DELIVERY_PASSED)).toBe(true);
    expect(inheritsBuildConflict({ conflict: DELIVERY_PASSED, inheritedFields: ["features"] }, DELIVERY_PASSED)).toBe(false);
    expect(inheritsBuildConflict({ conflict: DELIVERY_PASSED, inheritedFields: null }, DELIVERY_PASSED)).toBe(false);
    expect(inheritsBuildConflict({ conflict: DELIVERY_PASSED, inheritedFields: INHERITS }, OWN_YEAR)).toBe(false);
    expect(inheritsBuildConflict({ conflict: null, inheritedFields: INHERITS }, null)).toBe(false);
  });
});
