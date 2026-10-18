import { addDayKey } from "@/lib/services/calendar-window";
import { zonedParts, zonedWallClockToUtc } from "@/lib/utils/tz";

/**
 * The /tasks views (A02), shared by the page and its CSV export so the file is
 * always the list on the screen.
 *
 * SCOPE — whose tasks:
 *   mine       assignee = me (the default; what /tasks always showed)
 *   delegated  I created it and it is someone else's — or nobody's, when its
 *              holder was removed (still mine to chase). Read through
 *              tasks_select's creator arm; I can see these, not change them.
 *   team       every task of the organisation. Admin only: an agent's RLS shows
 *              them their own and their delegated tasks and nothing else, so a
 *              "team" view for an agent would be a mislabelled "mine + mine".
 *              A non-admin asking for it gets `mine`, and the page offers no
 *              Team link to them.
 *
 * DUE — which open tasks, by their Cyprus day (`due_at` is an instant; the day
 * a person means is Nicosia's, lib/utils/tz.ts):
 *   overdue    due before now
 *   today      due on today's Cyprus day, done-by-tonight or not
 *   week       due today or in the six days after it ("Next 7 days")
 *   undated    no due date
 * A due filter is about work still to do, so it reads OPEN tasks only — on the
 * page (the "Recently done" section steps aside) and in the export.
 */

export const TASK_SCOPES = ["mine", "delegated", "team"] as const;
export type TaskScope = (typeof TASK_SCOPES)[number];

export const TASK_DUE_FILTERS = ["overdue", "today", "week", "undated"] as const;
export type TaskDueFilter = (typeof TASK_DUE_FILTERS)[number];

export const TASK_SCOPE_LABELS: Record<TaskScope, string> = {
  mine: "Mine",
  delegated: "Delegated",
  team: "Team",
};

export const TASK_DUE_LABELS: Record<TaskDueFilter, string> = {
  overdue: "Overdue",
  today: "Today",
  week: "Next 7 days",
  undated: "No date",
};

export interface TaskListFilters {
  scope: TaskScope;
  due: TaskDueFilter | null;
}

type ParamValue = string | string[] | undefined;
export type TaskSearchParams = Record<string, ParamValue>;

/** A repeated parameter reads its FIRST value, as every list here does. */
function first(v: ParamValue): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Never throws. An unknown scope or due value is no filter (a stale or
 * hand-typed URL), and `team` is `mine` for anyone but an admin.
 */
export function parseTaskListFilters(sp: TaskSearchParams, isAdmin: boolean): TaskListFilters {
  const rawScope = first(sp.scope);
  const rawDue = first(sp.due);
  let scope: TaskScope = (TASK_SCOPES as readonly string[]).includes(rawScope ?? "")
    ? (rawScope as TaskScope)
    : "mine";
  if (scope === "team" && !isAdmin) scope = "mine";
  const due = (TASK_DUE_FILTERS as readonly string[]).includes(rawDue ?? "")
    ? (rawDue as TaskDueFilter)
    : null;
  return { scope, due };
}

/** The view's query string ("" for the default view), `page` never carried. */
export function taskListQuery(filters: TaskListFilters): string {
  const params = new URLSearchParams();
  if (filters.scope !== "mine") params.set("scope", filters.scope);
  if (filters.due) params.set("due", filters.due);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** The window a due filter selects, as instants (half-open: gte ≤ due_at < lt). */
export interface DueWindow {
  gte?: string;
  lt?: string;
  undated?: true;
}

export function taskDueWindow(due: TaskDueFilter, now: Date): DueWindow {
  if (due === "undated") return { undated: true };
  if (due === "overdue") return { lt: now.toISOString() };
  const todayKey = zonedParts(now).dayKey;
  const startOf = (key: string) => zonedWallClockToUtc(`${key}T00:00`).toISOString();
  // whole Cyprus days, stepped by day KEY (DST days are 23 and 25 hours long)
  return { gte: startOf(todayKey), lt: startOf(addDayKey(todayKey, due === "today" ? 1 : 7)) };
}

interface TaskFilterBuilder<Q> {
  eq(column: string, value: never): Q;
  is(column: string, value: null): Q;
  or(filter: string): Q;
  gte(column: string, value: string): Q;
  lt(column: string, value: string): Q;
}

/** `meId` comes from getCurrentProfile — a uuid the database issued, never typed text. */
export function applyTaskScope<Q extends TaskFilterBuilder<Q>>(query: Q, scope: TaskScope, meId: string): Q {
  if (scope === "mine") return query.eq("assignee_id", meId as never);
  if (scope === "delegated") {
    // not a bare `.neq`: `assignee_id <> me` is NULL for an unassigned row and
    // PostgREST would drop it — the reassignTask lesson (lib/actions/tasks.ts)
    return query.eq("created_by", meId as never).or(`assignee_id.is.null,assignee_id.neq.${meId}`);
  }
  return query; // team: RLS gives an admin the organisation's tasks
}

/** Open tasks in the due window — the filter implies `is_done = false`. */
export function applyTaskDue<Q extends TaskFilterBuilder<Q>>(query: Q, due: TaskDueFilter, now: Date): Q {
  const window = taskDueWindow(due, now);
  let out = query.eq("is_done", false as never);
  if (window.undated) return out.is("due_at", null);
  if (window.gte) out = out.gte("due_at", window.gte);
  if (window.lt) out = out.lt("due_at", window.lt);
  return out;
}
