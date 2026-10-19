import { describe, expect, it } from "vitest";
import { parsePropertyFilters } from "@/lib/queries/properties-list";
import { PROPERTY_KINDS, PROPERTY_STATUSES, resolvePropertyScope } from "@/lib/validators/properties";
import {
  LIVE_STATUSES,
  RETIRED_INVENTORY_HREF,
  inventoryListHref,
  parseInventoryCounts,
  summarizeInventory,
  type InventoryCount,
} from "./property-inventory";

/**
 * F04-C: the Inventory card's rules. The database half (0153's function, the
 * card against a real PostgREST, list parity) is pinned by
 * supabase/tests/dashboard-inventory.test.ts.
 */

const row = (kind: string, status: string, n: unknown) => ({ kind, status, n });

describe("parseInventoryCounts — what 0153's function may answer", () => {
  it("reads well-formed rows as they come", () => {
    expect(parseInventoryCounts([row("standalone", "available", 3), row("unit", "reserved", 1)])).toEqual([
      { kind: "standalone", status: "available", n: 3 },
      { kind: "unit", status: "reserved", n: 1 },
    ]);
    expect(parseInventoryCounts([])).toEqual([]);
  });

  it.each([
    ["an unknown kind", [row("building", "available", 1)], /row 0 is not a live kind and status/],
    ["a withdrawn row (outside the live scope)", [row("standalone", "withdrawn", 1)], /row 0 is not a live kind and status/],
    ["an unknown status", [row("unit", "let_agreed", 1)], /row 0 is not a live kind and status/],
    ["a count as text", [row("unit", "available", "6")], /row 0 has no whole count \("6"\)/],
    ["a zero count (a group-by never answers one)", [row("unit", "available", 0)], /row 0 has no whole count \(0\)/],
    ["a fractional count", [row("unit", "available", 1.5)], /row 0 has no whole count/],
    ["a missing count", [{ kind: "unit", status: "available" }], /row 0 has no whole count/],
    ["a null row", [null], /row 0 is not a live kind and status/],
    ["the same pair twice", [row("unit", "available", 2), row("unit", "available", 4)], /unit\/available answered twice/],
  ])("refuses %s — a failure, never a number", (_label, rows, message) => {
    expect(() => parseInventoryCounts(rows)).toThrow(/^Query failed \(inventory counts\): /);
    expect(() => parseInventoryCounts(rows)).toThrow(message);
  });
});

describe("summarizeInventory — records per status, stock without containers", () => {
  // the review's seed: 3 standalone listings and 1 project with 6 units, all available
  const seed: InventoryCount[] = [
    { kind: "standalone", status: "available", n: 3 },
    { kind: "project", status: "available", n: 1 },
    { kind: "unit", status: "available", n: 6 },
  ];

  it("counts every record once in its status total, broken down by kind", () => {
    const s = summarizeInventory(seed);
    expect(s.statuses).toEqual([
      {
        status: "available",
        total: 10,
        kinds: [
          { kind: "standalone", n: 3 },
          { kind: "project", n: 1 },
          { kind: "unit", n: 6 },
        ],
      },
    ]);
  });

  it("saleable available is listings + units — the project is never stock beside its own units", () => {
    expect(summarizeInventory(seed).saleableAvailable).toEqual({ total: 9, listings: 3, units: 6 });
    // a phase is a container too
    const phased = summarizeInventory([...seed, { kind: "phase", status: "available", n: 2 }]);
    expect(phased.saleableAvailable).toEqual({ total: 9, listings: 3, units: 6 });
    expect(phased.statuses[0]!.total).toBe(12);
    expect(phased.statuses[0]!.kinds.map((k) => k.kind)).toEqual(["standalone", "project", "phase", "unit"]);
  });

  it("orders statuses as the lifecycle does, omits empty ones and zero kinds, and never invents a withdrawn row", () => {
    const s = summarizeInventory([
      { kind: "unit", status: "sold", n: 2 },
      { kind: "standalone", status: "draft", n: 1 },
      { kind: "unit", status: "under_offer", n: 1 },
      { kind: "project", status: "draft", n: 1 },
    ]);
    expect(s.statuses.map((x) => x.status)).toEqual(["draft", "under_offer", "sold"]);
    expect(s.statuses[0]!.kinds).toEqual([
      { kind: "standalone", n: 1 },
      { kind: "project", n: 1 },
    ]);
    // nothing available: a real zero, from a complete answer
    expect(s.saleableAvailable).toEqual({ total: 0, listings: 0, units: 0 });
  });

  it("each status total is the sum of its kinds, for every kind × live status", () => {
    const all: InventoryCount[] = LIVE_STATUSES.flatMap((status, i) =>
      PROPERTY_KINDS.map((kind, j) => ({ kind, status, n: 1 + i * 4 + j })),
    );
    const s = summarizeInventory(all);
    expect(s.statuses).toHaveLength(LIVE_STATUSES.length);
    for (const st of s.statuses) {
      expect(st.kinds).toHaveLength(PROPERTY_KINDS.length);
      expect(st.total).toBe(st.kinds.reduce((sum, k) => sum + k.n, 0));
      expect(st.total).toBe(
        all.filter((c) => c.status === st.status).reduce((sum, c) => sum + c.n, 0),
      );
    }
  });

  it("an empty answer is an empty inventory", () => {
    expect(summarizeInventory([])).toEqual({
      statuses: [],
      saleableAvailable: { total: 0, listings: 0, units: 0 },
    });
  });
});

describe("the lists the numbers open", () => {
  it("live statuses are every status but withdrawn, in order", () => {
    expect(LIVE_STATUSES).toEqual(PROPERTY_STATUSES.filter((s) => s !== "withdrawn"));
  });

  it("a status total opens every kind; a chip opens its kind", () => {
    expect(inventoryListHref("available", "all")).toBe("/properties?status=available&kind=all");
    expect(inventoryListHref("under_offer", "unit")).toBe("/properties?status=under_offer&kind=unit");
    expect(RETIRED_INVENTORY_HREF).toBe("/properties?scope=archived&kind=all");
  });

  it.each(LIVE_STATUSES.flatMap((status) => PROPERTY_KINDS.map((kind) => [status, kind] as const)))(
    "%s × %s lands on the list's live default scope with that status and kind",
    (status, kind) => {
      const href = inventoryListHref(status, kind);
      const f = parsePropertyFilters(Object.fromEntries(new URL(href, "http://x").searchParams));
      expect(f.status).toBe(status);
      expect(f.kind).toBe(kind);
      expect(f.scope).toBe("active");
      // the same predicate as 0153's function: not archived, not withdrawn
      expect(resolvePropertyScope(f)).toBe("exclude-retired");
    },
  );
});
