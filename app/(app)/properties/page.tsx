import Link from "next/link";
import { Building2, Download, Plus } from "lucide-react";
import {
  PropertiesFilters,
  type AreaOption,
  type DistrictOption,
} from "@/components/features/properties/filters";
import {
  PropertiesCards,
  PropertiesTable,
  type PropertyRow,
} from "@/components/features/properties/list";
import type { MandateBadgeState } from "@/components/features/shared/mandate-badge";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";
import { unwrapRows } from "@/lib/supabase/unwrap";
import { PROPERTIES_PAGE_SIZE } from "@/lib/validators/properties";
import {
  applyPropertyListFilters,
  fetchMandateExcludeIds,
  mandateEmbed,
  parsePropertyFilters,
} from "@/lib/queries/properties-list";

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

export default async function PropertiesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const filters = parsePropertyFilters(sp);

  const supabase = await createClient();

  const [districtsRes, areasRes] = await Promise.all([
    supabase.from("districts").select("id, name, sort_order").order("sort_order"),
    supabase.from("areas").select("id, district_id, name"),
  ]);

  const districts: DistrictOption[] = unwrapRows(districtsRes, "districts").map((d) => ({
    id: d.id,
    name: (d.name as { en?: string })?.en ?? "—",
  }));
  const areas: AreaOption[] = unwrapRows(areasRes, "areas").map((a) => ({
    id: a.id,
    districtId: a.district_id,
    name: (a.name as { en?: string })?.en ?? "—",
  }));

  // Shared with the export route so the two select exactly the same rows.
  const excludeIds = await fetchMandateExcludeIds(supabase, filters);

  const base = supabase
    .from("properties")
    .select(
      `id, reference, kind, property_type, transaction_type, status, visibility,
       title, bedrooms, covered_area_sqm, plot_area_sqm, asking_price,
       rent_price_month, quality_score,
       districts(name), areas(name),
       property_media(path_thumb, is_cover, sort_order),
       ${mandateEmbed(filters)}`,
      { count: "exact" },
    );

  const query = applyPropertyListFilters(base, filters, excludeIds);

  const from = (filters.page - 1) * PROPERTIES_PAGE_SIZE;
  const result = await query
    .order("created_at", { ascending: false })
    .range(from, from + PROPERTIES_PAGE_SIZE - 1);

  // PGRST103 = page beyond the result set → render the empty-page state
  if (result.error && result.error.code !== "PGRST103") {
    throw new Error(`Properties query failed: ${result.error.message}`);
  }
  const data = result.data ?? [];
  const count = result.count ?? 0;

  const rows: PropertyRow[] = data.map((p) => {
    const media = (p.property_media ?? []) as {
      path_thumb: string | null;
      is_cover: boolean;
      sort_order: number;
    }[];
    const cover =
      media.find((m) => m.is_cover) ??
      [...media].sort((a, b) => a.sort_order - b.sort_order)[0];
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
      asking_price: p.asking_price === null ? null : Number(p.asking_price),
      rent_price_month: p.rent_price_month === null ? null : Number(p.rent_price_month),
      quality_score: p.quality_score,
      mandate: deriveMandateState((p.mandates ?? []) as MandateEmbed[]),
      thumb: cover?.path_thumb ?? null,
    };
  });

  const total = count;
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

  // Export carries the active filters but not pagination — the whole filtered
  // set, RLS-scoped to what this user can see.
  const exportHref = (() => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) {
      if (k === "page") continue;
      const val = first(v);
      if (val) params.set(k, val);
    }
    const qs = params.toString();
    return `/properties/export${qs ? `?${qs}` : ""}`;
  })();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-text-1">Properties</h1>
          <p className="text-sm text-text-2">
            {total} {filters.scope === "archived" ? "archived " : ""}propert
            {total === 1 ? "y" : "ies"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {total > 0 ? (
            <Button asChild variant="outline">
              {/* Plain anchor, not next/link: this is a file download. */}
              <a href={exportHref} download>
                <Download className="size-4" /> Export CSV
              </a>
            </Button>
          ) : null}
          <Button asChild>
            <Link href="/properties/new">
              <Plus className="size-4" /> Add property
            </Link>
          </Button>
        </div>
      </div>

      <PropertiesFilters districts={districts} areas={areas} />

      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-[10px] border border-border bg-surface py-16">
          <Building2 className="size-8 text-text-3" />
          <p className="text-sm text-text-2">
            {total > 0 || filters.page > 1
              ? "Nothing on this page."
              : filters.scope === "archived"
                ? "No archived properties — withdrawn listings and archived visibility show up here."
                : "No properties match — add the first one or clear filters."}
          </p>
          {filters.scope === "archived" ? null : (
            <Button asChild variant="outline" size="sm">
              <Link href="/properties/new">
                <Plus className="size-4" /> Add property
              </Link>
            </Button>
          )}
        </div>
      ) : filters.view === "cards" ? (
        <PropertiesCards rows={rows} />
      ) : (
        <PropertiesTable rows={rows} />
      )}

      {totalPages > 1 ? (
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
