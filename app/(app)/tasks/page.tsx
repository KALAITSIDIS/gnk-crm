import { Download } from "lucide-react";
import {
  QuickAddTask,
  TaskSection,
  type TaskItem,
} from "@/components/features/tasks/task-list";
import { Button } from "@/components/ui/button";
import { Pager } from "@/components/features/shared/pager";
import { getCurrentProfile } from "@/lib/services/auth";
import { createClient } from "@/lib/supabase/server";
import { unwrapRows } from "@/lib/supabase/unwrap";
import {
  isRangeBeyondEnd,
  pageRange,
  pageSchema,
  totalPages as countPages,
} from "@/lib/validators/pagination";

export const dynamic = "force-dynamic";

/**
 * My tasks (T5.5, doc 05 📱). Every row here is a real `tasks` row: quick-added
 * by the user, or system-generated (`kind` set) by the nightly cron —
 * `expire_mandates` for renewals, `create_followup_nudges` for the two B7
 * follow-up rules.
 *
 * The "Viewings awaiting feedback" section that used to live here was a LIVE
 * QUERY rather than task rows, chosen so it could never drift out of sync with
 * the viewings themselves. B7 replaced it with `viewing_feedback` nudges: the
 * drift it was avoiding is now prevented by the 0020 invariant instead (a
 * trigger supersedes the task the moment feedback is saved), and task rows can
 * carry the things a live query cannot — a 48-hour threshold, a due date, an
 * assignee fallback, admin visibility, CSV export and an event trail.
 */
export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const page = pageSchema.parse(Array.isArray(sp.page) ? sp.page[0] : sp.page);
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  const now = new Date(); // per-request clock for the overdue boundary

  const [
    // SQL: select * from tasks where assignee_id = :me and is_done = false order by due_at nulls last;
    openRes,
    // SQL: select * from tasks where assignee_id = :me and is_done = true order by done_at desc limit 10;
    doneRes,
    // exact overdue count — the header must describe the whole open set, not
    // whichever slice this page happens to hold (PERF-2)
    overdueRes,
  ] = await Promise.all([
    supabase
      .from("tasks")
      .select("id, title, due_at, is_done, property_id, deal_id, viewing_id, kind", {
        count: "exact",
      })
      .eq("assignee_id", profile.id)
      .eq("is_done", false)
      .order("due_at", { ascending: true, nullsFirst: false })
      // Paged over the WHOLE open set, ordered by due date — so the most
      // overdue work is always on page 1 and the Overdue/Upcoming split below
      // stays meaningful (audit 2026-07-22, PERF-2; was a flat .limit(200)).
      .range(pageRange(page).from, pageRange(page).to),
    supabase
      .from("tasks")
      .select("id, title, due_at, is_done, property_id, deal_id, viewing_id, kind")
      .eq("assignee_id", profile.id)
      .eq("is_done", true)
      .order("done_at", { ascending: false })
      .limit(10),
    supabase
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("assignee_id", profile.id)
      .eq("is_done", false)
      .lt("due_at", now.toISOString()),
  ]);
  // failed queries throw to the error boundary — "0 open" must mean empty,
  // not broken (dashboard audit convention, lib/supabase/unwrap.ts)
  // ...except a stale ?page= past the end, which is an empty page not a fault
  const openRows = unwrapRows(
    isRangeBeyondEnd(openRes.error) ? { data: [], error: null } : openRes,
    "open tasks",
  );
  const doneRows = unwrapRows(doneRes, "done tasks");
  const openCount = openRes.count ?? openRows.length;
  const overdueCount = overdueRes.count ?? 0;
  const pageCount = countPages(openCount);

  const propertyIds = [
    ...new Set(
      [...openRows, ...doneRows].map((t) => t.property_id).filter((v): v is string => Boolean(v)),
    ),
  ];
  const { data: props } = propertyIds.length
    ? await supabase.from("properties").select("id, reference").in("id", propertyIds)
    : { data: [] };
  const refById = new Map((props ?? []).map((p) => [p.id, p.reference]));

  const toItem = (t: (typeof openRows)[number]): TaskItem => ({
    id: t.id,
    title: t.title,
    dueAt: t.due_at,
    isDone: t.is_done,
    overdue: Boolean(t.due_at && new Date(t.due_at).getTime() < now.getTime()),
    propertyId: t.property_id,
    propertyRef: t.property_id ? (refById.get(t.property_id) ?? null) : null,
    // a nudge links to the thing it is nagging about; the viewing wins because
    // logging the feedback is the action that clears it
    href: t.viewing_id ? `/viewings/${t.viewing_id}` : t.deal_id ? `/deals/${t.deal_id}` : null,
    hrefLabel: t.viewing_id ? "Viewing" : t.deal_id ? "Deal" : null,
    isAuto: t.kind !== null,
  });

  const open = openRows.map(toItem);
  const overdue = open.filter((t) => t.overdue);
  const upcoming = open.filter((t) => !t.overdue);
  const done = doneRows.map(toItem);

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-text-1">Tasks</h1>
          <p className="text-sm text-text-2">
            {openCount} open{overdueCount > 0 ? ` · ${overdueCount} overdue` : ""}
          </p>
        </div>
        {/* Exports all of my tasks (open + done), not just this page. */}
        <Button asChild variant="outline" size="sm">
          <a href="/tasks/export" download>
            <Download className="size-4" /> Export CSV
          </a>
        </Button>
      </div>

      <QuickAddTask />

      <TaskSection
        title="Overdue"
        items={overdue}
        emptyText={page > 1 ? "None on this page." : "Nothing overdue."}
      />
      <TaskSection
        title="Upcoming"
        items={upcoming}
        emptyText={page > 1 ? "None on this page." : "No open tasks."}
      />

      <Pager
        page={page}
        pageCount={pageCount}
        total={openCount}
        searchParams={sp}
        label="open tasks"
      />

      <TaskSection title="Recently done" items={done} emptyText="Nothing completed yet." />
    </div>
  );
}
