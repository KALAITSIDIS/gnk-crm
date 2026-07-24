import { describe, expect, it } from "vitest";
import { parseKeyFilters, applyKeyListFilters } from "./keys-list";

function spy() {
  const calls: { method: string; args: unknown[] }[] = [];
  const s: Record<string, (...a: unknown[]) => unknown> = {
    eq: (...args) => (calls.push({ method: "eq", args }), s),
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

describe("applyKeyListFilters", () => {
  it("applies no status predicate for the 'all' scope and no term", () => {
    const { s, calls } = spy();
    applyKeyListFilters(s as never, parseKeyFilters({}), []);
    expect(calls).toHaveLength(0);
  });

  it("filters by a concrete status", () => {
    const { s, calls } = spy();
    applyKeyListFilters(s as never, parseKeyFilters({ status: "lost" }), []);
    expect(calls[0]).toEqual({ method: "eq", args: ["status", "lost"] });
  });

  it("ORs the text term across code/description/holder", () => {
    const { s, calls } = spy();
    applyKeyListFilters(s as never, parseKeyFilters({ q: "villa" }), []);
    const or = calls.find((c) => c.method === "or");
    expect(or?.args[0]).toContain("key_code.ilike.%villa%");
    expect(or?.args[0]).toContain("description.ilike.%villa%");
    expect(or?.args[0]).toContain("current_holder_name.ilike.%villa%");
    expect(or?.args[0]).not.toContain("property_id.in"); // no matched ids passed
  });

  it("folds matched property ids into the disjunction when provided", () => {
    const { s, calls } = spy();
    applyKeyListFilters(s as never, parseKeyFilters({ q: "PAF" }), ["p1", "p2"]);
    const or = calls.find((c) => c.method === "or");
    expect(or?.args[0]).toContain("property_id.in.(p1,p2)");
  });
});
