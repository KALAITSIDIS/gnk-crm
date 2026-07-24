import { describe, expect, it } from "vitest";
import { parseDealType, applyDealTypeFilter } from "./deals-list";

describe("parseDealType", () => {
  it("defaults to sale and keeps a valid tab", () => {
    expect(parseDealType({})).toBe("sale");
    expect(parseDealType({ type: "rental" })).toBe("rental");
    expect(parseDealType({ type: "advisory" })).toBe("advisory");
    expect(parseDealType({ type: "bogus" })).toBe("sale");
    expect(parseDealType({ type: ["antiparoxi", "sale"] })).toBe("antiparoxi");
  });
});

describe("applyDealTypeFilter", () => {
  it("filters the query to the chosen deal_type", () => {
    const calls: unknown[][] = [];
    const q: Record<string, (...a: unknown[]) => unknown> = {
      eq: (...args) => {
        calls.push(args);
        return q;
      },
    };
    applyDealTypeFilter(q as never, "rental");
    expect(calls[0]).toEqual(["deal_type", "rental"]);
  });
});
