import { describe, expect, it } from "vitest";
import { FETCH_PAGE, fetchAll } from "./fetch-all";

/** A table of n ids served in pages exactly as PostgREST's Range does it. */
const table = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i + 1).padStart(5, "0") }));
const serve =
  (rows: { id: string }[], calls: [number, number][] = []) =>
  async (from: number, to: number) => {
    calls.push([from, to]);
    return { data: rows.slice(from, to + 1), error: null };
  };

describe("fetchAll", () => {
  it("reads past the thousandth row, which a single select silently stops at", async () => {
    const calls: [number, number][] = [];
    const rows = await fetchAll(serve(table(1003), calls), "test");
    expect(rows).toHaveLength(1003);
    expect(rows.at(-1)!.id).toBe("01003");
    expect(calls).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it("stops on the first short page, and reads exactly one page for a short table", async () => {
    const calls: [number, number][] = [];
    expect(await fetchAll(serve(table(7), calls), "test")).toHaveLength(7);
    expect(calls).toEqual([[0, 999]]);
  });

  it("reads one extra, empty page when the table is exactly a multiple of the page", async () => {
    // A full page cannot know it is the last one; the cost is one cheap read.
    const calls: [number, number][] = [];
    expect(await fetchAll(serve(table(FETCH_PAGE), calls), "test")).toHaveLength(FETCH_PAGE);
    expect(calls).toHaveLength(2);
  });

  it("returns [] for an empty table, and null data counts as empty", async () => {
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
    ]);
  });
});
