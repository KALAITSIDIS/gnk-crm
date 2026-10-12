import { describe, expect, it } from "vitest";
import { KEY_SEARCH_MAX, KEY_SEARCH_NOTHING, KEY_SEARCH_TOO_LONG, type KeyFilters } from "@/lib/validators/keys";
import { parseKeyFilters, applyKeyListFilters, withKeySearchEmbed, KEY_REFERENCE_MATCH_EMBED, type KeySearchParams } from "./keys-list";

/** Filters a valid search parses to (fails the test on a refusal). */
function filtersOf(sp: KeySearchParams): KeyFilters {
  const parsed = parseKeyFilters(sp);
  if (!parsed.filters) throw new Error(`refused: ${parsed.refusal}`);
  return parsed.filters;
}

function spy() {
  const calls: { method: string; args: unknown[] }[] = [];
  const s: Record<string, (...a: unknown[]) => unknown> = {
    eq: (...args) => (calls.push({ method: "eq", args }), s),
    ilike: (...args) => (calls.push({ method: "ilike", args }), s),
    or: (...args) => (calls.push({ method: "or", args }), s),
  };
  return { s, calls };
}

describe("parseKeyFilters", () => {
  it("defaults status to all and keeps a valid status + trimmed q", () => {
    expect(filtersOf({}).status).toBe("all");
    expect(filtersOf({ status: "checked_out" }).status).toBe("checked_out");
    expect(filtersOf({ status: "bogus" }).status).toBe("all");
    expect(filtersOf({ q: "  534  " }).q).toBe("534");
  });

  // T-keys-search-length: a search longer than the box allows is REFUSED in
  // words — never thrown (the page error boundary / the export bare 500), never
  // truncated, never dropped to an unfiltered register.
  it("refuses a search longer than the box allows, in words", () => {
    for (const q of ["x".repeat(KEY_SEARCH_MAX + 1), `  ${"x".repeat(KEY_SEARCH_MAX + 1)}  `, "α".repeat(KEY_SEARCH_MAX + 1)]) {
      expect(parseKeyFilters({ q }), q.length.toString()).toEqual({ filters: null, refusal: KEY_SEARCH_TOO_LONG });
      expect(parseKeyFilters({ q, status: "checked_out" })).toEqual({ filters: null, refusal: KEY_SEARCH_TOO_LONG });
    }
    expect(KEY_SEARCH_TOO_LONG).toBe("That search is too long — 100 characters at most. Nothing was searched.");
  });

  it("runs a search of exactly the limit, counted after trimming", () => {
    const at = "x".repeat(KEY_SEARCH_MAX);
    expect(parseKeyFilters({ q: at })).toEqual({ filters: { status: "all", q: at }, refusal: null });
    expect(parseKeyFilters({ q: `   ${at}   ` })).toEqual({ filters: { status: "all", q: at }, refusal: null });
    expect(parseKeyFilters({ q: "α".repeat(KEY_SEARCH_MAX) }).filters?.q).toBe("α".repeat(KEY_SEARCH_MAX));
  });

  it("refuses a search of nothing but the characters a search leaves out — never the whole register", () => {
    for (const q of ["(,)", ",", "\\", " ( ) ", "()"]) {
      expect(parseKeyFilters({ q }), JSON.stringify(q)).toEqual({ filters: null, refusal: KEY_SEARCH_NOTHING });
      expect(parseKeyFilters({ q, status: "lost" }), JSON.stringify(q)).toEqual({ filters: null, refusal: KEY_SEARCH_NOTHING });
    }
    // an empty or blank box is no search at all, not a refusal
    for (const q of ["", "   "]) expect(parseKeyFilters({ q })).toEqual({ filters: { status: "all", q: undefined }, refusal: null });
    // a term with something left after the sanitizer still searches
    expect(filtersOf({ q: "(PAF)" }).q).toBe("(PAF)");
  });

  it("reads the first of a repeated search, and refuses it when that one is too long", () => {
    expect(filtersOf({ q: ["534", "x".repeat(KEY_SEARCH_MAX + 1)] }).q).toBe("534");
    expect(parseKeyFilters({ q: ["x".repeat(KEY_SEARCH_MAX + 1), "534"] }).refusal).toBe(KEY_SEARCH_TOO_LONG);
  });
});

describe("withKeySearchEmbed", () => {
  const COLUMNS = "key_code, properties(reference)";

  it("adds the reference-match embed — the property again, under an alias, selecting nothing — when there is a term", () => {
    expect(KEY_REFERENCE_MATCH_EMBED).toBe("reference_match:properties()");
    expect(withKeySearchEmbed(COLUMNS, filtersOf({ q: "PAF" }))).toBe(
      "key_code, properties(reference), reference_match:properties()",
    );
    expect(withKeySearchEmbed(COLUMNS, filtersOf({ q: "PAF", status: "lost" }))).toBe(
      "key_code, properties(reference), reference_match:properties()",
    );
  });

  it("leaves an unsearched select alone — exactly when applyKeyListFilters adds no reference filter", () => {
    // "(,)" is refused by the parser (below); the builders still add nothing for it
    for (const filters of [filtersOf({}), filtersOf({ status: "checked_out" }), filtersOf({ q: "   " }), { status: "all" as const, q: "(,)" }]) {
      const sp = filters;
      const { s, calls } = spy();
      applyKeyListFilters(s as never, filters);
      expect(withKeySearchEmbed(COLUMNS, filters), JSON.stringify(sp)).toBe(COLUMNS);
      expect(calls.some((c) => c.method === "ilike"), JSON.stringify(sp)).toBe(false);
    }
  });
});

describe("applyKeyListFilters", () => {
  it("applies no status predicate for the 'all' scope and no term", () => {
    const { s, calls } = spy();
    applyKeyListFilters(s as never, filtersOf({}));
    expect(calls).toHaveLength(0);
  });

  it("filters by a concrete status", () => {
    const { s, calls } = spy();
    applyKeyListFilters(s as never, filtersOf({ status: "lost" }));
    expect(calls).toEqual([{ method: "eq", args: ["status", "lost"] }]);
  });

  it("ORs the text term across code/description/holder and the property reference", () => {
    const { s, calls } = spy();
    applyKeyListFilters(s as never, filtersOf({ q: "villa" }));
    expect(calls).toEqual([
      // the reference predicate sits on the aliased embed, never on the displayed one
      { method: "ilike", args: ["reference_match.reference", "%villa%"] },
      {
        method: "or",
        args: [
          "key_code.ilike.%villa%,description.ilike.%villa%,current_holder_name.ilike.%villa%,reference_match.not.is.null",
        ],
      },
    ]);
  });

  it("keeps the status beside the search, and the term as the sanitizer leaves it", () => {
    const { s, calls } = spy();
    applyKeyListFilters(s as never, filtersOf({ status: "checked_out", q: " PAF(1),2 " }));
    expect(calls[0]).toEqual({ method: "eq", args: ["status", "checked_out"] });
    expect(calls[1]).toEqual({ method: "ilike", args: ["reference_match.reference", "%PAF 1  2%"] });
    expect(calls[2]?.args[0]).toBe(
      "key_code.ilike.%PAF 1  2%,description.ilike.%PAF 1  2%,current_holder_name.ilike.%PAF 1  2%,reference_match.not.is.null",
    );
  });

  it("adds nothing for a term the sanitizer empties", () => {
    const { s, calls } = spy();
    applyKeyListFilters(s as never, { status: "all", q: "(,)" });
    expect(calls).toHaveLength(0);
  });
});
