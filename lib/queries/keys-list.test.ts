import { describe, expect, it } from "vitest";
import { parseKeyFilters, applyKeyListFilters, withKeySearchEmbed, KEY_REFERENCE_MATCH_EMBED } from "./keys-list";

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
    expect(parseKeyFilters({}).status).toBe("all");
    expect(parseKeyFilters({ status: "checked_out" }).status).toBe("checked_out");
    expect(parseKeyFilters({ status: "bogus" }).status).toBe("all");
    expect(parseKeyFilters({ q: "  534  " }).q).toBe("534");
  });
});

describe("withKeySearchEmbed", () => {
  it("adds the reference-match embed — the property again, under an alias, selecting nothing", () => {
    expect(KEY_REFERENCE_MATCH_EMBED).toBe("reference_match:properties()");
    expect(withKeySearchEmbed("key_code, properties(reference)")).toBe(
      "key_code, properties(reference), reference_match:properties()",
    );
  });
});

describe("applyKeyListFilters", () => {
  it("applies no status predicate for the 'all' scope and no term", () => {
    const { s, calls } = spy();
    applyKeyListFilters(s as never, parseKeyFilters({}));
    expect(calls).toHaveLength(0);
  });

  it("filters by a concrete status", () => {
    const { s, calls } = spy();
    applyKeyListFilters(s as never, parseKeyFilters({ status: "lost" }));
    expect(calls).toEqual([{ method: "eq", args: ["status", "lost"] }]);
  });

  it("ORs the text term across code/description/holder and the property reference", () => {
    const { s, calls } = spy();
    applyKeyListFilters(s as never, parseKeyFilters({ q: "villa" }));
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
    applyKeyListFilters(s as never, parseKeyFilters({ status: "checked_out", q: " PAF(1),2 " }));
    expect(calls[0]).toEqual({ method: "eq", args: ["status", "checked_out"] });
    expect(calls[1]).toEqual({ method: "ilike", args: ["reference_match.reference", "%PAF 1  2%"] });
    expect(calls[2]?.args[0]).toBe(
      "key_code.ilike.%PAF 1  2%,description.ilike.%PAF 1  2%,current_holder_name.ilike.%PAF 1  2%,reference_match.not.is.null",
    );
  });

  it("adds nothing for a term the sanitizer empties", () => {
    const { s, calls } = spy();
    applyKeyListFilters(s as never, parseKeyFilters({ q: "(,)" }));
    expect(calls).toHaveLength(0);
  });
});
