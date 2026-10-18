import {
  QuickAddTask,
  TaskSection,
  type TaskItem,
} from "@/components/features/tasks/task-list";
import { Pager } from "@/components/features/shared/pager";
import { StrandedTasks } from "@/components/features/tasks/stranded-tasks";
import { TaskFilters } from "@/components/features/tasks/task-filters";
import { fetchStrandedTasks } from "@/lib/queries/stranded-tasks";
import {
  TASK_DUE_LABELS,
  applyTaskDue,
  applyTaskScope,
  parseTaskListFilters,
  taskListQuery,
} from "@/lib/queries/tasks-list";
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
import { TASK_STAFF_ROLES, taskRights, type TaskAssignee } from "@/lib/validators/tasks";
import { ExportCsvButton } from "@/components/features/shared/export-csv-button";

export const dynamic = "force-dynamic";

/** What a row needs: the task, its links (taskTarget), who created and who holds it. */
const TASK_COLUMNS =
  `id, title, due_at, is_done, assignee_id, created_by, ${TASK_LINK_COLUMNS}, assignee:profiles!assignee_id(full_name, is_active)` as const;

const SCOPE_HEADINGS = {
  mine: "My tasks",
  delegated: "Tasks I gave to others",
  team: "Everyone's tasks",
} as const;

/**
 * Tasks (T5.5, doc 05 📱). Every row here is a real `tasks` row: added by a
 * person, or system-generated (`kind` set) by the nightly cron —
 * `expire_mandates` for renewals, `create_followup_nudges` for the B7
 * follow-up rules — and their successors.
 *
 * A02: the page has views — Mine (the default, and all it used to show),
 * Delegated (tasks I created for someone else), Team (admins: the whole
 * organisation) — and due filters, all in the URL (lib/queries/tasks-list.ts),
 * and the CSV export reads the same view. A row offers only what its viewer may
 * do (`taskRights`): the tick and the edit belong to whoever holds the task and
 * to admins.
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
  const isAdmin = profile.role === "admin";
  const filters = parseTaskListFilters(sp, isAdmin);
  const now = new Date(); // per-request clock for the overdue boundary and the due windows

  // the open tasks of this view — scope, then the due window when one is chosen
  const openTasks = <S extends string>(columns: S, options?: { count: "exact"; head?: boolean }) => {
    const scoped = applyTaskScope(supabase.from("tasks").select(columns, options), filters.scope, profile.id);
    return filters.due ? applyTaskDue(scoped, filters.due, now) : scoped.eq("is_done", false);
  };

  const [
    // SQL: select … from tasks where <scope> and is_done = false [and <due window>]
    //      order by due_at nulls last, id offset … limit 25;
    openRes,
    // SQL: select … from tasks where <scope> and is_done = true order by done_at desc, id limit 10;
    // (not read under a due filter: those are about work still to do)
    doneRes,
    // exact overdue count of the same open set — the header must describe the
    // whole view, not whichever slice this page happens to hold (PERF-2)
    overdueRes,
    // who a task can be given to: active staff, by name
    assigneesRes,
  ] = await Promise.all([
    openTasks(TASK_COLUMNS, { count: "exact" })
      .order("due_at", { ascending: true, nullsFirst: false })
      // `id` breaks due_at ties — and ties are the norm here: every all-day
      // task is a Cyprus 23:59 stamp and every undated task is null. Without a
      // unique last key each offset page may order tied tasks differently,
      // repeating some and skipping others. Same order as the CSV export.
      // T-list-page-order
      .order("id")
      // Paged over the WHOLE open set, ordered by due date — so the most
      // overdue work is always on page 1 and the Overdue/Upcoming split below
      // stays meaningful (audit 2026-07-22, PERF-2).
      .range(pageRange(page).from, pageRange(page).to),
    filters.due
      ? null
      : applyTaskScope(supabase.from("tasks").select(TASK_COLUMNS), filters.scope, profile.id)
          .eq("is_done", true)
          .order("done_at", { ascending: false })
          .order("id")
          .limit(10),
    openTasks("id", { count: "exact", head: true }).lt("due_at", now.toISOString()),
    supabase
      .from("profiles")
      .select("id, full_name")
      .eq("is_active", true)
      .in("role", [...TASK_STAFF_ROLES])
      .order("full_name")
      .order("id"),
  ]);
  // failed queries throw to the error boundary — "0 open" must mean empty,
  // not broken (dashboard audit convention, lib/supabase/unwrap.ts) — except a
  // stale ?page= past the end, which is an empty page not a fault. PostgREST
  // answers that one (416) with no count, so the total is asked for again
  // rather than painted as zero.
  const beyondEnd = isRangeBeyondEnd(openRes.error);
  const openRows = unwrapRows(beyondEnd ? { data: [], error: null } : openRes, "open tasks");
  const openCount = unwrapCount(
    beyondEnd ? await openTasks("id", { count: "exact", head: true }) : openRes,
    "open tasks",
  );
  const doneRows = doneRes ? unwrapRows(doneRes, "done tasks") : [];
  // a count that could not be read is the page's failure, never "0 overdue"
  const overdueCount = unwrapCount(overdueRes, "overdue tasks");
  const pageCount = countPages(openCount);
  const assignees: TaskAssignee[] = unwrapRows(assigneesRes, "colleagues").map((p) => ({
    id: p.id,
    fullName: p.full_name,
  }));

  // at most one page of open tasks plus ten done ones: short `.in()` lists
  const propertyIds = [
    ...new Set(
      [...openRows, ...doneRows].map((t) => t.property_id).filter((v): v is string => Boolean(v)),
    ),
  ];
  const props = propertyIds.length
    ? unwrapRows(
        await supabase.from("properties").select("id, reference").in("id", propertyIds),
        "task properties",
      )
    : [];
  const refById = new Map(props.map((p) => [p.id, p.reference]));

  // WF-5: contact-linked tasks used to render with no link at all
  const contactIds = [
    ...new Set(
      [...openRows, ...doneRows].map((t) => t.contact_id).filter((v): v is string => Boolean(v)),
    ),
  ];
  const contactRows = contactIds.length
    ? unwrapRows(
        await supabase.from("contacts").select("id, display_name").in("id", contactIds),
        "task contacts",
      )
    : [];
  const contactById = new Map(contactRows.map((c) => [c.id, c.display_name]));

  const ownerLabel = (t: (typeof openRows)[number]): string | null => {
    if (filters.scope === "mine") return null;
    if (t.assignee_id === null) return "Unassigned";
    if (t.assignee_id === profile.id) return "For you";
    const holder = t.assignee;
    if (!holder) return "For a colleague";
    return holder.is_active ? `For ${holder.full_name}` : `For ${holder.full_name} (deactivated)`;
  };

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
    const holder = t.assignee;
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
      assigneeId: t.assignee_id,
      assigneeName: holder?.full_name ?? null,
      ownerLabel: ownerLabel(t),
      rights: taskRights(t, profile),
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
  const stranded = isAdmin ? await fetchStrandedTasks(supabase, profile.orgId) : [];

  const pageEmpty = page > 1 ? "None on this page." : null;

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-text-1">Tasks</h1>
          <p className="text-sm text-text-2">
            {SCOPE_HEADINGS[filters.scope]}
            {filters.due ? ` · ${TASK_DUE_LABELS[filters.due].toLowerCase()}` : ""} · {openCount} open
            {overdueCount > 0 ? ` · ${overdueCount} overdue` : ""}
          </p>
        </div>
        {/* Exports this view — every task in it, open and done (open only
            under a due filter), not just this page. */}
        <ExportCsvButton href={`/tasks/export${taskListQuery(filters)}`} size="sm" />
      </div>

      <TaskFilters filters={filters} isAdmin={isAdmin} />

      <QuickAddTask assignees={assignees} meId={profile.id} />

      {isAdmin ? <StrandedTasks tasks={stranded} users={assignees} /> : null}

      {filters.due ? (
        <TaskSection
          title={TASK_DUE_LABELS[filters.due]}
          items={open}
          emptyText={pageEmpty ?? "No open tasks in this view."}
          assignees={assignees}
          meId={profile.id}
        />
      ) : (
        <>
          <TaskSection
            title="Overdue"
            items={overdue}
            emptyText={pageEmpty ?? "Nothing overdue."}
            assignees={assignees}
            meId={profile.id}
          />
          <TaskSection
            title="Upcoming"
            items={upcoming}
            emptyText={pageEmpty ?? "No open tasks."}
            assignees={assignees}
            meId={profile.id}
          />
        </>
      )}

      <Pager
        page={page}
        pageCount={pageCount}
        total={openCount}
        searchParams={sp}
        label="open tasks"
      />

      {filters.due ? null : (
        <TaskSection
          title="Recently done"
          items={done}
          emptyText="Nothing completed yet."
          assignees={assignees}
          meId={profile.id}
        />
      )}
    </div>
  );
}
