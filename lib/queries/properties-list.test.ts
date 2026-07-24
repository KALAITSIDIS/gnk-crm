import { describe, expect, it } from "vitest";
import {
  parsePropertyFilters,
  applyPropertyListFilters,
  mandateEmbed,
} from "./properties-list";
import type { PropertyFilters } from "@/lib/validators/properties";

/**
 * A chainable spy standing in for the Supabase filter builder. Every predicate
 * records {method, args} and returns the spy, so a test can assert exactly which
 * filters a given filter-set applies — the point being that the properties query
 * is intricate (scope, transaction-context price, mandate exclusion) and must
 * stay identical between the list page and the export.
 */
function spyBuilder() {
  const calls: { method: string; args: unknown[] }[] = [];
  const make = () =>
    new Proxy(
      {},
      {
        get(_t, prop: string) {
          return (...args: unknown[]) => {
            calls.push({ method: prop, args });
            return spy;
          };
        },
      },
    );
  const spy = make();
  return { spy, calls };
}

// Raw searchParams shape (strings) — parsePropertyFilters does the coercion.
const base = (over: Record<string, string> = {}): PropertyFilters =>
  parsePropertyFilters(over);

describe("parsePropertyFilters", () => {
  it("defaults scope to active, view to table, page to 1", () => {
    const f = parsePropertyFilters({});
    expect(f.scope).toBe("active");
    expect(f.view).toBe("table");
    expect(f.page).toBe(1);
  });

  it("keeps valid enums and drops invalid ones", () => {
    const f = parsePropertyFilters({ type: "villa", transaction: "rent", status: "nonsense" });
    expect(f.type).toBe("villa");
    expect(f.transaction).toBe("rent");
    expect(f.status).toBeUndefined();
  });
});

describe("mandateEmbed", () => {
  it("inner-joins only when filtering by active/expired mandate", () => {
    expect(mandateEmbed(base({ mandate: "active" }))).toContain("!inner");
    expect(mandateEmbed(base({ mandate: "expired" }))).toContain("!inner");
    expect(mandateEmbed(base({ mandate: "none" }))).not.toContain("!inner");
    expect(mandateEmbed(base())).not.toContain("!inner");
  });
});

describe("applyPropertyListFilters", () => {
  const methods = (calls: { method: string; args: unknown[] }[]) => calls.map((c) => c.method);

  it("default active scope excludes retired status AND visibility", () => {
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(spy as never, base(), []);
    const neqs = calls.filter((c) => c.method === "neq");
    expect(neqs).toHaveLength(2);
    expect(neqs.map((c) => c.args[0])).toEqual(["status", "visibility"]);
  });

  it("archived scope ORs the two retired markers instead of excluding them", () => {
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(spy as never, base({ scope: "archived" }), []);
    expect(methods(calls)).not.toContain("neq");
    const or = calls.find((c) => c.method === "or");
    expect(or?.args[0]).toContain("status.eq.withdrawn");
    expect(or?.args[0]).toContain("visibility.eq.archived");
  });

  it("an explicit retired status filter suppresses scope predicates (would otherwise be empty)", () => {
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(spy as never, base({ status: "withdrawn" }), []);
    expect(methods(calls)).not.toContain("neq");
    // no scope OR either — resolvePropertyScope returned "none"
    expect(calls.filter((c) => c.method === "or")).toHaveLength(0);
    expect(calls.find((c) => c.method === "eq" && c.args[0] === "status")?.args[1]).toBe("withdrawn");
  });

  it("price bounds hit the transaction-specific column when a transaction is chosen", () => {
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(spy as never, base({ transaction: "rent", price_min: "500", price_max: "2000" }), []);
    const gte = calls.find((c) => c.method === "gte" && c.args[0] === "rent_price_month");
    const lte = calls.find((c) => c.method === "lte" && c.args[0] === "rent_price_month");
    expect(gte?.args[1]).toBe(500);
    expect(lte?.args[1]).toBe(2000);
  });

  it("price bounds OR across both columns when no transaction is chosen", () => {
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(spy as never, base({ price_min: "100000" }), []);
    const or = calls.find((c) => c.method === "or" && String(c.args[0]).includes("asking_price.gte"));
    expect(or?.args[0]).toBe("asking_price.gte.100000,rent_price_month.gte.100000");
  });

  it("excludes the pre-queried mandate ids for the 'none' filter", () => {
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(spy as never, base({ mandate: "none" }), ["id-1", "id-2"]);
    const not = calls.find((c) => c.method === "not");
    expect(not?.args).toEqual(["id", "in", "(id-1,id-2)"]);
  });

  it("does not emit a NOT IN when there are no ids to exclude", () => {
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(spy as never, base({ mandate: "none" }), []);
    expect(methods(calls)).not.toContain("not");
  });

  it("maps a sale filter to both sale and sale_or_rent", () => {
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(spy as never, base({ transaction: "sale" }), []);
    const inCall = calls.find((c) => c.method === "in" && c.args[0] === "transaction_type");
    expect(inCall?.args[1]).toEqual(["sale", "sale_or_rent"]);
  });
});
