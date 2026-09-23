/**
 * Shared harness for the data-import scripts (T5.6, doc 09). Self-contained —
 * only node_modules imports, so `node --env-file=.env.local scripts/import/*.mts`
 * runs it with native type-stripping (no build step, no app path aliases).
 *
 * Every importer: service role, `--dry-run`, an on-disk report, dedup, and one
 * `imported` event per created row.
 */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { batchIdFor, delimiterOf, unknownColumns } from "./_rules.mts";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface CliArgs {
  file: string;
  dryRun: boolean;
  org?: string;
  /** import a file whose header carries columns the template does not know (they are ignored) */
  allowExtra: boolean;
  /** the run's batch id; default derived from the run time and the file name (_rules.mts) */
  batch?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--allow-extra") args.allowExtra = true;
    else if (a === "--batch") args.batch = argv[++i];
    else if (a.startsWith("--batch=")) args.batch = a.slice(8);
    else if (a === "--file" || a === "-f") args.file = argv[++i];
    else if (a.startsWith("--file=")) args.file = a.slice(7);
    else if (a === "--org") args.org = argv[++i];
    else if (a.startsWith("--org=")) args.org = a.slice(6);
  }
  if (!args.file) {
    console.error("Usage: --file <csv> [--dry-run] [--org <uuid>] [--batch <id>] [--allow-extra]");
    process.exit(1);
  }
  return {
    file: String(args.file),
    dryRun: Boolean(args.dryRun),
    org: args.org as string | undefined,
    allowExtra: Boolean(args.allowExtra),
    batch: args.batch as string | undefined,
  };
}

export function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(
      "Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Run with --env-file=.env.local",
    );
    process.exit(1);
  }
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export async function resolveOrg(
  supabase: ReturnType<typeof serviceClient>,
  override?: string,
): Promise<string> {
  if (override) return override;
  const { data, error } = await supabase.from("organizations").select("id, name");
  if (error) throw new Error(`Cannot read organizations: ${error.message}`);
  if (!data || data.length === 0) throw new Error("No organizations found.");
  if (data.length > 1) {
    throw new Error(
      `Multiple orgs — pass --org <uuid>. Found:\n${data.map((o) => `  ${o.id}  ${o.name}`).join("\n")}`,
    );
  }
  return data[0].id;
}

/* ---- reading a CSV file ----
 *
 * The file's STRUCTURE is checked whole before a single row is handed to an
 * importer (2026-09-23). The reader used to take whatever a line held:
 * surplus cells were dropped (an unquoted `1,250,000` imported as a price of
 * 1 and an area of 250), a missing cell was padded to blank, a repeated
 * header let its second column overwrite the first, and a quote that never
 * closed swallowed the rest of the file — all silently, and all past the
 * number and measurement rules, because every value that came out looked
 * plausible. A cell's position is its meaning, so a file whose positions
 * cannot be trusted is refused, never repaired: which cells "should" be
 * joined is a guess.
 */

/** Why a file cannot be read as a table — every problem, in file order. Never a partial result. */
export class CsvStructureError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`not a well-formed CSV:\n${problems.join("\n")}`);
    this.name = "CsvStructureError";
    this.problems = problems;
  }
}

const QUOTE_INSIDE =
  'a double quote inside an unquoted value — wrap the whole value in double quotes and write each quote inside it twice ("")';
const TEXT_AFTER_QUOTE = "text after the closing double quote — a quoted value must end at its closing quote";
const NEVER_CLOSED = "the double quote that opens this value is never closed";

/** A record as written: the physical line it starts on, its raw cells, and its quoting faults. */
interface RawRecord {
  line: number;
  cells: string[];
  faults: { line: number; cell: number; reason: string }[];
  unclosed: boolean;
}

/**
 * RFC 4180 with two tolerances that cannot change a value: spaces around a
 * quoted value (every cell is trimmed anyway), and a line that is empty or
 * holds only spaces, which is skipped. Line numbers are PHYSICAL — a quoted
 * line break counts — so an error points where an editor does.
 */
function readRecords(src: string, delimiter: string): RawRecord[] {
  const records: RawRecord[] = [];
  let line = 1;
  let record: RawRecord = { line, cells: [], faults: [], unclosed: false };
  let field = "";
  // start: nothing but spaces yet · plain: unquoted text · quoted: inside quotes · closed: after the closing quote
  let state: "start" | "plain" | "quoted" | "closed" = "start";
  let quoteLine = 0;
  let faulted = false; // one fault per cell is enough to locate it

  const fault = (reason: string, at = line) => {
    if (!faulted) record.faults.push({ line: at, cell: record.cells.length, reason });
    faulted = true;
  };
  const endCell = () => {
    record.cells.push(field);
    field = "";
    state = "start";
    faulted = false;
  };
  const endRecord = () => {
    endCell();
    const blank = record.cells.length === 1 && record.cells[0].trim() === "" && record.faults.length === 0;
    if (!blank) records.push(record);
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (state === "quoted") {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        state = "closed";
      } else {
        if (c === "\n" || (c === "\r" && src[i + 1] !== "\n")) line++;
        field += c;
      }
    } else if (c === delimiter) {
      endCell();
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      endRecord();
      line++;
      record = { line, cells: [], faults: [], unclosed: false };
    } else if (state === "start" && c === '"') {
      state = "quoted";
      quoteLine = line;
      field = ""; // the spaces before it
    } else if (state === "closed") {
      if (c !== " " && c !== "\t") {
        fault(TEXT_AFTER_QUOTE);
        state = "plain";
        field += c;
      }
    } else {
      if (c === '"') fault(QUOTE_INSIDE);
      if (c !== " " && c !== "\t") state = "plain";
      field += c;
    }
  }
  if (state === "quoted") {
    fault(NEVER_CLOSED, quoteLine);
    record.unclosed = true;
    endRecord();
  } else if (field !== "" || record.cells.length > 0 || state === "closed") {
    endRecord(); // the last line had no line break
  }
  return records;
}

/**
 * Parse a CSV into its header and rows, or throw `CsvStructureError` naming
 * every problem: a blank or repeated header name, a row with more or fewer
 * cells than the header, a quote in the wrong place, a quote never closed.
 * A problem in the LAST row refuses the whole file — nothing is returned, so
 * nothing before it can be imported either. Messages carry line numbers,
 * column numbers, header names and counts, never a cell's value.
 *
 * Comma- OR semicolon-separated, decided by the header line (`delimiterOf`):
 * Excel under Greek regional settings saves "CSV" with semicolons.
 */
export function parseCsvTable(text: string): { header: string[]; rows: Record<string, string>[] } {
  const src = text.replace(/^﻿/, ""); // strip BOM
  const delimiter = delimiterOf(src.split(/\r?\n/, 1)[0] ?? "");
  const records = readRecords(src, delimiter);
  if (records.length === 0) return { header: [], rows: [] };
  const [head, ...body] = records;
  const header = head.cells.map((h) => h.trim());
  const problems: string[] = [];

  for (const f of head.faults) problems.push(`line ${f.line} (header), column ${f.cell + 1}: ${f.reason}`);
  header.forEach((name, i) => {
    if (name === "") {
      problems.push(
        `line ${head.line} (header): column ${i + 1} has no name — delete the empty column ` +
          "(a separator at the end of the header line makes one)",
      );
    }
  });
  if (!head.unclosed) {
    const positions = new Map<string, number[]>();
    header.forEach((name, i) => {
      if (name !== "") positions.set(name, [...(positions.get(name) ?? []), i + 1]);
    });
    for (const [name, columns] of positions) {
      if (columns.length > 1) {
        problems.push(
          `line ${head.line} (header): column "${name}" appears more than once (columns ${columns.join(", ")}) — keep one`,
        );
      }
    }
  }

  const example = delimiter === ";" ? '"pool;garden"' : '"1,250,000"';
  for (const record of body) {
    for (const f of record.faults) {
      const name = header[f.cell] ? ` (${header[f.cell]})` : "";
      problems.push(`line ${f.line}, column ${f.cell + 1}${name}: ${f.reason}`);
    }
    const found = record.cells.length;
    if (record.unclosed || found === header.length) continue; // an unclosed quote swallowed the count
    problems.push(
      `line ${record.line}: expected ${header.length} cells (one per header column), found ${found} — ` +
        (found > header.length
          ? `a value that contains "${delimiter}" must be wrapped in double quotes, e.g. ${example}`
          : "every row needs a separator for every column, even an empty one"),
    );
  }
  if (problems.length > 0) throw new CsvStructureError(problems);

  return {
    header,
    rows: body.map((record) => Object.fromEntries(header.map((h, i) => [h, record.cells[i].trim()]))),
  };
}

/** How many structure problems `loadCsv` prints before summarising the rest. */
const PROBLEMS_SHOWN = 20;

/**
 * Load a CSV for an importer, and stop the run before its first write when
 * the file cannot be trusted. Two refusals, in this order:
 *
 * - its STRUCTURE (`parseCsvTable`, 2026-09-23) — always, dry run or live;
 *   `--allow-extra` does not reach it.
 * - when told which columns the template knows, an unknown header (audit
 *   2026-09-15, LST-10). The importers read columns by name, so a misspelt
 *   header — `bedroom` — used to import every value in it as blank without a
 *   word. `--allow-extra` turns this refusal, and only this one, into a
 *   warning for a file that carries columns nobody meant to import.
 */
export function loadCsv(
  file: string,
  known?: readonly string[],
  allowExtra = false,
): Record<string, string>[] {
  const path = resolve(process.cwd(), file);
  let table: ReturnType<typeof parseCsvTable>;
  try {
    table = parseCsvTable(readFileSync(path, "utf8"));
  } catch (e) {
    if (!(e instanceof CsvStructureError)) throw e;
    const shown = e.problems.slice(0, PROBLEMS_SHOWN);
    const more = e.problems.length - shown.length;
    console.error(
      `Cannot import ${file}: it is not a well-formed CSV, so nothing was imported.\n` +
        shown.map((p) => `  ${p}`).join("\n") +
        (more > 0 ? `\n  …and ${more} more` : "") +
        "\nEvery row is checked before any is written. A value that contains the separator, a double quote " +
        'or a line break must be wrapped in double quotes ("1,250,000"), with each quote inside it written ' +
        'twice (""). See docs/09_DATA_IMPORT_TEMPLATES.md.',
    );
    process.exit(1);
  }
  const { header, rows } = table;
  if (known) {
    const unknown = unknownColumns(header, known);
    if (unknown.length > 0 && !allowExtra) {
      console.error(
        `Unknown column${unknown.length === 1 ? "" : "s"} in ${file}: ${unknown.join(", ")}\n` +
          "The importer reads only the columns in docs/09_DATA_IMPORT_TEMPLATES.md; a misspelt " +
          "header would import as blank. Fix the header, or pass --allow-extra to ignore these.",
      );
      process.exit(1);
    }
    if (unknown.length > 0) console.warn(`ignoring column(s): ${unknown.join(", ")}`);
  }
  return rows;
}

/* ---- field coercion ---- */
export const str = (v: string | undefined): string | null => (v && v.trim() ? v.trim() : null);
export const bool = (v: string | undefined): boolean => /^(true|yes|1)$/i.test((v ?? "").trim());
// Numbers are NOT coerced here any more: `parseNumberColumns` (_rules.mts)
// reads them the way Cyprus writes them and REFUSES what it cannot read. The
// old `num()` stripped every comma (85,5 → 855) and `int()` truncated (2.9 → 2).
export const list = (v: string | undefined): string[] =>
  (v ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

export function normalizePhone(raw: string | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  const parsed = parsePhoneNumberFromString(raw.trim(), "CY");
  return parsed && parsed.isValid() ? parsed.number : null;
}

/* ---- report ---- */
export interface RowResult {
  row: number;
  outcome: "created" | "skipped" | "error";
  detail: string;
  ref?: string;
}

export class Report {
  results: RowResult[] = [];
  kind: string;
  file: string;
  dryRun: boolean;
  /** names the run — in every `imported` event of it and in the report's file name */
  batch: string;
  constructor(kind: string, file: string, dryRun: boolean, batch?: string) {
    this.kind = kind;
    this.file = file;
    this.dryRun = dryRun;
    this.batch = batchIdFor(file, new Date(), batch);
  }

  add(r: RowResult) {
    this.results.push(r);
  }

  counts() {
    return {
      total: this.results.length,
      created: this.results.filter((r) => r.outcome === "created").length,
      skipped: this.results.filter((r) => r.outcome === "skipped").length,
      errors: this.results.filter((r) => r.outcome === "error").length,
    };
  }

  finish(): string {
    const c = this.counts();
    const dir = resolve(HERE, "reports");
    mkdirSync(dir, { recursive: true });
    const path = resolve(dir, `${this.kind}-${this.dryRun ? "dryrun-" : ""}${this.batch}.json`);
    writeFileSync(
      path,
      JSON.stringify(
        {
          kind: this.kind,
          file: this.file,
          batch: this.batch,
          mode: this.dryRun ? "dry-run" : "live",
          ...c,
          results: this.results,
        },
        null,
        2,
      ),
    );
    console.log(
      `\n${this.dryRun ? "[DRY RUN] " : ""}${this.kind}: ${c.created} created, ${c.skipped} skipped, ${c.errors} errors (of ${c.total}).`,
    );
    for (const r of this.results.filter((x) => x.outcome === "error")) {
      console.log(`  row ${r.row}: ERROR — ${r.detail}`);
    }
    console.log(`Batch: ${this.batch}\nReport: ${path}`);
    return path;
  }
}

/** One `imported` event per created row (system actor). Fires the hash-chain
 * trigger like any insert, so `verify_events_chain` stays valid. */
export async function logImported(
  supabase: ReturnType<typeof serviceClient>,
  orgId: string,
  entityType: string,
  entityId: string,
  payload: Record<string, unknown>,
) {
  const { error } = await supabase.from("events").insert({
    org_id: orgId,
    actor_id: null,
    entity_type: entityType,
    entity_id: entityId,
    event_type: "imported",
    payload: { source: "csv_import", ...payload },
  });
  if (error) throw new Error(`event insert failed: ${error.message}`);
}
