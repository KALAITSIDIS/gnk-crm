import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/services/auth";
import { logListExport } from "@/lib/services/export-audit";
import { toCsv, csvFilename } from "@/lib/services/csv";
import {
  VIEWING_EXPORT_SELECT,
  viewingCsvColumns,
  type ViewingExportRow,
} from "@/lib/services/viewing-export";

const EXPORT_CAP = 10_000;

export async function GET() {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  // The calendar screen has no filters; the export covers EVERY viewing, all
  // time (past viewings + signed slips are what commission reporting needs).
  const { data, error } = await supabase
    .from("viewings")
    .select(VIEWING_EXPORT_SELECT)
    .order("scheduled_at", { ascending: false })
    .range(0, EXPORT_CAP - 1);

  if (error) {
    return NextResponse.json({ error: "Export failed." }, { status: 500 });
  }

  const rows = (data ?? []) as unknown as ViewingExportRow[];

  await logListExport(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    list: "viewings",
    count: rows.length,
  });

  const csv = toCsv(viewingCsvColumns(), rows);

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvFilename("viewings")}"`,
      "Cache-Control": "no-store",
    },
  });
}
