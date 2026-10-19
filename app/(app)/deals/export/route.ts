import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/services/auth";
import { auditFilters, logListExport, vet } from "@/lib/services/export-audit";
import { toCsv, csvFilename } from "@/lib/services/csv";
import { exportFailed, readAgentNames, readExportRows } from "@/lib/services/export-read";
import { DEAL_EXPORT_SELECT, dealCsvColumns, type DealExportRow } from "@/lib/services/deal-export";
import {
  DEAL_TYPES,
  applyDealListFilters,
  parseDealListFilters,
  type DealSearchParams,
} from "@/lib/queries/deals-list";
import { DEAL_LIST_STATUSES, isDayKey } from "@/lib/validators/deals";

/**
 * The /deals register as a CSV (F05): the list's own filters, parsed and
 * applied by the same module, in the list's own order — so the file is the
 * list on screen, every page of it. /pipeline/export (one whole deal type,
 * unfiltered) is unchanged beside it.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  // every value of a repeated parameter, so the shared parser reads the FIRST
  // — as the page does (Object.fromEntries keeps the last; T-keys-search-length)
  const params = request.nextUrl.searchParams;
  const sp: DealSearchParams = Object.fromEntries([...new Set(params.keys())].map((k) => [k, params.getAll(k)]));
  const filters = parseDealListFilters(sp);

  const agentName = await readAgentNames(supabase);
  if (!agentName) return exportFailed();

  // EVERY matching deal up to the ceiling, or a refusal that says to narrow
  // the filters — never the rows one PostgREST response holds (readExportRows).
  // A fresh query per page, the same filters and session each time, ordered
  // uniquely and as the page orders.
  const read = await readExportRows(
    (from, to) =>
      applyDealListFilters(supabase.from("deals").select(DEAL_EXPORT_SELECT), filters)
        .order("created_at", { ascending: false })
        .order("id")
        .range(from, to),
    "deals",
  );
  if ("refused" in read) return read.refused;
  const rows = read.rows as unknown as DealExportRow[];

  // Audited BEFORE the CSV is handed over. The search matches deal titles,
  // which name the buyer: recorded as used, never as typed (T-export-filter-shape).
  await logListExport(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    list: "deals",
    count: rows.length,
    filters: auditFilters(filters, {
      type: vet.oneOf(DEAL_TYPES),
      status: vet.oneOf(DEAL_LIST_STATUSES),
      agent: vet.uuid,
      property: vet.uuid,
      contact: vet.uuid,
      closed_from: isDayKey,
      closed_to: isDayKey,
    }),
  });

  const csv = toCsv(dealCsvColumns(agentName), rows);
  const filename = csvFilename(filters.type ? `deals-${filters.type}` : "deals");

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
