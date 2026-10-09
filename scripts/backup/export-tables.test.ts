import { describe, expect, it } from "vitest";
import { PRIMARY_KEYS, TABLES, afterKeyFilter, readAllRows } from "./export-tables.mjs";

/**
 * export.mjs read every table with `.range(from, from + 999)` and no ORDER BY,
 * stopping at the first page shorter than 1000 rows. Three ways that loses or
 * repeats rows while the database keeps working underneath it:
 *
 *   - Postgres returns an unordered read in PHYSICAL order, and an UPDATE
 *     writes a new tuple wherever there is room. A row updated between two
 *     page requests moves past the offset already read, so it is read twice
 *     and the row that slid into its old offset is never read at all. The
 *     2026-10-09 enquiry_alert_sweep_runs export came back with 71 ids out of
 *     order — the reconcile step of the two-minute cron updates rows all the time.
 *   - A DELETE between pages (the same table prunes rows older than 30 days
 *     from 2026-10-21) shifts every later row one offset down, so the row at
 *     the page boundary is skipped even when the read IS ordered.
 *   - A server row cap below the page size (Supabase's `max_rows`) makes the
 *     first page short, and the loop takes "short" to mean "done".
 *
 * The count can come out right in the first case — one duplicate, one miss —
 * so the dump/export row-count check cannot see it.
 */

type Row = Record<string, string | number>;

/** A value PostgREST compares: numbers numerically, everything else as text. */
const cmp = (a: string | number, b: string | number) =>
  typeof a === "number" && typeof b === "number" ? a - b : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;

/** Split a PostgREST logic-tree list on top-level commas, honouring quotes and parens. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted && c === "\\") {
      cur += c + s[++i];
      continue;
    }
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === "(") depth++;
    else if (!quoted && c === ")") depth--;
    if (!quoted && depth === 0 && c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const unquote = (v: string) =>
  v.startsWith('"') ? v.slice(1, -1).replace(/\\(.)/g, "$1") : v;

/** Evaluate the subset of PostgREST's `or=` grammar a keyset filter uses. */
function matches(row: Row, expr: string): boolean {
  if (expr.startsWith("and(")) return splitTop(expr.slice(4, -1)).every((e) => matches(row, e));
  const m = expr.match(/^([a-z_]+)\.(eq|gt)\.(.*)$/s);
  if (!m) throw new Error(`fake PostgREST cannot parse ${expr}`);
  const [, col, op, raw] = m;
  const v = unquote(raw);
  const actual = row[col];
  const c = cmp(typeof actual === "number" ? actual : String(actual), typeof actual === "number" ? Number(v) : v);
  return op === "eq" ? c === 0 : c > 0;
}

interface Call {
  table: string;
  order: string[];
  gt?: [string, string | number];
  or?: string;
  limit?: number;
  range?: [number, number];
}

/**
 * A PostgREST stand-in over in-memory tables kept in PHYSICAL order, which is
 * what an unordered read returns. `beforeRequest(n)` runs before the n-th
 * request (0-based) so a test can write to a table between two pages, the way
 * pg_cron does at 03:46.
 */
function fakePostgrest(
  tables: Record<string, Row[]>,
  { maxRows = Infinity, beforeRequest }: { maxRows?: number; beforeRequest?: (n: number) => void } = {},
) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, order: [] };
      const run = () => {
        beforeRequest?.(calls.length);
        calls.push(call);
        let rows = [...tables[table]];
        if (call.order.length) {
          rows.sort((a, b) => {
            for (const col of call.order) {
              const c = cmp(a[col], b[col]);
              if (c) return c;
            }
            return 0;
          });
        }
        if (call.gt) {
          const [col, v] = call.gt;
          rows = rows.filter((r) => cmp(r[col], v) > 0);
        }
        if (call.or) {
          const arms = splitTop(call.or);
          rows = rows.filter((r) => arms.some((a) => matches(r, a)));
        }
        if (call.range) rows = rows.slice(call.range[0], call.range[1] + 1);
        if (call.limit !== undefined) rows = rows.slice(0, call.limit);
        return { data: rows.slice(0, maxRows).map((r) => ({ ...r })), error: null };
      };
      const builder = {
        select: () => builder,
        order: (col: string) => (call.order.push(col), builder),
        gt: (col: string, v: string | number) => ((call.gt = [col, v]), builder),
        or: (f: string) => ((call.or = f), builder),
        limit: (n: number) => ((call.limit = n), builder),
        range: (a: number, z: number) => ((call.range = [a, z]), builder),
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
          try {
            return Promise.resolve(resolve(run()));
          } catch (e) {
            return Promise.resolve(reject(e));
          }
        },
      };
      return builder;
    },
  };
  return { client, calls };
}

/** `n` rows with bigint ids 1..n, stored in a shuffled physical order. */
function sweepRuns(n: number): Row[] {
  const rows: Row[] = Array.from({ length: n }, (_, i) => ({ id: i + 1, outcome: "ok" }));
  // deterministic shuffle: interleave from both ends
  const out: Row[] = [];
  for (let lo = 0, hi = n - 1; lo <= hi; lo++, hi--) {
    out.push(rows[lo]);
    if (lo !== hi) out.push(rows[hi]);
  }
  return out;
}

/** Every id 1..n except `except`, exactly once. */
function expectEachOnce(rows: Row[], ids: number[]) {
  const seen = rows.map((r) => Number(r.id)).sort((a, b) => a - b);
  expect(seen).toEqual([...ids].sort((a, b) => a - b));
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe("TABLES and PRIMARY_KEYS", () => {
  it("name exactly the same tables, each with at least one key column", () => {
    expect(Object.keys(PRIMARY_KEYS).sort()).toEqual([...TABLES].sort());
    for (const t of TABLES) expect(PRIMARY_KEYS[t].length, t).toBeGreaterThan(0);
  });
});

describe("readAllRows", () => {
  it("reads every row of a table larger than one page", async () => {
    const { client } = fakePostgrest({ enquiry_alert_sweep_runs: sweepRuns(2500) });

    const rows = await readAllRows(client, "enquiry_alert_sweep_runs");

    expectEachOnce(rows, range(1, 2500));
  });

  it("reads a row updated between two pages exactly once, and still reads its neighbour", async () => {
    const tables = { enquiry_alert_sweep_runs: sweepRuns(2500) };
    const { client } = fakePostgrest(tables, {
      // the 03:46 reconcile marks an early row `ok`: the new tuple lands at the end of the heap
      beforeRequest: (n) => {
        if (n !== 1) return;
        const heap = tables.enquiry_alert_sweep_runs;
        const i = heap.findIndex((r) => r.id === 2);
        const [moved] = heap.splice(i, 1);
        heap.push({ ...moved, outcome: "ok" });
      },
    });

    const rows = await readAllRows(client, "enquiry_alert_sweep_runs");

    expectEachOnce(rows, range(1, 2500));
  });

  it("does not skip a row that was there throughout when another is deleted between pages", async () => {
    const tables = { enquiry_alert_sweep_runs: sweepRuns(2500) };
    const { client } = fakePostgrest(tables, {
      // the 30-day prune removes the oldest row after the first page
      beforeRequest: (n) => {
        if (n !== 1) return;
        const heap = tables.enquiry_alert_sweep_runs;
        heap.splice(heap.findIndex((r) => r.id === 1), 1);
      },
    });

    const rows = await readAllRows(client, "enquiry_alert_sweep_runs");

    // row 1 may or may not be read (it was deleted mid-read); every other row exactly once
    expectEachOnce(rows.filter((r) => r.id !== 1), range(2, 2500));
    expect(rows.filter((r) => r.id === 1).length).toBeLessThanOrEqual(1);
  });

  it("is not truncated by a server row cap below the page size", async () => {
    const { client } = fakePostgrest({ enquiry_alert_sweep_runs: sweepRuns(2500) }, { maxRows: 400 });

    const rows = await readAllRows(client, "enquiry_alert_sweep_runs");

    expectEachOnce(rows, range(1, 2500));
  });

  it("resumes a composite key inside a run of rows that share the first column", async () => {
    // (ip_hash, window_start): five windows for one hash straddle a 3-row page
    const at = (m: number) => `2026-10-09T00:4${m}:00.064126+00:00`;
    const attempts: Row[] = [
      { ip_hash: "b", window_start: at(1), id: 6 },
      { ip_hash: "a", window_start: at(3), id: 3 },
      { ip_hash: "a", window_start: at(1), id: 1 },
      { ip_hash: "a", window_start: at(5), id: 5 },
      { ip_hash: "a", window_start: at(2), id: 2 },
      { ip_hash: "a", window_start: at(4), id: 4 },
      { ip_hash: "c", window_start: at(0), id: 7 },
    ];
    const { client } = fakePostgrest({ public_enquiry_attempts: attempts });

    const rows = await readAllRows(client, "public_enquiry_attempts", ["ip_hash", "window_start"], 3);

    expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("asks PostgREST for key order and resumes after the last key it saw", async () => {
    const { client, calls } = fakePostgrest({
      enquiry_alert_sweep_runs: sweepRuns(5),
      events: [
        { id: 1, occurred_at: "2026-10-01T00:00:00+00:00" },
        { id: 2, occurred_at: "2026-10-02T00:00:00+00:00" },
        { id: 3, occurred_at: "2026-10-03T00:00:00+00:00" },
      ],
    });

    await readAllRows(client, "enquiry_alert_sweep_runs", ["id"], 2);
    await readAllRows(client, "events", ["id", "occurred_at"], 2);

    expect(calls.map(({ table, order, gt, or, limit }) => ({ table, order, gt, or, limit }))).toEqual([
      { table: "enquiry_alert_sweep_runs", order: ["id"], gt: undefined, or: undefined, limit: 2 },
      { table: "enquiry_alert_sweep_runs", order: ["id"], gt: ["id", 2], or: undefined, limit: 2 },
      { table: "enquiry_alert_sweep_runs", order: ["id"], gt: ["id", 4], or: undefined, limit: 2 },
      { table: "enquiry_alert_sweep_runs", order: ["id"], gt: ["id", 5], or: undefined, limit: 2 },
      { table: "events", order: ["id", "occurred_at"], gt: undefined, or: undefined, limit: 2 },
      {
        table: "events",
        order: ["id", "occurred_at"],
        gt: undefined,
        or: 'id.gt."2",and(id.eq."2",occurred_at.gt."2026-10-02T00:00:00+00:00")',
        limit: 2,
      },
      {
        table: "events",
        order: ["id", "occurred_at"],
        gt: undefined,
        or: 'id.gt."3",and(id.eq."3",occurred_at.gt."2026-10-03T00:00:00+00:00")',
        limit: 2,
      },
    ]);
  });

  it("refuses a table it has no primary key for rather than paging it unordered", async () => {
    const { client } = fakePostgrest({ mystery: [{ id: 1 }] });

    await expect(readAllRows(client, "mystery")).rejects.toThrow(/mystery.*primary key/i);
  });

  it("names the table when PostgREST answers with an error", async () => {
    const client = {
      from: () => {
        const b = {
          select: () => b,
          order: () => b,
          gt: () => b,
          or: () => b,
          limit: () => b,
          range: () => b,
          then: (resolve: (v: unknown) => unknown) => Promise.resolve(resolve({ data: null, error: { message: "boom" } })),
        };
        return b;
      },
    };

    await expect(readAllRows(client, "leads")).rejects.toThrow("leads: boom");
  });
});

describe("afterKeyFilter", () => {
  it("is a lexicographic 'strictly after' over the key columns", () => {
    expect(afterKeyFilter(["a", "b", "c"], { a: 1, b: "x", c: "y" })).toBe(
      'a.gt."1",and(a.eq."1",b.gt."x"),and(a.eq."1",b.eq."x",c.gt."y")',
    );
  });

  it("quotes values so PostgREST's reserved characters cannot split them", () => {
    const f = afterKeyFilter(["ip_hash", "window_start"], {
      ip_hash: 'a,b.(c):"d"\\e',
      window_start: "2026-10-09T00:46:00.064126+00:00",
    });

    expect(f).toBe(
      'ip_hash.gt."a,b.(c):\\"d\\"\\\\e",and(ip_hash.eq."a,b.(c):\\"d\\"\\\\e",window_start.gt."2026-10-09T00:46:00.064126+00:00")',
    );
    // and the fake PostgREST reads the same value back out of it
    expect(splitTop(f)).toHaveLength(2);
    expect(matches({ ip_hash: 'a,b.(c):"d"\\e', window_start: "2026-10-09T00:47:00+00:00" }, splitTop(f)[1])).toBe(true);
  });
});
