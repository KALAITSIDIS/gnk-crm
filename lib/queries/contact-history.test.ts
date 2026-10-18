import { describe, expect, it } from "vitest";
import { fakeClient } from "@/lib/testing/fake-client";
import { readContactHistoryIds } from "./contact-history";

/**
 * What the contact page's history and summary strip are asked about (A06
 * review): EVERY lead, deal and viewing of the person — read until an empty
 * page, never a display list's newest 50. The real-stack half (250 deals,
 * through RLS, into the readers) is in supabase/tests/contact-activity.test.ts.
 */

const C = "11111111-2222-3333-4444-555555555555";
const ids = (prefix: string, n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${from + i}` }));
const empty = { data: [], error: null };

describe("readContactHistoryIds", () => {
  it("reads every page of each list — a full first page is not the end", async () => {
    const db = fakeClient({
      leads: [{ data: ids("l", 3), error: null }, empty],
      // 1,000 deals, then 60 more: the seller on every unit deal of two projects
      deals: [{ data: ids("d", 1000), error: null }, { data: ids("d", 60, 1000), error: null }, empty],
      viewings: [{ data: ids("v", 2), error: null }, empty],
    });
    const out = await readContactHistoryIds(db.client as never, C);
    expect(out.leadIds).toEqual(["l0", "l1", "l2"]);
    expect(out.dealIds).toHaveLength(1060);
    expect(out.dealIds.at(-1)).toBe("d1059");
    expect(out.viewingIds).toEqual(["v0", "v1"]);
    expect(db.served).toEqual({ leads: 2, deals: 3, viewings: 2 });
  });

  it("pages over a unique order, with no row cap of its own", async () => {
    const db = fakeClient({ leads: [empty], deals: [empty], viewings: [empty] });
    await readContactHistoryIds(db.client as never, C);
    for (const t of ["leads", "deals", "viewings"]) {
      expect(db.argsOf(t, "order"), `${t}: ordered by id, so a page is a page`).toEqual([["id"]]);
      expect(db.argsOf(t, "range")).toEqual([[0, 999]]);
      expect(db.argsOf(t, "limit"), `${t}: never the tabs' .limit(50)`).toEqual([]);
    }
    expect(db.argsOf("deals", "or")).toEqual([[`buyer_contact_id.eq.${C},seller_contact_id.eq.${C}`]]);
    expect(db.argsOf("leads", "eq")).toEqual([["contact_id", C]]);
    expect(db.argsOf("viewings", "eq")).toEqual([["contact_id", C]]);
  });

  it("counts an id once when two pages overlap", async () => {
    const db = fakeClient({
      leads: [empty],
      deals: [{ data: ids("d", 2), error: null }, { data: [{ id: "d1" }, { id: "d2" }], error: null }, empty],
      viewings: [empty],
    });
    expect((await readContactHistoryIds(db.client as never, C)).dealIds).toEqual(["d0", "d1", "d2"]);
  });

  it("a failed page throws — never a shorter history read as the whole one", async () => {
    const db = fakeClient({
      leads: [empty],
      deals: [{ data: ids("d", 1000), error: null }, { data: null, error: { message: "statement timeout" } }],
      viewings: [empty],
    });
    await expect(readContactHistoryIds(db.client as never, C)).rejects.toThrow(/contact deal ids.*statement timeout/);
  });

  it("an answer with no rows array throws too (T-null-answer-guard)", async () => {
    const db = fakeClient({ leads: [{ data: null, error: null, status: 204 }], deals: [empty], viewings: [empty] });
    await expect(readContactHistoryIds(db.client as never, C)).rejects.toThrow(/contact lead ids/);
  });

  it("refuses what is not an id before it reaches the .or() filter", async () => {
    const db = fakeClient({});
    await expect(readContactHistoryIds(db.client as never, "x),id.not.is.null")).rejects.toThrow(/not a contact id/);
    expect(db.calls).toEqual([]);
  });
});
