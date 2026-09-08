import { describe, expect, it } from "vitest";
import {
  parsePropertyFilters,
  applyPropertyListFilters,
  fetchMandateExcludeIds,
  mandateEmbed,
  MANDATE_REL,
} from "./properties-list";
import { fakeClient } from "@/lib/testing/fake-client";
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

  /*
   * THROUGH THE VIEW, ALWAYS.
   *
   * `mandates_select` has no listing_manager arm — measured against the live
   * policy — so on the base table the embed came back empty on EVERY row for a
   * listing manager: the list badge read "none" while the property's own detail
   * page (which reads `mandates_safe`) showed the active mandate one click away,
   * mandate=active returned nothing, mandate=none returned every mandated
   * property as "needs a mandate", and the CSV wrote "none" down the column.
   *
   * Measured through real PostgREST with minted role JWTs, one mandated property:
   *   role             base embed   view embed
   *   admin            exclusive    exclusive
   *   listing_manager  []           exclusive   <- the bug and the fix
   *   assigned agent   exclusive    exclusive
   *   other agent      []           []          <- and nothing widens
   */
  it.each([
    ["active", true],
    ["expired", true],
    ["none", false],
    [undefined, false],
  ])("reads mandates_safe for mandate=%s", (mandate, inner) => {
    const embed = mandateEmbed(base(mandate ? { mandate } : {}));
    expect(embed, "doc 04: all UI mandate reads go through the view").toContain("mandates_safe");
    expect(embed.startsWith("mandates_safe"), "the base table is not a prefix match").toBe(true);
    expect(embed.includes("!inner")).toBe(inner);
  });

  /*
   * THE HALF NEITHER SIDE'S TEST WAS CHECKING.
   *
   * `mandateEmbed` names the relationship in the SELECT; `applyPropertyListFilters`
   * names it again as the prefix of an embedded-resource filter. PostgREST
   * requires them to be the same string — a filter on `<name>.<column>` whose
   * `<name>` is not embedded in that same select is rejected 400 PGRST108, not
   * ignored. When the embed moved to the view and the prefix stayed `mandates`,
   * mandate=active and mandate=expired threw the page's error boundary for EVERY
   * role and 500'd the CSV export, while both of the tests above still passed:
   * one asserted the embed, the other asserted the filter, and nothing compared
   * them. This is that comparison.
   *
   * Measured: `properties?select=...mandates_safe!inner(type,status)&mandates.status=eq.active`
   * -> 400 PGRST108 "'mandates' is not an embedded resource in this request";
   * with the prefix corrected -> 200, one row.
   */
  it.each(["active", "expired"] as const)(
    "the mandate=%s filter names the relationship the select actually embeds",
    (mandate) => {
      const filters = base({ mandate });
      const { spy, calls } = spyBuilder();
      applyPropertyListFilters(spy as never, filters, []);

      const mandateEq = calls.find(
        (c) => c.method === "eq" && String(c.args[0]).includes("."),
      );
      expect(mandateEq, "the filter is emitted at all").toBeDefined();

      const prefix = String(mandateEq!.args[0]).split(".")[0];
      expect(prefix, "PostgREST rejects a prefix that is not embedded here").toBe(MANDATE_REL);
      expect(
        mandateEmbed(filters).startsWith(prefix),
        `select embeds "${mandateEmbed(filters)}" but the filter prefixes "${prefix}"`,
      ).toBe(true);
    },
  );
});

describe("applyPropertyListFilters", () => {
  const methods = (calls: { method: string; args: unknown[] }[]) => calls.map((c) => c.method);

  /** neq calls that belong to the RETIRED scope, not to any other predicate.
   *  Filtering by column rather than counting every neq keeps these tests about
   *  the retired scope — the kind scope also emits one (see its own tests). */
  const retiredNeqs = (calls: { method: string; args: unknown[] }[]) =>
    calls.filter((c) => c.method === "neq" && (c.args[0] === "status" || c.args[0] === "visibility"));

  it("default active scope excludes retired status AND visibility", () => {
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(spy as never, base(), []);
    const neqs = retiredNeqs(calls);
    expect(neqs).toHaveLength(2);
    expect(neqs.map((c) => c.args[0])).toEqual(["status", "visibility"]);
  });

  it("archived scope ORs the two retired markers instead of excluding them", () => {
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(spy as never, base({ scope: "archived" }), []);
    expect(retiredNeqs(calls)).toHaveLength(0);
    const or = calls.find((c) => c.method === "or");
    expect(or?.args[0]).toContain("status.eq.withdrawn");
    expect(or?.args[0]).toContain("visibility.eq.archived");
  });

  it("an explicit retired status filter suppresses scope predicates (would otherwise be empty)", () => {
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(spy as never, base({ status: "withdrawn" }), []);
    expect(retiredNeqs(calls)).toHaveLength(0);
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

  it("a ceiling alone also ORs across both columns", () => {
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(spy as never, base({ price_max: "500000" }), []);
    const or = calls.find((c) => c.method === "or" && String(c.args[0]).includes("asking_price.lte"));
    expect(or?.args[0]).toBe("asking_price.lte.500000,rent_price_month.lte.500000");
  });

  it("a bracket with no transaction is grouped PER PRICE — one figure must satisfy both bounds", () => {
    // Audit A09. Two independent ORs let a listing for sale at 900,000 and to
    // let at 500 a month match 100,000–500,000: the sale cleared the floor,
    // the rent cleared the ceiling, and neither figure was in the range.
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(spy as never, base({ price_min: "100000", price_max: "500000" }), []);
    const priceOrs = calls.filter((c) => c.method === "or" && /price/.test(String(c.args[0])));
    expect(priceOrs).toHaveLength(1);
    expect(priceOrs[0]!.args[0]).toBe(
      "and(asking_price.gte.100000,asking_price.lte.500000),and(rent_price_month.gte.100000,rent_price_month.lte.500000)",
    );
    expect(methods(calls).filter((m) => m === "gte" || m === "lte")).toEqual([]);
  });

  it("the same bracket with sale_or_rent chosen is still grouped, because both prices are in play", () => {
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(
      spy as never,
      base({ transaction: "sale_or_rent", price_min: "100000", price_max: "500000" }),
      [],
    );
    const priceOrs = calls.filter((c) => c.method === "or" && /price/.test(String(c.args[0])));
    expect(priceOrs).toHaveLength(1);
    expect(String(priceOrs[0]!.args[0])).toMatch(/^and\(asking_price/);
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

describe("applyPropertyListFilters — kind scope (audit finding 3)", () => {
  const kindCalls = (calls: { method: string; args: unknown[] }[]) =>
    calls.filter((c) => c.args[0] === "kind");

  it("excludes units by default, so a project cannot bury the list", () => {
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(spy as never, base(), []);
    const k = kindCalls(calls);
    expect(k).toHaveLength(1);
    expect(k[0].method).toBe("neq");
    expect(k[0].args[1]).toBe("unit");
  });

  it("an explicit kind=unit selects units instead of excluding them", () => {
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(spy as never, base({ kind: "unit" }), []);
    const k = kindCalls(calls);
    expect(k).toHaveLength(1);
    expect(k[0].method).toBe("eq");
    expect(k[0].args[1]).toBe("unit");
  });

  it("an explicit non-unit kind narrows without also excluding units twice", () => {
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(spy as never, base({ kind: "project" }), []);
    const k = kindCalls(calls);
    expect(k).toHaveLength(1);
    expect(k[0].method).toBe("eq");
    expect(k[0].args[1]).toBe("project");
  });
});

describe("fetchMandateExcludeIds reads every excluded id, and fails loud (A08a)", () => {
  type Client = Parameters<typeof fetchMandateExcludeIds>[0];
  const ids = (from: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({ property_id: "p" + (from + i) }));

  it("pages past the thousandth mandate — the 1,001st exclusion used to fall off the list", async () => {
    const { client, served, argsOf } = fakeClient({
      mandates_safe: [
        { data: ids(0, 1000), error: null },
        { data: ids(1000, 3), error: null },
      ],
    });
    const out = await fetchMandateExcludeIds(client as unknown as Client, base({ mandate: "none" }));
    expect(out).toHaveLength(1003);
    expect(served.mandates_safe, "two pages of rows, then the empty read that ends it").toBe(3);
    // WHICH pages, and ordered: the count alone passed with .range() deleted
    expect(argsOf("mandates_safe", "range")).toEqual([
      [0, 999],
      [1000, 1999],
      [1003, 2002],
    ]);
    expect(argsOf("mandates_safe", "order")).toEqual([["id"], ["id"], ["id"]]);
  });

  it("dedupes ids across pages", async () => {
    const { client } = fakeClient({
      mandates_safe: [{ data: [...ids(0, 2), ...ids(0, 2)], error: null }],
    });
    expect(await fetchMandateExcludeIds(client as unknown as Client, base({ mandate: "expired" }))).toEqual(["p0", "p1"]);
  });

  it("throws on a failed page rather than excluding nothing", async () => {
    const { client } = fakeClient({ mandates_safe: [{ data: null, error: { message: "boom" } }] });
    await expect(
      fetchMandateExcludeIds(client as unknown as Client, base({ mandate: "none" })),
    ).rejects.toThrow("Query failed (mandates_safe): boom");
  });

  it("reads nothing at all when the filter does not need it", async () => {
    const { client, served } = fakeClient({});
    expect(await fetchMandateExcludeIds(client as unknown as Client, base({ mandate: "active" }))).toEqual([]);
    expect(served.mandates).toBeUndefined();
  });
});
