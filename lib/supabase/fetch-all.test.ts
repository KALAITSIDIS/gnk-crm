import { describe, expect, it } from "vitest";
import { FETCH_PAGE, fetchAll } from "./fetch-all";

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
});
