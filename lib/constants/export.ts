/**
 * The list CSV exports' ceiling and what a refused export says — shared by the
 * seven export routes (`lib/services/export-read.ts`) and the button that
 * downloads them (`components/features/shared/export-csv-button.tsx`), so the server and the
 * page cannot disagree about either (DECISIONS T-export-complete).
 *
 * The ceiling bounds the work one request does (PERF-2: an unbounded read is a
 * DoS on itself). Up to it, an export holds EVERY matching record; past it,
 * nothing is downloaded and the user is told to narrow the export — a partial
 * file that looks complete is the one outcome that is never allowed.
 */
export const EXPORT_CEILING = 10_000;

const TOO_MANY = `More than ${EXPORT_CEILING.toLocaleString("en-GB")} records match, which is more than one export holds.`;

/** Past the ceiling, on a list whose filters can narrow it. */
export const EXPORT_TOO_MANY_MESSAGE = `${TOO_MANY} Nothing was downloaded — narrow the filters and export again.`;

/** Past the ceiling, on a list with no filters (a deal pipeline, Viewings): say what CAN be done. My tasks is filterable now and gets the narrowing message. */
export const EXPORT_TOO_MANY_UNFILTERED_MESSAGE =
  `${TOO_MANY} Nothing was downloaded — this list has no filters to narrow it; ask an administrator for a full data export.`;

export const EXPORT_FAILED_MESSAGE = "The export failed and nothing was downloaded. Try again.";

/**
 * Why an export route refused; the body of its non-CSV answer carries it.
 * `invalid`: the request's filters could not be run as asked (a search longer
 * than the list allows) — nothing was read (T-keys-search-length).
 */
export type ExportRefusalReason = "too_many" | "failed" | "invalid";
