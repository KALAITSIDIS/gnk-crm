import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Download, ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { formatDateTime } from "@/lib/utils/format";
import { zonedDateRangeToUtc } from "@/lib/utils/tz";
import {
  num,
  pct,
  type AgentPerformanceRow,
  type PriceReductions,
  type ReportCitation,
  type SourceRoiRow,
  type StageConversion,
  type TimeToClose,
} from "@/lib/services/report-export";

export const dynamic = "force-dynamic";

/** Default window: the last 90 Cyprus-local days. Reports need a span. */
function defaultRange(): { from: string; to: string } {
  const today = new Date();
  const start = new Date(today.getTime() - 89 * 86_400_000);
  return { from: start.toISOString().slice(0, 10), to: today.toISOString().slice(0, 10) };
}

const isDate = (v: string | undefined): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);

export default async function PerformanceReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations("reports.performance");
  const sp = await searchParams;
  const supabase = await createClient();

  const def = defaultRange();
  const from = isDate(typeof sp.from === "string" ? sp.from : undefined)
    ? (sp.from as string)
    : def.from;
  const to = isDate(typeof sp.to === "string" ? sp.to : undefined) ? (sp.to as string) : def.to;

  // Window bounds computed HERE, not in SQL — the Cyprus wall-clock boundary
  // lives in lib/utils/tz.ts with unit tests, and re-deriving it in SQL would be
  // a second source of truth that could drift across a DST edge (0018's rule).
  const { gte, lt } = zonedDateRangeToUtc(from, to);
  const win = { p_from: gte!, p_to: lt! };

  const [perfRes, roiRes, ttcRes, convRes, priceRes, citeRes] = await Promise.all([
    supabase.rpc("report_agent_performance", win),
    supabase.rpc("report_source_roi", win),
    supabase.rpc("report_time_to_close", win),
    supabase.rpc("report_stage_conversion", win),
    supabase.rpc("report_price_reductions", win),
    supabase.rpc("report_citation"),
  ]);

  const perf = (perfRes.data ?? []) as unknown as AgentPerformanceRow[];
  const roi = (roiRes.data ?? []) as unknown as SourceRoiRow[];
  const ttc = ttcRes.data as unknown as TimeToClose | null;
  const conv = convRes.data as unknown as StageConversion | null;
  const price = priceRes.data as unknown as PriceReductions | null;
  const cite = citeRes.data as unknown as ReportCitation | null;

  // ids → names, the same way the list exports do it
  const agentIds = perf.map((r) => r.agent_id);
  const { data: profileRows } = agentIds.length
    ? await supabase.from("profiles").select("id, full_name, is_active").in("id", agentIds)
    : { data: [] };
  const agentName = new Map(
    (profileRows ?? []).map((p) => [
      p.id,
      p.is_active ? p.full_name : `${p.full_name} (inactive)`,
    ]),
  );

  const propertyIds = (price?.repeat_cuts ?? []).map((c) => c.property_id);
  const { data: propRows } = propertyIds.length
    ? await supabase.from("properties").select("id, reference").in("id", propertyIds)
    : { data: [] };
  const propertyRef = new Map((propRows ?? []).map((p) => [p.id, p.reference]));

  const exportHref = (report: string) =>
    `/reports/performance/export?${new URLSearchParams({ from, to, report }).toString()}`;

  const money = (v: unknown) => {
    const n = num(v);
    return n === null ? "—" : n.toLocaleString("en-GB", { maximumFractionDigits: 0 });
  };
  const days = (v: unknown) => {
    const n = num(v);
    return n === null ? "—" : n.toFixed(1);
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-text-1">{t("title")}</h1>
        <p className="text-sm text-text-2">{t("subtitle")}</p>
      </div>

      {/* window ------------------------------------------------------------ */}
      <form method="get" className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-text-3">
          {t("from")}
          <input
            type="date"
            name="from"
            defaultValue={from}
            className="rounded-[8px] border border-border bg-surface px-3 py-1.5 text-sm text-text-1"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-text-3">
          {t("to")}
          <input
            type="date"
            name="to"
            defaultValue={to}
            className="rounded-[8px] border border-border bg-surface px-3 py-1.5 text-sm text-text-1"
          />
        </label>
        <button
          type="submit"
          className="rounded-[8px] border border-border bg-surface px-3 py-1.5 text-sm font-medium text-text-1 hover:border-brand-300"
        >
          {t("apply")}
        </button>
        <Link href="/reports" className="py-1.5 text-sm text-text-2 underline">
          {t("backToReports")}
        </Link>
      </form>

      {/* citation ---------------------------------------------------------- */}
      {cite ? (
        <div className="flex max-w-4xl flex-col gap-1 rounded-[10px] border border-border bg-surface px-4 py-3 text-sm">
          <span className="flex items-center gap-2 font-medium text-text-1">
            <ShieldCheck className="size-4 text-brand-700" />
            {t("citation.heading")}
          </span>
          <span className="text-text-2">
            {cite.chain_verified_through === null
              ? t("citation.none")
              : t("citation.body", {
                  id: cite.chain_verified_through,
                  hash: (cite.chain_verified_hash ?? "").slice(0, 12),
                  when: cite.chain_verified_at ? formatDateTime(cite.chain_verified_at) : "—",
                })}
          </span>
          <span className="text-xs text-text-3">
            {cite.scope === "own" ? t("citation.scopeOwn") : t("citation.scopeOrg")}{" "}
            {t("citation.limits")}
          </span>
        </div>
      ) : null}

      {/* agent performance -------------------------------------------------- */}
      <Section title={t("agents.heading")} exportHref={exportHref("agent_performance")} exportLabel={t("export")}>
        {perf.length === 0 ? (
          <Empty text={t("empty")} />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-3">
                <th className="px-4 py-2">{t("agents.agent")}</th>
                <th className="px-4 py-2 text-right">{t("agents.leads")}</th>
                <th className="px-4 py-2 text-right">{t("agents.answered")}</th>
                <th className="px-4 py-2 text-right">{t("agents.avgResponse")}</th>
                <th className="px-4 py-2 text-right">{t("agents.viewings")}</th>
                <th className="px-4 py-2 text-right">{t("agents.won")}</th>
                <th className="px-4 py-2 text-right">{t("agents.wonValue")}</th>
                <th className="px-4 py-2 text-right">{t("agents.lost")}</th>
              </tr>
            </thead>
            <tbody>
              {perf.map((r) => (
                <tr key={r.agent_id} className="border-b border-border/60">
                  <td className="px-4 py-2 text-text-1">{agentName.get(r.agent_id) ?? r.agent_id}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-text-2">{r.leads_assigned}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-text-2">{r.leads_answered}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-text-2">
                    {days(r.avg_first_response_min)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-text-2">{r.viewings_completed}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-text-2">{r.deals_won}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-text-1">{money(r.won_value)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-text-2">{r.deals_lost}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {/* source ROI --------------------------------------------------------- */}
      <Section title={t("sources.heading")} exportHref={exportHref("source_roi")} exportLabel={t("export")}>
        {roi.length === 0 ? (
          <Empty text={t("empty")} />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-3">
                <th className="px-4 py-2">{t("sources.source")}</th>
                <th className="px-4 py-2 text-right">{t("sources.leads")}</th>
                <th className="px-4 py-2 text-right">{t("sources.converted")}</th>
                <th className="px-4 py-2 text-right">{t("sources.won")}</th>
                <th className="px-4 py-2 text-right">{t("sources.wonValue")}</th>
                <th className="px-4 py-2 text-right">{t("sources.convertRate")}</th>
                <th className="px-4 py-2 text-right">{t("sources.winRate")}</th>
              </tr>
            </thead>
            <tbody>
              {roi.map((r) => (
                <tr key={r.source} className="border-b border-border/60">
                  <td className="px-4 py-2 text-text-1">{r.source}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-text-2">{r.leads}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-text-2">{r.converted}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-text-2">{r.won}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-text-1">{money(r.won_value)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-text-2">
                    {pct(num(r.convert_rate)) || "—"}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-text-2">
                    {pct(num(r.win_rate)) || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      {/* time to close ------------------------------------------------------ */}
      <Section title={t("ttc.heading")} exportHref={exportHref("time_to_close")} exportLabel={t("export")}>
        <div className="grid gap-4 px-4 py-4 sm:grid-cols-2">
          {(["won", "lost"] as const).map((k) => (
            <div key={k} className="rounded-[8px] border border-border/60 p-3">
              <p className="text-xs uppercase tracking-wide text-text-3">{t(`ttc.${k}`)}</p>
              <p className="mt-1 text-lg font-semibold tabular-nums text-text-1">
                <span className="text-sm font-normal text-text-2">
                  {t("ttc.dealCount", { count: ttc ? ttc[k].count : 0 })}
                </span>
              </p>
              <p className="mt-1 text-sm text-text-2">
                {t("ttc.avg")} {days(ttc?.[k].avg_days)} · {t("ttc.median")} {days(ttc?.[k].median_days)}
                {k === "won" ? ` · ${t("ttc.p90")} ${days(ttc?.won.p90_days)}` : ""}
              </p>
            </div>
          ))}
        </div>
      </Section>

      {/* stage conversion --------------------------------------------------- */}
      <Section
        title={t("stages.heading")}
        exportHref={exportHref("stage_conversion")}
        exportLabel={t("export")}
      >
        <p className="border-b border-border/60 px-4 py-2 text-xs text-text-3">
          {t("stages.derivedFrom")}
          {conv?.stage_key === "name" ? ` ${t("stages.nameKeyed")}` : ""}
        </p>
        {(conv?.stages ?? []).length === 0 ? (
          <Empty text={t("empty")} />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-3">
                <th className="px-4 py-2">{t("stages.stage")}</th>
                <th className="px-4 py-2 text-right">{t("stages.entered")}</th>
                <th className="px-4 py-2 text-right">{t("stages.advanced")}</th>
                <th className="px-4 py-2 text-right">{t("stages.advanceRate")}</th>
              </tr>
            </thead>
            <tbody>
              {(conv?.stages ?? []).map((s) => (
                <tr key={s.stage} className="border-b border-border/60">
                  <td className="px-4 py-2 text-text-1">{s.stage}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-text-2">{s.entered}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-text-2">{s.advanced}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-text-2">
                    {pct(num(s.advance_rate)) || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {conv ? (
          <p className="border-t border-border/60 px-4 py-2 text-xs text-text-3">
            {t("stages.outcomes", { won: conv.outcomes.won, lost: conv.outcomes.lost })}
          </p>
        ) : null}
      </Section>

      {/* price reductions --------------------------------------------------- */}
      <Section
        title={t("prices.heading")}
        exportHref={exportHref("price_reductions")}
        exportLabel={t("export")}
      >
        <div className="grid gap-4 px-4 py-4 sm:grid-cols-4">
          <Stat label={t("prices.reductions")} value={String(price?.reductions ?? 0)} />
          <Stat label={t("prices.properties")} value={String(price?.properties_affected ?? 0)} />
          <Stat label={t("prices.avgCut")} value={pct(num(price?.avg_cut_fraction)) || "—"} />
          <Stat label={t("prices.totalCut")} value={money(price?.total_cut_amount)} />
        </div>
        {(price?.repeat_cuts ?? []).length > 0 ? (
          <table className="w-full border-t border-border/60 text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-3">
                <th className="px-4 py-2">{t("prices.property")}</th>
                <th className="px-4 py-2 text-right">{t("prices.cuts")}</th>
                <th className="px-4 py-2 text-right">{t("prices.totalCut")}</th>
                <th className="px-4 py-2">{t("prices.lastCut")}</th>
              </tr>
            </thead>
            <tbody>
              {(price?.repeat_cuts ?? []).map((c) => (
                <tr key={c.property_id} className="border-b border-border/60">
                  <td className="px-4 py-2 text-text-1">
                    {propertyRef.get(c.property_id) ?? c.property_id}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums text-text-2">{c.cuts}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-text-1">{money(c.total_cut)}</td>
                  <td className="px-4 py-2 text-text-2">{formatDateTime(c.last_cut_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Section>

      <p className="text-xs text-text-3">{t("windowNote", { from, to })}</p>
    </div>
  );
}

function Section({
  title,
  exportHref,
  exportLabel,
  children,
}: {
  title: string;
  exportHref: string;
  exportLabel: string;
  children: React.ReactNode;
}) {
  return (
    <section className="max-w-4xl overflow-x-auto rounded-[10px] border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-text-1">{title}</h2>
        <a
          href={exportHref}
          className="flex items-center gap-1.5 text-sm text-text-2 hover:text-text-1"
        >
          <Download className="size-4" />
          {exportLabel}
        </a>
      </div>
      {children}
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="px-4 py-6 text-sm text-text-2">{text}</p>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[8px] border border-border/60 p-3">
      <p className="text-xs uppercase tracking-wide text-text-3">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-text-1">{value}</p>
    </div>
  );
}
