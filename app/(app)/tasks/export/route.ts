import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/services/auth";
import { auditFilters, logListExport, vet } from "@/lib/services/export-audit";
import { toCsv, csvFilename } from "@/lib/services/csv";
import {
  TASK_EXPORT_SELECT,
  taskCsvColumns,
  taskExportSlug,
  type TaskExportRow,
} from "@/lib/services/task-export";
import { readExportRows } from "@/lib/services/export-read";
import {
  TASK_DUE_FILTERS,
  TASK_SCOPES,
  applyTaskDue,
  applyTaskScope,
  parseTaskListFilters,
} from "@/lib/queries/tasks-list";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  // The page's view (A02): `?scope=` and `?due=` parsed by the SAME function
  // the page uses — first value wins, Team is an admin's only. Without a due
  // filter it is EVERY task of the view (open and done, all time), not the
  // page's split; with one, the open tasks in that window. Undated tasks last,
  // as before; `id` breaks every tie, the undated included.
  const sp = request.nextUrl.searchParams;
  const filters = parseTaskListFilters(
    { scope: sp.get("scope") ?? undefined, due: sp.get("due") ?? undefined },
    profile.role === "admin",
  );
  const now = new Date();

  const read = await readExportRows(
    (from, to) => {
      const scoped = applyTaskScope(supabase.from("tasks").select(TASK_EXPORT_SELECT), filters.scope, profile.id);
      return (filters.due ? applyTaskDue(scoped, filters.due, now) : scoped)
        .order("due_at", { ascending: true, nullsFirst: false })
        .order("id")
        .range(from, to);
    },
    "tasks",
  );
  if ("refused" in read) return read.refused;
  const rows = read.rows as unknown as TaskExportRow[];

  await logListExport(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    list: "tasks",
    count: rows.length,
    // vocabulary members only — the view, never anything typed
    filters: auditFilters(filters, { scope: vet.oneOf(TASK_SCOPES), due: vet.oneOf(TASK_DUE_FILTERS) }),
  });

  const csv = toCsv(taskCsvColumns(), rows);

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${csvFilename(taskExportSlug(filters))}"`,
      "Cache-Control": "no-store",
    },
  });
}
