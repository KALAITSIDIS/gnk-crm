import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  boundsOf,
  featurePriceText,
  MAP_SLOW_AFTER_MS,
  mapErrorOutcome,
  mapFailureReason,
  placementSummary,
  resolvePosition,
  startVisibleTimer,
  toGeoJson,
  type MappableProperty,
} from "./property-map";

const base: MappableProperty = {
  id: "p1",
  reference: "PAF-0001",
  location: null,
  areaCentroid: null,
  districtCentroid: null,
  title: null,
  price: null,
  isRent: false,
  thumbPath: null,
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

describe("toGeoJson popup payload", () => {
  // The popup is the ONLY way to reach a property whose pin sits underneath
  // other pins, so the identifying fields have to survive the trip.
  it("carries the display fields onto the feature", () => {
    const fc = toGeoJson([
      {
        ...base,
        id: "a",
        reference: "PAF-0007",
        title: "Sea view villa",
        price: 450000,
        isRent: false,
        thumbPath: "org/prop/a-thumb.webp",
        location: { lat: 34.75, lng: 32.41 },
      },
    ]);
    expect(fc.features[0].properties).toEqual({
      id: "a",
      reference: "PAF-0007",
      precision: "exact",
      title: "Sea view villa",
      price: 450000,
      isRent: false,
      // The PATH, not a URL: this module stays free of env and storage config.
      thumb: "org/prop/a-thumb.webp",
      hasPrice: true,
    });
  });

  it("keeps missing display fields as null rather than inventing them", () => {
    const fc = toGeoJson([{ ...base, id: "a", location: { lat: 1, lng: 2 } }]);
    expect(fc.features[0].properties.title).toBeNull();
    expect(fc.features[0].properties.price).toBeNull();
    expect(fc.features[0].properties.thumb).toBeNull();
  });
});

describe("boundsOf", () => {
  // Without this the map opens at Cyprus-wide zoom 8 and the user hunts for a
  // single pin, which is exactly how the first version behaved.
  it("returns null when there is nothing to fit", () => {
    expect(boundsOf(toGeoJson([]))).toBeNull();
  });

  it("returns a degenerate box for a single property", () => {
    const fc = toGeoJson([{ ...base, id: "a", location: { lat: 34.75, lng: 32.41 } }]);
    // Same point twice — fitBounds handles this, but only with a maxZoom, or it
    // zooms to the tightest zoom the projection allows.
    expect(boundsOf(fc)).toEqual([
      [32.41, 34.75],
      [32.41, 34.75],
    ]);
  });

  it("spans every property, as [[west, south], [east, north]]", () => {
    const fc = toGeoJson([
      { ...base, id: "a", location: { lat: 34.7, lng: 32.4 } },
      { ...base, id: "b", location: { lat: 35.1, lng: 33.9 } },
      { ...base, id: "c", location: { lat: 34.9, lng: 32.9 } },
    ]);
    expect(boundsOf(fc)).toEqual([
      [32.4, 34.7],
      [33.9, 35.1],
    ]);
  });
});

describe("hasPrice", () => {
  /**
   * WHY THIS EXISTS AS A SEPARATE FLAG rather than a null check in the map style.
   *
   * MapLibre's `["to-number", x, fallback]` does NOT fall back for null — the
   * spec converts null to 0 successfully, so the fallback never fires. Relying on
   * it made every cluster containing one unpriced property read "from €0", and
   * fed a raw null to `number-format`, which warned. An explicit boolean is the
   * only thing a style expression can branch on safely.
   */
  it("is false when there is no price, so the style can branch on it", () => {
    const fc = toGeoJson([{ ...base, id: "a", location: { lat: 1, lng: 2 } }]);
    expect(fc.features[0].properties.hasPrice).toBe(false);
    expect(fc.features[0].properties.price).toBeNull();
  });

  it("is true for a priced property, including a rental", () => {
    const fc = toGeoJson([
      { ...base, id: "a", price: 450000, location: { lat: 1, lng: 2 } },
      { ...base, id: "b", price: 1500, isRent: true, location: { lat: 3, lng: 4 } },
    ]);
    expect(fc.features.map((f) => f.properties.hasPrice)).toEqual([true, true]);
  });

  // Zero is a price a human typed. It must not be mistaken for "unknown".
  it("treats a price of 0 as priced, not as missing", () => {
    const fc = toGeoJson([{ ...base, id: "a", price: 0, location: { lat: 1, lng: 2 } }]);
    expect(fc.features[0].properties.hasPrice).toBe(true);
  });
});

describe("a STORED centroid is still approximate (0054)", () => {
  // Before location_approx existed, "has a location" and "is exact" were the
  // same statement. Taking the area centre on save makes them different, and a
  // reader that still infers precision from the SOURCE alone draws a centroid
  // as a surveyed point — which is exactly what 0031 set out to prevent.
  it("marks a stored point approximate when the flag is set", () => {
    expect(
      resolvePosition({
        ...base,
        location: { lat: 34.9, lng: 32.3 },
        locationApprox: true,
      }),
    ).toEqual({ lat: 34.9, lng: 32.3, precision: "approximate" });
  });

  it("still calls an unflagged stored point exact", () => {
    expect(
      resolvePosition({ ...base, location: { lat: 34.75, lng: 32.41 }, locationApprox: false }),
    ).toEqual({ lat: 34.75, lng: 32.41, precision: "exact" });
  });

  it("treats an absent flag as exact, so pre-0054 rows are unchanged", () => {
    // every existing row has location_approx = false; a row read without the
    // column must not silently become approximate
    expect(resolvePosition({ ...base, location: { lat: 34.75, lng: 32.41 } })).toEqual({
      lat: 34.75, lng: 32.41, precision: "exact",
    });
  });

  it("still uses the stored point, not a centroid, when both exist", () => {
    // the flag changes how the point is LABELLED, never which point is used
    expect(
      resolvePosition({
        ...base,
        location: { lat: 34.9, lng: 32.3 },
        locationApprox: true,
        areaCentroid: { lat: 11.1, lng: 22.2 },
        districtCentroid: { lat: 33.3, lng: 44.4 },
      }),
    ).toEqual({ lat: 34.9, lng: 32.3, precision: "approximate" });
  });

  it("carries the precision into the GeoJSON the map actually draws", () => {
    const fc = toGeoJson([
      { ...base, id: "a", location: { lat: 34.9, lng: 32.3 }, locationApprox: true },
      { ...base, id: "b", location: { lat: 34.75, lng: 32.41 } },
    ]);
    expect(fc.features.map((f) => [f.properties.id, f.properties.precision])).toEqual([
      ["a", "approximate"],
      ["b", "exact"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// F08 — when the map cannot draw
// ---------------------------------------------------------------------------

/** What MapLibre 6.9 throws from the Map constructor when there is no WebGL2
 *  context (maplibre-gl-dev.mjs: `this.name = "GPUInitializationError"`). */
class GPUInitializationError extends Error {
  constructor() {
    super("WebGL2 is required to display this map.");
    this.name = "GPUInitializationError";
  }
}

describe("mapFailureReason", () => {
  it("calls a missing WebGL2 context the browser's environment, not a fault", () => {
    expect(mapFailureReason(new GPUInitializationError())).toBe("unsupported");
  });

  it("matches by name, so a minified or second copy of the class still counts", () => {
    expect(mapFailureReason({ name: "GPUInitializationError", message: "x" })).toBe("unsupported");
  });

  it("calls anything else a failure", () => {
    expect(mapFailureReason(new Error("boom"))).toBe("failed");
    expect(mapFailureReason(new TypeError("Failed to fetch dynamically imported module"))).toBe("failed");
    expect(mapFailureReason("a string")).toBe("failed");
    expect(mapFailureReason(null)).toBe("failed");
    expect(mapFailureReason(undefined)).toBe("failed");
  });
});

describe("mapErrorOutcome", () => {
  const styleError = { error: new Error("AJAXError: Failed to fetch (0): https://tiles.openfreemap.org/styles/liberty") };
  const tileError = {
    error: new Error("AJAXError: Failed to fetch (0)"),
    sourceId: "openmaptiles",
    tile: { tileID: {} },
  };

  it("an error naming no source before the style loaded is the style itself: the map failed", () => {
    expect(mapErrorOutcome(styleError, false)).toBe("failed");
  });

  it("a tile or source error is never a failure — one bad tile must not take the map away", () => {
    expect(mapErrorOutcome(tileError, false)).toBeNull();
    expect(mapErrorOutcome(tileError, true)).toBeNull();
    expect(mapErrorOutcome({ error: new Error("x"), sourceId: "openmaptiles" }, false)).toBeNull();
  });

  it("after the style loaded the pins are up: sprite, glyph and tile errors do not stop the map", () => {
    expect(mapErrorOutcome(styleError, true)).toBeNull();
  });

  it("a WebGL context MapLibre could not get back stops the map at any time", () => {
    expect(mapErrorOutcome({ error: new GPUInitializationError() }, true)).toBe("unsupported");
    expect(mapErrorOutcome({ error: new GPUInitializationError() }, false)).toBe("unsupported");
  });
});

describe("featurePriceText", () => {
  it("is the popup's wording: a sale price, a rent per month, a dash for none", () => {
    expect(featurePriceText(450000, false)).toBe("€450.000");
    expect(featurePriceText(1200, true)).toBe("€1.200 / month");
    expect(featurePriceText(null, false)).toBe("—");
    expect(featurePriceText(null, true)).toBe("—");
  });

  it("shows a typed 0 as a price, never as missing", () => {
    expect(featurePriceText(0, false)).toBe("€0");
  });
});

describe("placementSummary", () => {
  it("says how many are on the map and how many have no location", () => {
    expect(placementSummary(12, 3)).toBe("12 on the map · 3 without a location");
  });

  it("states a zero rather than leaving the half out — none dropped is a fact too", () => {
    expect(placementSummary(5, 0)).toBe("5 on the map · 0 without a location");
    expect(placementSummary(0, 0)).toBe("0 on the map · 0 without a location");
  });
});

describe("startVisibleTimer — the slow-map watchdog counts VISIBLE time only", () => {
  let visible = true;
  beforeEach(() => {
    vi.useFakeTimers();
    visible = true;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires once the visible time is up, and only once", () => {
    const onElapsed = vi.fn();
    startVisibleTimer(MAP_SLOW_AFTER_MS, () => visible, onElapsed);
    vi.advanceTimersByTime(MAP_SLOW_AFTER_MS - 1_000);
    expect(onElapsed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(onElapsed).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(MAP_SLOW_AFTER_MS * 4);
    expect(onElapsed).toHaveBeenCalledTimes(1);
  });

  // The 2026-08-20 trap: a hidden tab never runs requestAnimationFrame, so a
  // working map draws nothing there. A wall-clock timer would call it slow.
  it("never fires while the tab stays hidden, however long", () => {
    const onElapsed = vi.fn();
    visible = false;
    startVisibleTimer(MAP_SLOW_AFTER_MS, () => visible, onElapsed);
    vi.advanceTimersByTime(60 * 60 * 1_000);
    expect(onElapsed).not.toHaveBeenCalled();
  });

  it("pauses while hidden and resumes counting from where it stood", () => {
    const onElapsed = vi.fn();
    startVisibleTimer(MAP_SLOW_AFTER_MS, () => visible, onElapsed);
    vi.advanceTimersByTime(10_000); // 10 s visible
    visible = false;
    vi.advanceTimersByTime(10 * 60 * 1_000); // ten minutes in the background
    expect(onElapsed).not.toHaveBeenCalled();
    visible = true;
    vi.advanceTimersByTime(4_000); // 14 s visible in all
    expect(onElapsed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000); // 15 s
    expect(onElapsed).toHaveBeenCalledTimes(1);
  });

  it("stops for good when stopped — the pins drew, or the page left", () => {
    const onElapsed = vi.fn();
    const stop = startVisibleTimer(MAP_SLOW_AFTER_MS, () => visible, onElapsed);
    vi.advanceTimersByTime(MAP_SLOW_AFTER_MS - 1_000);
    stop();
    vi.advanceTimersByTime(MAP_SLOW_AFTER_MS * 2);
    expect(onElapsed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
