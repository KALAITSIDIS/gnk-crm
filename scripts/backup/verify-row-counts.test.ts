import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rowCountProblems, tableCountsFromSet } from "./verify-row-counts.mjs";

/**
 * The data-side verification in capture.mjs could not see a missing table.
 *
 * Until this module existed, `data.sql` was judged by a 10 KB size floor, one
 * header line, two substring greps (`COPY "auth"."users"`, `COPY
 * "storage"."objects"`) and the partitioned-events count. The 2026-09-20 audit
 * reproduced the hole: delete the ENTIRE public section from a real 246 KB
 * `data.sql` and the remaining 178 KB — auth, storage and events_parts alone —
 * still clears every check and the set is promoted `verified: true`. That is
 * 17.8x the floor, so the floor can never catch it. `pg_dump` is not run with
 * `--strict-names`, so a mistyped `--schema public` is ignored silently rather
 * than failing the dump.
 *
 * export.mjs has always written the answer next door: `data/<table>.json`, one
 * file per table, paged past the PostgREST cap so the counts are complete. This
 * module compares the two. Measured against the real 2026-09-16 and 2026-09-20
 * sets before a line of it was written: 39 of 39 tables agree exactly, so the
 * check is a true invariant here and not an approximation that would cry wolf
 * every night.
 */

/** A COPY block in the exact shape pg_dump writes: header, rows, then `\.`. */
const block = (table: string, rows: string[]) =>
  `COPY "public"."${table}" ("id", "org_id") FROM stdin;\n${rows.map((r) => `${r}\t00000000-0000-0000-0000-000000000001`).join("\n")}${rows.length ? "\n" : ""}\\.\n\n\n`;

const dump = (...blocks: string[]) =>
  `SET session_replication_role = replica;\n\n${blocks.join("")}`;

describe("rowCountProblems", () => {
  it("names a table whose rows are in production but absent from the dump", () => {
    const dataSql = dump(block("districts", ["a", "b", "c", "d", "e"]));

    const problems = rowCountProblems(dataSql, { districts: 5, properties: 17 });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("properties");
  });

  it("names a table whose COPY block is short of production", () => {
    const dataSql = dump(block("leads", ["a", "b", "c"]));

    const problems = rowCountProblems(dataSql, { leads: 11 });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/leads/);
    expect(problems[0]).toMatch(/3/);
    expect(problems[0]).toMatch(/11/);
  });

  /**
   * `events` is PARTITIONED since 0063: the parent `public.events` owns no rows
   * and emits no COPY at all — the rows arrive as one block per partition in
   * `events_parts`. capture.mjs already sums those and cross-checks the total
   * against a live count, which is a stronger check than this one. Reporting
   * `events` here would fail every single night.
   */
  it("exempts events, whose rows live in events_parts partitions", () => {
    const dataSql = dump(block("leads", ["a"]));

    const problems = rowCountProblems(dataSql, { leads: 1, events: 307 });

    expect(problems).toEqual([]);
  });

  /**
   * The trap this module exists around, and the one the first draft fell into.
   *
   * An empty table's terminator is the FIRST line after the header, so a parser
   * that splits the body on "\n\\." never sees it and runs on into the next
   * block. Probing the real 2026-09-20 set that way reported 5 rows for every
   * one of the 14 empty tables — the row count of whatever happened to follow.
   * Sixteen of this repo's 40 exported tables are currently empty, so a parser
   * with this bug is wrong about 40% of the database.
   */
  it("counts an empty table as zero, not as the next block's rows", () => {
    const dataSql = dump(block("tasks", []), block("districts", ["a", "b", "c", "d", "e"]));

    const problems = rowCountProblems(dataSql, { tasks: 0, districts: 5 });

    expect(problems).toEqual([]);
  });

  /**
   * `public.spatial_ref_sys` ships with PostGIS, is in every dump and in no
   * export. The check runs one way for exactly this reason.
   */
  it("ignores a COPY block the export does not cover", () => {
    const dataSql = dump(block("spatial_ref_sys", ["a", "b"]), block("leads", ["a"]));

    const problems = rowCountProblems(dataSql, { leads: 1 });

    expect(problems).toEqual([]);
  });

  /**
   * pg_dump escapes a backslash in a value as `\\`, so no row can ever BE the
   * terminator — but a row can certainly contain it, and 248 lines of the
   * current dump carry backslashes. A parser matching the terminator loosely
   * (`includes`, `startsWith`, `trim()`) ends the block early and under-counts,
   * which would read as data loss that has not happened.
   */
  it("does not end a block early on a row containing an escaped backslash", () => {
    const dataSql =
      'SET session_replication_role = replica;\n\n' +
      'COPY "public"."interaction_notes" ("id", "body") FROM stdin;\n' +
      "1\t\\\\.\n" +
      "2\tplain text\n" +
      "\\.\n\n";

    const problems = rowCountProblems(dataSql, { interaction_notes: 2 });

    expect(problems).toEqual([]);
  });

  /** A dump cut off mid-block is not a dump with fewer rows — it is truncated. */
  it("reports a block that never terminates", () => {
    const dataSql =
      'SET session_replication_role = replica;\n\n' +
      'COPY "public"."properties" ("id", "org_id") FROM stdin;\n' +
      "1\tx\n2\ty\n";

    const problems = rowCountProblems(dataSql, { properties: 17 });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("properties");
  });
});

/**
 * The wiring bug this pair of tests exists for.
 *
 * The first version of this check read `join(stagingRoot, "data")` and found
 * nothing, every night, on every run — because capture.mjs stages the SET at
 * `stagingRoot/<stamp>/` and renames THAT into place. export.mjs, given
 * `--out stagingRoot`, appends its own date stamp too, so the JSON lands at
 * `stagingRoot/<stamp>/data/`. The unit tests all passed and the end-to-end
 * proof was run against FINAL sets, where the rename has already flattened
 * `data/` to the top level — so nothing caught it. It shipped, and the first
 * real run printed `SKIPPED — no data/*.json (--skip-storage)` on a run that
 * had not used --skip-storage at all: a check doing nothing, explaining itself
 * with a reason that was not true.
 *
 * Hence both halves: read the directory through a tested function, and make an
 * absent one distinguishable from a deliberate skip.
 */
describe("tableCountsFromSet", () => {
  const stagedSet = (tables: Record<string, number>) => {
    const root = mkdtempSync(join(tmpdir(), "gnk-set-"));
    mkdirSync(join(root, "data"), { recursive: true });
    for (const [t, n] of Object.entries(tables)) {
      writeFileSync(join(root, "data", `${t}.json`), JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: i }))));
    }
    return root;
  };

  it("counts the rows in each table's json", () => {
    const dir = stagedSet({ leads: 11, properties: 17, tasks: 0 });

    expect(tableCountsFromSet(dir)).toEqual({ leads: 11, properties: 17, tasks: 0 });
  });

  it("returns null when the set has no data directory, so the caller can tell absent from empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "gnk-set-"));

    expect(tableCountsFromSet(dir)).toBeNull();
  });
});
