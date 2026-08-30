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

export interface SourceRoiRow {
  source: string;
  leads: number;
  converted: number;
  won: number;
  won_value: number | null;
  convert_rate: number | null;
  win_rate: number | null;
}

export interface TimeToClose {
  won: { count: number; avg_days: number | null; median_days: number | null; p90_days: number | null };
  lost: { count: number; avg_days: number | null; median_days: number | null };
}

export interface StageRow {
  stage: string;
  entered: number;
  advanced: number;
  advance_rate: number | null;
}

export interface StageConversion {
  derived_from: string;
  stage_key: string;
  stages: StageRow[];
  transitions: Array<{ from: string | null; to: string; deals: number }>;
  outcomes: { won: number; lost: number };
  note: string;
}

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

export const stageConversionCsv = (): CsvColumn<StageRow>[] => [
  { header: "Stage", value: (r) => r.stage },
  { header: "Entered", value: (r) => String(r.entered) },
  { header: "Advanced", value: (r) => String(r.advanced) },
  { header: "Advance rate", value: (r) => pct(num(r.advance_rate)) },
];

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
