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
import { readExportRows } from "@/lib/services/export-read";

export async function GET() {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  // The calendar screen has no filters; the export covers EVERY viewing, all
  // time (past viewings + signed slips are what commission reporting needs).
  const read = await readExportRows(
    (from, to) =>
      supabase
        .from("viewings")
        .select(VIEWING_EXPORT_SELECT)
        .order("scheduled_at", { ascending: false })
        .order("id")
        .range(from, to),
    "viewings",
    { filterable: false },
  );
  if ("refused" in read) return read.refused;
  // No cast: the generated types carry the slip as ONE object (a one-to-one),
  // and ViewingExportRow must agree — it said array until 2026-10-01.
  const rows: ViewingExportRow[] = read.rows;

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
