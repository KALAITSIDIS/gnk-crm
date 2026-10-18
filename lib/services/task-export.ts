import { type CsvColumn } from "./csv";
import { formatDateTime } from "@/lib/utils/format";
import { formatTaskDue } from "@/lib/validators/tasks";
import type { TaskListFilters } from "@/lib/queries/tasks-list";

/**
 * Column mapping for the tasks CSV export (IMPROVEMENTS B10). Pure and
 * unit-testable. The export is the page's VIEW (A02, lib/queries/tasks-list.ts)
 * — mine, delegated or the team's, narrowed by a due filter when one is
 * chosen — over EVERY matching task, open and done, all time (open only under
 * a due filter), not the page's split or its page. The route applies the
 * filters; RLS scopes it further.
 */

export const TASK_EXPORT_SELECT =
  "title, due_at, is_done, done_at, kind, created_at, properties(reference), assignee:profiles!assignee_id(full_name, is_active)";

export interface TaskExportRow {
  title: string | null;
  due_at: string | null;
  is_done: boolean | null;
  done_at: string | null;
  /** null = a human made this; otherwise the rule that generated it (0020) */
  kind: string | null;
  created_at: string | null;
  properties: { reference: string | null } | null;
  /** who holds it — null when nobody does */
  assignee: { full_name: string | null; is_active: boolean | null } | null;
}

/** The holder as the Assignee column names them; a deactivated one says so. */
function assigneeCell(t: TaskExportRow): string {
  if (!t.assignee) return "";
  const name = t.assignee.full_name ?? "";
  return t.assignee.is_active === false ? `${name} (inactive)` : name;
}

export function taskCsvColumns(): CsvColumn<TaskExportRow>[] {
  return [
    { header: "Title", value: (t) => t.title },
    { header: "Status", value: (t) => (t.is_done ? "done" : "open") },
    // the page's own reading: a date for an all-day task (Cyprus 23:59 is the
    // sentinel, lib/validators/tasks.ts), the date and time for a timed one
    { header: "Due", value: (t) => (t.due_at ? formatTaskDue(t.due_at) : "") },
    { header: "Done at", value: (t) => (t.done_at ? formatDateTime(t.done_at) : "") },
    { header: "Property", value: (t) => t.properties?.reference ?? "" },
    // `kind` set = system-generated; the slug says WHICH rule made it
    // (mandate_renewal · deal_no_contact · viewing_feedback). Empty = a human
    // typed it. Was `mandate_id ? "yes"`, which could not tell the rules apart.
    { header: "Auto", value: (t) => t.kind ?? "" },
    { header: "Created", value: (t) => formatDateTime(t.created_at) },
    // last, so the columns a spreadsheet already reads keep their places (A02)
    { header: "Assignee", value: assigneeCell },
  ];
}

/** "my-tasks", "delegated-tasks-overdue", "team-tasks-week" … (csvFilename adds the date). */
export function taskExportSlug(filters: TaskListFilters): string {
  const base = filters.scope === "mine" ? "my-tasks" : `${filters.scope}-tasks`;
  return filters.due ? `${base}-${filters.due}` : base;
}
