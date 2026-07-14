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

const HERE = dirname(fileURLToPath(import.meta.url));

export interface CliArgs {
  file: string;
  dryRun: boolean;
  org?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--file" || a === "-f") args.file = argv[++i];
    else if (a.startsWith("--file=")) args.file = a.slice(7);
    else if (a === "--org") args.org = argv[++i];
    else if (a.startsWith("--org=")) args.org = a.slice(6);
  }
  if (!args.file) {
    console.error("Usage: --file <csv> [--dry-run] [--org <uuid>]");
    process.exit(1);
  }
  return { file: String(args.file), dryRun: Boolean(args.dryRun), org: args.org as string | undefined };
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
export function parseCsv(text: string): Record<string, string>[] {
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
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    header.forEach((h, i) => (obj[h] = (r[i] ?? "").trim()));
    return obj;
  });
}

export function loadCsv(file: string): Record<string, string>[] {
  const path = resolve(process.cwd(), file);
  return parseCsv(readFileSync(path, "utf8"));
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
  constructor(kind: string, file: string, dryRun: boolean) {
    this.kind = kind;
    this.file = file;
    this.dryRun = dryRun;
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
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = resolve(HERE, "reports");
    mkdirSync(dir, { recursive: true });
    const path = resolve(dir, `${this.kind}-${this.dryRun ? "dryrun-" : ""}${stamp}.json`);
    writeFileSync(
      path,
      JSON.stringify(
        { kind: this.kind, file: this.file, mode: this.dryRun ? "dry-run" : "live", ...c, results: this.results },
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
    console.log(`Report: ${path}`);
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
