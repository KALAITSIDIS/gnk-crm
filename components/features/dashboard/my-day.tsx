import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { CalendarDays, Inbox, ListTodo } from "lucide-react";
import { Card, CardEmpty } from "@/components/features/dashboard/card";
import { HotIdleCard } from "@/components/features/dashboard/hot-idle-card";
import { LeadRowList, type DashboardLeadRow } from "@/components/features/dashboard/lead-row-list";
import { TaskRowList, kindLabel } from "@/components/features/dashboard/task-row-list";
import { TASK_LINK_COLUMNS, taskTarget } from "@/lib/services/task-target";
import { createClient } from "@/lib/supabase/server";
import { unwrapCount, unwrapRows } from "@/lib/supabase/unwrap";
import { LEAD_OPEN_STATUSES } from "@/lib/validators/contacts";
import { zonedParts, zonedWallClockToUtc } from "@/lib/utils/tz";
import { cn } from "@/lib/utils";

/**
 * My day (A01; was the body of the agent dashboard, T5.3 / doc 05 📱 — usable
 * at 380px). The SAME cards for whoever is signed in: the agent dashboard
 * renders them under its quick actions, the admin dashboard under a "My day"
 * heading. Production's only users are admins, who until A01 never saw their
 * own viewings, tasks or leads on the screen they open first.
 *
 * Fixed per role (guardrail 6, DECISIONS:5203 refuses dashboard filters): no
 * personal/team toggle — the admin's team view is a separate section of fixed
 * cards (team-cards.tsx), not a mode of this one.
 *
 * Every number is reproducible by the SQL above its query; `me` is the
 * signed-in profile id and every query is additionally org-scoped by RLS.
 * Badges are exact counts (`count: "exact"` through unwrapCount — a count that
 * could not be read is the page's failure, never a zero or the list length).
 *
 * The reminders here are the existing task rows the sweeps mint (lead SLA,
 * viewing feedback, holds, instalments, mandates…), labelled by kind — no live
 * query duplicates them (B7 retired the last one).
 */

const VIEWING_TONES: Record<string, string> = {
  scheduled: "bg-brand-100 text-brand-700",
  completed: "bg-success/10 text-success",
  cancelled: "bg-surface-2 text-text-3",
  no_show: "bg-danger/10 text-danger",
};

/** Rows per card: enough to act on, few enough for a phone. */
const LEAD_ROWS = 8;

export async function MyDay({
  profileId,
  level = 2,
  className,
}: {
  profileId: string;
  /** 3 under the admin dashboard's "My day" heading */
  level?: 2 | 3;
  className?: string;
}) {
  const t = await getTranslations("dashboard.myDay");
  const tKind = await getTranslations("dashboard.myDay.kind");
  const supabase = await createClient();

  const now = new Date(); // per-request clock anchors today's windows
  const todayKey = zonedParts(now).dayKey; // Cyprus calendar day
  const dayStart = zonedWallClockToUtc(`${todayKey}T00:00`).toISOString();
  // next Cyprus midnight via the next day KEY (not +24h — DST days are 23/25h)
  const nextDayKey = new Date(new Date(`${todayKey}T00:00:00Z`).getTime() + 86_400_000)
    .toISOString()
    .slice(0, 10);
  const dayEnd = zonedWallClockToUtc(`${nextDayKey}T00:00`).toISOString();

  const leadColumns = "id, received_at, first_response_at, source, message, contact_id, contacts(display_name)";

  const [
    // SQL: select * from viewings where agent_id = :me
    //      and scheduled_at >= :cyprus_day_start and scheduled_at < :cyprus_day_end
    //      order by scheduled_at;
    todaysViewingsRes,
    // SQL: select * from tasks where assignee_id = :me and is_done = false
    //      and due_at < :cyprus_day_end order by due_at, id limit 10;  (badge = exact count)
    //
    // Due-today, not just overdue (B7). Every nudge is stamped Cyprus 23:59 of
    // the day it fires, so an "overdue only" card would not show today's work
    // until tonight — on the screen an agent runs their day from.
    dueTasksRes,
    // Open = LEAD_OPEN_STATUSES (new, contacted, qualified — 'qualified' was
    // missing until A01). Unanswered FIRST, as two reads, because "nulls first,
    // then newest" is not one PostgREST order:
    // SQL: select * from leads where assigned_agent_id = :me and status in (:open)
    //      and first_response_at is null order by received_at desc, id desc limit 8;
    unansweredRes,
    // SQL: … and first_response_at is not null order by received_at desc, id desc limit 8;
    answeredRes,
  ] = await Promise.all([
    supabase
      .from("viewings")
      .select(
        "id, scheduled_at, duration_min, status, properties(reference), contacts(display_name)",
      )
      .eq("agent_id", profileId)
      .gte("scheduled_at", dayStart)
      .lt("scheduled_at", dayEnd)
      .order("scheduled_at", { ascending: true }),
    supabase
      .from("tasks")
      .select(`id, title, due_at, ${TASK_LINK_COLUMNS}`, { count: "exact" })
      .eq("assignee_id", profileId)
      .eq("is_done", false)
      .lt("due_at", dayEnd)
      .order("due_at", { ascending: true })
      .order("id")
      .limit(10),
    supabase
      .from("leads")
      .select(leadColumns, { count: "exact" })
      .eq("assigned_agent_id", profileId)
      .in("status", [...LEAD_OPEN_STATUSES])
      .is("first_response_at", null)
      .order("received_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(LEAD_ROWS),
    supabase
      .from("leads")
      .select(leadColumns, { count: "exact" })
      .eq("assigned_agent_id", profileId)
      .in("status", [...LEAD_OPEN_STATUSES])
      .not("first_response_at", "is", null)
      .order("received_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(LEAD_ROWS),
  ]);

  const todaysViewings = unwrapRows(todaysViewingsRes, "today's viewings");
  const dueTasks = unwrapRows(dueTasksRes, "tasks due today");
  const dueCount = unwrapCount(dueTasksRes, "tasks due today");
  const unanswered = unwrapRows(unansweredRes, "my unanswered leads");
  const unansweredCount = unwrapCount(unansweredRes, "my unanswered leads");
  const answered = unwrapRows(answeredRes, "my answered leads");
  const answeredCount = unwrapCount(answeredRes, "my answered leads");

  const leadRows = ([...unanswered, ...answered] as unknown as DashboardLeadRow[]).slice(0, LEAD_ROWS);
  const taskRows = dueTasks.map((task) => ({
    id: task.id,
    title: task.title,
    dueAt: task.due_at,
    href: taskTarget(task).href,
    kindLabel: kindLabel(tKind, task.kind),
  }));

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <Card
        title={t("cards.todaysViewings")}
        icon={<CalendarDays className="size-4 text-brand-700" />}
        count={todaysViewings.length}
        level={level}
      >
        {todaysViewings.length === 0 ? (
          <CardEmpty
            text={t("empty.noViewings")}
            href="/viewings"
            action={t("actions.scheduleViewing")}
          />
        ) : (
          <ul className="flex flex-col divide-y divide-border/60">
            {todaysViewings.map((v) => (
              <li key={v.id}>
                <Link
                  href={`/viewings/${v.id}`}
                  className="flex min-h-11 items-center gap-3 py-2 text-sm hover:text-brand-700"
                >
                  <span className="font-semibold tabular-nums text-text-1">
                    {zonedParts(v.scheduled_at).timeLabel}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-xs text-text-2">
                      {(v.properties as { reference: string } | null)?.reference ?? "—"}
                    </span>
                    <span className="block truncate text-text-2">
                      {(v.contacts as { display_name: string | null } | null)?.display_name ?? "—"}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium capitalize",
                      VIEWING_TONES[v.status] ?? "bg-surface-2 text-text-3",
                    )}
                  >
                    {v.status.replace("_", " ")}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title={t("cards.tasksDue")}
        icon={<ListTodo className="size-4 text-warning" />}
        count={dueCount}
        level={level}
      >
        {taskRows.length === 0 ? (
          <CardEmpty text={t("empty.noTasksDue")} href="/tasks" action={t("actions.allTasks")} />
        ) : (
          <TaskRowList rows={taskRows} now={now} />
        )}
      </Card>

      <Card
        title={t("cards.myLeads")}
        icon={<Inbox className="size-4 text-brand-700" />}
        count={unansweredCount + answeredCount}
        level={level}
      >
        {leadRows.length === 0 ? (
          <CardEmpty text={t("empty.noLeads")} href="/leads" action={t("actions.leadInbox")} />
        ) : (
          <>
            {unansweredCount > 0 ? (
              <p className="mb-1 text-xs font-medium text-danger">
                {t("unanswered", { count: unansweredCount })}
              </p>
            ) : null}
            <LeadRowList rows={leadRows} />
          </>
        )}
      </Card>

      <HotIdleCard profileId={profileId} level={level} />
    </div>
  );
}
