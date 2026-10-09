import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  copyRowCount,
  exportAgainstSnapshot,
  snapshotCountProblems,
  tableCountsFromSet,
  verifyStagedSet,
} from "./verify-row-counts.mjs";

/**
 * The data-side verification in capture.mjs could not see a missing table.
 *
 * Until 2026-09-20, `data.sql` was judged by a 10 KB size floor, one header
 * line, two substring greps (`COPY "auth"."users"`, `COPY "storage"."objects"`)
 * and the partitioned-events count. Deleting the ENTIRE public section from a
 * real 246 KB `data.sql` still cleared every check, and `pg_dump` is not run
 * with `--strict-names`, so a mistyped `--schema public` is silently ignored.
 *
 * The first answer (T-dump-row-counts) compared each COPY block with export.mjs's
 * PostgREST JSON. That comparator was read 20-45 s AFTER the dump's snapshot,
 * and on 2026-10-09 the two-minute enquiry-alerts cron inserted a row in
 * between: dump 12365, export 12366, a complete backup failed as untrustworthy.
 *
 * Now the comparator is the dump's own snapshot (dump-snapshot.mjs): every
 * table the data dump should hold, counted inside the very transaction the
 * dumps import. Equality is exact in both directions and cannot race. The
 * JSON export is still read, for what it can honestly say: that every table it
 * wrote exists, and how far it drifted while production kept working.
 */

/** A COPY block in the exact shape pg_dump writes: header, rows, then `\.`. */
const block = (table: string, rows: string[], schema = "public") =>
  `COPY "${schema}"."${table}" ("id", "org_id") FROM stdin;\n${rows.map((r) => `${r}\t00000000-0000-0000-0000-000000000001`).join("\n")}${rows.length ? "\n" : ""}\\.\n\n\n`;

const dump = (...blocks: string[]) => `SET session_replication_role = replica;\n\n${blocks.join("")}`;

const rows = (n: number) => Array.from({ length: n }, (_, i) => String(i + 1));

type Counted = { schema: string; table: string; rows: number };

/** A snapshot as dump-snapshot.mjs parses it, with the sentinel tables present. */
function snap(tables: Counted[], { extensionTables = [] as { schema: string; table: string; extension: string }[], events = 0 } = {}) {
  return {
    snapshotId: "00000003-0000001B-1",
    takenAt: "2026-10-09T00:45:38.1+00:00",
    tables,
    extensionTables,
    partitioned: [{ schema: "public", table: "events", rows: events }],
  };
}

/** The tables that must always be counted, with blocks to match. */
const SENTINELS: Counted[] = [
  { schema: "public", table: "organizations", rows: 1 },
  { schema: "auth", table: "users", rows: 2 },
  { schema: "storage", table: "objects", rows: 1 },
  { schema: "events_parts", table: "events_2026_10", rows: 0 },
];
const sentinelBlocks = () => SENTINELS.map((t) => block(t.table, rows(t.rows), t.schema)).join("");

describe("snapshotCountProblems", () => {
  /**
   * The night of 2026-10-09, replayed. Under the old check this exact shape
   * was `data: "public"."enquiry_alert_sweep_runs" has 12365 row(s) in the
   * dump, 12366 in production`. Against the dump's own snapshot the dump is
   * complete — which it was.
   */
  it("passes the 2026-10-09 dump, which held every row its snapshot had", () => {
    const dataSql = dump(sentinelBlocks(), block("enquiry_alert_sweep_runs", rows(12365)));
    const s = snap([...SENTINELS, { schema: "public", table: "enquiry_alert_sweep_runs", rows: 12365 }]);

    expect(snapshotCountProblems(dataSql, s)).toEqual([]);
  });

  it("fails a dump one row short of its own snapshot, naming both numbers", () => {
    const dataSql = dump(sentinelBlocks(), block("enquiry_alert_sweep_runs", rows(12364)));
    const s = snap([...SENTINELS, { schema: "public", table: "enquiry_alert_sweep_runs", rows: 12365 }]);

    expect(snapshotCountProblems(dataSql, s)).toEqual([
      'data: "public"."enquiry_alert_sweep_runs" has 12364 row(s) in the dump, 12365 in the dump\'s own snapshot',
    ]);
  });

  it("fails a dump with one row MORE than its snapshot — the equality is exact both ways", () => {
    const dataSql = dump(sentinelBlocks(), block("leads", rows(12)));

    expect(snapshotCountProblems(dataSql, snap([...SENTINELS, { schema: "public", table: "leads", rows: 11 }]))).toHaveLength(1);
  });

  it("names a counted table the dump lost entirely", () => {
    const dataSql = dump(sentinelBlocks());
    const problems = snapshotCountProblems(dataSql, snap([...SENTINELS, { schema: "public", table: "properties", rows: 17 }]));

    expect(problems).toEqual([
      'data: no COPY "public"."properties" — the dump\'s own snapshot has 17 row(s); the dump lost the table',
    ]);
  });

  it("checks auth, storage and every events partition exactly, not just public", () => {
    const dataSql = dump(sentinelBlocks(), block("events_2026_09", rows(204), "events_parts"));
    const problems = snapshotCountProblems(
      dataSql,
      snap([...SENTINELS, { schema: "events_parts", table: "events_2026_09", rows: 205 }]),
    );

    expect(problems).toEqual(['data: "events_parts"."events_2026_09" has 204 row(s) in the dump, 205 in the dump\'s own snapshot']);
  });

  it("fails a COPY block the snapshot never counted — the enumeration fell behind the dump", () => {
    const dataSql = dump(sentinelBlocks(), block("mystery", rows(3)));

    expect(snapshotCountProblems(dataSql, snap(SENTINELS))).toEqual([
      'data: COPY "public"."mystery" is in the dump but was not counted in its snapshot — the row check does not cover it',
    ]);
  });

  /**
   * PostGIS registers spatial_ref_sys with a dump filter, so its block holds
   * only user-added SRIDs (0 rows here) while count(*) sees ~8,500. The
   * snapshot lists it as an extension table: neither compared nor flagged.
   */
  it("neither compares nor flags an extension table's filtered block", () => {
    const dataSql = dump(sentinelBlocks(), block("spatial_ref_sys", []));
    const s = snap(SENTINELS, { extensionTables: [{ schema: "public", table: "spatial_ref_sys", extension: "postgis" }] });

    expect(snapshotCountProblems(dataSql, s)).toEqual([]);
  });

  /**
   * The check must not go quiet by enumerating too little. A typo shared by
   * the dump's schema list and the enumeration would drop public from BOTH —
   * nothing to compare, nothing uncounted — so the sentinels must be there.
   */
  it("fails when the snapshot did not count a table it always must", () => {
    const withoutPublic = SENTINELS.filter((t) => t.schema !== "public");
    const dataSql = dump(withoutPublic.map((t) => block(t.table, rows(t.rows), t.schema)).join(""));

    expect(snapshotCountProblems(dataSql, snap(withoutPublic))).toEqual([
      'data: the snapshot did not count "public"."organizations" — the table enumeration is wrong, so the row check did NOT run',
    ]);
    expect(snapshotCountProblems(dump(), snap([]))).toHaveLength(4);
  });

  // The parser traps the first version of this module was built around.

  /**
   * An empty table's terminator is the FIRST line after the header, so a parser
   * that splits the body on "\n\\." never sees it and runs on into the next
   * block: probing the real 2026-09-20 set that way reported 5 rows for every
   * one of the 14 empty tables.
   */
  it("counts an empty table as zero, not as the next block's rows", () => {
    const dataSql = dump(sentinelBlocks(), block("tasks", []), block("districts", rows(5)));
    const s = snap([...SENTINELS, { schema: "public", table: "tasks", rows: 0 }, { schema: "public", table: "districts", rows: 5 }]);

    expect(snapshotCountProblems(dataSql, s)).toEqual([]);
  });

  /**
   * pg_dump escapes a backslash in a value as `\\`, so no row can BE the
   * terminator — but rows contain it (248 lines of the 2026-09-20 dump), and a
   * loose match (`includes`, `startsWith`, `trim()`) ends the block early.
   */
  it("does not end a block early on a row containing an escaped backslash", () => {
    const notes =
      'COPY "public"."interaction_notes" ("id", "body") FROM stdin;\n' + "1\t\\\\.\n" + "2\tplain text\n" + "\\.\n\n";
    const dataSql = dump(sentinelBlocks(), notes);

    expect(snapshotCountProblems(dataSql, snap([...SENTINELS, { schema: "public", table: "interaction_notes", rows: 2 }]))).toEqual([]);
  });

  /** A dump cut off mid-block is not a dump with fewer rows — it is truncated. */
  it("reports a block that never terminates", () => {
    const dataSql = dump(sentinelBlocks()) + 'COPY "public"."properties" ("id", "org_id") FROM stdin;\n1\tx\n2\ty\n';

    const problems = snapshotCountProblems(dataSql, snap([...SENTINELS, { schema: "public", table: "properties", rows: 17 }]));

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"public"."properties"');
  });
});

describe("copyRowCount", () => {
  it("reads a block in any schema", () => {
    expect(copyRowCount(dump(block("users", rows(2), "auth")), "users", "auth")).toBe(2);
    expect(copyRowCount(dump(block("users", rows(2), "auth")), "users")).toBeNull();
  });
});

describe("exportAgainstSnapshot", () => {
  /** The same night, from the JSON's side: drift, explained, not a failure. */
  it("reports the 2026-10-09 export's extra row as drift, not as a problem", () => {
    const s = snap([...SENTINELS, { schema: "public", table: "enquiry_alert_sweep_runs", rows: 12365 }]);

    expect(exportAgainstSnapshot({ organizations: 1, enquiry_alert_sweep_runs: 12366 }, s)).toEqual({
      problems: [],
      warnings: [
        "export: public.enquiry_alert_sweep_runs json 12366, dump snapshot 12365 — written between the snapshot and the export's read; data.sql matches its snapshot and is the restore source",
      ],
    });
  });

  it("fails a table the export wrote that the dump's snapshot does not have", () => {
    const { problems } = exportAgainstSnapshot({ organizations: 1, ghosts: 3 }, snap(SENTINELS));

    expect(problems).toEqual([
      "export: public.ghosts has json but the dump's snapshot has no such table — the export and the dump disagree about what exists",
    ]);
  });

  it("compares events.json with the partitioned parent's count", () => {
    const s = snap(SENTINELS, { events: 335 });

    expect(exportAgainstSnapshot({ organizations: 1, events: 335 }, s)).toEqual({ problems: [], warnings: [] });
    expect(exportAgainstSnapshot({ organizations: 1, events: 336 }, s).warnings).toHaveLength(1);
  });

  it("warns about a public table in the dump that the export does not cover, and stays quiet about extension tables", () => {
    const s = snap([...SENTINELS, { schema: "public", table: "unit_type_applications", rows: 0 }], {
      extensionTables: [{ schema: "public", table: "spatial_ref_sys", extension: "postgis" }],
    });

    expect(exportAgainstSnapshot({ organizations: 1 }, s)).toEqual({
      problems: [],
      warnings: ["export: public.unit_type_applications is in the dump (0 row(s)) but not in the export"],
    });
  });
});

/**
 * The wiring bug the T-dump-row-counts addendum records: the first version
 * read `join(stagingRoot, "data")`, found nothing every night, and reported
 * it as a --skip-storage skip. capture.mjs stages the SET at
 * `stagingRoot/<stamp>/` and export.mjs, given `--out stagingRoot`, appends
 * the same stamp — so the JSON is at `stagingRoot/<stamp>/data/`. These tests
 * run the whole row check over that STAGED layout, through the one function
 * capture.mjs calls.
 */
describe("tableCountsFromSet and verifyStagedSet", () => {
  const stagedSet = (tables: Record<string, number>) => {
    const stagingRoot = mkdtempSync(join(tmpdir(), "gnk-staging-"));
    const stageDir = join(stagingRoot, "2026-10-09");
    mkdirSync(join(stageDir, "data"), { recursive: true });
    for (const [t, n] of Object.entries(tables)) {
      writeFileSync(join(stageDir, "data", `${t}.json`), JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: i }))));
    }
    return { stagingRoot, stageDir };
  };

  it("counts the rows in each table's json", () => {
    const { stageDir } = stagedSet({ leads: 11, properties: 17, tasks: 0 });

    expect(tableCountsFromSet(stageDir)).toEqual({ leads: 11, properties: 17, tasks: 0 });
  });

  it("returns null when the set has no data directory, so the caller can tell absent from empty", () => {
    expect(tableCountsFromSet(mkdtempSync(join(tmpdir(), "gnk-set-")))).toBeNull();
  });

  it("runs the snapshot check and the export check over a staged set", () => {
    const { stageDir } = stagedSet({ organizations: 1, enquiry_alert_sweep_runs: 12366 });
    const dataSql = dump(sentinelBlocks(), block("enquiry_alert_sweep_runs", rows(12365)));
    const s = snap([...SENTINELS, { schema: "public", table: "enquiry_alert_sweep_runs", rows: 12365 }]);

    const v = verifyStagedSet({ dataSql, stageDir, snap: s, skipStorage: false });

    expect(v.problems).toEqual([]);
    expect(v.warnings).toHaveLength(1);
    expect(v.lines).toEqual([
      "data: 5 tables match their snapshot count exactly",
      "export: 2 table json files checked against the snapshot — 1 drifted (warning)",
    ]);
  });

  it("is a problem, not a skip, when the export ran but its json is not where the check reads", () => {
    const stageDir = mkdtempSync(join(tmpdir(), "gnk-staging-"));
    const v = verifyStagedSet({ dataSql: dump(sentinelBlocks()), stageDir, snap: snap(SENTINELS), skipStorage: false });

    expect(v.problems).toHaveLength(1);
    expect(v.problems[0]).toMatch(/no data\/\*\.json .* the export check did NOT run/);
  });

  it("says the export check was skipped only when storage really was skipped", () => {
    const stageDir = mkdtempSync(join(tmpdir(), "gnk-staging-"));
    const v = verifyStagedSet({ dataSql: dump(sentinelBlocks()), stageDir, snap: snap(SENTINELS), skipStorage: true });

    expect(v.problems).toEqual([]);
    expect(v.lines.at(-1)).toBe("export: json cross-check SKIPPED — --skip-storage, export.mjs wrote no table json");
  });

  it("is a problem, never a pass, when there is no snapshot to check against", () => {
    const { stageDir } = stagedSet({ organizations: 1 });
    const v = verifyStagedSet({ dataSql: dump(sentinelBlocks()), stageDir, snap: null, skipStorage: false });

    expect(v.problems).toEqual(["data: no snapshot counts — the row check did NOT run"]);
  });
});
