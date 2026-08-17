import Link from "next/link";
import { List } from "lucide-react";
import { PropertyMap } from "@/components/features/properties/map-view";
import { Button } from "@/components/ui/button";
import {
  applyPropertyListFilters,
  fetchMandateExcludeIds,
  parsePropertyFilters,
} from "@/lib/queries/properties-list";
import { toGeoJson, type MappableProperty } from "@/lib/services/property-map";
import { createClient } from "@/lib/supabase/server";
import { unwrapRows } from "@/lib/supabase/unwrap";

type SearchParams = { [key: string]: string | string[] | undefined };

/**
 * Map view of the properties list (IMPROVEMENTS B5).
 *
 * Deliberately a SECOND VIEW of the list rather than a new module: it reuses
 * parsePropertyFilters and applyPropertyListFilters so the two views cannot
 * disagree about what a filter set means.
 */
export default async function PropertiesMapPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const filters = parsePropertyFilters(sp);
  const supabase = await createClient();

  // Same exclusion set the list page computes for the "no mandate" / "expired"
  // filters — omitting this would let the map disagree with the list.
  const excludeIds = await fetchMandateExcludeIds(supabase, filters);

  const query = applyPropertyListFilters(
    supabase
      .from("properties")
      .select("id, reference, location, areas(centroid), districts(centroid)"),
    filters,
    excludeIds,
  );

  const rows = unwrapRows(await query, "properties");

  const mappable: MappableProperty[] = rows.map((r) => ({
    id: r.id,
    reference: r.reference,
    location: parsePoint(r.location),
    areaCentroid: parsePoint(r.areas?.centroid),
    districtCentroid: parsePoint(r.districts?.centroid),
  }));

  const search = new URLSearchParams(
    Object.entries(sp).flatMap(([k, v]) =>
      typeof v === "string" ? [[k, v] as [string, string]] : [],
    ),
  ).toString();

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Properties — map</h1>
        <Button asChild variant="outline">
          <Link href={`/properties${search ? `?${search}` : ""}`}>
            <List className="mr-2 size-4" />
            List
          </Link>
        </Button>
      </div>
      <PropertyMap data={toGeoJson(mappable)} />
    </div>
  );
}

/** PostGIS points arrive from PostgREST as GeoJSON-shaped objects. Anything of
 *  another shape is treated as absent rather than guessed at. */
function parsePoint(value: unknown): { lat: number; lng: number } | null {
  if (!value || typeof value !== "object") return null;
  const coords = (value as { coordinates?: unknown }).coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const [lng, lat] = coords;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  return { lat, lng };
}
