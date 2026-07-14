import Link from "next/link";
import { EventTimeline } from "@/components/features/shared/event-timeline";
import { createClient } from "@/lib/supabase/server";
import { formatDate, formatMoney } from "@/lib/utils/format";

/**
 * Admin dashboard (T5.3, doc 05 + doc 02 §C9). Every number is reproducible
 * by the SQL documented above its query — acceptance requires the on-screen
 * figure to match the manual query on seeded data. All queries are org-scoped
 * by RLS; TS aggregates replace SQL aggregates (PostgREST aggregates are off),
 * with the equivalent SQL in the comment.
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
  valueLabel,
}: {
  rows: { label: string; value: number; display: string }[];
  valueLabel?: string;
}) {
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
      {rows.length === 0 ? (
        <li className="text-sm text-text-3">Nothing yet{valueLabel ? ` (${valueLabel})` : ""}.</li>
      ) : null}
    </ul>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[10px] border border-border bg-surface p-5">
      <h2 className="mb-3 text-sm font-semibold text-text-1">{title}</h2>
      {children}
    </section>
  );
}

export async function AdminDashboard() {
  const supabase = await createClient();

  const now = new Date(); // per-request clock anchors every window below
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const d7 = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const d30 = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const today = now.toISOString().slice(0, 10);
  const in30 = new Date(now.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);

  const [
    // SQL: select stage_id, expected_value from deals where status='open';
    { data: openDeals },
    // SQL: select expected_value from deals where status='won' and won_at >= date_trunc('month', now());
    { data: wonDeals },
    // SQL: select received_at, first_response_at from leads where received_at >= now() - interval '7 days';
    { data: leads7 },
    // SQL: select id, name, deal_type, sort_order from deal_stages where is_won=false and is_lost=false;
    { data: stages },
    // SQL: select source from leads where received_at >= now() - interval '30 days';
    { data: leads30 },
    // SQL: select property_id, type, expiry_date from mandates_safe
    //      where status='active' and expiry_date between current_date and current_date + 30;
    { data: expiring },
    // SQL: select * from events order by occurred_at desc limit 10;
    { data: latestEvents },
    // SQL: select status from properties;
    { data: propStatuses },
    // SQL: select actor_id, count(*) from events where occurred_at >= now() - interval '30 days'
    //      and actor_id is not null group by actor_id order by count desc limit 5;
    { data: actorEvents },
  ] = await Promise.all([
    supabase.from("deals").select("stage_id, expected_value").eq("status", "open").limit(2000),
    supabase.from("deals").select("expected_value").eq("status", "won").gte("won_at", monthStart),
    supabase.from("leads").select("received_at, first_response_at").gte("received_at", d7),
    supabase
      .from("deal_stages")
      .select("id, name, deal_type, sort_order")
      .eq("is_won", false)
      .eq("is_lost", false),
    supabase.from("leads").select("source").gte("received_at", d30).limit(2000),
    supabase
      .from("mandates_safe")
      .select("property_id, type, expiry_date")
      .eq("status", "active")
      .gte("expiry_date", today)
      .lte("expiry_date", in30)
      .order("expiry_date", { ascending: true }),
    supabase
      .from("events")
      .select("id, occurred_at, entity_type, event_type, payload")
      .order("occurred_at", { ascending: false })
      .limit(10),
    supabase.from("properties").select("status").limit(2000),
    supabase
      .from("events")
      .select("actor_id")
      .gte("occurred_at", d30)
      .not("actor_id", "is", null)
      .limit(5000),
  ]);

  const openPipeline = (openDeals ?? []).reduce((s, d) => s + Number(d.expected_value ?? 0), 0);
  const wonValue = (wonDeals ?? []).reduce((s, d) => s + Number(d.expected_value ?? 0), 0);

  const answered = (leads7 ?? []).filter((l) => l.first_response_at);
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
  for (const d of openDeals ?? []) {
    stageValue.set(d.stage_id, (stageValue.get(d.stage_id) ?? 0) + Number(d.expected_value ?? 0));
    stageCount.set(d.stage_id, (stageCount.get(d.stage_id) ?? 0) + 1);
  }
  const stageRows = (stages ?? [])
    .sort((a, b) => a.deal_type.localeCompare(b.deal_type) || a.sort_order - b.sort_order)
    .filter((s) => (stageCount.get(s.id) ?? 0) > 0)
    .map((s) => ({
      label: s.deal_type === "sale" ? s.name : `${s.name} (${s.deal_type})`,
      value: stageValue.get(s.id) ?? 0,
      display: `${formatMoney(stageValue.get(s.id) ?? 0)} · ${stageCount.get(s.id)}`,
    }));

  const sourceAgg = new Map<string, number>();
  for (const l of leads30 ?? []) sourceAgg.set(l.source, (sourceAgg.get(l.source) ?? 0) + 1);
  const sourceRows = [...sourceAgg.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, value]) => ({ label: label.replace(/_/g, " "), value, display: String(value) }));

  const statusAgg = new Map<string, number>();
  for (const p of propStatuses ?? []) statusAgg.set(p.status, (statusAgg.get(p.status) ?? 0) + 1);
  const statusRows = [...statusAgg.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, value]) => ({ label: label.replace(/_/g, " "), value, display: String(value) }));

  const actorAgg = new Map<string, number>();
  for (const e of actorEvents ?? []) {
    if (e.actor_id) actorAgg.set(e.actor_id, (actorAgg.get(e.actor_id) ?? 0) + 1);
  }
  const topActorIds = [...actorAgg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const { data: actorProfiles } = topActorIds.length
    ? await supabase
        .from("profiles")
        .select("id, full_name")
        .in("id", topActorIds.map(([id]) => id))
    : { data: [] };
  const actorName = new Map((actorProfiles ?? []).map((p) => [p.id, p.full_name]));
  const agentRows = topActorIds.map(([id, value]) => ({
    label: actorName.get(id) ?? "—",
    value,
    display: `${value} events`,
  }));

  const expiringIds = [
    ...new Set((expiring ?? []).map((m) => m.property_id).filter((v): v is string => Boolean(v))),
  ];
  const { data: expProps } = expiringIds.length
    ? await supabase.from("properties").select("id, reference").in("id", expiringIds)
    : { data: [] };
  const expRef = new Map((expProps ?? []).map((p) => [p.id, p.reference]));

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Open pipeline" value={formatMoney(openPipeline)} sub={`${(openDeals ?? []).length} deals`} />
        <Kpi label="Won this month" value={formatMoney(wonValue)} sub={`${(wonDeals ?? []).length} deals`} />
        <Kpi label="New leads (7d)" value={String((leads7 ?? []).length)} />
        <Kpi label="Avg first response (7d)" value={avgResponseLabel} sub={`${answered.length} answered`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Pipeline by stage (open deals)">
          <BarList rows={stageRows} valueLabel="no open deals" />
        </Card>
        <Card title="Leads by source (30d)">
          <BarList rows={sourceRows} valueLabel="no leads" />
        </Card>
        <Card title="Listings by status">
          <BarList rows={statusRows} />
        </Card>
        <Card title="Top agents by activity (30d)">
          <BarList rows={agentRows} valueLabel="no events" />
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Mandates expiring ≤30 days">
          {(expiring ?? []).length === 0 ? (
            <p className="text-sm text-text-3">None in the next 30 days.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border/60 text-sm">
              {(expiring ?? []).map((m, i) => (
                <li key={i} className="flex items-baseline justify-between gap-4 py-2">
                  <Link
                    href={`/properties/${m.property_id}`}
                    className="font-mono text-xs text-brand-700 hover:underline"
                  >
                    {expRef.get(m.property_id!) ?? m.property_id}
                  </Link>
                  <span className="capitalize text-text-2">{m.type}</span>
                  <span className="tabular-nums text-text-1">{formatDate(m.expiry_date)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Latest events">
          <EventTimeline events={latestEvents ?? []} />
        </Card>
      </div>
    </div>
  );
}
