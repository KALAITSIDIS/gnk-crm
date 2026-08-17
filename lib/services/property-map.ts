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
};

export type Precision = "exact" | "approximate";

export type Position = LatLng & { precision: Precision };

export type PropertyFeature = {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: { id: string; reference: string; precision: Precision };
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
      properties: { id: p.id, reference: p.reference, precision: pos.precision },
    });
  }

  return { type: "FeatureCollection", features };
}
