/**
 * Shapes and CSV columns for the C4 reports (migration 0065).
 *
 * Pure and I/O-free, like `lead-export.ts`: the page renders these types and
 * the export route serialises them with the same `toCsv` used by the seven list
 * exports. Keeping the column definitions here means the CSV and the table
 * cannot drift into showing different numbers.
 *
 * The `unknown`-ish reads are deliberate. These come back as jsonb, and
 * Postgres serialises `numeric` inside jsonb as a JSON number OR — for values
 * that cannot be represented exactly — as a string. Everything numeric is
 * therefore normalised through `num()` rather than trusted to arrive as a
 * number, which is the same defect class that made the events backup script
 * necessary (a JS number silently losing scale, BACKUP_RESTORE §1).
 */
import type { CsvColumn } from "./csv";

export const REPORT_KEYS = [
  "agent_performance",
  "source_roi",
  "time_to_close",
  "stage_conversion",
  "price_reductions",
] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

export function isReportKey(value: string | null | undefined): value is ReportKey {
  return !!value && (REPORT_KEYS as readonly string[]).includes(value);
}

/** jsonb numerics may arrive as number or string; null stays null. */
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

const fmt = (v: number | null, digits = 2): string =>
  v === null ? "" : v.toFixed(digits);

/** A fraction (0.333…) as a percentage string; blank when the rate is undefined. */
export const pct = (v: number | null, digits = 1): string =>
  v === null ? "" : `${(v * 100).toFixed(digits)}%`;

export interface AgentPerformanceRow {
  agent_id: string;
  leads_assigned: number;
  leads_answered: number;
  avg_first_response_min: number | null;
  viewings_completed: number;
  deals_won: number;
  won_value: number | null;
  deals_lost: number;
}

/**
 * One lead source (report_source_roi). The identifiers keep their 0065 name
 * (`source_roi`, `SourceRoiRow`, `sourceRoiCsv`): the URL key and the audit
 * list `report:source_roi` are already in the chain. What the report IS — a
 * count of enquiries and what became of them, not a return on investment
 * (docs/01 §10: no spend is recorded) — is said on the page (F06).
 */
export interface SourceRoiRow {
  source: string;
  leads: number;
  /** 0154: enquiries marked spam — counted in `leads`, in neither side of `convert_rate`. Absent before 0154. */
  spam?: number;
  converted: number;
  /**
   * 0154: converted enquiries whose deal the caller can read (RLS) — the
   * whole agency for an admin or a listing manager, an agent's own deals for
   * an agent; the denominator of `win_rate`. Absent before 0154.
   */
  converted_visible?: number;
  won: number;
  won_value: number | null;
  convert_rate: number | null;
  win_rate: number | null;
}

/** 0154's source rows carry `spam`; a database still at 0076 answers without it (a rollback). */
export const sourceRowsDefineSpam = (rows: SourceRoiRow[]): boolean =>
  rows.some((r) => r.spam !== undefined && r.spam !== null);

export interface TimeToClose {
  won: { count: number; avg_days: number | null; median_days: number | null; p90_days: number | null };
  lost: { count: number; avg_days: number | null; median_days: number | null };
}

export interface StageRow {
  /** the stage's CURRENT name, or the name recorded at the time when no current stage matches */
  stage: string;
  entered: number;
  /** 0154: departures FORWARD (a later stage of the same pipeline); at 0130, departures in any direction */
  advanced: number;
  advance_rate: number | null;
  /** 0154 — the pipeline; null when it cannot be read. Absent from a database at 0130. */
  deal_type?: string | null;
  /** 0154 — null for a row under a recorded name (no current stage) */
  stage_id?: string | null;
  sort_order?: number | null;
  /** 0154 — departures BACKWARD (an earlier stage of the same pipeline) */
  regressed?: number;
  /** 0154 — departures whose direction cannot be read (a side that is not a current stage) */
  departed_unknown?: number;
}

export interface StageConversion {
  derived_from: string;
  stage_key: string;
  /** movements the figures are computed from (0067) */
  moves_total?: number;
  moves_with_ids?: number;
  /**
   * 0130: `stage_changed` events left out of every figure because a recorded
   * stage id is present but not a uuid. Optional so these readers also run
   * against a database still at 0076's body (a rollback), where it is absent.
   */
  moves_malformed?: number;
  stages: StageRow[];
  transitions: Array<{
    from: string | null;
    to: string | null;
    deals: number;
    /** 0154 */
    deal_type?: string | null;
    from_stage_id?: string | null;
    to_stage_id?: string | null;
    direction?: "forward" | "backward" | null;
  }>;
  outcomes: { won: number; lost: number };
  /** 0154: won / lost per pipeline (the deal's type today; null when the caller cannot read the deal) */
  outcomes_by_type?: Array<{ deal_type: string | null; won: number; lost: number }>;
  note: string;
}

/**
 * 0154: rows keyed on (pipeline, stage id) with departures split by
 * direction. A database still at 0130 (a rollback) answers `stage_key: 'name'`
 * — one row per stage NAME across pipelines, `advanced` in any direction —
 * and the page and CSV must then not call that figure "moved forward".
 */
export const isDirectional = (conv: StageConversion): boolean => conv.stage_key === "id";

export interface PipelineGroup {
  /** null: the pipeline could not be read (a recorded name on a deal the caller cannot see) */
  dealType: string | null;
  stages: StageRow[];
}

/** Stage rows grouped by pipeline, keeping the RPC's order (pipeline, then stage order). */
export function stagesByPipeline(stages: StageRow[]): PipelineGroup[] {
  const groups: PipelineGroup[] = [];
  for (const s of stages) {
    const dealType = s.deal_type ?? null;
    let group = groups.find((g) => g.dealType === dealType);
    if (!group) {
      group = { dealType, stages: [] };
      groups.push(group);
    }
    group.stages.push(s);
  }
  return groups;
}

/**
 * What the stage-conversion section may honestly say (T-stage-conversion-malformed).
 *
 * Before 0130 one malformed event made the RPC fail, and the page read
 * `data ?? null` without looking at `error` — a failure painted as "Nothing in
 * this window." Four states now, each rendered and exported differently:
 *
 *   error         the RPC failed, or answered something that is not a report
 *   empty         a real report with no stage rows; `excluded` (possibly 0)
 *                 malformed movements were left out beside valid ones that
 *                 produced no row
 *   data          stage rows; `excluded` (possibly 0) were left out
 *   excluded_only no valid movement at all, and `excluded` > 0 were left out —
 *                 NOT the same as an empty window, and never shown as one
 *
 * `excluded_only` needs `moves_total` = 0: a window whose valid movements
 * produce no stage row (a legacy event with no destination name) is not one
 * where "all" stage changes were unreadable.
 */
export type StageConversionView =
  | { status: "error" }
  | { status: "empty"; conv: StageConversion; excluded: number }
  | { status: "data"; conv: StageConversion; excluded: number }
  | { status: "excluded_only"; conv: StageConversion; excluded: number };

export function stageConversionView(res: { data: unknown; error: unknown }): StageConversionView {
  if (res.error) return { status: "error" };
  const conv = res.data as StageConversion | null;
  if (!conv || typeof conv !== "object" || !Array.isArray(conv.stages)) return { status: "error" };
  const excluded = Math.max(0, num(conv.moves_malformed) ?? 0);
  if (conv.stages.length > 0) return { status: "data", conv, excluded };
  if (excluded > 0 && (num(conv.moves_total) ?? 0) === 0) return { status: "excluded_only", conv, excluded };
  return { status: "empty", conv, excluded };
}

/**
 * The other four reports' answers, read the way stageConversionView reads its
 * own (BACKLOG "The performance page paints four other reports' failures as
 * 'Nothing in this window.'"): an RPC error, or a body that is not the
 * report, is a FAILURE — never an empty list, never zeros.
 */
export type RowsView<T> = { status: "error" } | { status: "ok"; rows: T[] };

/** A list report (agent performance, lead sources): an array, or a failure. */
export function reportRows<T>(res: { data: unknown; error: unknown }): RowsView<T> {
  if (res.error || !Array.isArray(res.data)) return { status: "error" };
  return { status: "ok", rows: res.data as T[] };
}

export type ObjectView<T> = { status: "error" } | { status: "ok"; value: T };

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** A summary report (time to close, price reductions, the citation): an object `valid` accepts, or a failure. */
export function reportObject<T>(
  res: { data: unknown; error: unknown },
  valid: (body: Record<string, unknown>) => boolean,
): ObjectView<T> {
  if (res.error || !isObject(res.data) || !valid(res.data)) return { status: "error" };
  return { status: "ok", value: res.data as T };
}

/** What each summary report must carry to be rendered at all — a count it lacks is never shown as 0. */
export const isTimeToClose = (v: Record<string, unknown>): boolean =>
  isObject(v.won) && isObject(v.lost) && num(v.won.count) !== null && num(v.lost.count) !== null;
export const isPriceReductions = (v: Record<string, unknown>): boolean =>
  num(v.reductions) !== null && num(v.properties_affected) !== null && Array.isArray(v.repeat_cuts);
export const isCitation = (v: Record<string, unknown>): boolean =>
  "chain_verified_through" in v && "chain_verified_hash" in v && "chain_verified_at" in v;

export interface RepeatCut {
  property_id: string;
  cuts: number;
  total_cut: number | null;
  first_cut_at: string;
  last_cut_at: string;
}

export interface PriceReductions {
  reductions: number;
  properties_affected: number;
  avg_cut_fraction: number | null;
  median_cut_fraction: number | null;
  total_cut_amount: number | null;
  repeat_cuts: RepeatCut[];
}

export interface ReportCitation {
  computed_at: string;
  visible_last_event_id: number | null;
  chain_verified_through: number | null;
  chain_verified_hash: string | null;
  chain_verified_at: string | null;
  chain_full_walk_at: string | null;
  scope: "org" | "own";
}

/* ------------------------------------------------------------------ */
/* CSV columns. `agentName` resolves ids the same way the list exports  */
/* do — the RPCs return ids so the aggregate stays a pure group-by.     */
/* ------------------------------------------------------------------ */

export const agentPerformanceCsv = (
  agentName: Map<string, string>,
): CsvColumn<AgentPerformanceRow>[] => [
  { header: "Agent", value: (r) => agentName.get(r.agent_id) ?? r.agent_id },
  { header: "Leads assigned", value: (r) => String(r.leads_assigned) },
  { header: "Leads answered", value: (r) => String(r.leads_answered) },
  { header: "Avg first response (min)", value: (r) => fmt(num(r.avg_first_response_min), 1) },
  { header: "Viewings completed", value: (r) => String(r.viewings_completed) },
  { header: "Deals won", value: (r) => String(r.deals_won) },
  { header: "Won value", value: (r) => fmt(num(r.won_value)) },
  { header: "Deals lost", value: (r) => String(r.deals_lost) },
];

export const sourceRoiCsv = (): CsvColumn<SourceRoiRow>[] => [
  { header: "Source", value: (r) => r.source },
  { header: "Leads", value: (r) => String(r.leads) },
  { header: "Converted", value: (r) => String(r.converted) },
  { header: "Won", value: (r) => String(r.won) },
  { header: "Won value", value: (r) => fmt(num(r.won_value)) },
  { header: "Convert rate", value: (r) => pct(num(r.convert_rate)) },
  { header: "Win rate", value: (r) => pct(num(r.win_rate)) },
];

/** Time-to-close is a summary, not a list; one row per outcome reads best. */
export const timeToCloseCsv = (): CsvColumn<{
  outcome: string;
  count: number;
  avg_days: number | null;
  median_days: number | null;
  p90_days: number | null;
}>[] => [
  { header: "Outcome", value: (r) => r.outcome },
  { header: "Deals", value: (r) => String(r.count) },
  { header: "Avg days", value: (r) => fmt(num(r.avg_days), 1) },
  { header: "Median days", value: (r) => fmt(num(r.median_days), 1) },
  { header: "P90 days", value: (r) => fmt(num(r.p90_days), 1) },
];

export const timeToCloseRows = (t: TimeToClose) => [
  { outcome: "won", ...t.won },
  { outcome: "lost", ...t.lost, p90_days: null },
];

// note: the RPC's own caveat sentence (0076's self-describing-output
// convention) — APPENDED as a constant column, never inserted, so existing
// left-to-right row pins and desk spreadsheets survive (the withWindow rule).
// The 2026-09-01 review found the caveat lived ONLY in the payload: demotions
// counted as advancement and nothing the desk exports said so. Since 0154
// "Advanced" counts forward departures only (withStageSplits appends the
// rest), and the note this column carries says that too.
export const stageConversionCsv = (note = ""): CsvColumn<StageRow>[] => [
  { header: "Stage", value: (r) => r.stage },
  { header: "Entered", value: (r) => String(r.entered) },
  { header: "Advanced", value: (r) => String(r.advanced) },
  { header: "Advance rate", value: (r) => pct(num(r.advance_rate)) },
  { header: "Note", value: () => note },
];

/**
 * 0130: how many malformed stage changes the figures leave out, on every row.
 * APPENDED after From / To (the withWindow rule — never inserted), and present
 * on every stage-conversion export, 0 included, so the column set does not
 * depend on the data. An export with no stage rows but exclusions is refused
 * by the route instead (422): a header-only file has no row to carry the
 * count, and would read as a complete, empty report.
 */
export function withExcluded<T>(cols: CsvColumn<T>[], excluded: number): CsvColumn<T>[] {
  return [...cols, { header: "Malformed moves excluded", value: () => String(excluded) }];
}

/** A count cell: blank when the key is absent (a database before 0154), never a made-up 0. */
const countCell = (v: unknown): string => {
  const n = num(v);
  return n === null ? "" : String(n);
};

/**
 * 0154: the stage split, APPENDED after "Malformed moves excluded" (the
 * withWindow rule — never inserted). "Advanced" now counts forward departures
 * only, which the Note column says; "Moved back" and "Direction unknown" are
 * the rest. "Deal type" names the pipeline ("unknown" when it cannot be read)
 * and "Stage id" tells a current stage from a name recorded at the time
 * (blank). Every cell is blank against a database still at 0130.
 */
export function withStageSplits(cols: CsvColumn<StageRow>[]): CsvColumn<StageRow>[] {
  return [
    ...cols,
    { header: "Deal type", value: (r) => (r.deal_type === undefined ? "" : (r.deal_type ?? "unknown")) },
    { header: "Moved back", value: (r) => countCell(r.regressed) },
    { header: "Direction unknown", value: (r) => countCell(r.departed_unknown) },
    { header: "Stage id", value: (r) => r.stage_id ?? "" },
  ];
}

/**
 * 0154: the lead-source split, APPENDED after From / To. "Convert rate"
 * leaves spam out since 0154 and "Win rate" divides by "Converted, deal
 * visible" — the converted enquiries whose deal the exporter can read — so
 * the file carries both counts it needs to be checked. Blank before 0154.
 */
export function withSourceSplits(cols: CsvColumn<SourceRoiRow>[]): CsvColumn<SourceRoiRow>[] {
  return [
    ...cols,
    { header: "Spam", value: (r) => countCell(r.spam) },
    { header: "Converted, deal visible", value: (r) => countCell(r.converted_visible) },
  ];
}

export const priceReductionsCsv = (
  propertyRef: Map<string, string>,
): CsvColumn<RepeatCut>[] => [
  { header: "Property", value: (r) => propertyRef.get(r.property_id) ?? r.property_id },
  { header: "Cuts", value: (r) => String(r.cuts) },
  { header: "Total cut", value: (r) => fmt(num(r.total_cut)) },
  { header: "First cut", value: (r) => r.first_cut_at },
  { header: "Last cut", value: (r) => r.last_cut_at },
];

/**
 * RPT-4: two exports over different windows were byte-indistinguishable —
 * the window lived only in the audit event, invisible to whoever holds the
 * file. Every report row now carries its From/To. APPENDED, never prepended:
 * the row-substring assertions in report-export.test.ts (and any spreadsheet
 * the desk already built on these columns) read left-to-right.
 */
export function withWindow<T>(cols: CsvColumn<T>[], from: string, to: string): CsvColumn<T>[] {
  return [...cols, { header: "From", value: () => from }, { header: "To", value: () => to }];
}
