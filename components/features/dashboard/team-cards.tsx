import { getTranslations } from "next-intl/server";
import { AlarmClock, UserX } from "lucide-react";
import { Card, CardEmpty } from "@/components/features/dashboard/card";
import { LeadRowList, type DashboardLeadRow } from "@/components/features/dashboard/lead-row-list";
import { TaskRowList, kindLabel } from "@/components/features/dashboard/task-row-list";
import { TASK_LINK_COLUMNS, taskTarget } from "@/lib/services/task-target";
import { createClient } from "@/lib/supabase/server";
import { unwrapCount, unwrapRows } from "@/lib/supabase/unwrap";
import { LEAD_OPEN_STATUSES } from "@/lib/validators/contacts";
import { cn } from "@/lib/utils";

/**
 * Team (A01; BACKLOG "Admin visibility into org-wide overdue tasks and
 * unassigned leads"). ADMIN dashboard only, two fixed cards — not a mode of My
 * day (guardrail 6). Rendered only in the admin branch of the dashboard page:
 * `tasks_select` shows an admin every task of the organisation and an agent
 * only their own or ones they created, so an agent's version of the overdue
 * card would be a different, misleading number.
 *
 *  - Unassigned open leads: nobody's inbox holds them. The routing rules
 *    normally assign on arrival; what lands here is what they could not place.
 *  - Overdue across the team: everyone else's overdue work, unassigned tasks
 *    included (those are the ones nobody will see otherwise — /tasks lists them
 *    as "stranded"). The admin's own overdue tasks are already under My day.
 *
 * Exact counts on both badges (unwrapCount); rows link to their records.
 */
export async function TeamCards({
  profileId,
  level = 2,
  className,
}: {
  profileId: string;
  level?: 2 | 3;
  className?: string;
}) {
  const t = await getTranslations("dashboard.team");
  const tKind = await getTranslations("dashboard.myDay.kind");
  const supabase = await createClient();
  const now = new Date();

  const [
    // SQL: select * from leads where assigned_agent_id is null
    //      and status in ('new','contacted','qualified')
    //      order by received_at, id limit 8;  (badge = exact count; oldest first —
    //      the longest without an owner)
    unassignedRes,
    // SQL: select t.*, p.full_name from tasks t left join profiles p on p.id = t.assignee_id
    //      where t.is_done = false and t.due_at < now()
    //      and (t.assignee_id is null or t.assignee_id <> :me)
    //      order by t.due_at, t.id limit 10;  (badge = exact count)
    overdueRes,
  ] = await Promise.all([
    supabase
      .from("leads")
      .select("id, received_at, first_response_at, source, message, contact_id, contacts(display_name)", {
        count: "exact",
      })
      .is("assigned_agent_id", null)
      .in("status", [...LEAD_OPEN_STATUSES])
      .order("received_at", { ascending: true })
      .order("id")
      .limit(8),
    supabase
      .from("tasks")
      .select(`id, title, due_at, assignee_id, ${TASK_LINK_COLUMNS}, assignee:profiles!assignee_id(full_name)`, {
        count: "exact",
      })
      .eq("is_done", false)
      .lt("due_at", now.toISOString())
      // `<>` alone drops the NULL-assignee rows — the very ones nobody sees
      .or(`assignee_id.is.null,assignee_id.neq.${profileId}`)
      .order("due_at", { ascending: true })
      .order("id")
      .limit(10),
  ]);

  const unassigned = unwrapRows(unassignedRes, "unassigned open leads") as unknown as DashboardLeadRow[];
  const unassignedCount = unwrapCount(unassignedRes, "unassigned open leads");
  const overdue = unwrapRows(overdueRes, "team overdue tasks");
  const overdueCount = unwrapCount(overdueRes, "team overdue tasks");

  const overdueRows = overdue.map((task) => {
    const assignee = task.assignee as { full_name: string | null } | null;
    return {
      id: task.id,
      title: task.title,
      dueAt: task.due_at,
      href: taskTarget(task).href,
      kindLabel: kindLabel(tKind, task.kind),
      owner: task.assignee_id ? (assignee?.full_name ?? t("unknownUser")) : t("unassigned"),
    };
  });

  return (
    <div className={cn("grid gap-4 lg:grid-cols-2", className)}>
      <Card
        title={t("cards.unassignedLeads")}
        icon={<UserX className="size-4 text-warning" />}
        count={unassignedCount}
        level={level}
      >
        {unassigned.length === 0 ? (
          <CardEmpty text={t("empty.noUnassigned")} />
        ) : (
          <LeadRowList rows={unassigned} />
        )}
      </Card>
      <Card
        title={t("cards.overdue")}
        icon={<AlarmClock className="size-4 text-danger" />}
        count={overdueCount}
        level={level}
      >
        {overdueRows.length === 0 ? (
          <CardEmpty text={t("empty.noOverdue")} />
        ) : (
          <TaskRowList rows={overdueRows} now={now} />
        )}
      </Card>
    </div>
  );
}
