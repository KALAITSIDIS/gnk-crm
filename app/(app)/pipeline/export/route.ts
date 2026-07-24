import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/services/auth";
import { logListExport } from "@/lib/services/export-audit";
import { toCsv, csvFilename } from "@/lib/services/csv";
import { DEAL_EXPORT_SELECT, dealCsvColumns, type DealExportRow } from "@/lib/services/deal-export";
import { applyDealTypeFilter, parseDealType } from "@/lib/queries/deals-list";

const EXPORT_CAP = 10_000;

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  const sp: Record<string, string> = Object.fromEntries(request.nextUrl.searchParams.entries());
  const dealType = parseDealType(sp);

  const { data: profileRows } = await supabase
    .from("profiles")
    .select("id, full_name, is_active")
    .order("full_name");
  const agentName = new Map(
    (profileRows ?? []).map((p) => [p.id, p.is_active ? p.full_name : `${p.full_name} (inactive)`]),
  );

  // The board shows open + a 30-day closed window; the export gives EVERY deal of
  // this type (all statuses) — reporting wants old won deals too. See DECISIONS.
  const base = supabase.from("deals").select(DEAL_EXPORT_SELECT);
  const { data, error } = await applyDealTypeFilter(base, dealType)
    .order("created_at", { ascending: false })
    .range(0, EXPORT_CAP - 1);

  if (error) {
    return NextResponse.json({ error: "Export failed." }, { status: 500 });
  }

  const rows = (data ?? []) as unknown as DealExportRow[];

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
