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
