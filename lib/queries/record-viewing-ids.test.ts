import { describe, expect, it } from "vitest";
import { fakeClient } from "@/lib/testing/fake-client";
import { readRecordViewingIds } from "./record-viewing-ids";

/**
 * What the property's and the deal's Activity feeds read viewing events for
 * (A06 step 5): EVERY viewing of the record, read until an empty page — never
 * the page's "next ten" or "newest ten". The real-stack half (through RLS,
 * into the reader, onto the rendered page) is in
 * supabase/tests/record-activity-feeds.test.ts.
 */

const P = "11111111-2222-3333-4444-555555555555";
const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `v${from + i}` }));
const empty = { data: [], error: null };

describe("readRecordViewingIds", () => {
  it("reads every page — a full first page is not the end", async () => {
    const db = fakeClient({ viewings: [{ data: ids(1000), error: null }, { data: ids(5, 1000), error: null }, empty] });
    const out = await readRecordViewingIds(db.client as never, { column: "property_id", id: P });
    expect(out).toHaveLength(1005);
    expect(out.at(-1)).toBe("v1004");
    expect(db.served).toEqual({ viewings: 3 });
  });

  it("asks by the record's own column, over a unique order, with no cap of its own", async () => {
    for (const column of ["property_id", "deal_id"] as const) {
      const db = fakeClient({ viewings: [empty] });
      await readRecordViewingIds(db.client as never, { column, id: P });
      expect(db.argsOf("viewings", "select")).toEqual([["id"]]);
      expect(db.argsOf("viewings", "eq")).toEqual([[column, P]]);
      expect(db.argsOf("viewings", "order")).toEqual([["id"]]);
      expect(db.argsOf("viewings", "range")).toEqual([[0, 999]]);
      expect(db.argsOf("viewings", "limit")).toEqual([]);
    }
  });

  it("counts an id once when two pages overlap", async () => {
    const db = fakeClient({ viewings: [{ data: ids(2), error: null }, { data: [{ id: "v1" }, { id: "v2" }], error: null }, empty] });
    expect(await readRecordViewingIds(db.client as never, { column: "deal_id", id: P })).toEqual(["v0", "v1", "v2"]);
  });

  it("a failed page, or an answer with no rows array, throws — never a shorter history", async () => {
    const failed = fakeClient({ viewings: [{ data: ids(1000), error: null }, { data: null, error: { message: "statement timeout" } }] });
    await expect(readRecordViewingIds(failed.client as never, { column: "property_id", id: P })).rejects.toThrow(
      /property viewing ids.*statement timeout/,
    );
    const hollow = fakeClient({ viewings: [{ data: null, error: null, status: 204 }] });
    await expect(readRecordViewingIds(hollow.client as never, { column: "deal_id", id: P })).rejects.toThrow(/deal viewing ids/);
  });

  it("refuses what is not an id before any query", async () => {
    const db = fakeClient({});
    await expect(readRecordViewingIds(db.client as never, { column: "property_id", id: "x,id.not.is.null" })).rejects.toThrow(
      /not a record id/,
    );
    expect(db.calls).toEqual([]);
  });
});
