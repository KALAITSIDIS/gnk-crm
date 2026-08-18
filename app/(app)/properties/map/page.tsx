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
import { parseLocationPoint } from "@/lib/utils/geo";

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
      .select(
        `id, reference, location, title, asking_price, rent_price_month,
         areas(centroid), districts(centroid),
         property_media(path_thumb, is_cover, sort_order)`,
      ),
    filters,
    excludeIds,
  );

  const rows = unwrapRows(await query, "properties");

  // PostgREST serialises geography(point,4326) as EWKB HEX, not GeoJSON — a
  // hand-rolled GeoJSON reader silently returns null for every row and renders a
  // permanently empty map. lib/utils/geo.ts already decodes it and is tested;
  // lib/actions/properties.ts writes through the matching toLocationEWKT().
  const mappable: MappableProperty[] = rows.map((r) => {
    // Same cover rule as the list page: the flagged cover, else the lowest
    // sort_order. The two views must not disagree about which photo is the one.
    const media = (r.property_media ?? []) as {
      path_thumb: string | null;
      is_cover: boolean;
      sort_order: number;
    }[];
    const cover =
      media.find((m) => m.is_cover) ??
      [...media].sort((a, b) => a.sort_order - b.sort_order)[0];

    // Sale price first; a rental with no asking price shows its monthly rent,
    // flagged so the popup can say so rather than quoting rent as a sale price.
    const asking = r.asking_price === null ? null : Number(r.asking_price);
    const rent = r.rent_price_month === null ? null : Number(r.rent_price_month);

    return {
      id: r.id,
      reference: r.reference,
      location: parseLocationPoint(r.location),
      areaCentroid: parseLocationPoint(r.areas?.centroid),
      districtCentroid: parseLocationPoint(r.districts?.centroid),
      title: (r.title as { en?: string } | null)?.en ?? null,
      price: asking ?? rent,
      isRent: asking === null && rent !== null,
      thumbPath: cover?.path_thumb ?? null,
    };
  });

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
