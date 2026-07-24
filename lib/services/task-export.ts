import { type CsvColumn } from "./csv";
import { formatDateTime } from "@/lib/utils/format";

/**
 * Column mapping for the tasks CSV export (IMPROVEMENTS B10). Pure and
 * unit-testable. The tasks screen is "my tasks" (assignee-scoped) with no
 * searchParam filters and an open/done split capped for display; the export
 * mirrors the assignee scope but covers EVERY task (open and done, all time),
 * which is what a personal work-history report needs. The route applies the
 * assignee filter; RLS scopes it further.
 */

export const TASK_EXPORT_SELECT =
  "title, due_at, is_done, done_at, mandate_id, created_at, properties(reference)";

export interface TaskExportRow {
  title: string | null;
  due_at: string | null;
  is_done: boolean | null;
  done_at: string | null;
  mandate_id: string | null;
  created_at: string | null;
  properties: { reference: string | null } | null;
}

export function taskCsvColumns(): CsvColumn<TaskExportRow>[] {
  return [
    { header: "Title", value: (t) => t.title },
    { header: "Status", value: (t) => (t.is_done ? "done" : "open") },
    { header: "Due", value: (t) => (t.due_at ? formatDateTime(t.due_at) : "") },
    { header: "Done at", value: (t) => (t.done_at ? formatDateTime(t.done_at) : "") },
    { header: "Property", value: (t) => t.properties?.reference ?? "" },
    // mandate_id set = an auto-generated renewal task (expire_mandates)
    { header: "Auto", value: (t) => (t.mandate_id ? "yes" : "") },
    { header: "Created", value: (t) => formatDateTime(t.created_at) },
  ];
}
