import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/services/auth";
import { logListExport } from "@/lib/services/export-audit";
import { toCsv, csvFilename } from "@/lib/services/csv";
import { LEAD_EXPORT_SELECT, leadCsvColumns, type LeadExportRow } from "@/lib/services/lead-export";
import { applyLeadListFilters, parseLeadFilters } from "@/lib/queries/leads-list";

const EXPORT_CAP = 10_000;

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  const sp: Record<string, string> = Object.fromEntries(request.nextUrl.searchParams.entries());
  const filters = parseLeadFilters(sp);

  const { data: profileRows } = await supabase
    .from("profiles")
    .select("id, full_name, is_active")
    .order("full_name");
  const agentName = new Map(
    (profileRows ?? []).map((p) => [p.id, p.is_active ? p.full_name : `${p.full_name} (inactive)`]),
  );

  const base = supabase.from("leads").select(LEAD_EXPORT_SELECT);
  const { data, error } = await applyLeadListFilters(base, filters)
    .order("received_at", { ascending: false })
    .range(0, EXPORT_CAP - 1);

  if (error) {
    return NextResponse.json({ error: "Export failed." }, { status: 500 });
  }

  const rows = (data ?? []) as unknown as LeadExportRow[];

  await logListExport(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    list: "leads",
    count: rows.length,
    filters: sp,
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
