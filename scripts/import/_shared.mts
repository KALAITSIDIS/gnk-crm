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
import { batchIdFor, unknownColumns } from "./_rules.mts";

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

/** RFC-4180-ish CSV parse: quoted fields, "" escapes, newlines inside quotes. */
export function parseCsvTable(text: string): { header: string[]; rows: Record<string, string>[] } {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const src = text.replace(/^﻿/, ""); // strip BOM
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  if (rows.length === 0) return { header: [], rows: [] };
  const header = rows[0].map((h) => h.trim());
  return {
    header,
    rows: rows.slice(1).map((r) => {
      const obj: Record<string, string> = {};
      header.forEach((h, i) => (obj[h] = (r[i] ?? "").trim()));
      return obj;
    }),
  };
}

export function parseCsv(text: string): Record<string, string>[] {
  return parseCsvTable(text).rows;
}

/**
 * Load a CSV and, when told which columns the template knows, REFUSE an
 * unknown header before any row is written (audit 2026-09-15, LST-10).
 * The importers read columns by name, so a misspelt header — `bedroom` —
 * used to import every value in it as blank without a word. `--allow-extra`
 * turns the refusal into a warning for a file that carries columns nobody
 * meant to import.
 */
export function loadCsv(
  file: string,
  known?: readonly string[],
  allowExtra = false,
): Record<string, string>[] {
  const path = resolve(process.cwd(), file);
  const { header, rows } = parseCsvTable(readFileSync(path, "utf8"));
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
export const num = (v: string | undefined): number | null => {
  if (!v || !v.trim()) return null;
  const n = Number(v.replace(/[, ]/g, ""));
  return Number.isFinite(n) ? n : null;
};
export const int = (v: string | undefined): number | null => {
  const n = num(v);
  return n === null ? null : Math.trunc(n);
};
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
