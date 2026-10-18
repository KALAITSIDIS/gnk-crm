import { describe, expect, it } from "vitest";
import {
  parsePropertyFilters,
  applyPropertyListFilters,
  applyPropertyListOrder,
  clearedPropertiesQuery,
  columnSort,
  countPropertyList,
  describePropertyFilters,
  describePropertySort,
  FILTER_ALL,
  hiddenUnitFilters,
  hiddenUnitsText,
  mandateEmbed,
  nextPropertiesQuery,
  ownWriteTracker,
  propertiesViewTitle,
  propertyCountNoun,
  propertySortColumn,
  searchParamsRecord,
  SORTABLE_COLUMNS,
  MANDATE_BLOCK_EMBED,
  MANDATE_HAS_EMBED,
  MANDATE_REL,
} from "./properties-list";
import { PROPERTY_SORTS, type PropertyFilters } from "@/lib/validators/properties";

/**
 * A chainable spy standing in for the Supabase filter builder. Every predicate
 * records {method, args} and returns the spy, so a test can assert exactly which
 * filters a given filter-set applies — the point being that the properties query
 * is intricate (scope, transaction-context price, mandate anti-joins) and must
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
  it("defaults scope to active, view to auto (cards on a phone, table above — CRM-06), page to 1", () => {
    const f = parsePropertyFilters({});
    expect(f.scope).toBe("active");
    expect(f.view).toBe("auto");
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
    // the anti-join aliases embed the view too, never the base table
    expect(embed, "no embed of the base table").not.toMatch(/(^|[\s,:])mandates(!inner)?\(/);
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
  it.each(["active", "expired", "none"] as const)(
    "every mandate=%s filter names an embed the select actually carries",
    (mandate) => {
      const filters = base({ mandate });
      const { spy, calls } = spyBuilder();
      applyPropertyListFilters(spy as never, filters);
      const select = mandateEmbed(filters);

      // filters on an embedded resource: "<embed>.<column>", or the anti-join's "<alias>" is null
      const embedFilters = calls.filter(
        (c) => String(c.args[0]).includes(".") ? !["or"].includes(c.method) : c.method === "is",
      );
      expect(embedFilters.length, "the filter is emitted at all").toBeGreaterThan(0);
      for (const f of embedFilters) {
        const prefix = String(f.args[0]).split(".")[0]!;
        const named = select.startsWith(`${prefix}(`) || select.startsWith(`${prefix}!inner(`) || select.includes(`${prefix}:`);
        expect(named, `select embeds "${select}" but ${f.method} names "${prefix}"`).toBe(true);
      }
    },
  );

  /*
   * THE ALIAS RULE (T-mandate-filter-anti-join). Measured on PostgREST v14.5:
   * when the view is embedded more than once, a filter on the UNALIASED
   * `mandates_safe.status` is not applied where it is written — "expired" as
   * `mandates_safe!inner(type, status)` + `mandates_safe.status=eq.expired` + the
   * aliased block listed every mandated listing, active ones included. So in a
   * select carrying an alias of the view, every filter names an alias.
   */
  it.each(["active", "expired", "none"] as const)(
    "mandate=%s: beside an alias of the view, no filter names the unaliased embed",
    (mandate) => {
      const filters = base({ mandate });
      const { spy, calls } = spyBuilder();
      applyPropertyListFilters(spy as never, filters);
      const embedsOfView = mandateEmbed(filters).split(MANDATE_REL).length - 1;
      const onUnaliased = calls.filter((c) => String(c.args[0]).startsWith(`${MANDATE_REL}.`));
      if (embedsOfView > 1) expect(onUnaliased, mandateEmbed(filters)).toEqual([]);
      else expect(embedsOfView).toBe(1);
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
    applyPropertyListFilters(spy as never, base());
    const neqs = retiredNeqs(calls);
    expect(neqs).toHaveLength(2);
    expect(neqs.map((c) => c.args[0])).toEqual(["status", "visibility"]);
  });

  it("archived scope ORs the two retired markers instead of excluding them", () => {
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(spy as never, base({ scope: "archived" }));
    expect(retiredNeqs(calls)).toHaveLength(0);
    const or = calls.find((c) => c.method === "or");
    expect(or?.args[0]).toContain("status.eq.withdrawn");
    expect(or?.args[0]).toContain("visibility.eq.archived");
  });

  it("an explicit retired status filter suppresses scope predicates (would otherwise be empty)", () => {
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(spy as never, base({ status: "withdrawn" }));
    expect(retiredNeqs(calls)).toHaveLength(0);
    // no scope OR either — resolvePropertyScope returned "none"
    expect(calls.filter((c) => c.method === "or")).toHaveLength(0);
    expect(calls.find((c) => c.method === "eq" && c.args[0] === "status")?.args[1]).toBe("withdrawn");
  });

  it("price bounds hit the transaction-specific column when a transaction is chosen", () => {
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(spy as never, base({ transaction: "rent", price_min: "500", price_max: "2000" }));
    const gte = calls.find((c) => c.method === "gte" && c.args[0] === "rent_price_month");
    const lte = calls.find((c) => c.method === "lte" && c.args[0] === "rent_price_month");
    expect(gte?.args[1]).toBe(500);
    expect(lte?.args[1]).toBe(2000);
  });

  it("price bounds OR across both columns when no transaction is chosen", () => {
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(spy as never, base({ price_min: "100000" }));
    const or = calls.find((c) => c.method === "or" && String(c.args[0]).includes("asking_price.gte"));
    expect(or?.args[0]).toBe("asking_price.gte.100000,rent_price_month.gte.100000");
  });

  it("a ceiling alone also ORs across both columns", () => {
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(spy as never, base({ price_max: "500000" }));
    const or = calls.find((c) => c.method === "or" && String(c.args[0]).includes("asking_price.lte"));
    expect(or?.args[0]).toBe("asking_price.lte.500000,rent_price_month.lte.500000");
  });

  it("a bracket with no transaction is grouped PER PRICE — one figure must satisfy both bounds", () => {
    // Audit A09. Two independent ORs let a listing for sale at 900,000 and to
    // let at 500 a month match 100,000–500,000: the sale cleared the floor,
    // the rent cleared the ceiling, and neither figure was in the range.
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(spy as never, base({ price_min: "100000", price_max: "500000" }));
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
    );
    const priceOrs = calls.filter((c) => c.method === "or" && /price/.test(String(c.args[0])));
    expect(priceOrs).toHaveLength(1);
    expect(String(priceOrs[0]!.args[0])).toMatch(/^and\(asking_price/);
  });

  /*
   * "No mandate" / "Expired" are anti-joins on an aliased, empty embed of the
   * view — never an id list in the URL, which past ~400 mandated listings was
   * 414 (T-mandate-filter-anti-join).
   */
  const mandateCalls = (calls: { method: string; args: unknown[] }[]) =>
    calls.filter((c) => /^mandate/.test(String(c.args[0])));

  it("mandate=none: no active or expired mandate — the block embed narrowed to both, then empty", () => {
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(spy as never, base({ mandate: "none" }));
    expect(mandateEmbed(base({ mandate: "none" }))).toBe(`mandates_safe(type, status), ${MANDATE_BLOCK_EMBED}`);
    expect(mandateCalls(calls)).toEqual([
      { method: "in", args: ["mandate_block.status", ["active", "expired"]] },
      { method: "is", args: ["mandate_block", null] },
    ]);
  });

  it("mandate=expired: an expired mandate (inner-joined alias) and no active one (the block)", () => {
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(spy as never, base({ mandate: "expired" }));
    expect(mandateEmbed(base({ mandate: "expired" }))).toBe(
      `mandates_safe(type, status), ${MANDATE_HAS_EMBED}, ${MANDATE_BLOCK_EMBED}`,
    );
    expect(mandateCalls(calls)).toEqual([
      { method: "eq", args: ["mandate_has.status", "expired"] },
      { method: "in", args: ["mandate_block.status", ["active"]] },
      { method: "is", args: ["mandate_block", null] },
    ]);
  });

  it("mandate=active is unchanged: the inner-joined display embed, filtered", () => {
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(spy as never, base({ mandate: "active" }));
    expect(mandateEmbed(base({ mandate: "active" }))).toBe("mandates_safe!inner(type, status)");
    expect(mandateCalls(calls)).toEqual([{ method: "eq", args: ["mandates_safe.status", "active"] }]);
  });

  it("no mandate filter: no mandate predicate, and never an id list", () => {
    for (const f of [base(), base({ mandate: "none" }), base({ mandate: "expired" }), base({ mandate: "active" })]) {
      const { spy, calls } = spyBuilder();
      applyPropertyListFilters(spy as never, f);
      expect(methods(calls), JSON.stringify(f.mandate)).not.toContain("not");
      if (!f.mandate) expect(mandateCalls(calls)).toEqual([]);
    }
    expect(mandateEmbed(base())).toBe("mandates_safe(type, status)");
  });

  it("maps a sale filter to both sale and sale_or_rent", () => {
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(spy as never, base({ transaction: "sale" }));
    const inCall = calls.find((c) => c.method === "in" && c.args[0] === "transaction_type");
    expect(inCall?.args[1]).toEqual(["sale", "sale_or_rent"]);
  });
});

describe("applyPropertyListFilters — kind scope (audit finding 3)", () => {
  const kindCalls = (calls: { method: string; args: unknown[] }[]) =>
    calls.filter((c) => c.args[0] === "kind");

  it("excludes units by default, so a project cannot bury the list", () => {
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(spy as never, base());
    const k = kindCalls(calls);
    expect(k).toHaveLength(1);
    expect(k[0].method).toBe("neq");
    expect(k[0].args[1]).toBe("unit");
  });

  it("an explicit kind=unit selects units instead of excluding them", () => {
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(spy as never, base({ kind: "unit" }));
    const k = kindCalls(calls);
    expect(k).toHaveLength(1);
    expect(k[0].method).toBe("eq");
    expect(k[0].args[1]).toBe("unit");
  });

  it("an explicit non-unit kind narrows without also excluding units twice", () => {
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(spy as never, base({ kind: "project" }));
    const k = kindCalls(calls);
    expect(k).toHaveLength(1);
    expect(k[0].method).toBe("eq");
    expect(k[0].args[1]).toBe("project");
  });
});

describe("applyPropertyListFilters — kind=all (F04)", () => {
  const kindCalls = (calls: { method: string; args: unknown[] }[]) =>
    calls.filter((c) => c.args[0] === "kind");

  it("kind=all parses to 'all' and puts NO kind predicate on the query", () => {
    const f = base({ kind: "all" });
    expect(f.kind).toBe("all");
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(spy as never, f);
    expect(kindCalls(calls)).toEqual([]);
  });

  it("kind=all leaves the retired scope exactly as it was", () => {
    const scoped = (over: Record<string, string>) => {
      const { spy, calls } = spyBuilder();
      applyPropertyListFilters(spy as never, base(over));
      return calls.filter((c) => c.args[0] !== "kind");
    };
    expect(scoped({ kind: "all" })).toEqual(scoped({}));
    expect(scoped({ kind: "all", scope: "archived" })).toEqual(scoped({ scope: "archived" }));
    expect(scoped({ kind: "all", status: "available" })).toEqual(scoped({ status: "available" }));
  });

  it("a kind the list does not know still falls back to the default — units hidden", () => {
    const f = base({ kind: "everything" });
    expect(f.kind).toBeUndefined();
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(spy as never, f);
    expect(kindCalls(calls)).toEqual([{ method: "neq", args: ["kind", "unit"] }]);
  });
});

describe("hiddenUnitFilters — the units the default list leaves out (F04)", () => {
  it("is the same filters with kind=unit when the list hides units", () => {
    const f = base({ status: "available", mandate: "none", q: "PAF", page: "3" });
    const hidden = hiddenUnitFilters(f);
    expect(hidden).toEqual({ ...f, kind: "unit" });
  });

  it("is null when the list hides nothing — any explicit kind, all included", () => {
    for (const kind of ["all", "unit", "standalone", "project", "phase"]) {
      expect(hiddenUnitFilters(base({ kind })), kind).toBeNull();
    }
  });

  it("the default and the hidden-units count split one all-kinds set: neq vs eq on kind, the rest identical", () => {
    const f = base({ status: "available", type: "apartment", mandate: "expired" });
    const record = (filters: ReturnType<typeof base>) => {
      const { spy, calls } = spyBuilder();
      applyPropertyListFilters(spy as never, filters);
      return calls;
    };
    const shown = record(f);
    const hidden = record(hiddenUnitFilters(f)!);
    const all = record(base({ status: "available", type: "apartment", mandate: "expired", kind: "all" }));
    expect(shown.filter((c) => c.args[0] === "kind")).toEqual([{ method: "neq", args: ["kind", "unit"] }]);
    expect(hidden.filter((c) => c.args[0] === "kind")).toEqual([{ method: "eq", args: ["kind", "unit"] }]);
    const rest = (calls: typeof shown) => calls.filter((c) => c.args[0] !== "kind");
    expect(rest(hidden)).toEqual(rest(shown));
    expect(rest(all)).toEqual(rest(shown));
  });
});

describe("countPropertyList", () => {
  it("is an exact HEAD count over the list's embeds and predicates", () => {
    const selects: unknown[][] = [];
    const { spy, calls } = spyBuilder();
    const supabase = {
      from: (table: string) => {
        calls.push({ method: "from", args: [table] });
        return {
          select: (...args: unknown[]) => {
            selects.push(args);
            return spy;
          },
        };
      },
    };
    const f = base({ mandate: "none", kind: "unit" });
    countPropertyList(supabase as never, f);
    expect(calls[0]).toEqual({ method: "from", args: ["properties"] });
    // the mandate aliases ride in the select, or their filters are 400 PGRST108
    expect(selects).toEqual([[`id, ${mandateEmbed(f)}`, { count: "exact", head: true }]]);
    expect(calls).toContainEqual({ method: "eq", args: ["kind", "unit"] });
    expect(calls).toContainEqual({ method: "is", args: ["mandate_block", null] });
  });
});

describe("propertyCountNoun / hiddenUnitsText — the header's words", () => {
  it("names what the default holds — not 'properties' with the units taken out", () => {
    expect(propertyCountNoun(undefined, 4)).toBe("listings & developments");
    expect(propertyCountNoun(undefined, 1)).toBe("listing or development");
    expect(propertyCountNoun(undefined, 0)).toBe("listings & developments");
  });

  it("names each explicit kind, and says when every kind is in", () => {
    expect(propertyCountNoun("all", 10)).toBe("properties · all kinds");
    expect(propertyCountNoun("all", 1)).toBe("property · all kinds");
    expect(propertyCountNoun("standalone", 3)).toBe("standalone listings");
    expect(propertyCountNoun("project", 1)).toBe("project");
    expect(propertyCountNoun("phase", 2)).toBe("phases");
    expect(propertyCountNoun("unit", 6)).toBe("units");
    expect(propertyCountNoun("unit", 1)).toBe("unit");
  });

  it("counts the hidden units in words", () => {
    expect(hiddenUnitsText(6)).toBe("6 units not shown");
    expect(hiddenUnitsText(1)).toBe("1 unit not shown");
  });
});

/* ------------------------------------------------------------------------ *
 * A03 — land filters, the sort, the filter bar's URL, a view that names itself
 * ------------------------------------------------------------------------ */

const PAPHOS = "11111111-2222-4333-8444-555555555555";
const PEYIA = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const PLACES = {
  districts: [{ id: PAPHOS, name: "Paphos" }],
  areas: [{ id: PEYIA, name: "Peyia" }],
};

describe("applyPropertyListFilters — land and plot (A03)", () => {
  const landCalls = (calls: { method: string; args: unknown[] }[]) =>
    calls.filter((c) => c.args[0] === "plot_area_sqm" || c.args[0] === "building_density_pct");

  it("plot_min / plot_max / density_min bound plot_area_sqm and building_density_pct, as numbers", () => {
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(spy as never, base({ plot_min: "1500", plot_max: "6000", density_min: "90" }));
    expect(landCalls(calls)).toEqual([
      { method: "gte", args: ["plot_area_sqm", 1500] },
      { method: "lte", args: ["plot_area_sqm", 6000] },
      { method: "gte", args: ["building_density_pct", 90] },
    ]);
  });

  it("each bound stands alone", () => {
    for (const [param, expected] of [
      ["plot_min", { method: "gte", args: ["plot_area_sqm", 1500.5] }],
      ["plot_max", { method: "lte", args: ["plot_area_sqm", 1500.5] }],
      ["density_min", { method: "gte", args: ["building_density_pct", 1500.5] }],
    ] as const) {
      const { spy, calls } = spyBuilder();
      applyPropertyListFilters(spy as never, base({ [param]: "1500.5" }));
      expect(landCalls(calls), param).toEqual([expected]);
    }
  });

  it("a negative, non-numeric, infinite or empty bound is no filter at all", () => {
    for (const bad of ["-1", "abc", "Infinity", "1e999", "", "NaN"]) {
      const f = base({ plot_min: bad, plot_max: bad, density_min: bad });
      expect([f.plot_min, f.plot_max, f.density_min], bad).toEqual([undefined, undefined, undefined]);
      const { spy, calls } = spyBuilder();
      applyPropertyListFilters(spy as never, f);
      expect(landCalls(calls), bad).toEqual([]);
    }
  });

  it("no land parameter, no land predicate — the default list is untouched", () => {
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(spy as never, base({ type: "land" }));
    expect(landCalls(calls)).toEqual([]);
  });

  it("the business example: Paphos land, plot 1,500–6,000 m², density ≥ 90%", () => {
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(
      spy as never,
      base({ district: PAPHOS, type: "land", plot_min: "1500", plot_max: "6000", density_min: "90" }),
    );
    expect(calls).toContainEqual({ method: "eq", args: ["district_id", PAPHOS] });
    expect(calls).toContainEqual({ method: "eq", args: ["property_type", "land"] });
    expect(landCalls(calls)).toHaveLength(3);
  });
});

describe("applyPropertyListFilters — the search box (q)", () => {
  it("matches reference, address and English title, with PostgREST's separators taken out", () => {
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(spy as never, base({ q: " PAF(0012),%x " }));
    const or = calls.filter((c) => c.method === "or" && String(c.args[0]).includes("ilike"));
    // trimmed by the schema, then each of % , ( ) becomes a space and the ends are trimmed again
    expect(or).toEqual([
      { method: "or", args: ["reference.ilike.%PAF 0012   x%,address.ilike.%PAF 0012   x%,title->>en.ilike.%PAF 0012   x%"] },
    ]);
  });

  it("a search made only of separators searches nothing rather than everything", () => {
    const { spy, calls } = spyBuilder();
    applyPropertyListFilters(spy as never, base({ q: "%(),%" }));
    expect(calls.filter((c) => c.method === "or" && String(c.args[0]).includes("ilike"))).toEqual([]);
  });
});

describe("applyPropertyListOrder (A03)", () => {
  const orders = (filters: PropertyFilters) => {
    const { spy, calls } = spyBuilder();
    applyPropertyListOrder(spy as never, filters);
    return calls;
  };

  it("the default is EXACTLY the order the list always sent: created_at desc, then id", () => {
    const expected = [
      { method: "order", args: ["created_at", { ascending: false }] },
      { method: "order", args: ["id"] },
    ];
    expect(orders(base())).toEqual(expected);
    expect(orders(base({ sort: "newest" }))).toEqual(expected);
    // an unknown sort is the default, like any other invalid parameter
    expect(base({ sort: "cheapest" }).sort).toBe("newest");
    expect(orders(base({ sort: "cheapest" }))).toEqual(expected);
  });

  it("on the wire the default is still created_at.desc,id.asc — the pin list-page-order holds (no nulls clause)", async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const db = createClient("http://127.0.0.1:1", "anon-key-unused");
    const wire = (filters: PropertyFilters) => {
      const q = applyPropertyListOrder(db.from("properties").select("id"), filters);
      return (q as unknown as { url: URL }).url.searchParams.get("order");
    };
    expect(wire(base())).toBe("created_at.desc,id.asc");
    expect(wire(base({ sort: "price_asc" }))).toBe("asking_price.asc.nullslast,id.asc");
    expect(wire(base({ sort: "price_desc", transaction: "rent" }))).toBe("rent_price_month.desc.nullslast,id.asc");
    expect(wire(base({ sort: "plot_desc" }))).toBe("plot_area_sqm.desc.nullslast,id.asc");
  });

  it.each(PROPERTY_SORTS.filter((s) => s !== "newest"))(
    "%s: one sort column with unknowns last, then id — a unique order, so pages partition",
    (sort) => {
      const calls = orders(base({ sort }));
      expect(calls).toHaveLength(2);
      expect(calls[0]!.method).toBe("order");
      expect(calls[0]!.args[1]).toMatchObject({ nullsFirst: false });
      expect(calls[1]).toEqual({ method: "order", args: ["id"] });
    },
  );

  it("each sort orders the column it names, in the direction it names", () => {
    expect(propertySortColumn(base({ sort: "updated" }))).toEqual({ column: "updated_at", ascending: false });
    expect(propertySortColumn(base({ sort: "price_asc" }))).toEqual({ column: "asking_price", ascending: true });
    expect(propertySortColumn(base({ sort: "price_desc" }))).toEqual({ column: "asking_price", ascending: false });
    expect(propertySortColumn(base({ sort: "plot_asc" }))).toEqual({ column: "plot_area_sqm", ascending: true });
    expect(propertySortColumn(base({ sort: "plot_desc" }))).toEqual({ column: "plot_area_sqm", ascending: false });
    expect(propertySortColumn(base({ sort: "score_asc" }))).toEqual({ column: "quality_score", ascending: true });
    expect(propertySortColumn(base({ sort: "score_desc" }))).toEqual({ column: "quality_score", ascending: false });
    expect(propertySortColumn(base({ sort: "reference" }))).toEqual({ column: "reference", ascending: true });
    expect(propertySortColumn(base({ sort: "reference_desc" }))).toEqual({ column: "reference", ascending: false });
    expect(propertySortColumn(base())).toBeNull();
  });

  it("price orders by the price the transaction filter reads: rent under Rent, the asking price otherwise", () => {
    expect(propertySortColumn(base({ sort: "price_asc", transaction: "rent" }))?.column).toBe("rent_price_month");
    for (const transaction of ["sale", "sale_or_rent"]) {
      expect(propertySortColumn(base({ sort: "price_asc", transaction }))?.column, transaction).toBe("asking_price");
    }
    expect(propertySortColumn(base({ sort: "price_asc" }))?.column).toBe("asking_price");
  });
});

describe("columnSort — the table's sortable headers (A03)", () => {
  it("a header that is not the sort goes to its first (ascending) sort, every filter kept, page dropped", () => {
    const s = columnSort("price", `district=${PAPHOS}&view=table&page=3`, "newest");
    expect(s.direction).toBeNull();
    expect(s.href).toBe(`/properties?district=${PAPHOS}&view=table&sort=price_asc`);
  });

  it("the current sort's header says its direction and flips it", () => {
    const asc = columnSort("price", "sort=price_asc", "price_asc");
    expect(asc).toEqual({ direction: "ascending", href: "/properties?sort=price_desc" });
    const desc = columnSort("price", "sort=price_desc", "price_desc");
    expect(desc).toEqual({ direction: "descending", href: "/properties?sort=price_asc" });
  });

  it("every sortable column pairs two real sorts, ascending first", () => {
    for (const [column, [asc, desc]] of Object.entries(SORTABLE_COLUMNS)) {
      expect(PROPERTY_SORTS, column).toContain(asc);
      expect(PROPERTY_SORTS, column).toContain(desc);
      expect(propertySortColumn(base({ sort: asc }))?.ascending, `${column} first is ascending`).toBe(true);
      expect(propertySortColumn(base({ sort: desc }))?.ascending, `${column} second is descending`).toBe(false);
    }
  });
});

describe("nextPropertiesQuery — what the filter bar writes (A03)", () => {
  it("sets a value, removes an empty / undefined / ALL one, keeps the rest", () => {
    expect(nextPropertiesQuery("type=villa&view=table", { district: PAPHOS })).toBe(
      `type=villa&view=table&district=${PAPHOS}`,
    );
    for (const cleared of [undefined, "", FILTER_ALL]) {
      expect(nextPropertiesQuery("type=villa&view=table", { type: cleared }), String(cleared)).toBe("view=table");
    }
  });

  it("a filter change returns to page 1; the view toggle keeps the page", () => {
    expect(nextPropertiesQuery("type=villa&page=3", { type: "land" })).toBe("type=land");
    expect(nextPropertiesQuery("type=villa&page=3", { view: "cards" }, { keepPage: true })).toBe(
      "type=villa&page=3&view=cards",
    );
  });

  it("a change that changes nothing keeps the page — leaving a number box as it was is not a new filter", () => {
    expect(nextPropertiesQuery("beds=2&page=3", { beds: "2" })).toBe("beds=2&page=3");
    expect(nextPropertiesQuery("page=3", { beds: undefined })).toBe("page=3");
  });

  it("the default sort is no parameter at all", () => {
    expect(nextPropertiesQuery("sort=price_asc&type=land", { sort: "newest" })).toBe("type=land");
    expect(nextPropertiesQuery("type=land", { sort: "plot_desc" })).toBe("type=land&sort=plot_desc");
  });

  it("a repeated key collapses to the one value written", () => {
    expect(nextPropertiesQuery("type=villa&type=land&page=2", { type: "land" })).toBe("type=land");
  });
});

describe("clearedPropertiesQuery — Clear keeps how the list is shown, nothing else", () => {
  it("keeps view and sort; drops every filter and the page", () => {
    expect(
      clearedPropertiesQuery(`q=PAF&district=${PAPHOS}&plot_min=1500&kind=all&scope=all&view=cards&sort=plot_desc&page=4`),
    ).toBe("view=cards&sort=plot_desc");
    expect(clearedPropertiesQuery("q=PAF&type=land")).toBe("");
  });
});

describe("searchParamsRecord", () => {
  it("reads the FIRST value of a repeated key, as the page does", () => {
    expect(searchParamsRecord(new URLSearchParams("type=villa&type=land&q=x"))).toEqual({ type: "villa", q: "x" });
  });
});

describe("ownWriteTracker — the filter bar's own navigations vs everyone else's (A03)", () => {
  it("an own write that lands is the bar's; nothing is left pending", () => {
    const t = ownWriteTracker();
    t.wrote("type=land");
    expect(t.settled("type=land")).toBe(true);
    expect(t.pending()).toEqual([]);
  });

  it("two writes in flight land in order; each is the bar's own", () => {
    const t = ownWriteTracker();
    t.wrote(`district=${PAPHOS}`);
    t.wrote(`district=${PAPHOS}&type=land`);
    expect(t.settled(`district=${PAPHOS}`)).toBe(true);
    expect(t.pending()).toEqual([`district=${PAPHOS}&type=land`]);
    expect(t.settled(`district=${PAPHOS}&type=land`)).toBe(true);
    expect(t.pending()).toEqual([]);
  });

  it("a superseded write never lands — and is forgotten, so a later Back to that URL is external", () => {
    const t = ownWriteTracker();
    t.wrote("type=villa");
    t.wrote("type=land");
    expect(t.settled("type=land")).toBe(true);
    expect(t.pending()).toEqual([]);
    expect(t.settled("type=villa"), "Back to the superseded URL").toBe(false);
  });

  it("a URL the bar did not write is external, and drops whatever was pending", () => {
    const t = ownWriteTracker();
    t.wrote("type=land");
    expect(t.settled("sort=price_asc")).toBe(false);
    expect(t.pending()).toEqual([]);
  });

  it("A, B, A: the settled A is the newest A — no stale copy lingers", () => {
    const t = ownWriteTracker();
    t.wrote("type=land");
    t.wrote("type=villa");
    t.wrote("type=land");
    expect(t.settled("type=land")).toBe(true);
    expect(t.pending()).toEqual([]);
  });

  /*
   * The race itself, on a model of the bar: changes composed from the URL on
   * screen (the old bar) against changes composed from the newest URL asked
   * for (`latest`, the bar now). Two changes before the first navigation
   * commits — a district, then a type; or a select and then the search's
   * debounce firing.
   */
  it("composing from the newest URL asked for keeps both changes; composing from the screen lost the first", () => {
    const onScreen = ""; // nothing has committed yet
    // the old bar: each change from the rendered URL
    const oldFirst = nextPropertiesQuery(onScreen, { district: PAPHOS });
    const oldSecond = nextPropertiesQuery(onScreen, { type: "land" });
    expect(oldFirst).toBe(`district=${PAPHOS}`);
    expect(oldSecond, "the old bar's second write drops the district").toBe("type=land");

    // the bar now: each change from `latest`
    const t = ownWriteTracker();
    let latest = onScreen;
    const write = (updates: Record<string, string | undefined>) => {
      latest = nextPropertiesQuery(latest, updates);
      t.wrote(latest);
      return latest;
    };
    write({ district: PAPHOS });
    const last = write({ type: "land" });
    // the search's debounce fires after both
    const withSearch = write({ q: "plot" });
    expect(last).toBe(`district=${PAPHOS}&type=land`);
    expect(withSearch).toBe(`district=${PAPHOS}&type=land&q=plot`);
    // only the last navigation commits (the router superseded the others)
    expect(t.settled(withSearch)).toBe(true);
    expect(t.pending()).toEqual([]);
  });
});

describe("describePropertyFilters / propertiesViewTitle — a view that names itself (A03)", () => {
  it("the default view has no description, and its title is just the list's name", () => {
    expect(describePropertyFilters(base(), PLACES)).toBe("");
    expect(propertiesViewTitle("Properties", base(), PLACES)).toBe("Properties");
    // presentation is not description
    expect(describePropertyFilters(base({ view: "cards", page: "2" }), PLACES)).toBe("");
  });

  it("the business example reads as the view it is", () => {
    const f = base({
      district: PAPHOS,
      type: "land",
      plot_min: "1500",
      plot_max: "6000",
      density_min: "90",
      sort: "plot_desc",
    });
    const words = "Paphos · Land · plot 1.500–6.000 m² · density ≥ 90% · sorted by plot ↓";
    expect(describePropertyFilters(f, PLACES)).toBe(words);
    expect(propertiesViewTitle("Properties", f, PLACES)).toBe(`Properties · ${words}`);
  });

  it("names every filter, in a fixed order", () => {
    const f = base({
      q: "sea view",
      district: PAPHOS,
      area: PEYIA,
      type: "villa",
      kind: "all",
      transaction: "sale",
      status: "under_offer",
      visibility: "vip",
      mandate: "none",
      beds: "3",
      price_min: "100000",
      price_max: "500000",
      scope: "all",
      sort: "price_desc",
    });
    expect(describePropertyFilters(f, PLACES)).toBe(
      "“sea view” · Paphos · Peyia · Villa · All kinds · For sale · Under offer · Visibility: VIP · No mandate · " +
        "3+ beds · price €100.000–€500.000 · Active & archived · sorted by asking price ↓",
    );
  });

  it("one bound reads as ≥ or ≤; a rent bracket says rent and per month", () => {
    expect(describePropertyFilters(base({ plot_min: "1500" }), PLACES)).toBe("plot ≥ 1.500 m²");
    expect(describePropertyFilters(base({ plot_max: "800.5" }), PLACES)).toBe("plot ≤ 800,5 m²");
    expect(describePropertyFilters(base({ price_min: "100000" }), PLACES)).toBe("price ≥ €100.000");
    expect(describePropertyFilters(base({ transaction: "rent", price_min: "500", price_max: "2000" }), PLACES)).toBe(
      "For rent · rent €500–€2.000/mo",
    );
  });

  it("an id the session cannot name is still described — the list still filters by it", () => {
    const other = "99999999-9999-4999-8999-999999999999";
    expect(describePropertyFilters(base({ district: other, area: other }), PLACES)).toBe(
      "Unknown district · Unknown area",
    );
  });

  it("only what the parser kept is described: an invalid parameter the list ignores is not named", () => {
    expect(describePropertyFilters(base({ beds: "150", type: "castle", district: "not-an-id", sort: "x" }), PLACES)).toBe("");
  });

  it("a long search is cut at 40 characters, in quotes", () => {
    const q = "a".repeat(60);
    expect(describePropertyFilters(base({ q }), PLACES)).toBe(`“${"a".repeat(40)}…”`);
  });

  it("the archived scope and page numbers are named; page only in the title", () => {
    expect(describePropertyFilters(base({ scope: "archived" }), PLACES)).toBe("Archived");
    expect(propertiesViewTitle("Properties", base({ scope: "archived", page: "3" }), PLACES)).toBe(
      "Properties · Archived · page 3",
    );
    expect(propertiesViewTitle("Properties", base({ page: "2" }), PLACES)).toBe("Properties · page 2");
  });

  it("every sort but the default has words; price says which price it orders by", () => {
    for (const sort of PROPERTY_SORTS) {
      const words = describePropertySort(base({ sort }));
      if (sort === "newest") expect(words).toBeNull();
      else expect(words, sort).toMatch(/\S/);
    }
    expect(describePropertySort(base({ sort: "price_asc", transaction: "rent" }))).toBe("sorted by rent ↑");
    expect(describePropertySort(base({ sort: "price_asc" }))).toBe("sorted by asking price ↑");
  });
});
