import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Tasks that nobody will ever see (BACKLOG, T-audit-tasks).
 *
 * Every task surface in this app is assignee-scoped — `/tasks` filters on
 * `assignee_id = me`, and so does the agent dashboard. Two states therefore fall
 * out of the product entirely rather than merely being awkward:
 *
 *  - **deactivated** — the assignee's profile is `is_active = false`. 0024's
 *    nightly sweep re-homes these, but ONLY for system rows (`kind is not null`).
 *    A task one person assigned to another by hand is deliberately left alone,
 *    because silently reassigning it would overwrite a human's decision about
 *    who owns the work. Correct, and it leaves the row invisible.
 *  - **unassigned** — `assignee_id is null`. Reachable despite 0012's admin
 *    fallback: `create_followup_nudges` ends its three-arm coalesce at "oldest
 *    active admin", so an org with no active admin mints a NULL assignee.
 *
 * Hence a surface with an explicit reassign, rather than another cron rule. The
 * fallback prevents new orphans; it cannot show you the existing ones.
 */

export type StrandedReason = "unassigned" | "deactivated";

export interface StrandedTask {
  id: string;
  title: string;
  dueAt: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  reason: StrandedReason;
  /** `kind is not null` — a system-generated nudge rather than a typed task. */
  isAuto: boolean;
}

/**
 * Which of the two invisibilities this row is in. Pure so the distinction is
 * testable without a database — it drives what the UI can offer (a deactivated
 * task names who held it; an unassigned one has nobody to name).
 */
export function strandedReason(
  assignee: { is_active: boolean } | null | undefined,
): StrandedReason {
  return assignee ? "deactivated" : "unassigned";
}

/** Soonest due first, undated last — the same ordering `/tasks` uses. */
export function sortStranded(rows: StrandedTask[]): StrandedTask[] {
  return [...rows].sort((a, b) => {
    if (a.dueAt === b.dueAt) return a.title.localeCompare(b.title);
    if (!a.dueAt) return 1;
    if (!b.dueAt) return -1;
    return a.dueAt.localeCompare(b.dueAt);
  });
}

type Row = {
  id: string;
  title: string;
  due_at: string | null;
  kind: string | null;
  assignee_id: string | null;
  assignee?: { full_name: string; is_active: boolean } | null;
};

const toStranded = (r: Row): StrandedTask => ({
  id: r.id,
  title: r.title,
  dueAt: r.due_at,
  assigneeId: r.assignee_id,
  assigneeName: r.assignee?.full_name ?? null,
  reason: strandedReason(r.assignee ?? null),
  isAuto: r.kind !== null,
});

const COLUMNS = "id, title, due_at, kind, assignee_id";

/**
 * Two queries rather than one `.or()`: the deactivated case needs an INNER join
 * onto `profiles` to filter on `is_active`, and an inner join is exactly what
 * excludes the NULL-assignee rows. Asking for both in one statement would
 * silently drop half the answer.
 *
 * Admin-gated by RLS (`tasks_select` grants admins the whole org), so this
 * returns nothing useful for an agent — the caller still checks the role, since
 * an empty list and "not allowed" should not look the same in the UI.
 */
export async function fetchStrandedTasks(
  supabase: SupabaseClient<Database>,
  orgId: string,
): Promise<StrandedTask[]> {
  const [unassigned, deactivated] = await Promise.all([
    supabase
      .from("tasks")
      .select(COLUMNS)
      .eq("org_id", orgId)
      .eq("is_done", false)
      .is("assignee_id", null),
    supabase
      .from("tasks")
      .select(`${COLUMNS}, assignee:profiles!assignee_id!inner(full_name, is_active)`)
      .eq("org_id", orgId)
      .eq("is_done", false)
      .eq("assignee.is_active", false),
  ]);

  if (unassigned.error) throw new Error(`Query failed (unassigned tasks): ${unassigned.error.message}`);
  if (deactivated.error)
    throw new Error(`Query failed (deactivated-assignee tasks): ${deactivated.error.message}`);

  return sortStranded([
    ...((unassigned.data ?? []) as Row[]).map(toStranded),
    ...((deactivated.data ?? []) as unknown as Row[]).map(toStranded),
  ]);
}
