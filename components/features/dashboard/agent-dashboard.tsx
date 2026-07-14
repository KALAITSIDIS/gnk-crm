import Link from "next/link";
import {
  CalendarDays,
  CalendarPlus,
  Calculator,
  Flame,
  Inbox,
  ListTodo,
  MessageSquareWarning,
  UserPlus,
} from "lucide-react";
import { ResponseClock } from "@/components/features/shared/response-clock";
import { createClient } from "@/lib/supabase/server";
import { formatDate, formatDateTime } from "@/lib/utils/format";
import { zonedParts, zonedWallClockToUtc } from "@/lib/utils/tz";
import { cn } from "@/lib/utils";

/**
 * Agent dashboard (T5.3, doc 05 — mobile-first 📱, usable at 380px). Every
 * number is reproducible by the SQL documented above its query; `me` is the
 * signed-in profile id and all queries are additionally org-scoped by RLS.
 * Listing managers see this dashboard too (DECISIONS 2026-07-13 · T5.3).
 */

function Card({
  title,
  icon,
  count,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[10px] border border-border bg-surface p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-1">
        {icon}
        {title}
        {count !== undefined ? (
          <span className="ml-auto rounded-full bg-surface-2 px-2 py-0.5 text-xs tabular-nums text-text-2">
            {count}
          </span>
        ) : null}
      </h2>
      {children}
    </section>
  );
}

const VIEWING_TONES: Record<string, string> = {
  scheduled: "bg-brand-100 text-brand-700",
  completed: "bg-success/10 text-success",
  cancelled: "bg-surface-2 text-text-3",
  no_show: "bg-danger/10 text-danger",
};

export async function AgentDashboard({ profileId }: { profileId: string }) {
  const supabase = await createClient();

  const now = new Date(); // per-request clock anchors today's windows
  const todayKey = zonedParts(now).dayKey; // Cyprus calendar day
  const dayStart = zonedWallClockToUtc(`${todayKey}T00:00`).toISOString();
  const dayEnd = new Date(
    zonedWallClockToUtc(`${todayKey}T00:00`).getTime() + 86_400_000,
  ).toISOString();

  const [
    // SQL: select * from viewings where agent_id = :me
    //      and scheduled_at >= :cyprus_day_start and scheduled_at < :cyprus_day_end
    //      order by scheduled_at;
    { data: todaysViewings },
    // SQL: select * from tasks where assignee_id = :me and is_done = false
    //      and due_at < now() order by due_at limit 10;
    { data: overdueTasks },
    // SQL: select * from leads where assigned_agent_id = :me
    //      and status in ('new','contacted') order by received_at desc limit 8;
    { data: myLeads },
    // SQL: select id, display_name from contacts where assigned_agent_id = :me
    //      and temperature = 'hot' and is_archived = false;
    { data: hotContacts },
    // SQL: select id, scheduled_at from viewings where agent_id = :me
    //      and status = 'completed' and feedback is null
    //      order by scheduled_at desc limit 8;  (T4.3 nudge)
    { data: needFeedback },
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
      .select("id, title, due_at")
      .eq("assignee_id", profileId)
      .eq("is_done", false)
      .lt("due_at", now.toISOString())
      .order("due_at", { ascending: true })
      .limit(10),
    supabase
      .from("leads")
      .select("id, received_at, first_response_at, source, message, contacts(display_name)")
      .eq("assigned_agent_id", profileId)
      .in("status", ["new", "contacted"])
      .order("received_at", { ascending: false })
      .limit(8),
    supabase
      .from("contacts")
      .select("id, display_name")
      .eq("assigned_agent_id", profileId)
      .eq("temperature", "hot")
      .eq("is_archived", false)
      .limit(50),
    supabase
      .from("viewings")
      .select("id, scheduled_at, properties(reference)")
      .eq("agent_id", profileId)
      .eq("status", "completed")
      .is("feedback", null)
      .order("scheduled_at", { ascending: false })
      .limit(8),
  ]);

  // Hot buyers idle ≥3 days: latest contact-scoped event per hot contact;
  // SQL: select entity_id, max(occurred_at) from events where entity_type='contact'
  //      and entity_id in (:hot_ids) group by entity_id;
  //      idle = no event or max(occurred_at) < now() - interval '3 days'
  const hotIds = (hotContacts ?? []).map((c) => c.id);
  const { data: hotEvents } = hotIds.length
    ? await supabase
        .from("events")
        .select("entity_id, occurred_at")
        .eq("entity_type", "contact")
        .in("entity_id", hotIds)
        .order("occurred_at", { ascending: false })
        .limit(500)
    : { data: [] };
  const lastTouch = new Map<string, string>();
  for (const e of hotEvents ?? []) {
    if (e.entity_id && !lastTouch.has(e.entity_id)) lastTouch.set(e.entity_id, e.occurred_at);
  }
  const idleCutoff = now.getTime() - 3 * 86_400_000;
  const idleHot = (hotContacts ?? [])
    .map((c) => {
      const last = lastTouch.get(c.id);
      const idleDays = last
        ? Math.floor((now.getTime() - new Date(last).getTime()) / 86_400_000)
        : null;
      return { ...c, idleDays, lastMs: last ? new Date(last).getTime() : 0 };
    })
    .filter((c) => c.lastMs < idleCutoff)
    .sort((a, b) => a.lastMs - b.lastMs)
    .slice(0, 8);

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
      {/* quick actions — thumb-sized targets at 380px */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { href: "/leads", label: "Add lead", icon: <UserPlus className="size-4" /> },
          { href: "/viewings", label: "Viewings", icon: <CalendarPlus className="size-4" /> },
          { href: "/contacts", label: "Contacts", icon: <Inbox className="size-4" /> },
          { href: "/calculators", label: "Calculators", icon: <Calculator className="size-4" /> },
        ].map((a) => (
          <Link
            key={a.href}
            href={a.href}
            className="flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-border bg-surface px-3 text-sm font-medium text-text-1 hover:border-brand-300"
          >
            {a.icon}
            {a.label}
          </Link>
        ))}
      </div>

      <Card
        title="Today's viewings"
        icon={<CalendarDays className="size-4 text-brand-700" />}
        count={(todaysViewings ?? []).length}
      >
        {(todaysViewings ?? []).length === 0 ? (
          <p className="text-sm text-text-3">Nothing scheduled today.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border/60">
            {(todaysViewings ?? []).map((v) => (
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
        title="Overdue tasks"
        icon={<ListTodo className="size-4 text-warning" />}
        count={(overdueTasks ?? []).length}
      >
        {(overdueTasks ?? []).length === 0 ? (
          <p className="text-sm text-text-3">Nothing overdue.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border/60 text-sm">
            {(overdueTasks ?? []).map((t) => (
              <li key={t.id} className="flex items-baseline justify-between gap-3 py-2">
                <span className="min-w-0 truncate text-text-1">{t.title}</span>
                <span className="shrink-0 tabular-nums text-xs text-danger">
                  {formatDate(t.due_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="My new leads"
        icon={<Inbox className="size-4 text-brand-700" />}
        count={(myLeads ?? []).length}
      >
        {(myLeads ?? []).length === 0 ? (
          <p className="text-sm text-text-3">No open leads assigned to you.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border/60 text-sm">
            {(myLeads ?? []).map((l) => (
              <li key={l.id} className="flex items-center justify-between gap-3 py-2">
                <Link href="/leads" className="min-w-0 flex-1 truncate text-text-1 hover:text-brand-700">
                  {(l.contacts as { display_name: string | null } | null)?.display_name ??
                    l.message?.slice(0, 40) ??
                    l.source}
                </Link>
                <ResponseClock receivedAt={l.received_at} firstResponseAt={l.first_response_at} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Hot buyers idle 3+ days"
        icon={<Flame className="size-4 text-danger" />}
        count={idleHot.length}
      >
        {idleHot.length === 0 ? (
          <p className="text-sm text-text-3">All hot buyers touched recently.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border/60 text-sm">
            {idleHot.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/contacts/${c.id}`}
                  className="flex min-h-11 items-center justify-between gap-3 py-2 hover:text-brand-700"
                >
                  <span className="truncate text-text-1">{c.display_name ?? "Unnamed"}</span>
                  <span className="shrink-0 text-xs tabular-nums text-text-3">
                    {c.idleDays === null ? "no activity" : `${c.idleDays}d idle`}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {(needFeedback ?? []).length > 0 ? (
        <Card
          title="Viewings awaiting your feedback"
          icon={<MessageSquareWarning className="size-4 text-warning" />}
          count={(needFeedback ?? []).length}
        >
          <ul className="flex flex-col divide-y divide-border/60 text-sm">
            {(needFeedback ?? []).map((v) => (
              <li key={v.id}>
                <Link
                  href={`/viewings/${v.id}`}
                  className="flex min-h-11 items-baseline justify-between gap-3 py-2 hover:text-brand-700"
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
        </Card>
      ) : null}
    </div>
  );
}
