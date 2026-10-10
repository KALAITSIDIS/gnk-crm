import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/services/auth";
import { auditFilters, logListExport, vet } from "@/lib/services/export-audit";
import { LEAD_STATUS_FILTERS } from "@/lib/validators/contacts";
import { toCsv, csvFilename } from "@/lib/services/csv";
import { LEAD_EXPORT_SELECT, leadCsvColumns, type LeadExportRow } from "@/lib/services/lead-export";
import { applyLeadListFilters, parseLeadFilters } from "@/lib/queries/leads-list";
import { exportFailed, readAgentNames, readExportRows } from "@/lib/services/export-read";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  const sp: Record<string, string> = Object.fromEntries(request.nextUrl.searchParams.entries());
  const filters = parseLeadFilters(sp);

  const agentName = await readAgentNames(supabase);
  if (!agentName) return exportFailed();

  const read = await readExportRows(
    (from, to) =>
      applyLeadListFilters(supabase.from("leads").select(LEAD_EXPORT_SELECT), filters)
        .order("received_at", { ascending: false })
        .order("id")
        .range(from, to),
    "leads",
  );
  if ("refused" in read) return read.refused;
  const rows = read.rows as unknown as LeadExportRow[];

  await logListExport(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    list: "leads",
    count: rows.length,
    // the parsed scope only — a parameter this list does not read is not recorded
    filters: auditFilters(filters, { status: vet.oneOf(LEAD_STATUS_FILTERS) }),
  });

  const csv = toCsv(leadCsvColumns(agentName), rows);
  const filename = csvFilename(`leads-${filters.status}`);

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
