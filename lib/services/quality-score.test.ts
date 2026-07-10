import { describe, expect, it } from "vitest";
import { computeQualityScore, type QualityScoreInput } from "./quality-score";

const empty: QualityScoreInput = {
  isLand: false,
  hasCoverPhoto: false,
  photoCount: 0,
  titleEn: null,
  publicDescriptionEn: null,
  hasPrice: false,
  hasArea: false,
  hasBedroomsAndBathrooms: false,
  hasPlanningZoneAndDensity: false,
  hasCoords: false,
  titleDeedSet: false,
  permitSet: false,
  mandateActive: false,
};

const full: QualityScoreInput = {
  isLand: false,
  hasCoverPhoto: true,
  photoCount: 6,
  titleEn: "Seafront villa",
  publicDescriptionEn: "x".repeat(300),
  hasPrice: true,
  hasArea: true,
  hasBedroomsAndBathrooms: true,
  hasPlanningZoneAndDensity: false,
  hasCoords: true,
  titleDeedSet: true,
  permitSet: true,
  mandateActive: true,
};

describe("computeQualityScore — weight table (doc 02 §C1)", () => {
  it("empty property scores 0; complete property scores 100", () => {
    expect(computeQualityScore(empty).score).toBe(0);
    expect(computeQualityScore(full).score).toBe(100);
  });

  it.each([
    ["hasCoverPhoto", { hasCoverPhoto: true }, 10],
    ["photoCount ≥ 6", { photoCount: 6 }, 15],
    ["titleEn", { titleEn: "Villa" }, 5],
    ["description ≥ 300", { publicDescriptionEn: "x".repeat(300) }, 10],
    ["hasPrice", { hasPrice: true }, 10],
    ["hasArea", { hasArea: true }, 10],
    ["rooms", { hasBedroomsAndBathrooms: true }, 5],
    ["hasCoords", { hasCoords: true }, 10],
    ["titleDeedSet", { titleDeedSet: true }, 10],
    ["permitSet", { permitSet: true }, 5],
    ["mandateActive", { mandateActive: true }, 10],
  ] as const)("%s alone contributes exactly its weight", (_name, patch, points) => {
    expect(computeQualityScore({ ...empty, ...patch }).score).toBe(points);
  });

  it("boundaries: 5 photos ≠ 6 photos; 299 chars ≠ 300 chars", () => {
    expect(computeQualityScore({ ...empty, photoCount: 5 }).score).toBe(0);
    expect(computeQualityScore({ ...empty, photoCount: 6 }).score).toBe(15);
    expect(computeQualityScore({ ...empty, publicDescriptionEn: "x".repeat(299) }).score).toBe(0);
    expect(computeQualityScore({ ...empty, publicDescriptionEn: "x".repeat(300) }).score).toBe(10);
  });

  it("land swaps rooms weight for planning zone + density", () => {
    const land = { ...empty, isLand: true };
    // rooms no longer counts for land
    expect(computeQualityScore({ ...land, hasBedroomsAndBathrooms: true }).score).toBe(0);
    // planning fields count instead, same 5 points
    expect(computeQualityScore({ ...land, hasPlanningZoneAndDensity: true }).score).toBe(5);
    // non-land ignores planning fields
    expect(computeQualityScore({ ...empty, hasPlanningZoneAndDensity: true }).score).toBe(0);
  });

  it("whitespace-only title does not count", () => {
    expect(computeQualityScore({ ...empty, titleEn: "   " }).score).toBe(0);
  });

  it("missing list names exactly the unearned items", () => {
    const result = computeQualityScore({ ...full, hasCoverPhoto: false, mandateActive: false });
    expect(result.score).toBe(80);
    expect(result.missing.map((m) => m.key).sort()).toEqual(["cover", "mandate"]);
  });
});
