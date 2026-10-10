import { describe, expect, it } from "vitest";
import { FETCH_PAGE, fetchAll, fetchUpTo } from "./fetch-all";

/** A table of n ids served in pages exactly as PostgREST's Range does it. */
const table = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i + 1).padStart(5, "0") }));
const serve =
  (rows: { id: string }[], calls: [number, number][] = [], cap = Infinity) =>
  async (from: number, to: number) => {
    calls.push([from, to]);
    // `cap` is the server's own max-rows: it may answer with FEWER rows than
    // the range asked for, whatever the range says.
    return { data: rows.slice(from, Math.min(to + 1, from + cap)), error: null };
  };

describe("fetchAll", () => {
  it("reads past the thousandth row, which a single select silently stops at", async () => {
    const calls: [number, number][] = [];
    const rows = await fetchAll(serve(table(1003), calls), "test");
    expect(rows).toHaveLength(1003);
    expect(rows.at(-1)!.id).toBe("01003");
    // advances by what ARRIVED, and stops only on an empty page
    expect(calls).toEqual([
      [0, 999],
      [1000, 1999],
      [1003, 2002],
    ]);
  });

  it("stops on the first EMPTY page — one page of rows, then one that confirms the end", async () => {
    const calls: [number, number][] = [];
    expect(await fetchAll(serve(table(7), calls), "test")).toHaveLength(7);
    expect(calls).toEqual([
      [0, 999],
      [7, 1006],
    ]);
  });

  it("keeps reading when the SERVER caps below the page size — the truncation this guards", async () => {
    // PostgREST's max-rows is a project setting, not a constant. Lower it and
    // every page comes back short; a `got.length < pageSize` stop would have
    // read the first 300 rows and called that the whole table.
    const calls: [number, number][] = [];
    const rows = await fetchAll(serve(table(2500), calls, 300), "test");
    expect(rows).toHaveLength(2500);
    expect(rows.at(-1)!.id).toBe("02500");
    expect(calls.length, "2500 at 300 a page, plus the empty one that ends it").toBe(10);
    expect(calls.slice(0, 3)).toEqual([
      [0, 999],
      [300, 1299],
      [600, 1599],
    ]);
  });

  it("reads one extra, empty page when the table is exactly a multiple of the page", async () => {
    const calls: [number, number][] = [];
    expect(await fetchAll(serve(table(FETCH_PAGE), calls), "test")).toHaveLength(FETCH_PAGE);
    expect(calls).toHaveLength(2);
  });

  it("returns [] for an empty table in one read, and null data counts as empty", async () => {
    const calls: [number, number][] = [];
    expect(await fetchAll(serve(table(0), calls), "test")).toEqual([]);
    expect(calls).toEqual([[0, 999]]);
    expect(await fetchAll(async () => ({ data: null, error: null }), "test")).toEqual([]);
  });

  it("THROWS on a failed page instead of returning the rows read so far", async () => {
    // "no matches" and "the read failed" are different facts.
    const flaky = async (from: number, to: number) =>
      from === 0
        ? { data: table(1000).slice(from, to + 1), error: null }
        : { data: null, error: { message: "canceling statement due to statement timeout" } };
    await expect(fetchAll(flaky, "buyer_requirements")).rejects.toThrow(
      "Query failed (buyer_requirements): canceling statement due to statement timeout",
    );
  });

  it("honours a smaller page size when asked", async () => {
    const calls: [number, number][] = [];
    expect(await fetchAll(serve(table(5), calls), "test", 2)).toHaveLength(5);
    expect(calls).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
      [5, 6],
    ]);
  });

  it("has no ceiling — the export's bound is fetchUpTo's, never this sweep's", async () => {
    expect(await fetchAll(serve(table(12_345)), "test")).toHaveLength(12_345);
  });
});

describe("fetchUpTo", () => {
  it.each([0, 1, 999, 1000, 1001, 2501, 9999, 10_000])(
    "returns all %i rows, in order, when the query matches no more than the ceiling",
    async (n) => {
      const read = await fetchUpTo(serve(table(n)), "test", 10_000);
      expect(read.more).toBe(false);
      expect(read.rows).toEqual(table(n));
    },
  );

  it("answers `more` — and no rows — one row past the ceiling", async () => {
    expect(await fetchUpTo(serve(table(10_001)), "test", 10_000)).toEqual({ more: true, rows: null });
    expect(await fetchUpTo(serve(table(50_000)), "test", 10_000)).toEqual({ more: true, rows: null });
  });

  it("never asks for more than ONE row past the ceiling, however large the table", async () => {
    const calls: [number, number][] = [];
    await fetchUpTo(serve(table(50_000), calls), "test", 10_000);
    expect(calls).toHaveLength(11);
    expect(calls.at(-1)).toEqual([10_000, 10_000]);
    expect(Math.max(...calls.map(([, to]) => to))).toBe(10_000);
  });

  it("at exactly the ceiling, one single-row probe confirms the end", async () => {
    const calls: [number, number][] = [];
    const read = await fetchUpTo(serve(table(10_000), calls), "test", 10_000);
    expect(read.rows).toHaveLength(10_000);
    expect(calls.at(-1)).toEqual([10_000, 10_000]);
  });

  it.each([1, 300, 750, 999])(
    "a server capped at %i rows a page still yields every row up to the ceiling",
    async (cap) => {
      const ok = await fetchUpTo(serve(table(2501), [], cap), "test", 10_000);
      expect(ok.rows).toEqual(table(2501));
      expect(await fetchUpTo(serve(table(10_001), [], cap), "test", 10_000)).toEqual({ more: true, rows: null });
    },
  );

  it("keeps no more than it asked for when a server over-answers a range", async () => {
    // not something PostgREST does — the bound must not depend on it. What was
    // KEPT shows in where the next page starts: the asked-for 1000, never 5000.
    const calls: [number, number][] = [];
    const greedy = async (from: number, to: number) => {
      calls.push([from, to]);
      return { data: table(20_000).slice(from, from + 5000), error: null };
    };
    expect(await fetchUpTo(greedy, "test", 10_000)).toEqual({ more: true, rows: null });
    expect(calls.map(([from]) => from)).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10_000]);
    const ok = await fetchUpTo(async (from: number, to: number) => ({ data: table(10).slice(from, to + 5), error: null }), "test", 10_000);
    expect(ok.rows).toEqual(table(10));
  });

  it("THROWS on a page with no rows array — an empty-bodied OK answer is not the end", async () => {
    // postgrest-js: an OK response with an empty body → { data: null, error: null }
    let n = 0;
    const hollow = async (from: number, to: number) =>
      n++ === 0 ? { data: table(2500).slice(from, to + 1), error: null } : { data: null, error: null };
    await expect(fetchUpTo(hollow, "leads export", 10_000)).rejects.toThrow(
      "Query failed (leads export): the answer held no rows",
    );
    await expect(fetchUpTo(async () => ({ data: null, error: null }), "x", 10)).rejects.toThrow();
  });

  it("THROWS on a later page's failure instead of returning the pages before it", async () => {
    let n = 0;
    const flaky = async (from: number, to: number) =>
      n++ === 0
        ? { data: table(2500).slice(from, to + 1), error: null }
        : { data: null, error: { message: "canceling statement due to statement timeout" } };
    await expect(fetchUpTo(flaky, "deals export", 10_000)).rejects.toThrow(
      "Query failed (deals export): canceling statement due to statement timeout",
    );
  });
});
