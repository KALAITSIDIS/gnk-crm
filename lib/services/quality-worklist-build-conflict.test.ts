import { describe, expect, it } from "vitest";
import { buildWorklist, type ScoredProperty } from "./quality-worklist";
import type { QualityScoreResult } from "./quality-score";

/**
 * The worklist names the listings whose build details contradict each other,
 * as it names the ones sharing a photograph: a group of its own, not a
 * category with points, because nothing is missing — something is wrong.
 */
const scored = (reference: string, warnings: QualityScoreResult["warnings"]): ScoredProperty => ({
  property: { id: `id-${reference}`, reference, title: null, score: 85 },
  listing: { visibility: "private", status: "available", publishedAt: null },
  result: { score: 85, items: [], missing: [], warnings },
});

describe("buildWorklist and build conflicts", () => {
  it("lists a listing whose score carries a build_conflict warning, with the warning's words", () => {
    const w = buildWorklist([
      scored("PAF0001", [{ key: "build_conflict", label: "Built in 2007, but recorded as finishing.", references: [] }]),
      scored("PAF0004", []),
    ]);
    expect(w.buildConflicts).toEqual([
      { property: { id: "id-PAF0001", reference: "PAF0001", title: null, score: 85 }, label: "Built in 2007, but recorded as finishing." },
    ]);
  });

  it("leaves the shared-photo group as it was", () => {
    const w = buildWorklist([
      scored("PAF0002", [{ key: "shared_photo", label: "A photograph also appears on PAF0001", references: ["PAF0001"] }]),
    ]);
    expect(w.sharedPhotos).toHaveLength(1);
    expect(w.buildConflicts).toEqual([]);
  });
});
