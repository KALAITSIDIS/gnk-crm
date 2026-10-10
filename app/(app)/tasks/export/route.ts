import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/services/auth";
import { logListExport } from "@/lib/services/export-audit";
import { toCsv, csvFilename } from "@/lib/services/csv";
import { TASK_EXPORT_SELECT, taskCsvColumns, type TaskExportRow } from "@/lib/services/task-export";
import { readExportRows } from "@/lib/services/export-read";

export async function GET() {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  // "My tasks", like the page — assignee = the current user — but EVERY task
  // (open and done, all time), not the page's split. RLS scopes it further.
  // Undated tasks last, as before; `id` breaks every tie, the undated included.
  const read = await readExportRows(
    (from, to) =>
      supabase
        .from("tasks")
        .select(TASK_EXPORT_SELECT)
        .eq("assignee_id", profile.id)
        .order("due_at", { ascending: true, nullsFirst: false })
        .order("id")
        .range(from, to),
    "tasks",
    { filterable: false },
  );
  if ("refused" in read) return read.refused;
  const rows = read.rows as unknown as TaskExportRow[];

  await logListExport(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    list: "tasks",
    count: rows.length,
  });

  const csv = toCsv(taskCsvColumns(), rows);

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvFilename("my-tasks")}"`,
      "Cache-Control": "no-store",
    },
  });
}
