import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/services/auth";
import { logListExport } from "@/lib/services/export-audit";
import { toCsv, csvFilename } from "@/lib/services/csv";
import { exportFailed, readAgentNames, readExportRows } from "@/lib/services/export-read";
import { DEAL_EXPORT_SELECT, dealCsvColumns, type DealExportRow } from "@/lib/services/deal-export";
import { applyDealTypeFilter, parseDealType } from "@/lib/queries/deals-list";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  const sp: Record<string, string> = Object.fromEntries(request.nextUrl.searchParams.entries());
  const dealType = parseDealType(sp);

  const agentName = await readAgentNames(supabase);
  if (!agentName) return exportFailed();

  // The board shows open + a 30-day closed window; the export gives EVERY deal of
  // this type (all statuses) — reporting wants old won deals too. See DECISIONS.
  // Paged — a fresh query per page, ordered uniquely (readExportRows).
  const read = await readExportRows(
    (from, to) =>
      applyDealTypeFilter(supabase.from("deals").select(DEAL_EXPORT_SELECT), dealType)
        .order("created_at", { ascending: false })
        .order("id")
        .range(from, to),
    "deals",
    // the deal type picks a pipeline; nothing narrows one
    { filterable: false },
  );
  if ("refused" in read) return read.refused;
  const rows = read.rows as unknown as DealExportRow[];

  await logListExport(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    list: "deals",
    count: rows.length,
    filters: { type: dealType },
  });

  const csv = toCsv(dealCsvColumns(agentName), rows);
  const filename = csvFilename(`deals-${dealType}`);

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
