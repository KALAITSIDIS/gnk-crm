import type { Metadata } from "next";
import Link from "next/link";
import { Building2, ListChecks, Map, Plus } from "lucide-react";
import { PropertiesFilters } from "@/components/features/properties/filters";
import {
  PropertiesCards,
  PropertiesTable,
  type PropertyRow,
} from "@/components/features/properties/list";
import type { MandateBadgeState } from "@/components/features/shared/mandate-badge";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";
import { unwrapCount, unwrapRows } from "@/lib/supabase/unwrap";
import { PROPERTIES_PAGE_SIZE } from "@/lib/validators/properties";
import {
  applyPropertyListFilters,
  applyPropertyListOrder,
  columnSort,
  countPropertyList,
  describePropertyFilters,
  hiddenUnitFilters,
  hiddenUnitsText,
  mandateEmbed,
  parsePropertyFilters,
  propertiesViewTitle,
  propertyCountNoun,
  type ColumnSort,
  type SortableColumn,
} from "@/lib/queries/properties-list";
import { readPropertyPlaces } from "@/lib/queries/property-places";
import { ExportCsvButton } from "@/components/features/shared/export-csv-button";

type SearchParams = { [key: string]: string | string[] | undefined };

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

interface MandateEmbed {
  type: "exclusive" | "open" | "verbal";
  status: "draft" | "active" | "expired" | "terminated";
}

function deriveMandateState(mandates: MandateEmbed[]): MandateBadgeState {
  const active = mandates.find((m) => m.status === "active");
  if (active) return active.type;
  if (mandates.some((m) => m.status === "expired")) return "expired";
  return "none";
}

/**
 * The tab, the history entry and the bookmark name the view (A03): "Properties
 * · Paphos · Land · plot 1.500–6.000 m² · density ≥ 90% · sorted by plot ↓".
 * The URL is the saved view; this is its name. The district and area names
 * come from the same per-request read the page makes (`readPropertyPlaces`).
 */
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<Metadata> {
  const filters = parsePropertyFilters(await searchParams);
  return { title: propertiesViewTitle("Properties", filters, await readPropertyPlaces()) };
}

export default async function PropertiesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const filters = parsePropertyFilters(sp);

  const supabase = await createClient();

  // Shared with the export route and the map so they select exactly the same
  // rows; the mandate filters ride in this one request (T-mandate-filter-anti-join).
  const base = supabase
    .from("properties")
    .select(
      `id, reference, kind, property_type, transaction_type, status, visibility,
       title, bedrooms, covered_area_sqm, plot_area_sqm, building_density_pct,
       asking_price, rent_price_month, quality_score,
       districts(name), areas(name),
       property_media(path_thumb, is_cover, sort_order, kind),
       ${mandateEmbed(filters)}`,
      { count: "exact" },
    );

  const query = applyPropertyListFilters(base, filters);

  // F04: the default list leaves units out, so it SAYS how many — one exact
  // HEAD count of the same filters with kind=unit, beside the page read. The
  // default total plus this count is exactly what "Show all kinds" lists.
  const unitFilters = hiddenUnitFilters(filters);

  const from = (filters.page - 1) * PROPERTIES_PAGE_SIZE;
  // The list's sort (A03), then `id`: without a unique last key each offset
  // page may order tied rows differently, repeating some and skipping others.
  // The default is exactly the order this page always sent (created_at desc,
  // id). Same order as the CSV export; the table and the cards render these
  // same rows. (A listing added between two page loads still shifts the
  // pages — each is its own request.) T-list-page-order
  const [places, result, hiddenRes] = await Promise.all([
    readPropertyPlaces(),
    applyPropertyListOrder(query, filters).range(from, from + PROPERTIES_PAGE_SIZE - 1),
    unitFilters ? countPropertyList(supabase, unitFilters) : null,
  ]);

  // PGRST103 = page beyond the result set → render the empty-page state. That
  // answer carries no count, so the total is asked for rather than shown as 0;
  // every other answer must carry its rows and its count (a missing one is a
  // failure, never an empty list).
  const beyondEnd = result.error?.code === "PGRST103";
  const data = beyondEnd ? [] : unwrapRows(result, "properties");
  const total = beyondEnd
    ? unwrapCount(await countPropertyList(supabase, filters), "properties (count)")
    : unwrapCount(result, "properties");
  const hiddenUnits = hiddenRes ? unwrapCount(hiddenRes, "properties (units not shown)") : 0;

  const rows: PropertyRow[] = data.map((p) => {
    const media = (p.property_media ?? []) as {
      path_thumb: string | null;
      is_cover: boolean;
      sort_order: number;
      kind: string;
    }[];
    // fallback prefers PHOTOS (MEDIA-K): a coverless gallery must not put a
    // floor plan on the card
    const photos = media.filter((m) => m.kind === "photo");
    const cover =
      media.find((m) => m.is_cover) ??
      [...photos].sort((a, b) => a.sort_order - b.sort_order)[0];
    return {
      id: p.id,
      reference: p.reference,
      kind: p.kind,
      property_type: p.property_type,
      transaction_type: p.transaction_type,
      status: p.status,
      visibility: p.visibility,
      title: (p.title as { en?: string })?.en ?? null,
      district: ((p.districts as { name?: { en?: string } } | null)?.name?.en ?? null),
      area: ((p.areas as { name?: { en?: string } } | null)?.name?.en ?? null),
      bedrooms: p.bedrooms,
      covered_area_sqm: p.covered_area_sqm === null ? null : Number(p.covered_area_sqm),
      plot_area_sqm: p.plot_area_sqm === null ? null : Number(p.plot_area_sqm),
      building_density_pct: p.building_density_pct === null ? null : Number(p.building_density_pct),
      asking_price: p.asking_price === null ? null : Number(p.asking_price),
      rent_price_month: p.rent_price_month === null ? null : Number(p.rent_price_month),
      quality_score: p.quality_score,
      mandate: deriveMandateState((p.mandates_safe ?? []) as MandateEmbed[]),
      thumb: cover?.path_thumb ?? null,
    };
  });

  const totalPages = Math.max(1, Math.ceil(total / PROPERTIES_PAGE_SIZE));
  const pageParams = (page: number) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) {
      const val = first(v);
      if (val) params.set(k, val);
    }
    params.set("page", String(page));
    return `?${params.toString()}`;
  };

  // Both Export and Map carry the active filters but not pagination — the whole
  // filtered set, RLS-scoped to what this user can see. ONE source of truth for
  // which params travel: a second copy would drift from this one.
  const filterParams = (() => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) {
      if (k === "page") continue;
      const val = first(v);
      if (val) params.set(k, val);
    }
    return params;
  })();
  const filterQuery = filterParams.toString() ? `?${filterParams.toString()}` : "";

  const exportHref = `/properties/export${filterQuery}`;
  const mapHref = `/properties/map${filterQuery}`;
  // the same filters with every kind — the default's rows plus the units it hides
  const allKindsHref = (() => {
    const params = new URLSearchParams(filterParams);
    params.set("kind", "all");
    return `/properties?${params.toString()}`;
  })();

  // A03: the sortable headers — plain links to this list with the column's
  // next sort, every filter kept, page 1
  const land = filters.type === "land";
  const sortable: SortableColumn[] = land ? ["reference", "plot", "price", "score"] : ["reference", "price", "score"];
  const sorts: Partial<Record<SortableColumn, ColumnSort>> = {};
  for (const column of sortable) sorts[column] = columnSort(column, filterParams.toString(), filters.sort);
  // under "Rent" the price shown is the price the bracket and the sort read:
  // the monthly rent, a sale_or_rent row's too (A03 review)
  const rent = filters.transaction === "rent";

  // what this view holds, in words — the same words as the document title
  const description = describePropertyFilters(filters, places);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-text-1">Properties</h1>
          <p className="text-sm text-text-2">
            {total} {filters.scope === "archived" ? "archived " : ""}
            {propertyCountNoun(filters.kind, total)}
            {hiddenUnits > 0 ? (
              <>
                {" · "}
                {hiddenUnitsText(hiddenUnits)}
                {" — "}
                <Link
                  href={allKindsHref}
                  className="font-medium text-brand-700 underline-offset-2 hover:underline"
                >
                  Show all kinds
                </Link>
              </>
            ) : null}
          </p>
          {description ? (
            <p className="text-[13px] text-text-3" data-testid="properties-view-description">
              {description}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {/* Deliberately NOT filter-aware, unlike Map and Export below: the
              worklist answers "what should I go fix across everything", which a
              filtered subset cannot. */}
          <Button asChild variant="outline">
            <Link href="/properties/worklist">
              <ListChecks className="mr-2 size-4" />
              Worklist
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={mapHref}>
              <Map className="mr-2 size-4" />
              Map
            </Link>
          </Button>
          {total > 0 ? (
            <ExportCsvButton href={exportHref} />
          ) : null}
          <Button asChild>
            <Link href="/properties/new">
              <Plus className="size-4" /> Add property
            </Link>
          </Button>
        </div>
      </div>

      <PropertiesFilters districts={places.districts} areas={places.areas} />

      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-[10px] border border-border bg-surface py-16">
          <Building2 className="size-8 text-text-3" />
          <p className="text-sm text-text-2">
            {total > 0 || filters.page > 1
              ? "Nothing on this page."
              : hiddenUnits > 0
                ? `No listings or developments match — ${hiddenUnits} ${hiddenUnits === 1 ? "unit does" : "units do"}.`
                : filters.scope === "archived"
                  ? "No archived properties — withdrawn listings and archived visibility show up here."
                  : "No properties match — add the first one or clear filters."}
          </p>
          {total === 0 && filters.page === 1 && hiddenUnits > 0 ? (
            <Button asChild variant="outline" size="sm">
              <Link href={allKindsHref}>Show all kinds</Link>
            </Button>
          ) : filters.scope === "archived" ? null : (
            <Button asChild variant="outline" size="sm">
              <Link href="/properties/new">
                <Plus className="size-4" /> Add property
              </Link>
            </Button>
          )}
        </div>
      ) : filters.view === "cards" ? (
        <PropertiesCards rows={rows} rent={rent} />
      ) : filters.view === "table" ? (
        <PropertiesTable rows={rows} land={land} rent={rent} sorts={sorts} />
      ) : (
        /* auto (audit CRM-06): cards on a phone, the table from the tablet
           breakpoint up. Both are rendered and one is hidden by CSS, because
           this is a server component and the viewport is not known here; an
           explicit ?view= shows one everywhere. */
        <>
          {/* The table comes FIRST in the DOM. Both layouts are present and one
              is display:none, so a locator's first match for a title is the
              table's on a desktop — where the happy-path e2e looks (run
              34767615456 failed on the hidden card). A phone never sees the
              table, so its order costs nothing there. */}
          <div className="hidden md:block">
            <PropertiesTable rows={rows} land={land} rent={rent} sorts={sorts} />
          </div>
          <div className="md:hidden">
            <PropertiesCards rows={rows} rent={rent} />
          </div>
        </>
      )}

      {/* past the end there is no "Page 12 of 11" to show; the empty state says
          so and the header still states the true total */}
      {totalPages > 1 && !beyondEnd ? (
        <div className="flex items-center justify-between text-sm text-text-2">
          <span>
            Page {filters.page} of {totalPages}
          </span>
          <div className="flex gap-2">
            {filters.page > 1 ? (
              <Button asChild variant="outline" size="sm">
                <Link href={pageParams(filters.page - 1)}>Previous</Link>
              </Button>
            ) : null}
            {filters.page < totalPages ? (
              <Button asChild variant="outline" size="sm">
                <Link href={pageParams(filters.page + 1)}>Next</Link>
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
