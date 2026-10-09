/**
 * The nightly backup's row check counts every table inside the snapshot the
 * dumps import (scripts/backup/dump-snapshot.mjs). Requires the local Supabase
 * stack. Run: npm run test:rls
 *
 * The real session is a psql child, and CI has no psql 17 client — so this
 * runs the SAME generated SQL through node-postgres, in a REPEATABLE READ
 * transaction on a migrated database, and parses the output with the same
 * parser. What it pins: the catalog enumeration finds what pg_dump dumps
 * (the sentinels, every exported table, each events partition, the
 * partitioned parent), names PostGIS's spatial_ref_sys as an extension table
 * instead of counting it, leaves the excluded platform tables out, and every
 * generated count runs.
 */
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SNAPSHOT_END, enumerationSql, parseSnapshotOutput } from "../../scripts/backup/dump-snapshot.mjs";
import { TABLES } from "../../scripts/backup/export-tables.mjs";
import { DATA_DUMP_EXCLUDED_TABLES, DATA_SCHEMAS } from "../../scripts/backup/pg-native.mjs";

const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

let db: Client;
let snap: NonNullable<ReturnType<typeof parseSnapshotOutput>>;

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  await db.connect();
  await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY");
  const { rows: statements } = await db.query<{ stmt: string }>(
    enumerationSql({ schemas: DATA_SCHEMAS, excluded: DATA_DUMP_EXCLUDED_TABLES }),
  );
  const out: string[] = [];
  for (const { stmt: sql } of statements) {
    const { rows } = await db.query<{ json_build_object: unknown }>(sql);
    out.push(JSON.stringify(rows[0].json_build_object));
  }
  const { rows } = await db.query<{ s: unknown }>(
    "SELECT json_build_object('snapshot', pg_catalog.pg_export_snapshot(), 'taken_at', pg_catalog.now()) AS s",
  );
  out.push(JSON.stringify(rows[0].s), SNAPSHOT_END);
  snap = parseSnapshotOutput(out.join("\n"))!;
});

afterAll(async () => {
  await db.query("ROLLBACK");
  await db.end();
});

describe("the snapshot's table enumeration on a migrated database", () => {
  const names = () => snap.tables.map((t) => `${t.schema}.${t.table}`);

  it("parses, with a real exported snapshot id", () => {
    expect(snap.snapshotId).toMatch(/^[0-9A-F]{8}-[0-9A-F]{8}-\d+$/i);
  });

  it("counts the sentinel tables and every table the export reads", () => {
    for (const t of ["public.organizations", "auth.users", "storage.objects"]) expect(names()).toContain(t);
    for (const t of TABLES.filter((x) => x !== "events")) expect(names(), t).toContain(`public.${t}`);
  });

  it("counts each events partition, and the partitioned parent as a whole", () => {
    expect(snap.tables.filter((t) => t.schema === "events_parts").length).toBeGreaterThan(0);
    expect(snap.partitioned).toEqual([expect.objectContaining({ schema: "public", table: "events" })]);
    const partitionSum = snap.tables.filter((t) => t.schema === "events_parts").reduce((a, t) => a + t.rows, 0);
    expect(snap.partitioned[0].rows).toBe(partitionSum);
  });

  it("names spatial_ref_sys as PostGIS's, and does not count it", () => {
    expect(snap.extensionTables).toContainEqual({ schema: "public", table: "spatial_ref_sys", extension: "postgis" });
    expect(names()).not.toContain("public.spatial_ref_sys");
  });

  it("leaves out the tables the data dump excludes", () => {
    for (const t of DATA_DUMP_EXCLUDED_TABLES) expect(names()).not.toContain(t);
  });

  it("counts in the transaction's snapshot: a row committed elsewhere afterwards is not seen", async () => {
    const before = snap.tables.find((t) => t.schema === "public" && t.table === "enquiry_alert_sweep_runs")!.rows;
    const other = new Client({ connectionString: DB_URL });
    await other.connect();
    try {
      await other.query("insert into public.enquiry_alert_sweep_runs (request_id) values (-424242)");
      const { rows } = await db.query<{ n: number }>("select count(*)::int as n from only public.enquiry_alert_sweep_runs");
      expect(rows[0].n).toBe(before);
    } finally {
      await other.query("delete from public.enquiry_alert_sweep_runs where request_id = -424242");
      await other.end();
    }
  });
});
