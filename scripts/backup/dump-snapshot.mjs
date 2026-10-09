/**
 * ONE SNAPSHOT FOR THE DUMPS AND THE COUNTS THAT CHECK THEM (T-dump-snapshot-counts).
 *
 * The row-count check compared data.sql — one MVCC snapshot, taken when the
 * data pg_dump started — with counts export.mjs read through PostgREST 20-45 s
 * later. On 2026-10-09 the enquiry-alerts cron (every two minutes) inserted
 * sweep row 12367 at 00:46:00.064Z between the two: the dump held all 12365
 * rows that existed when it started, the export saw 12366, and the night was
 * failed for a backup that had lost nothing. Retiming cannot close that — a
 * WakeToRun or catch-up start lands anywhere — and a tolerance would hide a
 * dump that really lost rows.
 *
 * So the comparator moves into the dump's own snapshot. A psql child (the
 * pinned client, same connection and TLS as pg_dump) opens a READ ONLY
 * REPEATABLE READ transaction, counts every table the data dump should hold —
 * enumerated from the catalog, not from a hand list — then exports the
 * snapshot and stays open. Both pg_dumps run with `--snapshot <id>`, which
 * imports it or fails; they never fall back to a fresh one. Every COPY block
 * must then equal its count exactly: an MVCC identity, not a timing hope.
 *
 * Needs a SESSION-mode connection (the pooler on 5432, or direct): the
 * exporting transaction must stay open on one backend while pg_dump's own
 * connection imports it.
 */
import { spawn } from "node:child_process";

/** Printed by `\echo` after the snapshot line; the output is complete once it appears. */
export const SNAPSHOT_END = "__gnk_dump_snapshot_end__";

/**
 * -w: never prompt for a password (the S4U task has no console to answer);
 * -X: no psqlrc; -q -A -t: rows only, unaligned, no headers, no command tags.
 */
export const PSQL_ARGS = ["-X", "-q", "-w", "-A", "-t", "-v", "ON_ERROR_STOP=1"];

const literal = (s) => `'${String(s).replace(/'/g, "''")}'`;
const array = (xs) => `ARRAY[${xs.map(literal).join(", ")}]::text[]`;

/**
 * One SELECT per table, generated from the catalog and run by `\gexec`, each
 * printing one JSON line:
 *   - a plain table: its row count, `FROM ONLY` (a partition counts itself);
 *   - a partitioned parent (`events`): the whole tree, for the events check —
 *     the parent emits no COPY of its own, its partitions do;
 *   - an extension's table: named, NOT counted. PostGIS registers
 *     spatial_ref_sys with a dump filter, so its COPY block is deliberately
 *     short (0 rows against ~8,500) and a count would fail every night.
 * The tables pg_dump is told to exclude are left out by the same list.
 */
export function enumerationSql({ schemas, excluded }) {
  return [
    "SELECT CASE",
    "  WHEN e.extname IS NOT NULL THEN format($q$SELECT json_build_object('schema', %L, 'table', %L, 'extension', %L)$q$, n.nspname, c.relname, e.extname)",
    "  WHEN c.relkind = 'p' THEN format($q$SELECT json_build_object('schema', %L, 'table', %L, 'partitioned', true, 'rows', count(*)) FROM %I.%I$q$, n.nspname, c.relname, n.nspname, c.relname)",
    "  ELSE format($q$SELECT json_build_object('schema', %L, 'table', %L, 'rows', count(*)) FROM ONLY %I.%I$q$, n.nspname, c.relname, n.nspname, c.relname)",
    "END",
    "FROM pg_catalog.pg_class c",
    "JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace",
    "LEFT JOIN pg_catalog.pg_depend d ON d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'",
    "LEFT JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid",
    "WHERE c.relkind IN ('r', 'p')",
    `  AND n.nspname = ANY (${array(schemas)})`,
    `  AND n.nspname || '.' || c.relname <> ALL (${array(excluded)})`,
    "ORDER BY n.nspname, c.relname",
  ].join("\n");
}

/**
 * What psql is fed. The SETs mirror pg_dump's own session (SET ROLE postgres
 * as `--role postgres` does; row_security off, so a table RLS would filter
 * ERRORS instead of counting short; no timeout may end the held transaction
 * while pg_dump still needs it). The enumeration is the transaction's first
 * statement, which fixes the snapshot; the export comes after every count.
 * No COMMIT and no \q: the transaction stays open until close().
 */
export function snapshotSessionScript({ schemas, excluded }) {
  return [
    "SET ROLE postgres;",
    "SET row_security = off;",
    "SET statement_timeout = 0;",
    "SET lock_timeout = 0;",
    "SET idle_in_transaction_session_timeout = 0;",
    "SELECT current_setting('server_version_num')::int >= 170000 AS gnk_pg17 \\gset",
    "\\if :gnk_pg17",
    "SET transaction_timeout = 0;",
    "\\endif",
    "BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;",
    enumerationSql({ schemas, excluded }),
    "\\gexec",
    "SELECT json_build_object('snapshot', pg_catalog.pg_export_snapshot(), 'taken_at', pg_catalog.now());",
    `\\echo ${SNAPSHOT_END}`,
    "",
  ].join("\n");
}

const SNAPSHOT_ID = /^[0-9A-F]{8}-[0-9A-F]{8}-\d+$/i;
const isName = (v) => typeof v === "string" && v.length > 0;

/**
 * The session's output, or null while the end marker has not arrived. Every
 * line before it must be one of the four shapes; anything else — a command
 * tag, a notice, a malformed count — throws, because a check built on output
 * it cannot account for would be checking against less than it claims.
 */
export function parseSnapshotOutput(text) {
  const lines = text.split(/\r?\n/);
  const end = lines.indexOf(SNAPSHOT_END);
  if (end === -1) return null;
  const tables = [];
  const extensionTables = [];
  const partitioned = [];
  const seen = new Set();
  let snap = null;
  for (const line of lines.slice(0, end)) {
    if (line === "") continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      o = null;
    }
    if (o && typeof o === "object" && "snapshot" in o) {
      if (snap) throw new Error("snapshot session: two snapshot lines");
      if (typeof o.snapshot !== "string" || !SNAPSHOT_ID.test(o.snapshot)) {
        throw new Error(`snapshot session: not a snapshot id: ${JSON.stringify(o.snapshot)}`);
      }
      snap = { snapshotId: o.snapshot, takenAt: String(o.taken_at) };
      continue;
    }
    const known =
      o && isName(o.schema) && isName(o.table) &&
      (isName(o.extension) || (Number.isInteger(o.rows) && o.rows >= 0));
    if (!known) throw new Error(`snapshot session: not a snapshot line: ${line.slice(0, 120)}`);
    const name = `${o.schema}.${o.table}`;
    if (seen.has(name)) throw new Error(`snapshot session: ${name} listed twice`);
    seen.add(name);
    if (isName(o.extension)) extensionTables.push({ schema: o.schema, table: o.table, extension: o.extension });
    else if (o.partitioned === true) partitioned.push({ schema: o.schema, table: o.table, rows: o.rows });
    else tables.push({ schema: o.schema, table: o.table, rows: o.rows });
  }
  if (!snap) throw new Error("snapshot session: no snapshot line before the end marker");
  return { ...snap, tables, extensionTables, partitioned };
}

/**
 * Start the session and resolve once it has counted and exported, with
 * `close()` to roll it back afterwards. Rejects — never hangs, never resolves
 * with a partial picture — if psql exits first, prints what it should not,
 * or has not answered within `timeoutMs`; psql is killed in each case. If
 * this process dies instead, psql reads EOF on stdin and the server rolls the
 * transaction back on its own.
 */
export function openDumpSnapshot({
  psql,
  connEnv,
  schemas,
  excluded,
  timeoutMs = 180_000,
  psqlArgs = PSQL_ARGS,
  spawnImpl = spawn,
}) {
  const secrets = [connEnv.PGPASSWORD].filter(Boolean);
  const scrub = (s) => secrets.reduce((acc, sec) => acc.split(sec).join("[REDACTED]"), String(s ?? ""));
  const child = spawnImpl(psql, psqlArgs, {
    env: { ...process.env, ...connEnv },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let out = "";
  let err = "";
  let exitCode = null;
  const exited = new Promise((resolve) => {
    child.on("close", (code) => {
      exitCode = code;
      resolve(code);
    });
  });
  const stderrTail = () =>
    scrub(err).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-6).join("\n      ");

  const close = async () => {
    if (exitCode === null) {
      child.stdin.end("ROLLBACK;\n\\q\n");
      const timer = setTimeout(() => child.kill(), 30_000);
      await exited;
      clearTimeout(timer);
    }
    return exitCode;
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(new Error(message));
    };
    const timer = setTimeout(
      () => fail(`snapshot session: no snapshot within ${timeoutMs / 1000} s`),
      timeoutMs,
    );
    child.on("error", (e) => fail(`snapshot session: ${scrub(e.message)}`));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => (err += d));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      if (settled) return;
      out += d;
      let parsed;
      try {
        parsed = parseSnapshotOutput(out);
      } catch (e) {
        fail(e.message);
        return;
      }
      if (parsed) {
        settled = true;
        clearTimeout(timer);
        resolve({ ...parsed, close });
      }
    });
    exited.then((code) => fail(`snapshot session: psql exit ${code} before the snapshot\n      ${stderrTail()}`));
    child.stdin.on("error", () => {}); // a psql that died is reported by its exit, not by EPIPE
    child.stdin.write(snapshotSessionScript({ schemas, excluded }));
  });
}
