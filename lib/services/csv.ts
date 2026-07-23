/**
 * CSV serialization for list exports (IMPROVEMENTS B10).
 *
 * Symmetric with the import-side parser in `scripts/import/_shared.mts`: RFC-4180
 * quoting, `""` escaping, CRLF rows, leading BOM. A value written here round-trips
 * back through `parseCsv` unchanged (modulo the parser's field trimming).
 *
 * Pure and I/O-free so it is unit-testable and reusable by any list page.
 */

const BOM = "﻿";
const EOL = "\r\n";

/** Leading characters a spreadsheet may interpret as the start of a formula. */
const FORMULA_LEADS = new Set(["=", "+", "-", "@", "\t", "\r"]);

export interface CsvColumn<T> {
  header: string;
  /** Cell value for a row; null/undefined become an empty cell. */
  value: (row: T) => string | null | undefined;
}

/**
 * Guard against spreadsheet formula injection. Export fields are user-typed
 * (names, notes, reasons), so a value like `=HYPERLINK(...)` or `+1+1` would be
 * executed on open in Excel/Sheets. Prefixing a single quote forces the cell to
 * text without changing what a human reads. See OWASP "CSV Injection".
 */
function neutraliseFormula(value: string): string {
  return value.length > 0 && FORMULA_LEADS.has(value[0]) ? `'${value}` : value;
}

function escapeField(raw: string | null | undefined): string {
  const value = neutraliseFormula(raw ?? "");
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Serialize `rows` to a CSV document (BOM + header + one line per row). */
export function toCsv<T>(columns: CsvColumn<T>[], rows: readonly T[]): string {
  const lines: string[] = [columns.map((c) => escapeField(c.header)).join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => escapeField(c.value(row))).join(","));
  }
  return BOM + lines.join(EOL) + EOL;
}

/**
 * A filename-safe, dated basename for a download, e.g.
 * `contacts-2026-07-23.csv`. Slug is caller-controlled (not user input).
 */
export function csvFilename(slug: string, now: Date = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  return `${slug}-${date}.csv`;
}
