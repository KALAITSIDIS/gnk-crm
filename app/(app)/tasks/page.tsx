import Link from "next/link";
import { MessageSquareWarning } from "lucide-react";
import {
  QuickAddTask,
  TaskSection,
  type TaskItem,
} from "@/components/features/tasks/task-list";
import { getCurrentProfile } from "@/lib/services/auth";
import { createClient } from "@/lib/supabase/server";
import { unwrapRows } from "@/lib/supabase/unwrap";
import { formatDateTime } from "@/lib/utils/format";

export const dynamic = "force-dynamic";

/**
 * My tasks (T5.5, doc 05 📱). Real task rows (quick-added + auto-generated
 * mandate renewals from expire_mandates) plus the feedback nudge as a virtual
 * section — completed viewings without feedback are a live QUERY, not task
 * rows, so they can never drift out of sync with the viewings themselves
 * (same source the agent dashboard uses).
 */
export default async function TasksPage() {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  const now = new Date(); // per-request clock for the overdue boundary

  const [
    // SQL: select * from tasks where assignee_id = :me and is_done = false order by due_at nulls last;
    openRes,
    // SQL: select * from tasks where assignee_id = :me and is_done = true order by done_at desc limit 10;
    doneRes,
    // SQL: select id, scheduled_at from viewings where agent_id = :me and status='completed'
    //      and feedback is null order by scheduled_at desc limit 10;
    needFeedbackRes,
  ] = await Promise.all([
    supabase
      .from("tasks")
      .select("id, title, due_at, is_done, property_id, mandate_id", { count: "exact" })
      .eq("assignee_id", profile.id)
      .eq("is_done", false)
      .order("due_at", { ascending: true, nullsFirst: false })
      .limit(200),
    supabase
      .from("tasks")
      .select("id, title, due_at, is_done, property_id, mandate_id")
      .eq("assignee_id", profile.id)
      .eq("is_done", true)
      .order("done_at", { ascending: false })
      .limit(10),
    supabase
      .from("viewings")
      .select("id, scheduled_at, properties(reference)", { count: "exact" })
      .eq("agent_id", profile.id)
      .eq("status", "completed")
      .is("feedback", null)
      .order("scheduled_at", { ascending: false })
      .limit(10),
  ]);
  // failed queries throw to the error boundary — "0 open" must mean empty,
  // not broken (dashboard audit convention, lib/supabase/unwrap.ts)
  const openRows = unwrapRows(openRes, "open tasks");
  const doneRows = unwrapRows(doneRes, "done tasks");
  const needFeedback = unwrapRows(needFeedbackRes, "viewings awaiting feedback");
  const openCount = openRes.count ?? openRows.length;
  const needFeedbackCount = needFeedbackRes.count ?? needFeedback.length;

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
    isAuto: t.mandate_id !== null,
  });

  const open = openRows.map(toItem);
  const overdue = open.filter((t) => t.overdue);
  const upcoming = open.filter((t) => !t.overdue);
  const done = doneRows.map(toItem);

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-text-1">Tasks</h1>
        <p className="text-sm text-text-2">
          {openCount} open{overdue.length > 0 ? ` · ${overdue.length} overdue` : ""}
        </p>
      </div>

      <QuickAddTask />

      <TaskSection title="Overdue" items={overdue} emptyText="Nothing overdue." />
      <TaskSection title="Upcoming" items={upcoming} emptyText="No open tasks." />

      {needFeedback.length > 0 ? (
        <section className="rounded-[10px] border border-warning/40 bg-warning/5 p-4">
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-text-1">
            <MessageSquareWarning className="size-4 text-warning" />
            Viewings awaiting feedback
            <span className="ml-auto rounded-full bg-surface-2 px-2 py-0.5 text-xs tabular-nums text-text-2">
              {needFeedbackCount}
            </span>
          </h2>
          <ul className="flex flex-col divide-y divide-border/60">
            {needFeedback.map((v) => (
              <li key={v.id}>
                <Link
                  href={`/viewings/${v.id}`}
                  className="flex min-h-11 items-baseline justify-between gap-3 py-2 text-sm hover:text-brand-700"
                >
                  <span className="font-mono text-xs text-text-2">
                    {(v.properties as { reference: string } | null)?.reference ?? "—"}
                  </span>
                  <span className="tabular-nums text-xs text-text-3">
                    {formatDateTime(v.scheduled_at)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <TaskSection title="Recently done" items={done} emptyText="Nothing completed yet." />
    </div>
  );
}
