"use server";

import type { LatLng } from "@/lib/utils/geo";
import { followMapsRedirects } from "@/lib/utils/maps-resolver";
import { createClient } from "@/lib/supabase/server";

/**
 * Resolve a Google Maps short link (maps.app.goo.gl, goo.gl/maps, g.co,
 * share.google) to coordinates by following its redirect server-side — the
 * browser cannot, since the short-link host sends no permissive CORS headers.
 *
 * Read-only and side-effect free (no DB write, no event), but gated on an
 * authenticated session so it isn't an open redirect-follower. Returns null for
 * anything that isn't a Google short link or doesn't resolve to a point.
 */
export async function resolveMapsShortLink(url: string): Promise<LatLng | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  return followMapsRedirects(url);
}

/**
 * The centre of a property's area, or failing that its district (0031, 0054).
 *
 * The same fallback the MAP already applies at read time, offered at save time
 * so a listing can carry a coordinate of its own — flagged approximate — rather
 * than depending on every reader to re-derive one.
 *
 * Read through the USER's client, so RLS decides whether they may see the
 * property at all; a property they cannot read yields null and the button
 * simply does nothing. No write and no event: the coordinate is not stored
 * until the form is saved, which is where its event belongs.
 */
export async function fetchLocationFallback(
  propertyId: string,
): Promise<{ lat: number; lng: number; label: string; source: "area" | "district" } | null> {
  const supabase = await createClient();

  const { data: row } = await supabase
    .from("properties")
    .select("id, areas(name, centroid), districts(code, name, centroid)")
    .eq("id", propertyId)
    .maybeSingle();
  if (!row) return null;

  const { parseLocationPoint } = await import("@/lib/utils/geo");
  const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);

  const area = one(row.areas as { name: unknown; centroid: unknown } | null);
  const areaPoint = parseLocationPoint(area?.centroid);
  if (areaPoint) {
    return {
      ...areaPoint,
      label: (area?.name as { en?: string } | null)?.en ?? "this area",
      source: "area",
    };
  }

  // The district is the coarser answer and is offered only when the area has no
  // centroid — or when no area is set at all, which is common on a new listing.
  const district = one(row.districts as { code: string; name: unknown; centroid: unknown } | null);
  const districtPoint = parseLocationPoint(district?.centroid);
  if (districtPoint) {
    return {
      ...districtPoint,
      label: (district?.name as { en?: string } | null)?.en ?? district?.code ?? "this district",
      source: "district",
    };
  }

  return null;
}
