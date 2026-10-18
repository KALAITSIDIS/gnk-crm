/**
 * Turning properties into map pins (IMPROVEMENTS B5).
 *
 * Pure and dependency-free so it can be unit tested without a database or a
 * browser: the page fetches, this decides, the client draws.
 *
 * WHY CENTROIDS EXIST AT ALL: properties.location is populated by hand and, as
 * of 2026-08-11, no production row had it set. Keying the map on exact
 * coordinates alone would have shipped a permanently empty screen.
 */

import { formatMoney } from "@/lib/utils/format";

export type LatLng = { lat: number; lng: number };

export type MappableProperty = {
  id: string;
  reference: string;
  location: LatLng | null;
  /** 0054: `location` holds a centroid, not a surveyed point. */
  locationApprox?: boolean;
  areaCentroid: LatLng | null;
  districtCentroid: LatLng | null;
  /** Display fields for the popup. The popup is the only way to reach a
   *  property whose pin is buried under others, so these travel with the pin. */
  title: string | null;
  /** Asking price, or the monthly rent when there is no asking price. */
  price: number | null;
  isRent: boolean;
  /** Storage PATH inside the public `media` bucket — not a URL. This module
   *  stays free of env and storage config so it can be tested without either. */
  thumbPath: string | null;
};

export type Precision = "exact" | "approximate";

export type Position = LatLng & { precision: Precision };

export type PropertyFeature = {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    id: string;
    reference: string;
    precision: Precision;
    title: string | null;
    price: number | null;
    /** Whether `price` holds a number. MapLibre style expressions cannot test
     *  for null safely — `["to-number", x, fallback]` converts null to 0 rather
     *  than falling back — so the branch has to exist in the data. */
    hasPrice: boolean;
    isRent: boolean;
    thumb: string | null;
  };
};

export type PropertyFeatureCollection = {
  type: "FeatureCollection";
  features: PropertyFeature[];
};

/**
 * Exact location wins, then the area centroid, then the district centroid.
 * Returns null when the property cannot be placed at all — the caller omits it
 * rather than inventing a position.
 */
export function resolvePosition(p: MappableProperty): Position | null {
  // 0054: a stored centroid is still a centroid. Before that column existed,
  // "has a location" and "is exact" were the same statement; they are not now,
  // and inferring precision from the SOURCE alone would draw an approximate
  // point as a surveyed one.
  if (p.location) {
    return { ...p.location, precision: p.locationApprox ? "approximate" : "exact" };
  }
  if (p.areaCentroid) return { ...p.areaCentroid, precision: "approximate" };
  if (p.districtCentroid) return { ...p.districtCentroid, precision: "approximate" };
  return null;
}

export function toGeoJson(properties: MappableProperty[]): PropertyFeatureCollection {
  const features: PropertyFeature[] = [];

  for (const p of properties) {
    const pos = resolvePosition(p);
    if (!pos) continue;
    features.push({
      type: "Feature",
      // GeoJSON is [lng, lat]. Opposite to how humans say it; getting it
      // backwards is the single most common way to lose a map.
      geometry: { type: "Point", coordinates: [pos.lng, pos.lat] },
      properties: {
        id: p.id,
        reference: p.reference,
        precision: pos.precision,
        title: p.title,
        price: p.price,
        hasPrice: p.price !== null,
        isRent: p.isRent,
        thumb: p.thumbPath,
      },
    });
  }

  return { type: "FeatureCollection", features };
}

/** Bounding box of every placed property as `[[west, south], [east, north]]`,
 *  or null when there is nothing to fit.
 *
 *  WHY: the map used to open hardcoded at Cyprus-wide zoom 8, so a single pin in
 *  Paphos left the user panning around an empty island looking for it. A single
 *  property yields a DEGENERATE box (both corners identical) — `fitBounds` copes,
 *  but only if the caller passes a maxZoom, otherwise it zooms to the tightest
 *  zoom the projection allows and you land in somebody's garden. */
export function boundsOf(
  fc: PropertyFeatureCollection,
): [[number, number], [number, number]] | null {
  if (fc.features.length === 0) return null;

  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;

  for (const f of fc.features) {
    const [lng, lat] = f.geometry.coordinates;
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }

  return [
    [west, south],
    [east, north],
  ];
}

/**
 * Sentinel for "this property has no price", used when MapLibre aggregates a
 * minimum price across a cluster.
 *
 * WHY A SENTINEL: cluster aggregation runs in the worker over an expression, and
 * `["min", …]` has no notion of "skip this one". Mapping an absent price to 0
 * would make every cluster containing one read "from €0"; mapping it to this
 * value keeps it out of the minimum, and the label layer hides itself when the
 * aggregate still equals it — i.e. when nothing in the cluster is priced.
 *
 * Comfortably above any Cyprus property price, and deliberately not
 * Number.MAX_SAFE_INTEGER: it has to survive a round trip through the worker's
 * JSON, and a plainly absurd round number is easier to recognise in a debugger.
 */
export const PRICE_ABSENT = 1_000_000_000_000;

/** A pin's price in words — the popup's and the map page's list's one wording.
 *  No price is a dash, never €0 (a 0 a human typed IS a price, and shows). */
export function featurePriceText(price: number | null, isRent: boolean): string {
  if (price === null) return "—";
  return isRent ? `${formatMoney(price)} / month` : formatMoney(price);
}

/**
 * The map page's line about what it could place (F08): "12 on the map · 3
 * without a location". The rows without a location used to vanish from the map
 * with nothing anywhere saying so; they are still in the list.
 */
export function placementSummary(placed: number, unplaced: number): string {
  return `${placed} on the map · ${unplaced} without a location`;
}

// ---------------------------------------------------------------------------
// When the map cannot draw (F08)
// ---------------------------------------------------------------------------

/**
 * `loading` until the style is in and the pins are added; `ready` after.
 * `unsupported`: this browser cannot give MapLibre a WebGL2 context — a remote
 * desktop, a virtual machine, a GPU-blocklisted browser, hardware acceleration
 * off. `failed`: anything else that stops the map (the map library's code did
 * not arrive, the style did not load).
 */
export type MapStatus = "loading" | "ready" | "unsupported" | "failed";
export type MapFailure = Extract<MapStatus, "unsupported" | "failed">;

/**
 * What a thrown error means for the map. MapLibre 6 throws
 * `GPUInitializationError` from the `Map` constructor when it cannot create a
 * WebGL2 context. Matched by NAME (the class sets it explicitly, so it survives
 * minification) rather than `instanceof`, so this stays free of the library.
 */
export function mapFailureReason(err: unknown): MapFailure {
  const name = typeof err === "object" && err !== null ? (err as { name?: unknown }).name : undefined;
  return name === "GPUInitializationError" ? "unsupported" : "failed";
}

/**
 * What one MapLibre `error` event means for the map as a whole — null when it
 * does not stop the map.
 *
 * - A lost WebGL context MapLibre could not get back (`GPUInitializationError`
 *   through the event, any time): the map is gone — `unsupported`.
 * - Before the style has loaded, an error naming no source is the STYLE itself
 *   (unreachable, refused by the CSP, invalid): nothing will ever draw — `failed`.
 * - After it, errors are tiles, sprites and glyphs: transient, and the pins
 *   are already up. Not a failure — one bad tile must not take the map away.
 */
export function mapErrorOutcome(
  event: { error?: unknown; sourceId?: unknown; tile?: unknown },
  styleLoaded: boolean,
): MapFailure | null {
  if (mapFailureReason(event.error) === "unsupported") return "unsupported";
  if (styleLoaded) return null;
  if (event.sourceId || event.tile) return null;
  return "failed";
}

/** How much VISIBLE time a map may take to draw its pins before the page says
 *  so and offers the list. */
export const MAP_SLOW_AFTER_MS = 15_000;

/**
 * Calls `onElapsed` once `after` ms of VISIBLE time have passed; returns a stop
 * function. Time while the tab is hidden never counts.
 *
 * WHY VISIBLE TIME: a hidden tab never runs requestAnimationFrame, so MapLibre
 * neither renders nor requests a tile there. A wall-clock timer would call a
 * perfectly working map "slow" in every background tab — the exact instrument
 * trap that once had a working map reported as broken (BACKLOG "THE PROPERTY
 * MAP (B5) RENDERS BLANK", withdrawn 2026-08-20; ENGINEERING_NOTES §7.1). A tick
 * counts only when the tab is visible at that tick, so hidden time is never
 * counted by more than one step.
 */
export function startVisibleTimer(
  after: number,
  isVisible: () => boolean,
  onElapsed: () => void,
  step = 1_000,
): () => void {
  let visibleMs = 0;
  const id = setInterval(() => {
    if (!isVisible()) return;
    visibleMs += step;
    if (visibleMs >= after) {
      clearInterval(id);
      onElapsed();
    }
  }, step);
  return () => clearInterval(id);
}
