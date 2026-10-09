import { describe, expect, it } from "vitest";
import {
  SNAPSHOT_END,
  enumerationSql,
  openDumpSnapshot,
  parseSnapshotOutput,
  snapshotSessionScript,
} from "./dump-snapshot.mjs";

/**
 * The 2026-10-09 night failed because the row-count check compared data.sql
 * (one snapshot, taken when the data pg_dump started) with counts read 20-45 s
 * later through PostgREST, and the enquiry-alerts cron inserted a row between
 * the two. dump-snapshot.mjs holds ONE read-only REPEATABLE READ transaction
 * open in a psql child: it counts every table the dump should hold, exports
 * its snapshot, and both pg_dumps read that snapshot with --snapshot. Counts
 * and dump then describe the same instant, whatever is written around them.
 */

const SCHEMAS = ["public", "events_parts", "auth", "storage"];
const EXCLUDED = ["auth.schema_migrations", "storage.migrations", "supabase_functions.migrations"];

describe("snapshotSessionScript", () => {
  const script = snapshotSessionScript({ schemas: SCHEMAS, excluded: EXCLUDED });
  const lines = script.split("\n");
  const at = (re: RegExp) => lines.findIndex((l) => re.test(l));

  it("mirrors pg_dump's session — role, no row security, no timeouts — before the transaction opens", () => {
    for (const re of [/^SET ROLE postgres;$/, /^SET row_security = off;$/, /^SET statement_timeout = 0;$/,
      /^SET lock_timeout = 0;$/, /^SET idle_in_transaction_session_timeout = 0;$/]) {
      expect(at(re), String(re)).toBeGreaterThanOrEqual(0);
      expect(at(re), String(re)).toBeLessThan(at(/^BEGIN /));
    }
    // pg 17 only, and silently: a plain SELECT would print a row into the output
    expect(script).toMatch(/\\gset\n\\if :gnk_pg17\nSET transaction_timeout = 0;\n\\endif\n/);
  });

  it("opens READ ONLY REPEATABLE READ, so its first statement fixes the one snapshot everything shares", () => {
    expect(lines[at(/^BEGIN /)]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;");
    // the enumeration is the transaction's first statement, the export comes after every count
    expect(at(/^\\gexec$/)).toBeGreaterThan(at(/^BEGIN /));
    expect(at(/pg_export_snapshot\(\)/)).toBeGreaterThan(at(/^\\gexec$/));
    expect(lines.filter(Boolean).at(-1)).toBe(`\\echo ${SNAPSHOT_END}`);
  });

  it("leaves the transaction open for pg_dump to import — no COMMIT, ROLLBACK or \\q", () => {
    expect(script).not.toMatch(/\b(COMMIT|ROLLBACK)\b/i);
    expect(script).not.toMatch(/\\q\b/);
  });
});

describe("enumerationSql", () => {
  const sql = enumerationSql({ schemas: SCHEMAS, excluded: EXCLUDED });

  it("covers the dumped schemas minus the excluded tables, quoted as literals", () => {
    expect(sql).toContain("ARRAY['public', 'events_parts', 'auth', 'storage']");
    expect(sql).toContain("ARRAY['auth.schema_migrations', 'storage.migrations', 'supabase_functions.migrations']");
    expect(enumerationSql({ schemas: ["it's"], excluded: [] })).toContain("ARRAY['it''s']");
  });

  it("counts plain tables with ONLY, partitioned parents whole, and lists extension tables without a count", () => {
    expect(sql).toMatch(/FROM ONLY %I\.%I/);
    expect(sql).toMatch(/'partitioned', true, 'rows', count\(\*\)\) FROM %I\.%I/);
    expect(sql).toMatch(/'extension', %L\)/);
    expect(sql).toMatch(/relkind IN \('r', 'p'\)/);
    expect(sql).toMatch(/deptype = 'e'/);
  });
});

describe("parseSnapshotOutput", () => {
  const table = (schema: string, t: string, rows: number) => JSON.stringify({ schema, table: t, rows });
  const snapLine = JSON.stringify({ snapshot: "00000003-0000001B-1", taken_at: "2026-10-09T00:45:38.1+00:00" });

  it("waits for the end marker", () => {
    expect(parseSnapshotOutput(`${table("public", "leads", 11)}\n${snapLine}\n`)).toBeNull();
  });

  it("reads tables, extension tables, partitioned parents and the snapshot, CRLF included", () => {
    const out = [
      table("auth", "users", 2),
      JSON.stringify({ schema: "public", table: "spatial_ref_sys", extension: "postgis" }),
      JSON.stringify({ schema: "public", table: "events", partitioned: true, rows: 335 }),
      table("public", "enquiry_alert_sweep_runs", 12365),
      snapLine,
      SNAPSHOT_END,
      "",
    ].join("\r\n");

    expect(parseSnapshotOutput(out)).toEqual({
      snapshotId: "00000003-0000001B-1",
      takenAt: "2026-10-09T00:45:38.1+00:00",
      tables: [
        { schema: "auth", table: "users", rows: 2 },
        { schema: "public", table: "enquiry_alert_sweep_runs", rows: 12365 },
      ],
      extensionTables: [{ schema: "public", table: "spatial_ref_sys", extension: "postgis" }],
      partitioned: [{ schema: "public", table: "events", rows: 335 }],
    });
  });

  it("refuses output it cannot account for, rather than checking against less than it should", () => {
    const end = `${snapLine}\n${SNAPSHOT_END}\n`;
    expect(() => parseSnapshotOutput(`SET\n${end}`)).toThrow(/not a snapshot line/);
    expect(() => parseSnapshotOutput(`${table("public", "a", 1)}\n${table("public", "a", 1)}\n${end}`)).toThrow(/twice/);
    expect(() => parseSnapshotOutput(`${table("public", "a", 1)}\n${SNAPSHOT_END}\n`)).toThrow(/no snapshot/);
    expect(() => parseSnapshotOutput(`${snapLine}\n${end}`)).toThrow(/two snapshot/);
    expect(() => parseSnapshotOutput(`${JSON.stringify({ snapshot: "x;drop", taken_at: "t" })}\n${SNAPSHOT_END}\n`)).toThrow(/snapshot id/);
    expect(() => parseSnapshotOutput(`${JSON.stringify({ schema: "public", table: "a", rows: "1" })}\n${end}`)).toThrow(/not a snapshot line/);
  });
});

/**
 * A stand-in psql: node itself, told what to do by a script. It reads stdin the
 * way psql does and answers with what the real session prints.
 */
const fakePsql = (body: string) => ({ psql: process.execPath, psqlArgs: ["-e", body] });

const ANSWERING = `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  input += d;
  if (input.includes("\\\\echo ${SNAPSHOT_END}") && !input.includes("__answered__")) {
    input += "__answered__";
    process.stdout.write('{"schema":"public","table":"leads","rows":11}\\r\\n');
    process.stdout.write('{"snapshot":"00000003-0000001B-1","taken_at":"2026-10-09T00:45:38+00:00"}\\r\\n');
    process.stdout.write("${SNAPSHOT_END}\\r\\n");
  }
  if (/ROLLBACK;\\n\\\\q\\n/.test(input)) process.exit(input.includes("BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;") ? 0 : 9);
});
`;

describe("openDumpSnapshot", () => {
  it("resolves with the counts and the snapshot id, and close() rolls the session back", async () => {
    const snap = await openDumpSnapshot({
      ...fakePsql(ANSWERING), connEnv: {}, schemas: SCHEMAS, excluded: EXCLUDED, timeoutMs: 10_000,
    });

    expect(snap.snapshotId).toBe("00000003-0000001B-1");
    expect(snap.tables).toEqual([{ schema: "public", table: "leads", rows: 11 }]);
    // exit 0 only if it saw the transaction open and then ROLLBACK + \q
    expect(await snap.close()).toBe(0);
  });

  it("rejects when psql exits first, with its exit code and the password scrubbed", async () => {
    const body = `process.stderr.write("FATAL: password authentication failed: hunter2\\n"); process.exit(2);`;

    await expect(
      openDumpSnapshot({ ...fakePsql(body), connEnv: { PGPASSWORD: "hunter2" }, schemas: SCHEMAS, excluded: EXCLUDED, timeoutMs: 10_000 }),
    ).rejects.toThrow(/exit 2.*\[REDACTED\]/s);
  });

  it("rejects on a timeout instead of hanging the 03:45 run, and kills psql", async () => {
    const body = `process.stdin.resume(); setInterval(() => {}, 1000);`;
    const started = Date.now();

    await expect(
      openDumpSnapshot({ ...fakePsql(body), connEnv: {}, schemas: SCHEMAS, excluded: EXCLUDED, timeoutMs: 500 }),
    ).rejects.toThrow(/no snapshot within 0\.5 s/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("rejects output it cannot parse", async () => {
    const body = `process.stdin.on("data", () => { process.stdout.write("garbage\\n${SNAPSHOT_END}\\n"); });`;

    await expect(
      openDumpSnapshot({ ...fakePsql(body), connEnv: {}, schemas: SCHEMAS, excluded: EXCLUDED, timeoutMs: 10_000 }),
    ).rejects.toThrow(/not a snapshot line/);
  });
});
