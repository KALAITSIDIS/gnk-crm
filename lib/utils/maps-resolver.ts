/**
 * Server-side resolution of a Google Maps short link to coordinates.
 *
 * A `maps.app.goo.gl` / `goo.gl/maps` link carries no coordinates in the URL —
 * they only appear after the redirect (`…/maps/search/lat,+lng?entry=tts`). The
 * browser can't follow it (the short-link host sends no permissive CORS
 * headers), so the details form calls a server action that runs this.
 *
 * SSRF-guarded: the entry point must be a known Google short-link host, and each
 * hop is only followed while it stays on a Google host. Coordinates are read
 * straight from the redirect `Location` header, so the final page is never
 * fetched. No import of this module reaches the client bundle.
 */

import { isGoogleMapsShortLink, parseMapsCoords, type LatLng } from "./geo";

/** Minimal fetch surface, injectable so the redirect chain can be unit-tested. */
export type RedirectFetch = (url: string) => Promise<{ status: number; headers: Headers }>;

const MAX_HOPS = 5;
const TIMEOUT_MS = 4000;

/** Google hosts that are safe to keep following a redirect chain through. */
function isGoogleHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === "google.com" ||
    h.endsWith(".google.com") ||
    h === "goo.gl" ||
    h.endsWith(".goo.gl") ||
    h === "g.co" ||
    h === "share.google"
  );
}

function normalizeUrl(raw: string): string | null {
  const s = raw.trim();
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
    return new URL(withScheme).toString();
  } catch {
    return null;
  }
}

const defaultFetch: RedirectFetch = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      // A desktop UA — Google returns a coordinate-bearing redirect for it.
      headers: { "user-agent": "Mozilla/5.0 (compatible; gnk-crm/1.0)" },
    });
    return { status: res.status, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Follow a Google Maps short link's redirects and return the coordinates they
 * land on, or null if `entry` isn't a Google short link, leaves Google hosts,
 * loops, times out, or never resolves to a point.
 */
export async function followMapsRedirects(
  entry: string,
  fetchImpl: RedirectFetch = defaultFetch,
): Promise<LatLng | null> {
  if (!isGoogleMapsShortLink(entry)) return null;
  let current = normalizeUrl(entry);
  if (!current) return null;

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    let response: { status: number; headers: Headers };
    try {
      response = await fetchImpl(current);
    } catch {
      return null; // network error, abort/timeout, etc.
    }

    if (response.status < 300 || response.status >= 400) return null;
    const location = response.headers.get("location");
    if (!location) return null;

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return null;
    }
    if (next.protocol !== "http:" && next.protocol !== "https:") return null;

    // Coordinates in this hop's URL end the chase — this also unwraps a
    // consent-page `continue=<encoded maps url>` without fetching it.
    const coords = parseMapsCoords(next.toString());
    if (coords) return coords;

    // Otherwise keep following, but only while we stay on a Google host.
    if (!isGoogleHost(next.hostname)) return null;
    current = next.toString();
  }

  return null;
}
