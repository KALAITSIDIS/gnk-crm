import { describe, expect, it } from "vitest";
import { resolvePosition, toGeoJson, type MappableProperty } from "./property-map";

const base: MappableProperty = {
  id: "p1",
  reference: "PAF-0001",
  location: null,
  areaCentroid: null,
  districtCentroid: null,
};

describe("resolvePosition", () => {
  it("prefers the exact location over both centroids", () => {
    expect(
      resolvePosition({
        ...base,
        location: { lat: 34.75, lng: 32.41 },
        areaCentroid: { lat: 34.9, lng: 32.3 },
        districtCentroid: { lat: 34.7, lng: 32.4 },
      }),
    ).toEqual({ lat: 34.75, lng: 32.41, precision: "exact" });
  });

  it("falls back to the area centroid before the district", () => {
    expect(
      resolvePosition({
        ...base,
        areaCentroid: { lat: 34.9, lng: 32.3 },
        districtCentroid: { lat: 34.7, lng: 32.4 },
      }),
    ).toEqual({ lat: 34.9, lng: 32.3, precision: "approximate" });
  });

  it("falls back to the district centroid last", () => {
    expect(
      resolvePosition({ ...base, districtCentroid: { lat: 34.7, lng: 32.4 } }),
    ).toEqual({ lat: 34.7, lng: 32.4, precision: "approximate" });
  });

  // Not a bug to paper over: a property with no location, no area and no
  // district genuinely cannot be placed, and inventing a position would be worse
  // than omitting it.
  it("returns null when there is nothing to place it by", () => {
    expect(resolvePosition(base)).toBeNull();
  });
});

describe("toGeoJson", () => {
  it("emits one feature per placeable property and omits the rest", () => {
    const fc = toGeoJson([
      { ...base, id: "a", location: { lat: 34.75, lng: 32.41 } },
      { ...base, id: "b", districtCentroid: { lat: 34.7, lng: 32.4 } },
      { ...base, id: "c" },
    ]);

    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features).toHaveLength(2);
    expect(fc.features.map((f) => f.properties.id)).toEqual(["a", "b"]);
  });

  // GeoJSON is [lng, lat] — the opposite order to how humans say it, and the
  // single easiest way to put Cyprus in the Indian Ocean.
  it("writes coordinates as [lng, lat]", () => {
    const fc = toGeoJson([{ ...base, id: "a", location: { lat: 34.75, lng: 32.41 } }]);
    expect(fc.features[0].geometry.coordinates).toEqual([32.41, 34.75]);
  });

  it("carries precision through so the pin can render differently", () => {
    const fc = toGeoJson([
      { ...base, id: "a", location: { lat: 1, lng: 2 } },
      { ...base, id: "b", areaCentroid: { lat: 3, lng: 4 } },
    ]);
    expect(fc.features.map((f) => f.properties.precision)).toEqual([
      "exact",
      "approximate",
    ]);
  });
});
