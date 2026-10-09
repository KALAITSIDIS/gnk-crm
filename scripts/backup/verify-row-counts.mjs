import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Cross-check `data.sql`'s COPY blocks against row counts taken in the dump's
 * OWN snapshot (dump-snapshot.mjs), and the JSON export against the same.
 *
 * capture.mjs judged the data dump by a 10 KB size floor, one header line, two
 * substring greps and the partitioned-events count. None of those can see a
 * table that is simply absent: strip the ENTIRE public section from a real
 * 246 KB `data.sql` and the remaining 178 KB of auth, storage and events_parts
 * still clears every check — 17.8x the floor. `pg_dump` is not run with
 * `--strict-names`, so a mistyped `--schema public` is ignored silently.
 *
 * T-dump-row-counts (2026-09-20) compared each COPY block with export.mjs's
 * PostgREST JSON. That comparator was read 20-45 s after the dump's snapshot,
 * and on 2026-10-09 the two-minute enquiry-alerts cron inserted a row between
 * the two: dump 12365, export 12366, and a complete backup was failed as
 * untrustworthy (T-dump-snapshot-counts). The comparator is now counted inside
 * the very transaction both pg_dumps import, so an intact dump equals it
 * EXACTLY — an MVCC identity, not a timing hope — in both directions, for
 * every table the dump holds: public, auth, storage and each events partition.
 *
 * The JSON export still runs (it is the only capture of storage objects, and
 * a readable copy of the tables) and is still read, for what it can honestly
 * say: every table it wrote must exist in the dump (fatal if not), and how far
 * each drifted while production kept working (a warning — data.sql, not the
 * JSON, is what a restore loads).
 */

/** Tables the snapshot must have counted, or its enumeration is wrong. */
const SENTINELS = [
  ["public", "organizations"],
  ["auth", "users"],
  ["storage", "objects"],
];
/** The schema that holds the `events` partitions (0063); at least one must be counted. */
const EVENTS_PARTITION_SCHEMA = "events_parts";

const COPY_HEADER = /^COPY "([^"]+)"\."([^"]+)" \(/gm;

/**
 * Rows in a table's COPY block, or null when the block is absent or never
 * terminates (a truncated file).
 *
 * The terminator is a line that is exactly `\.`, and for an EMPTY table it is
 * the FIRST line after the header with no newline before it. Splitting the body
 * on "\n\\." misses that case and silently swallows the rows of the next block:
 * every zero-row table then reports the row count of whatever followed it.
 * Scanning line by line is what makes an empty table read as 0 instead.
 *
 * Matching the line exactly is also what keeps real data safe. pg_dump escapes
 * a backslash in a value as `\\`, so no row line can ever equal `\.` — but 248
 * lines of the 2026-09-20 dump contain backslashes, so a looser `startsWith`
 * or `includes` test would terminate a block early and under-count it.
 */
export function copyRowCount(dataSql, table, schema = "public") {
  const i = dataSql.indexOf(`COPY "${schema}"."${table}" `);
  if (i === -1) return null;
  const body = dataSql.slice(i).split("FROM stdin;\n")[1];
  if (body === undefined) return null;
  let rows = 0;
  for (const line of body.split("\n")) {
    if (line === "\\.") return rows;
    if (line !== "") rows++;
  }
  return null;
}

const q = (schema, table) => `"${schema}"."${table}"`;

/**
 * Every way the dump can disagree with its own snapshot. Fatal, all of them.
 *
 *   - a counted table whose block is missing, truncated, short or long;
 *   - a COPY block for a table the snapshot never counted (the enumeration
 *     fell behind what pg_dump dumps — the check would not cover it);
 *   - a snapshot that did not count the sentinel tables (an enumeration that
 *     shrank with the dump, e.g. one schema typo shared by both, would
 *     otherwise compare nothing and pass).
 * An extension's table (PostGIS's spatial_ref_sys, dumped through its config
 * filter) is listed by the snapshot and deliberately neither compared nor
 * flagged.
 *
 * @param {string} dataSql
 * @param {{tables: {schema: string, table: string, rows: number}[],
 *          extensionTables: {schema: string, table: string}[]}} snap
 * @returns {string[]}
 */
export function snapshotCountProblems(dataSql, snap) {
  const problems = [];
  for (const { schema, table, rows } of snap.tables) {
    const got = copyRowCount(dataSql, table, schema);
    if (got === rows) continue;
    if (got !== null) {
      problems.push(`data: ${q(schema, table)} has ${got} row(s) in the dump, ${rows} in the dump's own snapshot`);
    } else if (dataSql.includes(`COPY ${q(schema, table)} `)) {
      problems.push(`data: COPY ${q(schema, table)} never terminates — the dump is truncated (its snapshot has ${rows} row(s))`);
    } else {
      problems.push(`data: no COPY ${q(schema, table)} — the dump's own snapshot has ${rows} row(s); the dump lost the table`);
    }
  }

  const known = new Set([...snap.tables, ...snap.extensionTables].map((t) => q(t.schema, t.table)));
  for (const m of dataSql.matchAll(COPY_HEADER)) {
    if (!known.has(q(m[1], m[2]))) {
      problems.push(`data: COPY ${q(m[1], m[2])} is in the dump but was not counted in its snapshot — the row check does not cover it`);
    }
  }

  const counted = new Set(snap.tables.map((t) => q(t.schema, t.table)));
  for (const [schema, table] of SENTINELS) {
    if (!counted.has(q(schema, table))) {
      problems.push(`data: the snapshot did not count ${q(schema, table)} — the table enumeration is wrong, so the row check did NOT run`);
    }
  }
  if (!snap.tables.some((t) => t.schema === EVENTS_PARTITION_SCHEMA)) {
    problems.push(`data: the snapshot counted no "${EVENTS_PARTITION_SCHEMA}" partition — the table enumeration is wrong, so the row check did NOT run`);
  }
  return problems;
}

/**
 * The JSON export, judged against the dump's snapshot. export.mjs reads each
 * table through PostgREST after the dumps, page by page with no shared
 * snapshot, so its counts can legitimately differ: production kept working.
 *
 *   problem — a table it wrote that the snapshot does not have (the export
 *             and the dump disagree about what exists, which no concurrent
 *             write explains);
 *   warning — a count that drifted, and a public table the dump holds that
 *             the export does not cover.
 * `events.json` is compared with the partitioned parent's count.
 *
 * @param {Record<string, number>} exportCounts  table -> rows, from tableCountsFromSet
 * @returns {{problems: string[], warnings: string[]}}
 */
export function exportAgainstSnapshot(exportCounts, snap) {
  const problems = [];
  const warnings = [];
  const inSnapshot = new Map(
    [...snap.tables, ...snap.partitioned].filter((t) => t.schema === "public").map((t) => [t.table, t.rows]),
  );
  const extension = new Set(snap.extensionTables.filter((t) => t.schema === "public").map((t) => t.table));
  for (const [table, rows] of Object.entries(exportCounts)) {
    if (extension.has(table)) continue;
    const expected = inSnapshot.get(table);
    if (expected === undefined) {
      problems.push(`export: public.${table} has json but the dump's snapshot has no such table — the export and the dump disagree about what exists`);
    } else if (expected !== rows) {
      warnings.push(
        `export: public.${table} json ${rows}, dump snapshot ${expected} — written between the snapshot and the export's read; data.sql matches its snapshot and is the restore source`,
      );
    }
  }
  for (const { schema, table, rows } of snap.tables) {
    if (schema === "public" && !(table in exportCounts)) {
      warnings.push(`export: public.${table} is in the dump (${rows} row(s)) but not in the export`);
    }
  }
  return { problems, warnings };
}

/**
 * Row counts per table from a set's `data/<table>.json`, or null when the set
 * has no `data` directory at all.
 *
 * Null and `{}` are different answers and the caller must treat them as such:
 * `{}` is "export ran and found no tables", null is "export's output is not
 * here". The first version of this check inlined `readdirSync` in capture.mjs
 * against the WRONG directory, got the null case on every run, and reported it
 * as a deliberate `--skip-storage` skip — a check that did nothing while
 * explaining itself with a reason that was not true.
 *
 * @param {string} setDir the set root — capture.mjs's `stageDir`, i.e.
 *   `<stagingRoot>/<stamp>`, NOT `stagingRoot`. export.mjs appends its own date
 *   stamp to its `--out`, and capture stages the set under that same stamp and
 *   renames THAT into place, which is why the two agree only one level down.
 * @returns {Record<string, number> | null}
 */
export function tableCountsFromSet(setDir) {
  const dir = join(setDir, "data");
  if (!existsSync(dir)) return null;
  const counts = {};
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    const rows = JSON.parse(readFileSync(join(dir, f), "utf8"));
    if (Array.isArray(rows)) counts[f.replace(/\.json$/, "")] = rows.length;
  }
  return counts;
}

/**
 * The whole row check, as capture.mjs runs it over a STAGED set — one tested
 * entry point, because the defect the T-dump-row-counts addendum records was
 * in the wiring (the wrong directory), not in the comparison.
 *
 * @param {{dataSql: string, stageDir: string, snap: object | null, skipStorage: boolean}} args
 * @returns {{problems: string[], warnings: string[], lines: string[]}}
 */
export function verifyStagedSet({ dataSql, stageDir, snap, skipStorage }) {
  if (!snap) return { problems: ["data: no snapshot counts — the row check did NOT run"], warnings: [], lines: [] };
  const problems = snapshotCountProblems(dataSql, snap);
  const warnings = [];
  const lines = [
    problems.length
      ? `data: ${problems.length} problem(s) against the snapshot's ${snap.tables.length} table counts`
      : `data: ${snap.tables.length} tables match their snapshot count exactly`,
  ];

  const counts = tableCountsFromSet(stageDir);
  if (counts === null) {
    if (skipStorage) lines.push("export: json cross-check SKIPPED — --skip-storage, export.mjs wrote no table json");
    else {
      problems.push(
        `export: no data/*.json under ${stageDir} — export.mjs ran but its table json is not where the check reads it, so the export check did NOT run`,
      );
    }
    return { problems, warnings, lines };
  }
  const e = exportAgainstSnapshot(counts, snap);
  problems.push(...e.problems);
  warnings.push(...e.warnings);
  const drifted = e.warnings.filter((w) => w.includes(" json ")).length;
  lines.push(
    `export: ${Object.keys(counts).length} table json files checked against the snapshot — ${drifted ? `${drifted} drifted (warning)` : "none drifted"}`,
  );
  return { problems, warnings, lines };
}
