import {
  QuickAddTask,
  TaskSection,
  type TaskItem,
} from "@/components/features/tasks/task-list";
import { Pager } from "@/components/features/shared/pager";
import { StrandedTasks } from "@/components/features/tasks/stranded-tasks";
import { fetchStrandedTasks } from "@/lib/queries/stranded-tasks";
import { getCurrentProfile } from "@/lib/services/auth";
import { TASK_LINK_COLUMNS, taskTarget } from "@/lib/services/task-target";
import { createClient } from "@/lib/supabase/server";
import { unwrapCount, unwrapRows } from "@/lib/supabase/unwrap";
import {
  isRangeBeyondEnd,
  pageRange,
  pageSchema,
  totalPages as countPages,
} from "@/lib/validators/pagination";
import { ExportCsvButton } from "@/components/features/shared/export-csv-button";

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
      .select(`id, title, due_at, is_done, ${TASK_LINK_COLUMNS}`, {
        count: "exact",
      })
      .eq("assignee_id", profile.id)
      .eq("is_done", false)
      .order("due_at", { ascending: true, nullsFirst: false })
      // `id` breaks due_at ties — and ties are the norm here: every due date is
      // a Cyprus 23:59 stamp and every undated task is null. Without a unique
      // last key each offset page may order tied tasks differently, repeating
      // some and skipping others. Same order as the CSV export. (A task added
      // or done between two page loads still shifts the pages — each is its
      // own request.) T-list-page-order
      .order("id")
      // Paged over the WHOLE open set, ordered by due date — so the most
      // overdue work is always on page 1 and the Overdue/Upcoming split below
      // stays meaningful (audit 2026-07-22, PERF-2; was a flat .limit(200)).
      .range(pageRange(page).from, pageRange(page).to),
    supabase
      .from("tasks")
      .select(`id, title, due_at, is_done, ${TASK_LINK_COLUMNS}`)
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
  // a count that could not be read is the page's failure, never "0 overdue"
  const overdueCount = unwrapCount(overdueRes, "overdue tasks");
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

  // WF-5: contact-linked tasks used to render with no link at all
  const contactIds = [
    ...new Set(
      [...openRows, ...doneRows].map((t) => t.contact_id).filter((v): v is string => Boolean(v)),
    ),
  ];
  const { data: contactRows } = contactIds.length
    ? await supabase.from("contacts").select("id, display_name").in("id", contactIds)
    : { data: [] };
  const contactById = new Map((contactRows ?? []).map((c) => [c.id, c.display_name]));

  const toItem = (t: (typeof openRows)[number]): TaskItem => {
    // A nudge links to the page where the thing it nags about is done — the
    // SAME rule the dashboard uses (lib/services/task-target.ts, A01): the
    // viewing for feedback, the deal for no-contact, the property's own tab for
    // a hold, an instalment, a mandate or a buyer match, the inbox for an
    // unanswered lead.
    const target = taskTarget(t);
    const propertyRef = t.property_id ? (refById.get(t.property_id) ?? null) : null;
    // when the target IS the property, its reference chip carries the link
    // (opening the right tab) rather than a second link to the same page
    const onChip = target.type === "property" && propertyRef !== null;
    return {
      id: t.id,
      title: t.title,
      dueAt: t.due_at,
      isDone: t.is_done,
      overdue: Boolean(t.due_at && new Date(t.due_at).getTime() < now.getTime()),
      propertyId: t.property_id,
      propertyRef,
      propertyHref: onChip ? target.href : null,
      href: target.type === "tasks" || onChip ? null : target.href,
      hrefLabel:
        target.type === "viewing"
          ? "Viewing"
          : target.type === "deal"
            ? "Deal"
            : target.type === "contact"
              ? ((t.contact_id ? contactById.get(t.contact_id) : null) ?? "Contact")
              : target.type === "leads"
                ? "Lead inbox"
                : target.type === "property"
                  ? "Property"
                  : null,
      isAuto: t.kind !== null,
    };
  };

  const open = openRows.map(toItem);
  const overdue = open.filter((t) => t.overdue);
  const upcoming = open.filter((t) => !t.overdue);
  const done = doneRows.map(toItem);

  // Admin-only, and org-wide rather than assignee-scoped: these are precisely
  // the rows every other query on this page filters out (BACKLOG T-audit-tasks).
  // Only fetched for admins — an agent's page must not pay for a query whose
  // rows RLS would withhold anyway.
  const isAdmin = profile.role === "admin";
  const [stranded, activeUsers] = isAdmin
    ? await Promise.all([
        fetchStrandedTasks(supabase, profile.orgId),
        supabase
          .from("profiles")
          .select("id, full_name")
          .eq("org_id", profile.orgId)
          .eq("is_active", true)
          .order("full_name"),
      ])
    : [[], { data: [] as { id: string; full_name: string }[] }];
  const users = (activeUsers.data ?? []).map((u) => ({ id: u.id, fullName: u.full_name }));

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
        <ExportCsvButton href="/tasks/export" size="sm" />
      </div>

      <QuickAddTask />

      {isAdmin ? <StrandedTasks tasks={stranded} users={users} /> : null}

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
