/**
 * WGS84 point helpers for the `properties.location` geography(point, 4326)
 * column. Isomorphic (no server-only imports) so the details form can decode
 * a stored point for prefill on the client.
 *
 * PostGIS axis order is (longitude, latitude). PostgREST accepts an EWKT string
 * on write and returns an EWKB hex string on read — both handled here.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

/** EWKT accepted by PostgREST for a geography column. lng before lat. */
export function toLocationEWKT(lat: number, lng: number): string {
  return `SRID=4326;POINT(${lng} ${lat})`;
}

/**
 * Decode the EWKB hex a geography(point,4326) column serialises to, e.g.
 * "0101000020E6100000AC8BDB6800374040894160E5D0624140".
 * Layout: 1 byte order · 4 type · 4 SRID (= 18 hex chars) · X double · Y double.
 * Returns null for null/empty/unparseable input.
 */
export function parseLocationPoint(value: unknown): LatLng | null {
  if (typeof value !== "string") return null;
  const hex = value.trim();
  // header (18) + X (16) + Y (16) = 50 hex chars minimum
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length < 50) return null;

  const little = hex.slice(0, 2).toLowerCase() === "01";
  const readDouble = (startHex: number): number => {
    const view = new DataView(new ArrayBuffer(8));
    for (let i = 0; i < 8; i++) {
      view.setUint8(i, parseInt(hex.slice(startHex + i * 2, startHex + i * 2 + 2), 16));
    }
    return view.getFloat64(0, little);
  };

  const lng = readDouble(18);
  const lat = readDouble(18 + 16);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

const inRange = (lat: number, lng: number): boolean =>
  Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

/**
 * Best-effort extraction of coordinates from what an agent might paste: a Google
 * Maps URL (`@lat,lng`, `!3d…!4d…`, or `q=lat,lng`) or a bare "lat, lng" string.
 * Returns null when nothing in range is found.
 */
export function parseMapsCoords(input: string): LatLng | null {
  const text = (input ?? "").trim();
  if (!text) return null;

  // !3d<lat>!4d<lng> — the place-pin segment, most precise when present
  const pin = text.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (pin) {
    const lat = Number(pin[1]);
    const lng = Number(pin[2]);
    if (inRange(lat, lng)) return { lat, lng };
  }

  // @<lat>,<lng> — the viewport centre
  const at = text.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (at) {
    const lat = Number(at[1]);
    const lng = Number(at[2]);
    if (inRange(lat, lng)) return { lat, lng };
  }

  // q=<lat>,<lng> or query/ll params
  const q = text.match(/[?&](?:q|query|ll)=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (q) {
    const lat = Number(q[1]);
    const lng = Number(q[2]);
    if (inRange(lat, lng)) return { lat, lng };
  }

  // bare "lat, lng"
  const bare = text.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (bare) {
    const lat = Number(bare[1]);
    const lng = Number(bare[2]);
    if (inRange(lat, lng)) return { lat, lng };
  }

  return null;
}
