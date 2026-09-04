import { describe, expect, it } from "vitest";
import { hashIp } from "./ip-hash";
import { budgetsFor, ORIGIN_RATE_LIMIT, RATE_LIMIT } from "./enquiry-budget";

const TRANSPORT = hashIp("203.0.113.7");

describe("whose budget an enquiry spends", () => {
  it("spends ONE budget when the caller is the visitor — spending two would halve the limit", () => {
    // The regression this exists to catch: metering the same hash twice per
    // request quietly turns a limit of five into a limit of two.
    const budgets = budgetsFor(TRANSPORT, undefined);
    expect(budgets).toHaveLength(1);
    expect(budgets[0]).toEqual({ hash: TRANSPORT, limit: RATE_LIMIT });
  });

  it("treats a blank or whitespace header as no header at all", () => {
    expect(budgetsFor(TRANSPORT, "")).toHaveLength(1);
    expect(budgetsFor(TRANSPORT, "   ")).toHaveLength(1);
    expect(budgetsFor(TRANSPORT, null)).toHaveLength(1);
  });

  it("meters the visitor AND keeps a ceiling on the caller, so a forged header buys no escape", () => {
    const budgets = budgetsFor(TRANSPORT, "198.51.100.22");
    expect(budgets).toHaveLength(2);
    expect(budgets[0]).toEqual({ hash: hashIp("198.51.100.22"), limit: RATE_LIMIT });
    expect(budgets[1]).toEqual({ hash: TRANSPORT, limit: ORIGIN_RATE_LIMIT });
  });

  it("gives two different buyers two different budgets — the whole point of the fix", () => {
    const a = budgetsFor(TRANSPORT, "198.51.100.22")[0]!.hash;
    const b = budgetsFor(TRANSPORT, "198.51.100.23")[0]!.hash;
    expect(a).not.toBe(b);
  });

  it("gives the SAME buyer the same budget twice, or nothing would ever accumulate", () => {
    const a = budgetsFor(TRANSPORT, "198.51.100.22")[0]!.hash;
    const b = budgetsFor(TRANSPORT, "198.51.100.22")[0]!.hash;
    expect(a).toBe(b);
  });

  it("takes the client from the front of an x-forwarded-for chain, not a proxy", () => {
    const chained = budgetsFor(TRANSPORT, "198.51.100.22, 70.41.3.18, 150.172.238.178");
    expect(chained[0]!.hash).toBe(hashIp("198.51.100.22"));
  });

  it("keeps the personal budget strictly tighter than the origin ceiling", () => {
    // If these ever cross, the origin limit would refuse first and every
    // visitor would again share one budget — the bug this replaced.
    expect(RATE_LIMIT).toBeLessThan(ORIGIN_RATE_LIMIT);
  });
});

describe("the hash the counters are keyed on", () => {
  it("is 32 characters, because that is what the counter tables were built for", () => {
    expect(hashIp("203.0.113.7")).toHaveLength(32);
  });

  it("never contains the address it came from", () => {
    expect(hashIp("203.0.113.7")).not.toContain("203");
  });
});
