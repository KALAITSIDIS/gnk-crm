import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { AlertTriangle, Download, ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/services/auth";
import { addDayKey } from "@/lib/services/calendar-window";
import { formatDateTime, formatMoney } from "@/lib/utils/format";
import { zonedDateRangeToUtc, zonedParts } from "@/lib/utils/tz";
import {
  isCitation,
  isDirectional,
  isPriceReductions,
  isTimeToClose,
  num,
  pct,
  reportObject,
  reportRows,
  sourceRowsDefineSpam,
  stageConversionView,
  stagesByPipeline,
  type AgentPerformanceRow,
  type PriceReductions,
  type ReportCitation,
  type SourceRoiRow,
  type TimeToClose,
} from "@/lib/services/report-export";

export const dynamic = "force-dynamic";

/**
 * Default window: the last 90 Cyprus-local days (RPT-3). `dayKey`, not
 * `toISOString().slice(0,10)` — the latter is the UTC date, and between
 * Cyprus midnight and 02:00/03:00 local it ends the default window on
 * YESTERDAY'S Cyprus date, silently dropping today from the very report
 * whose footer claims "Cyprus local time". addDayKey runs at UTC noon so a
 * DST edge inside the 90 days cannot slip a day.
 */
function defaultRange(): { from: string; to: string } {
  const to = zonedParts(new Date()).dayKey;
  return { from: addDayKey(to, -89), to };
}

const isDate = (v: string | undefined): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** The deal_type enum's values, each with a `stages.pipelines.*` label. */
const PIPELINES = new Set(["sale", "rental", "antiparoxi", "advisory"]);

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

  const [profile, perfRes, roiRes, ttcRes, convRes, priceRes, citeRes] = await Promise.all([
    getCurrentProfile(supabase),
    supabase.rpc("report_agent_performance", win),
    supabase.rpc("report_source_roi", win),
    supabase.rpc("report_time_to_close", win),
    supabase.rpc("report_stage_conversion", win),
    supabase.rpc("report_price_reductions", win),
    supabase.rpc("report_citation"),
  ]);

  // Every RPC's error is READ (BACKLOG "The performance page paints four other
  // reports' failures as 'Nothing in this window.'"): a failed or shapeless
  // answer renders as a failure in its own section — role="alert", no export
  // link — never as an empty list or as zeros. The other sections render from
  // their own results. (Stage conversion has read its error since 0130.)
  const perfView = reportRows<AgentPerformanceRow>(perfRes);
  const roiView = reportRows<SourceRoiRow>(roiRes);
  const ttcView = reportObject<TimeToClose>(ttcRes, isTimeToClose);
  const stages = stageConversionView(convRes);
  const conv = stages.status === "error" ? null : stages.conv;
  const priceView = reportObject<PriceReductions>(priceRes, isPriceReductions);
  const citeView = reportObject<ReportCitation>(citeRes, isCitation);

  const perf = perfView.status === "ok" ? perfView.rows : [];
  const roi = roiView.status === "ok" ? roiView.rows : [];
  const repeatCuts = priceView.status === "ok" ? priceView.value.repeat_cuts : [];

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

  const propertyIds = repeatCuts.map((c) => c.property_id);
  const { data: propRows } = propertyIds.length
    ? await supabase.from("properties").select("id, reference").in("id", propertyIds)
    : { data: [] };
  const propertyRef = new Map((propRows ?? []).map((p) => [p.id, p.reference]));

  const exportHref = (report: string) =>
    `/reports/performance/export?${new URLSearchParams({ from, to, report }).toString()}`;

  // doc 02 §A11: euros as €1.234.567 — the transaction value, not commission
  const money = (v: unknown) => formatMoney(num(v));
  const days = (v: unknown) => {
    const n = num(v);
    return n === null ? "—" : n.toFixed(1);
  };
  /** a count the answer does not carry (a database before 0154) is a dash, never 0 */
  const count = (v: unknown) => {
    const n = num(v);
    return n === null ? "—" : String(n);
  };

  // What each figure covers follows the caller's ROLE, because RLS does:
  // leads_select and viewings_select are organisation-wide, deals_select gives
  // an agent only their own deals, events_select gives everyone but an admin
  // only the events they wrote. report_citation's `scope` says 'own' for every
  // non-admin — a listing manager reads every deal — so it is not what this
  // line is chosen from.
  const isAgent = profile.role === "agent";
  const scopeLine =
    profile.role === "admin"
      ? t("scope.admin")
      : profile.role === "listing_manager"
        ? t("scope.listingManager")
        : t("scope.agent");

  // 0154 answers carry `spam`; a database still at 0076's body does not, and
  // its convert rate then still counts spam — the labels must not say otherwise
  const roiDefinesSpam = sourceRowsDefineSpam(roi);
  const directional = conv ? isDirectional(conv) : false;
  const pipelineLabel = (dealType: string | null | undefined) =>
    dealType && PIPELINES.has(dealType)
      ? t(`stages.pipelines.${dealType}`)
      : (dealType ?? t("stages.pipelines.unknown"));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-text-1">{t("title")}</h1>
        <p className="text-sm text-text-2">{t("subtitle")}</p>
        <p data-testid="report-scope" className="mt-1 max-w-4xl text-xs text-text-3">
          {scopeLine}
        </p>
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
      {citeView.status === "error" ? (
        <p
          role="alert"
          data-testid="citation-error"
          className="max-w-4xl rounded-[10px] border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger"
        >
          {t("citation.loadError")}
        </p>
      ) : (
        <div className="flex max-w-4xl flex-col gap-1 rounded-[10px] border border-border bg-surface px-4 py-3 text-sm">
          <span className="flex items-center gap-2 font-medium text-text-1">
            <ShieldCheck className="size-4 text-brand-700" />
            {t("citation.heading")}
          </span>
          <span className="text-text-2">
            {citeView.value.chain_verified_through === null
              ? t("citation.none")
              : t("citation.body", {
                  id: citeView.value.chain_verified_through,
                  hash: (citeView.value.chain_verified_hash ?? "").slice(0, 12),
                  when: citeView.value.chain_verified_at
                    ? formatDateTime(citeView.value.chain_verified_at)
                    : "—",
                })}
          </span>
          <span className="text-xs text-text-3">{t("citation.limits")}</span>
        </div>
      )}

      {/* agent performance -------------------------------------------------- */}
      <Section
        title={t("agents.heading")}
        exportHref={perfView.status === "error" ? undefined : exportHref("agent_performance")}
        exportLabel={t("export")}
      >
        {perfView.status === "error" ? (
          <LoadError testId="agent-performance-error" text={t("loadError")} />
        ) : perf.length === 0 ? (
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
        {perfView.status === "error" ? null : (
          <Note testId="agent-performance-definition" text={t("agents.definition")} />
        )}
      </Section>

      {/* lead sources — identifiers stay `source_roi` (the URL key and the
          audit list report:source_roi are in the chain); what the report is,
          and is not, is said in words under the table (F06) --------------- */}
      <Section
        title={t("sources.heading")}
        exportHref={roiView.status === "error" ? undefined : exportHref("source_roi")}
        exportLabel={t("export")}
      >
        {roiView.status === "error" ? (
          <LoadError testId="lead-sources-error" text={t("loadError")} />
        ) : roi.length === 0 ? (
          <Empty text={t("empty")} />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-3">
                <th className="px-4 py-2">{t("sources.source")}</th>
                <th className="px-4 py-2 text-right">{t("sources.leads")}</th>
                <th className="px-4 py-2 text-right">{t("sources.spam")}</th>
                <th className="px-4 py-2 text-right">{t("sources.converted")}</th>
                <th className="px-4 py-2 text-right">{t("sources.won")}</th>
                <th className="px-4 py-2 text-right">{t("sources.wonValue")}</th>
                <th className="px-4 py-2 text-right">
                  {roiDefinesSpam ? t("sources.convertRateExclSpam") : t("sources.convertRate")}
                </th>
                <th className="px-4 py-2 text-right">{t("sources.winRate")}</th>
              </tr>
            </thead>
            <tbody>
              {roi.map((r) => {
                const visible = num(r.converted_visible);
                return (
                  <tr key={r.source} className="border-b border-border/60">
                    <td className="px-4 py-2 text-text-1">{r.source}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-text-2">{r.leads}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-text-2">{count(r.spam)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-text-2">
                      {r.converted}
                      {visible !== null && visible !== num(r.converted) ? (
                        <span className="block text-xs text-text-3">
                          {t("sources.visibleToYou", { count: visible })}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-text-2">{r.won}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-text-1">{money(r.won_value)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-text-2">
                      {pct(num(r.convert_rate)) || "—"}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-text-2">
                      {pct(num(r.win_rate)) || "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {roiView.status === "error" ? null : (
          <div
            data-testid="lead-sources-definition"
            className="flex flex-col gap-1 border-t border-border/60 px-4 py-2 text-xs text-text-3"
          >
            <p>
              {t("sources.definition")}
              {roiDefinesSpam ? ` ${t("sources.definitionSpam")}` : ""}
            </p>
            <p data-testid="lead-sources-scope">
              {isAgent ? t("sources.scopeAgent") : t("sources.scopeOrg")}
              {isAgent && roi.length > 0
                ? ` ${roiDefinesSpam ? t("sources.winRateOwn") : t("sources.winRateMixed")}`
                : ""}
            </p>
          </div>
        )}
      </Section>

      {/* time to close ------------------------------------------------------ */}
      <Section
        title={t("ttc.heading")}
        exportHref={ttcView.status === "error" ? undefined : exportHref("time_to_close")}
        exportLabel={t("export")}
      >
        {ttcView.status === "error" ? (
          <LoadError testId="time-to-close-error" text={t("loadError")} />
        ) : (
          <div className="grid gap-4 px-4 py-4 sm:grid-cols-2">
            {(["won", "lost"] as const).map((k) => (
              <div key={k} className="rounded-[8px] border border-border/60 p-3">
                <p className="text-xs uppercase tracking-wide text-text-3">{t(`ttc.${k}`)}</p>
                <p className="mt-1 text-lg font-semibold tabular-nums text-text-1">
                  <span className="text-sm font-normal text-text-2">
                    {t("ttc.dealCount", { count: Number(ttcView.value[k].count) })}
                  </span>
                </p>
                <p className="mt-1 text-sm text-text-2">
                  {t("ttc.avg")} {days(ttcView.value[k].avg_days)} · {t("ttc.median")}{" "}
                  {days(ttcView.value[k].median_days)}
                  {k === "won" ? ` · ${t("ttc.p90")} ${days(ttcView.value.won.p90_days)}` : ""}
                </p>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* stage conversion --------------------------------------------------- */}
      <Section
        title={t("stages.heading")}
        // a failed section has nothing to export, and the route refuses a
        // window with no stage rows but exclusions (422) — neither offers it
        exportHref={
          stages.status === "error" || (stages.status !== "data" && stages.excluded > 0)
            ? undefined
            : exportHref("stage_conversion")
        }
        exportLabel={t("export")}
      >
        <p className="border-b border-border/60 px-4 py-2 text-xs text-text-3">
          {t("stages.derivedFrom")}
          {conv ? ` ${directional ? t("stages.idKeyed") : t("stages.nameKeyed")}` : ""}
        </p>
        {stages.status === "error" ? (
          <p role="alert" data-testid="stage-conversion-error" className="px-4 py-6 text-sm text-danger">
            {t("stages.loadError")}
          </p>
        ) : null}
        {(stages.status === "data" || stages.status === "empty") && stages.excluded > 0 ? (
          <Warning testId="stage-conversion-excluded" text={t("stages.excluded", { count: stages.excluded })} />
        ) : null}
        {stages.status === "excluded_only" ? (
          <Warning testId="stage-conversion-all-excluded" text={t("stages.allExcluded", { count: stages.excluded })} />
        ) : null}
        {stages.status === "empty" ? <Empty text={t("empty")} /> : null}
        {stages.status !== "data" ? null : directional ? (
          // 0154: one table per pipeline, stages in pipeline order; a
          // departure is forward, back, or of a direction that cannot be read
          stagesByPipeline(stages.conv.stages).map((g) => (
            <div key={g.dealType ?? "unknown"} data-testid={`stage-pipeline-${g.dealType ?? "unknown"}`}>
              <h3 className="border-b border-border/60 px-4 pb-2 pt-3 text-xs font-semibold uppercase tracking-wide text-text-2">
                {pipelineLabel(g.dealType)}
              </h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-3">
                    <th className="px-4 py-2">{t("stages.stage")}</th>
                    <th className="px-4 py-2 text-right">{t("stages.entered")}</th>
                    <th className="px-4 py-2 text-right">{t("stages.advanced")}</th>
                    <th className="px-4 py-2 text-right">{t("stages.regressed")}</th>
                    <th className="px-4 py-2 text-right">{t("stages.departedUnknown")}</th>
                    <th className="px-4 py-2 text-right">{t("stages.forwardRate")}</th>
                  </tr>
                </thead>
                <tbody>
                  {g.stages.map((s) => (
                    <tr key={s.stage_id ?? `name:${s.stage}`} className="border-b border-border/60">
                      <td className="px-4 py-2 text-text-1">
                        {s.stage_id ? s.stage : t("stages.recordedName", { stage: s.stage })}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-text-2">{s.entered}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-text-2">{s.advanced}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-text-2">{count(s.regressed)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-text-2">
                        {count(s.departed_unknown)}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-text-2">
                        {pct(num(s.advance_rate)) || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))
        ) : (
          // a database still at 0130 (a rollback): one row per stage NAME
          // across pipelines, and `advanced` counts departures either way
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-3">
                <th className="px-4 py-2">{t("stages.stage")}</th>
                <th className="px-4 py-2 text-right">{t("stages.entered")}</th>
                <th className="px-4 py-2 text-right">{t("stages.advancedAnyDirection")}</th>
                <th className="px-4 py-2 text-right">{t("stages.advanceRate")}</th>
              </tr>
            </thead>
            <tbody>
              {stages.conv.stages.map((s) => (
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
          <p
            data-testid="stage-conversion-outcomes"
            className="border-t border-border/60 px-4 py-2 text-xs text-text-3"
          >
            {t("stages.outcomes", { won: conv.outcomes.won, lost: conv.outcomes.lost })}
            {directional && (conv.outcomes_by_type ?? []).length > 0
              ? ` ${(conv.outcomes_by_type ?? [])
                  .map(
                    (o) =>
                      `${pipelineLabel(o.deal_type)}: ${t("stages.outcomesPipeline", { won: o.won, lost: o.lost })}`,
                  )
                  .join(" · ")}`
              : ""}
          </p>
        ) : null}
        {conv?.note ? (
          // the RPC's own caveat, rendered verbatim (0076 self-describing
          // output): the UI can never disagree with what the payload says —
          // since 0154, that direction reads the CURRENT stage order and that
          // won / lost are not attributed to the stage they left
          <p className="border-t border-border/60 px-4 py-2 text-xs text-text-3">{conv.note}</p>
        ) : null}
      </Section>

      {/* price reductions --------------------------------------------------- */}
      <Section
        title={t("prices.heading")}
        exportHref={priceView.status === "error" ? undefined : exportHref("price_reductions")}
        exportLabel={t("export")}
      >
        {priceView.status === "error" ? (
          <LoadError testId="price-reductions-error" text={t("loadError")} />
        ) : (
          <div className="grid gap-4 px-4 py-4 sm:grid-cols-4">
            <Stat label={t("prices.reductions")} value={count(priceView.value.reductions)} />
            <Stat label={t("prices.properties")} value={count(priceView.value.properties_affected)} />
            <Stat label={t("prices.avgCut")} value={pct(num(priceView.value.avg_cut_fraction)) || "—"} />
            <Stat label={t("prices.totalCut")} value={money(priceView.value.total_cut_amount)} />
          </div>
        )}
        {repeatCuts.length > 0 ? (
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
              {repeatCuts.map((c) => (
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
  /** omitted when the section has nothing honest to export */
  exportHref?: string;
  exportLabel: string;
  children: React.ReactNode;
}) {
  return (
    <section className="max-w-4xl overflow-x-auto rounded-[10px] border border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-text-1">{title}</h2>
        {exportHref ? (
          <a
            href={exportHref}
            className="flex items-center gap-1.5 text-sm text-text-2 hover:text-text-1"
          >
            <Download className="size-4" />
            {exportLabel}
          </a>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="px-4 py-6 text-sm text-text-2">{text}</p>;
}

/** A section whose report failed: said as a failure, never as an empty window. */
function LoadError({ text, testId }: { text: string; testId: string }) {
  return (
    <p role="alert" data-testid={testId} className="px-4 py-6 text-sm text-danger">
      {text}
    </p>
  );
}

function Note({ text, testId }: { text: string; testId: string }) {
  return (
    <p data-testid={testId} className="border-t border-border/60 px-4 py-2 text-xs text-text-3">
      {text}
    </p>
  );
}

function Warning({ text, testId }: { text: string; testId: string }) {
  return (
    <p
      role="status"
      data-testid={testId}
      className="flex items-start gap-2 border-b border-warning/40 bg-warning/5 px-4 py-3 text-sm text-text-2"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
      <span>{text}</span>
    </p>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[8px] border border-border/60 p-3">
      <p className="text-xs uppercase tracking-wide text-text-3">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-text-1">{value}</p>
    </div>
  );
}
