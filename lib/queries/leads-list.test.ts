import { describe, expect, it } from "vitest";
import { parseLeadFilters, applyLeadListFilters } from "./leads-list";

function spy() {
  const calls: { method: string; args: unknown[] }[] = [];
  const s: Record<string, (...a: unknown[]) => unknown> = {
    in: (...args) => {
      calls.push({ method: "in", args });
      return s;
    },
  };
  return { s, calls };
}

describe("parseLeadFilters", () => {
  it("defaults to the open scope and keeps valid filters", () => {
    expect(parseLeadFilters({}).status).toBe("open");
    expect(parseLeadFilters({ status: "closed" }).status).toBe("closed");
    expect(parseLeadFilters({ status: "converted" }).status).toBe("converted");
    expect(parseLeadFilters({ status: "nonsense" }).status).toBe("open");
  });
});

describe("applyLeadListFilters", () => {
  it("scopes open to the open statuses", () => {
    const { s, calls } = spy();
    applyLeadListFilters(s as never, parseLeadFilters({ status: "open" }));
    expect(calls[0].args[0]).toBe("status");
    expect(calls[0].args[1]).toEqual(["new", "contacted", "qualified"]);
  });

  it("applies no status filter for the 'all' scope", () => {
    const { s, calls } = spy();
    applyLeadListFilters(s as never, parseLeadFilters({ status: "all" }));
    expect(calls).toHaveLength(0);
  });

  it("scopes a concrete status to just that status", () => {
    const { s, calls } = spy();
    applyLeadListFilters(s as never, parseLeadFilters({ status: "spam" }));
    expect(calls[0].args[1]).toEqual(["spam"]);
  });
});
