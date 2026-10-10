import { describe, expect, it } from "vitest";
import {
  EXPORT_CEILING,
  EXPORT_FAILED_MESSAGE,
  EXPORT_TOO_MANY_MESSAGE,
  EXPORT_TOO_MANY_UNFILTERED_MESSAGE,
} from "@/lib/constants/export";
import { exportFailed, readAgentNames, readExportRows } from "./export-read";

/**
 * The refusals a list export answers with (T-export-complete). The paging
 * itself is pinned in fetch-all.test.ts and, against a real PostgREST, in
 * supabase/tests/list-export-complete.test.ts.
 */
const table = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));
const serve = (rows: { id: number }[]) => async (from: number, to: number) => ({
  data: rows.slice(from, to + 1),
  error: null,
});

describe("readExportRows", () => {
  it("hands back every row up to the ceiling", async () => {
    const read = await readExportRows(serve(table(EXPORT_CEILING)), "contacts");
    expect("rows" in read && read.rows).toHaveLength(EXPORT_CEILING);
  });

  it("refuses one row past it: 422, the reason, no rows, not cached", async () => {
    const read = await readExportRows(serve(table(EXPORT_CEILING + 1)), "contacts");
    expect("refused" in read).toBe(true);
    if (!("refused" in read)) return;
    expect(read.refused.status).toBe(422);
    expect(read.refused.headers.get("cache-control")).toBe("no-store");
    expect(await read.refused.json()).toEqual({ error: EXPORT_TOO_MANY_MESSAGE, reason: "too_many" });
  });

  it("refuses a failed page: 500, the reason — never the pages before it", async () => {
    let n = 0;
    const read = await readExportRows(
      async (from: number, to: number) =>
        n++ === 0 ? { data: table(3000).slice(from, to + 1), error: null } : { data: null, error: { message: "boom" } },
      "deals",
    );
    expect("refused" in read).toBe(true);
    if (!("refused" in read)) return;
    expect(read.refused.status).toBe(500);
    expect(await read.refused.json()).toEqual({ error: EXPORT_FAILED_MESSAGE, reason: "failed" });
  });

  it("a list with no filters is not told to narrow them", async () => {
    const read = await readExportRows(serve(table(EXPORT_CEILING + 1)), "tasks", { filterable: false });
    if (!("refused" in read)) throw new Error("expected a refusal");
    expect(await read.refused.json()).toEqual({ error: EXPORT_TOO_MANY_UNFILTERED_MESSAGE, reason: "too_many" });
  });

  it("each ceiling message names the ceiling and what CAN be done", () => {
    for (const m of [EXPORT_TOO_MANY_MESSAGE, EXPORT_TOO_MANY_UNFILTERED_MESSAGE]) {
      expect(m).toContain("More than 10,000 records match");
      expect(m).toContain("Nothing was downloaded");
    }
    expect(EXPORT_TOO_MANY_MESSAGE).toMatch(/narrow the filters and export again/);
    expect(EXPORT_TOO_MANY_UNFILTERED_MESSAGE).not.toMatch(/narrow the filters and/);
    expect(EXPORT_TOO_MANY_UNFILTERED_MESSAGE).toMatch(/ask an administrator/);
  });
});

describe("exportFailed", () => {
  it("is the same failed answer", async () => {
    const res = exportFailed();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: EXPORT_FAILED_MESSAGE, reason: "failed" });
  });
});

describe("readAgentNames", () => {
  const client = (pages: ({ data: unknown[] | null; error: { message: string } | null })[]) => {
    const calls: [number, number][] = [];
    const builder = {
      select: () => builder,
      order: () => builder,
      range: (from: number, to: number) => {
        calls.push([from, to]);
        return Promise.resolve(pages[calls.length - 1] ?? { data: [], error: null });
      },
    };
    return { calls, supabase: { from: () => builder } as never };
  };

  it("pages every profile and marks the inactive", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({ id: `p${i}`, full_name: `Agent ${i}`, is_active: true }));
    const { calls, supabase } = client([
      { data: page1, error: null },
      { data: [{ id: "late", full_name: "Late Agent", is_active: false }], error: null },
    ]);
    const names = await readAgentNames(supabase);
    expect(names?.size).toBe(1001);
    expect(names?.get("late")).toBe("Late Agent (inactive)");
    expect(calls).toHaveLength(3);
  });

  it("is null — a failed export — when a page fails, never an empty map", async () => {
    const { supabase } = client([{ data: null, error: { message: "boom" } }]);
    expect(await readAgentNames(supabase)).toBeNull();
  });
});
