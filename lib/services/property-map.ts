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

export type LatLng = { lat: number; lng: number };

export type MappableProperty = {
  id: string;
  reference: string;
  location: LatLng | null;
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
  if (p.location) return { ...p.location, precision: "exact" };
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
