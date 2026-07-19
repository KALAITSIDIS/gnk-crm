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

// A decimal (or integer) number, optionally signed.
const NUM = "-?\\d+(?:\\.\\d+)?";
// The separator Google puts between lat and lng across its URL forms: a comma,
// tolerating the "+" or whitespace padding seen in "/search/lat,+lng" paths and
// "?q=lat, lng" queries.
const SEP = "\\s*,\\s*\\+?\\s*";
const PAIR = `(${NUM})${SEP}(${NUM})`;

// Ordered most-precise-first. Each anchors the pair to a real coordinate context
// so place names and street numbers in the URL can't be mistaken for a point.
const PIN_RE = new RegExp(`!3d(${NUM})!4d(${NUM})`); //  place pin
const AT_RE = new RegExp(`@${PAIR}`); //                 viewport centre
const QUERY_RE = new RegExp(`[?&](?:q|query|ll)=${PAIR}`); // query param
const PATH_RE = new RegExp(`/${PAIR}(?=[/?#]|$)`); //     a /search|place|dir path segment
const BARE_RE = new RegExp(`^\\s*${PAIR}\\s*$`); //       hand-typed "lat, lng"

function firstInRange(re: RegExp, s: string): LatLng | null {
  const m = s.match(re);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  return inRange(lat, lng) ? { lat, lng } : null;
}

function extractCoords(s: string): LatLng | null {
  return (
    firstInRange(PIN_RE, s) ??
    firstInRange(AT_RE, s) ??
    firstInRange(QUERY_RE, s) ??
    firstInRange(PATH_RE, s) ??
    firstInRange(BARE_RE, s)
  );
}

/**
 * Best-effort extraction of coordinates from what an agent might paste: a Google
 * Maps URL (`@lat,lng`, `!3d…!4d…`, `q=lat,lng`, or a `/maps/search/lat,+lng`
 * path — the form a short link ultimately redirects to) or a bare "lat, lng"
 * string. Decodes percent-escapes first so `%2C` commas and consent-page
 * `continue=<encoded url>` wrappers resolve too. Returns null when nothing in
 * range is found. Does NOT follow short links — see followMapsRedirects for that.
 */
export function parseMapsCoords(input: string): LatLng | null {
  const text = (input ?? "").trim();
  if (!text) return null;
  let decoded = text;
  try {
    decoded = decodeURIComponent(text);
  } catch {
    // Malformed escape — fall back to the raw string.
  }
  return extractCoords(decoded) ?? extractCoords(text);
}

// Hosts Google hands out for shortened Maps/place links. A short link has no
// coordinates in the URL, so recognising one tells the UI to resolve it server-
// side (the browser can't follow the redirect — the host sends no CORS headers).
const SHORT_LINK_HOSTS = new Set(["maps.app.goo.gl", "goo.gl", "g.co", "share.google"]);

/**
 * True when `input` is a Google Maps short link (with or without a protocol).
 * An exact hostname match, so lookalikes like `maps.app.goo.gl.evil.com` and
 * full `google.com/maps` URLs (which already carry coordinates) return false.
 */
export function isGoogleMapsShortLink(input: string): boolean {
  const raw = (input ?? "").trim();
  if (!raw) return false;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    return SHORT_LINK_HOSTS.has(new URL(withScheme).hostname.toLowerCase());
  } catch {
    return false;
  }
}
