/**
 * The backup export pages every table by its PRIMARY KEY (scripts/backup/
 * export-tables.mjs). Requires the local Supabase stack. Run: npm run test:rls
 *
 * Keyset paging is only as good as the key it walks: a column list that is not
 * the real primary key can tie at a page boundary and skip the rows that tie.
 * PRIMARY_KEYS is written by hand, so this pins it against pg_constraint on a
 * migrated database — a migration that changes a key, or a table added to
 * TABLES with a guessed one, fails here rather than in a 03:45 export.
 *
 * The second half drives the real PostgREST: the composite-key filter is a
 * hand-built `or=(…,and(…))` string carrying quoted timestamps, and only the
 * real server can say it parses and compares them the way the ORDER BY does.
 */
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRIMARY_KEYS, TABLES, readAllRows } from "../../scripts/backup/export-tables.mjs";
import { serviceClient } from "./helpers";

const DB_URL = process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const PROBE_HASH = "backup-export-keys-probe";

let db: Client;

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  await db.connect();
});

afterAll(async () => {
  await db.query("delete from public.public_enquiry_attempts where ip_hash = $1", [PROBE_HASH]);
  await db.end();
});

describe("PRIMARY_KEYS is each exported table's real primary key", () => {
  it("matches pg_constraint, column for column and in order, for every table in TABLES", async () => {
    const { rows } = await db.query<{ table: string; cols: string[] }>(
      `select c.relname as table, array_agg(a.attname::text order by k.ord) as cols
         from pg_constraint con
         join pg_class c on c.oid = con.conrelid
         join pg_namespace n on n.oid = c.relnamespace
         cross join lateral unnest(con.conkey) with ordinality as k(attnum, ord)
         join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
        where con.contype = 'p' and n.nspname = 'public' and c.relname = any($1::text[])
        group by c.relname`,
      [TABLES],
    );
    const actual = Object.fromEntries(rows.map((r) => [r.table, r.cols]));

    for (const table of TABLES) {
      expect(actual[table], `${table} has no primary key on a migrated database`).toBeDefined();
      expect(PRIMARY_KEYS[table], table).toEqual(actual[table]);
    }
  });
});

describe("readAllRows against the real PostgREST", () => {
  it("walks a composite (text, timestamptz) key across pages that split a run of equal first columns", async () => {
    // five windows for one hash, microsecond timestamps, so a 2-row page
    // boundary falls INSIDE the run and only the and(eq, gt) arm can resume it
    await db.query(
      `insert into public.public_enquiry_attempts (ip_hash, window_start, attempts)
       select $1, timestamptz '2026-10-09 00:46:00.064126+00' + make_interval(secs => g * 0.000001 + g * 60), 1
         from generate_series(0, 4) g
       on conflict do nothing`,
      [PROBE_HASH],
    );
    const { rows: expected } = await db.query<{ k: string }>(
      `select ip_hash || '|' || (to_json(window_start) #>> '{}') as k
         from public.public_enquiry_attempts order by ip_hash, window_start`,
    );

    const read = await readAllRows(serviceClient(), "public_enquiry_attempts", undefined, 2);

    expect(read.map((r) => `${r.ip_hash}|${r.window_start}`)).toEqual(expected.map((r) => r.k));
    expect(read.filter((r) => r.ip_hash === PROBE_HASH)).toHaveLength(5);
  });

  // A small page so every non-trivial table crosses several boundaries. Measured
  // on a well-used local stack: 37,746 rows over 42 tables in 34 s at 7 rows a
  // page; 50 keeps a crowded stack inside the timeout and still pages.
  it("walks every exported table in key order with a small page and reads each row once", async () => {
    const sb = serviceClient();
    for (const table of TABLES) {
      const key = PRIMARY_KEYS[table];
      const keyText = key.map((c) => `(to_json("${c}") #>> '{}')`).join(" || '|' || ");
      const order = key.map((c) => `"${c}"`).join(", ");
      const { rows: expected } = await db.query<{ k: string }>(
        `select ${keyText} as k from public."${table}" order by ${order}`,
      );

      const read = await readAllRows(sb, table, undefined, 50);

      expect(read.map((r) => key.map((c) => String(r[c])).join("|")), table).toEqual(expected.map((r) => r.k));
    }
  }, 120_000);
});
