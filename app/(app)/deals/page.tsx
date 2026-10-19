import Link from "next/link";
import { Handshake, SquareKanban } from "lucide-react";
import { DealsFilters } from "@/components/features/deals/deals-filters";
import { DealsTable, type DealListItem } from "@/components/features/deals/deals-table";
import { ExportCsvButton } from "@/components/features/shared/export-csv-button";
import { Pager } from "@/components/features/shared/pager";
import { Button } from "@/components/ui/button";
import type { EntityOption } from "@/lib/actions/entity-search";
import {
  applyDealListFilters,
  isDealListFiltered,
  parseDealListFilters,
  type DealListFilters,
} from "@/lib/queries/deals-list";
import { dealValue, dealValueIsFinal } from "@/lib/services/deal-value";
import { createClient } from "@/lib/supabase/server";
import { unwrapCount, unwrapRows } from "@/lib/supabase/unwrap";
import {
  isRangeBeyondEnd,
  pageRange,
  pageSchema,
  totalPages as countPages,
} from "@/lib/validators/pagination";
import type { Metadata } from "next";

/** The browser tab's name (A08): "Deals · GN REOS" through the root layout's title template. */
export const metadata: Metadata = { title: "Deals" };

export const dynamic = "force-dynamic";

/**
 * The deals register (F05): every deal the session may read, of every type
 * and status, paged and filtered in the URL. The pipeline board is current
 * work — open deals, and closed ones for 30 days only — so a deal closed
 * longer ago was reachable only through a contact, a lead or a task that
 * happened to link it. RLS decides the rows (deals_select: admin and listing
 * manager the whole organisation, an agent the deals they own or created);
 * the page holds no role logic. /deals/export is the same filters, the same
 * order, as a CSV.
 */
const DEAL_LIST_SELECT =
  // the buyer embed is hinted by CONSTRAINT NAME, as the export's is: a column
  // hint stops resolving once the key is composite (0139, PGRST200)
  "id, title, deal_type, status, expected_value, final_value, won_at, lost_at, created_at, agent_id, property_id, buyer_contact_id, deal_stages(name), properties(reference), buyer:contacts!deals_buyer_contact_id_fkey(display_name)";

interface DealListRow {
  id: string;
  title: string;
  deal_type: string;
  status: string;
  expected_value: number | null;
  final_value: number | null;
  won_at: string | null;
  lost_at: string | null;
  created_at: string;
  agent_id: string | null;
  property_id: string | null;
  buyer_contact_id: string | null;
  deal_stages: { name: string | null } | null;
  properties: { reference: string | null } | null;
  buyer: { display_name: string | null } | null;
}

type SearchParams = { [key: string]: string | string[] | undefined };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** The URL of this list with these parameters (page left out when it is 1). */
function listHref(sp: SearchParams, page?: number): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (k === "page") continue;
    const val = first(v);
    if (val) params.set(k, val);
  }
  if (page && page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/deals?${qs}` : "/deals";
}

export default async function DealsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const filters: DealListFilters = parseDealListFilters(sp);
  const filtered = isDealListFiltered(filters);
  const page = pageSchema.parse(first(sp.page));
  const { from, to } = pageRange(page);
  const supabase = await createClient();

  const [listRes, profilesRes, propertyRes, contactRes] = await Promise.all([
    applyDealListFilters(supabase.from("deals").select(DEAL_LIST_SELECT, { count: "exact" }), filters)
      // `id` breaks created_at ties so every offset page is its exact slice;
      // the same order as /deals/export, so the file lists the screen's rows
      // in the screen's order (T-list-page-order)
      .order("created_at", { ascending: false })
      .order("id")
      .range(from, to),
    // the Agent column and filter: every profile, so a deactivated agent's
    // deals do not read as unassigned
    supabase.from("profiles").select("id, full_name, is_active").order("full_name").order("id"),
    // the chosen property / contact, named for the filter bar's pickers
    filters.property
      ? supabase.from("properties").select("id, reference, title").eq("id", filters.property).limit(1)
      : null,
    filters.contact
      ? supabase.from("contacts").select("id, display_name, phone_e164, email").eq("id", filters.contact).limit(1)
      : null,
  ]);

  // A stale ?page= past the end is an empty page, not a failure — but its
  // total is still a fact to read, never a zero to assume: PostgREST's
  // range-not-satisfiable answer carries no count, so it is asked separately.
  const beyond = isRangeBeyondEnd(listRes.error);
  const rows = beyond ? [] : (unwrapRows(listRes, "deals") as unknown as DealListRow[]);
  const total = beyond
    ? unwrapCount(
        await applyDealListFilters(supabase.from("deals").select("id", { count: "exact", head: true }), filters),
        "deal count",
      )
    : unwrapCount(listRes, "deal count");
  const profiles = unwrapRows(profilesRes, "profiles");
  const pageCount = countPages(total);

  const agentName = new Map(profiles.map((p) => [p.id, p.is_active ? p.full_name : `${p.full_name} (inactive)`]));
  const agentOptions = profiles.filter((p) => p.is_active).map((p) => ({ id: p.id, full_name: p.full_name }));

  const propertyRow = propertyRes ? (unwrapRows(propertyRes, "deal filter property")[0] ?? null) : null;
  const contactRow = contactRes ? (unwrapRows(contactRes, "deal filter contact")[0] ?? null) : null;
  // a chosen id this session cannot read (or that no longer exists) still
  // filters — and still shows, so it can be cleared
  const propertyOption: EntityOption | null = filters.property
    ? propertyRow
      ? {
          id: propertyRow.id,
          label: (propertyRow.title as { en?: string } | null)?.en || propertyRow.reference,
          sublabel: propertyRow.reference,
        }
      : { id: filters.property, label: "Property not found", sublabel: null }
    : null;
  const contactOption: EntityOption | null = filters.contact
    ? contactRow
      ? {
          id: contactRow.id,
          label: contactRow.display_name ?? "Unnamed",
          sublabel: contactRow.phone_e164 ?? contactRow.email,
        }
      : { id: filters.contact, label: "Contact not found", sublabel: null }
    : null;

  const items: DealListItem[] = rows.map((d) => ({
    id: d.id,
    title: d.title,
    dealType: d.deal_type,
    stageName: d.deal_stages?.name ?? null,
    status: d.status,
    value: dealValue(d),
    valueIsFinal: dealValueIsFinal(d),
    propertyId: d.property_id,
    propertyRef: d.properties?.reference ?? null,
    buyerId: d.buyer_contact_id,
    buyerName: d.buyer?.display_name ?? null,
    agentName: d.agent_id ? (agentName.get(d.agent_id) ?? null) : null,
    createdAt: d.created_at,
    closedAt: d.status === "won" ? d.won_at : d.status === "lost" ? d.lost_at : null,
  }));

  // the export carries the filters, never the page: the whole filtered set
  const exportHref = listHref(sp).replace(/^\/deals/, "/deals/export");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-text-1">Deals</h1>
          <p className="text-sm text-text-2">
            {total} {filtered ? "matching " : ""}deal{total === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {total > 0 ? <ExportCsvButton href={exportHref} /> : null}
          <Button asChild variant="outline">
            <Link href={filters.type ? `/pipeline?type=${filters.type}` : "/pipeline"}>
              <SquareKanban className="size-4" /> Pipeline board
            </Link>
          </Button>
        </div>
      </div>

      <DealsFilters
        agents={agentOptions}
        values={filters}
        property={propertyOption}
        contact={contactOption}
      />

      {items.length > 0 ? (
        <>
          <DealsTable rows={items} />
          <Pager
            page={page}
            pageCount={pageCount}
            total={total}
            searchParams={sp}
            label={filtered ? "matching deals" : "deals"}
          />
        </>
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-[10px] border border-border bg-surface py-16 text-center">
          <Handshake className="size-8 text-text-3" />
          {total > 0 ? (
            <>
              <p className="text-sm text-text-2">Nothing on this page.</p>
              <Button asChild variant="outline" size="sm">
                <Link href={listHref(sp, pageCount)}>Go to the last page</Link>
              </Button>
            </>
          ) : filtered ? (
            <>
              <p className="text-sm text-text-2">No deals match these filters.</p>
              <Button asChild variant="outline" size="sm">
                <Link href="/deals">Clear filters</Link>
              </Button>
            </>
          ) : (
            <>
              <p className="text-sm text-text-2">No deals yet — a deal opens when a lead is converted.</p>
              <Button asChild variant="outline" size="sm">
                <Link href="/leads">Go to Leads</Link>
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
