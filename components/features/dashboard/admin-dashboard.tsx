import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Card, CardEmpty } from "@/components/features/dashboard/card";
import { EventTimeline } from "@/components/features/shared/event-timeline";
import { createClient } from "@/lib/supabase/server";
import { unwrapRows } from "@/lib/supabase/unwrap";
import { formatDate, formatMoney } from "@/lib/utils/format";
import { zonedParts, zonedWallClockToUtc } from "@/lib/utils/tz";

/**
 * Admin dashboard (T5.3, doc 05 + doc 02 §C9). Every number is reproducible
 * by the SQL documented above its query — acceptance requires the on-screen
 * figure to match the manual query on seeded data. All queries are org-scoped
 * by RLS; TS aggregates replace SQL aggregates (PostgREST aggregates are off),
 * with the equivalent SQL in the comment (SQL-side aggregates via RPC are in
 * BACKLOG for when row caps start to matter).
 *
 * Audit 2026-07-16: every response is unwrapped — a failed query throws to
 * the segment error boundary instead of painting €0 as if it were real data.
 * Calendar boundaries (today, month start, expiry window) are Cyprus
 * wall-clock days (doc 02 §A11), matching the agent dashboard; rolling
 * 7d/30d windows are instant-relative and zone-free. KPI counts come from
 * `count: "exact"` so they stay honest past the row caps on the summed rows.
 */

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-[10px] border border-border bg-surface p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-text-3">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-text-1">{value}</p>
      {sub ? <p className="text-sm tabular-nums text-text-2">{sub}</p> : null}
    </div>
  );
}

function BarList({
  rows,
  empty,
}: {
  rows: { label: string; value: number; display: string }[];
  empty: React.ReactNode;
}) {
  if (rows.length === 0) return <>{empty}</>;
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((r) => (
        <li key={r.label} className="flex items-center gap-3 text-sm">
          <span className="w-36 shrink-0 truncate text-text-2">{r.label}</span>
          <span className="h-4 rounded bg-brand-100" style={{ width: `${(r.value / max) * 100}%` }} />
          <span className="shrink-0 tabular-nums text-text-1">{r.display}</span>
        </li>
      ))}
    </ul>
  );
}

export async function AdminDashboard() {
  const t = await getTranslations("dashboard.admin");
  const supabase = await createClient();

  const now = new Date(); // per-request clock anchors every window below
  const todayKey = zonedParts(now).dayKey; // Cyprus calendar day (doc 02 §A11)
  const monthStart = zonedWallClockToUtc(`${todayKey.slice(0, 7)}-01T00:00`).toISOString();
  const d7 = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const d30 = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  // date-only arithmetic on the Cyprus day key — DST cannot shift a date+30d
  const in30 = new Date(new Date(`${todayKey}T00:00:00Z`).getTime() + 30 * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const [
    // SQL: select stage_id, expected_value from deals where status='open';
    //      (count: exact keeps the KPI honest if rows exceed the 2000 cap)
    openDealsRes,
    // SQL: select expected_value from deals where status='won'
    //      and won_at >= :cyprus_month_start;
    wonDealsRes,
    // SQL: select received_at, first_response_at from leads
    //      where received_at >= now() - interval '7 days';
    leads7Res,
    // SQL: select id, name, deal_type, sort_order from deal_stages
    //      where is_won=false and is_lost=false;
    stagesRes,
    // SQL: select source from leads where received_at >= now() - interval '30 days';
    leads30Res,
    // SQL: select id, property_id, type, expiry_date from mandates_safe
    //      where status='active' and expiry_date between :cyprus_today and :cyprus_today + 30;
    expiringRes,
    // SQL: select * from events order by occurred_at desc limit 10;
    latestEventsRes,
    // SQL: select status from properties;
    propStatusesRes,
    // SQL: select actor_id, count(*) from events where occurred_at >= now() - interval '30 days'
    //      and actor_id is not null group by actor_id order by count desc limit 5;
    //      (sampled over the most recent 5000 events — ordered so the sample
    //      is deterministic and recent if the org ever exceeds the cap)
    actorEventsRes,
  ] = await Promise.all([
    supabase
      .from("deals")
      .select("stage_id, expected_value", { count: "exact" })
      .eq("status", "open")
      .limit(2000),
    supabase
      .from("deals")
      .select("expected_value", { count: "exact" })
      .eq("status", "won")
      .gte("won_at", monthStart)
      .limit(2000),
    supabase
      .from("leads")
      .select("received_at, first_response_at", { count: "exact" })
      .gte("received_at", d7)
      .limit(2000),
    supabase
      .from("deal_stages")
      .select("id, name, deal_type, sort_order")
      .eq("is_won", false)
      .eq("is_lost", false),
    supabase.from("leads").select("source").gte("received_at", d30).limit(2000),
    supabase
      .from("mandates_safe")
      .select("id, property_id, type, expiry_date")
      .eq("status", "active")
      .gte("expiry_date", todayKey)
      .lte("expiry_date", in30)
      .order("expiry_date", { ascending: true })
      .limit(100),
    supabase
      .from("events")
      .select("id, occurred_at, entity_type, entity_id, event_type, payload, actor_id")
      .order("occurred_at", { ascending: false })
      .limit(10),
    supabase.from("properties").select("status").limit(2000),
    supabase
      .from("events")
      .select("actor_id")
      .gte("occurred_at", d30)
      .not("actor_id", "is", null)
      .order("occurred_at", { ascending: false })
      .limit(5000),
  ]);

  const openDeals = unwrapRows(openDealsRes, "open deals");
  const wonDeals = unwrapRows(wonDealsRes, "won deals");
  const leads7 = unwrapRows(leads7Res, "leads 7d");
  const stages = unwrapRows(stagesRes, "deal stages");
  const leads30 = unwrapRows(leads30Res, "leads 30d");
  const expiring = unwrapRows(expiringRes, "expiring mandates");
  const latestEvents = unwrapRows(latestEventsRes, "latest events");
  const propStatuses = unwrapRows(propStatusesRes, "property statuses");
  const actorEvents = unwrapRows(actorEventsRes, "actor events");

  const openDealsCount = openDealsRes.count ?? openDeals.length;
  const wonDealsCount = wonDealsRes.count ?? wonDeals.length;
  const leads7Count = leads7Res.count ?? leads7.length;

  const openPipeline = openDeals.reduce((s, d) => s + Number(d.expected_value ?? 0), 0);
  const wonValue = wonDeals.reduce((s, d) => s + Number(d.expected_value ?? 0), 0);

  const answered = leads7.filter((l) => l.first_response_at);
  // avg(first_response_at - received_at) over answered leads of the last 7 days
  const avgResponseMin =
    answered.length > 0
      ? answered.reduce(
          (s, l) =>
            s + (new Date(l.first_response_at!).getTime() - new Date(l.received_at).getTime()),
          0,
        ) /
        answered.length /
        60_000
      : null;
  const avgResponseLabel =
    avgResponseMin === null
      ? "—"
      : avgResponseMin < 60
        ? `${Math.round(avgResponseMin)}m`
        : `${Math.floor(avgResponseMin / 60)}h ${Math.round(avgResponseMin % 60)}m`;

  // pipeline € by stage (open deals only), ordered by deal type then stage
  // order; stages with deals but no expected value still show (as €0 · N)
  const stageValue = new Map<string, number>();
  const stageCount = new Map<string, number>();
  for (const d of openDeals) {
    stageValue.set(d.stage_id, (stageValue.get(d.stage_id) ?? 0) + Number(d.expected_value ?? 0));
    stageCount.set(d.stage_id, (stageCount.get(d.stage_id) ?? 0) + 1);
  }
  const stageRows = stages
    .sort((a, b) => a.deal_type.localeCompare(b.deal_type) || a.sort_order - b.sort_order)
    .filter((s) => (stageCount.get(s.id) ?? 0) > 0)
    .map((s) => ({
      label: s.deal_type === "sale" ? s.name : `${s.name} (${s.deal_type})`,
      value: stageValue.get(s.id) ?? 0,
      display: `${formatMoney(stageValue.get(s.id) ?? 0)} · ${stageCount.get(s.id)}`,
    }));

  const sourceAgg = new Map<string, number>();
  for (const l of leads30) sourceAgg.set(l.source, (sourceAgg.get(l.source) ?? 0) + 1);
  const sourceRows = [...sourceAgg.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, value]) => ({ label: label.replace(/_/g, " "), value, display: String(value) }));

  const statusAgg = new Map<string, number>();
  for (const p of propStatuses) statusAgg.set(p.status, (statusAgg.get(p.status) ?? 0) + 1);
  const statusRows = [...statusAgg.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, value]) => ({ label: label.replace(/_/g, " "), value, display: String(value) }));

  const actorAgg = new Map<string, number>();
  for (const e of actorEvents) {
    if (e.actor_id) actorAgg.set(e.actor_id, (actorAgg.get(e.actor_id) ?? 0) + 1);
  }
  const topActorIds = [...actorAgg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  // one profiles fetch covers the top-agents bars AND the event-feed bylines;
  // one properties fetch covers mandate references AND event-feed references
  const eventActorIds = latestEvents
    .map((e) => e.actor_id)
    .filter((v): v is string => Boolean(v));
  const profileIds = [...new Set([...topActorIds.map(([id]) => id), ...eventActorIds])];
  const expiringIds = expiring
    .map((m) => m.property_id)
    .filter((v): v is string => Boolean(v));
  const eventPropIds = latestEvents
    .filter((e) => e.entity_type === "property" && e.entity_id)
    .map((e) => e.entity_id!);
  const refIds = [...new Set([...expiringIds, ...eventPropIds])];

  const [actorProfilesRes, refPropsRes] = await Promise.all([
    profileIds.length
      ? supabase.from("profiles").select("id, full_name").in("id", profileIds)
      : Promise.resolve({ data: [], error: null }),
    refIds.length
      ? supabase.from("properties").select("id, reference").in("id", refIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  const actorName = new Map(
    unwrapRows(actorProfilesRes, "actor profiles").map((p) => [p.id, p.full_name]),
  );
  const propRef = new Map(
    unwrapRows(refPropsRes, "property references").map((p) => [p.id, p.reference]),
  );

  const agentRows = topActorIds.map(([id, value]) => ({
    label: actorName.get(id) ?? "—",
    value,
    display: t("events", { count: value }),
  }));

  // annotate the feed with who did it and, for property events, which listing
  const timelineEvents = latestEvents.map((e) => {
    const ref = e.entity_type === "property" && e.entity_id ? propRef.get(e.entity_id) : null;
    const actor = e.actor_id ? (actorName.get(e.actor_id) ?? null) : t("system");
    return { ...e, note: [ref, actor].filter(Boolean).join(" · ") || null };
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          label={t("kpi.openPipeline")}
          value={formatMoney(openPipeline)}
          sub={t("deals", { count: openDealsCount })}
        />
        <Kpi
          label={t("kpi.wonThisMonth")}
          value={formatMoney(wonValue)}
          sub={t("deals", { count: wonDealsCount })}
        />
        <Kpi label={t("kpi.newLeads7d")} value={String(leads7Count)} />
        <Kpi
          label={t("kpi.avgFirstResponse")}
          value={avgResponseLabel}
          sub={t("answered", { count: answered.length })}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t("cards.pipelineByStage")}>
          <BarList
            rows={stageRows}
            empty={
              <CardEmpty
                text={t("empty.noOpenDeals")}
                href="/pipeline"
                action={t("actions.openPipeline")}
              />
            }
          />
        </Card>
        <Card title={t("cards.leadsBySource")}>
          <BarList
            rows={sourceRows}
            empty={
              <CardEmpty
                text={t("empty.noLeads")}
                href="/leads"
                action={t("actions.leadInbox")}
              />
            }
          />
        </Card>
        <Card title={t("cards.listingsByStatus")}>
          <BarList
            rows={statusRows}
            empty={
              <CardEmpty
                text={t("empty.noListings")}
                href="/properties"
                action={t("actions.properties")}
              />
            }
          />
        </Card>
        <Card title={t("cards.topAgents")}>
          <BarList rows={agentRows} empty={<CardEmpty text={t("empty.noActivity")} />} />
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={t("cards.mandatesExpiring")}>
          {expiring.length === 0 ? (
            <CardEmpty text={t("empty.noMandates")} />
          ) : (
            <ul className="flex flex-col divide-y divide-border/60 text-sm">
              {expiring.map((m) => (
                <li key={m.id} className="flex items-baseline justify-between gap-4 py-2">
                  <Link
                    href={`/properties/${m.property_id}`}
                    className="font-mono text-xs text-brand-700 hover:underline"
                  >
                    {propRef.get(m.property_id!) ?? m.property_id}
                  </Link>
                  <span className="capitalize text-text-2">{m.type}</span>
                  <span className="tabular-nums text-text-1">{formatDate(m.expiry_date)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={t("cards.latestEvents")}>
          <EventTimeline events={timelineEvents} emptyText={t("empty.noEvents")} />
        </Card>
      </div>
    </div>
  );
}
