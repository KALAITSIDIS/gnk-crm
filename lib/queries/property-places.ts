import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { unwrapRows } from "@/lib/supabase/unwrap";
import type { PlaceName } from "@/lib/queries/properties-list";

/** An area, with the district it belongs to (the Area select lists a district's own). */
export interface AreaPlace extends PlaceName {
  districtId: string;
}
export interface PropertyPlaces {
  districts: PlaceName[];
  areas: AreaPlace[];
}

/**
 * The districts and areas the properties list and map name (A03): the filter
 * bar's options, and the words of a view's description in its heading and its
 * document title.
 *
 * ONE READ PER REQUEST. `generateMetadata` and the page are rendered for the
 * same request, and both need these names; React's `cache` shares this read
 * between them (it holds for one server request only — a district renamed in
 * settings shows on the next load). No arguments, on purpose: `cache` keys on
 * argument identity, and every `createClient()` is a new object, so a client
 * passed in would miss every time. The session client is made inside, the
 * same one the page would make, so RLS reads exactly what the session may see.
 *
 * A failed read throws to the error boundary (`unwrapRows`): a filter bar with
 * no districts, or a title naming "Unknown district" for a district that
 * exists, would be a wrong page, not an empty one.
 */
export const readPropertyPlaces = cache(async (): Promise<PropertyPlaces> => {
  const supabase = await createClient();
  const [districtsRes, areasRes] = await Promise.all([
    supabase.from("districts").select("id, name, sort_order").order("sort_order").order("id"),
    supabase.from("areas").select("id, district_id, name"),
  ]);
  return {
    districts: unwrapRows(districtsRes, "districts").map((d) => ({
      id: d.id,
      name: (d.name as { en?: string } | null)?.en ?? "—",
    })),
    areas: unwrapRows(areasRes, "areas").map((a) => ({
      id: a.id,
      districtId: a.district_id,
      name: (a.name as { en?: string } | null)?.en ?? "—",
    })),
  };
});
