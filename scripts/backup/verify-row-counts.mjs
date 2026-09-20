/**
 * Cross-check `data.sql`'s COPY blocks against the per-table JSON export.
 *
 * capture.mjs judged the data dump by a 10 KB size floor, one header line, two
 * substring greps and the partitioned-events count. None of those can see a
 * table that is simply absent: strip the ENTIRE public section from a real
 * 246 KB `data.sql` and the remaining 178 KB of auth, storage and events_parts
 * still clears every check — 17.8x the floor — and the set is promoted
 * `verified: true`. `pg_dump` is not run with `--strict-names`, so a mistyped
 * `--schema public` is ignored silently instead of failing the dump.
 *
 * export.mjs already writes the answer next door as `data/<table>.json`, paged
 * past the PostgREST cap so its counts are complete. Comparing the two closes
 * the hole with no new query against production.
 *
 * The comparison runs ONE WAY — every table the export counted must appear in
 * the dump with the same number of rows. It deliberately does not require the
 * reverse: `public.spatial_ref_sys` is a PostGIS table that is in every dump
 * and in no export, and flagging it would fail every night.
 */

/**
 * `events` is PARTITIONED since 0063. The parent `public.events` owns no rows
 * and emits no COPY at all; the rows arrive as one block per partition under
 * `events_parts`. capture.mjs sums those and cross-checks the total against a
 * live count — a stronger check than this one — so `events` is counted there,
 * never here.
 */
export const PARTITIONED_TABLES = new Set(["events"]);

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
 * lines of the current dump do contain backslashes, so a looser `startsWith`
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

/**
 * @param {string} dataSql   the captured data.sql
 * @param {Record<string, number>} tableCounts  table -> row count, from export.mjs
 * @returns {string[]} one message per table that disagrees; empty means agreement
 */
export function rowCountProblems(dataSql, tableCounts) {
  const problems = [];
  for (const [table, expected] of Object.entries(tableCounts)) {
    if (PARTITIONED_TABLES.has(table)) continue;
    const got = copyRowCount(dataSql, table);
    if (got === null) {
      problems.push(
        `data: no COPY "public"."${table}" — production has ${expected} row(s); the dump lost the table`,
      );
    } else if (got !== expected) {
      problems.push(
        `data: "public"."${table}" has ${got} row(s) in the dump, ${expected} in production`,
      );
    }
  }
  return problems;
}
