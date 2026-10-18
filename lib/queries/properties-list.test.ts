import { describe, expect, it } from "vitest";
import {
  parsePropertyFilters,
  applyPropertyListFilters,
  countPropertyList,
  hiddenUnitFilters,
  hiddenUnitsText,
  mandateEmbed,
  propertyCountNoun,
  MANDATE_BLOCK_EMBED,
  MANDATE_HAS_EMBED,
  MANDATE_REL,
} from "./properties-list";
import type { PropertyFilters } from "@/lib/validators/properties";

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
