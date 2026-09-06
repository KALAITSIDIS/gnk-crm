import { describe, expect, it } from "vitest";
import { hashIp } from "./ip-hash";
import { budgetsFor, ORIGIN_RATE_LIMIT, RATE_LIMIT } from "./enquiry-budget";

const TRANSPORT = hashIp("203.0.113.7");
const VISITOR = "198.51.100.22";

describe("whose budget an enquiry spends", () => {
  it("spends ONE budget when the caller is the visitor — spending two would halve the limit", () => {
    // The regression this exists to catch: metering the same hash twice per
    // request quietly turns a limit of five into a limit of two.
    const budgets = budgetsFor(TRANSPORT, undefined, true);
    expect(budgets).toHaveLength(1);
    expect(budgets[0]).toEqual({ hash: TRANSPORT, limit: RATE_LIMIT });
  });

  it("treats a blank or whitespace header as no header at all", () => {
    expect(budgetsFor(TRANSPORT, "", true)).toHaveLength(1);
    expect(budgetsFor(TRANSPORT, "   ", true)).toHaveLength(1);
    expect(budgetsFor(TRANSPORT, null, true)).toHaveLength(1);
  });

  // The table the audit's A02 asked for, one row each.
  it("unsigned: a request with no proof spends the caller's own budget of five", () => {
    expect(budgetsFor(TRANSPORT, undefined, false)).toEqual([
      { hash: TRANSPORT, limit: RATE_LIMIT },
    ]);
  });

  it("forged: a visitor header from an unproven caller is IGNORED — no fresh budget for a header", () => {
    // Before 2026-09-06 this row read [visitor 5, transport 60]: every forged
    // value bought a personal budget, so one address could be as many as it
    // liked. Now the caller is metered as itself, tightly.
    expect(budgetsFor(TRANSPORT, VISITOR, false)).toEqual([
      { hash: TRANSPORT, limit: RATE_LIMIT },
    ]);
  });

  it("signed: our site's visitor gets the tight budget and the site keeps a ceiling", () => {
    expect(budgetsFor(TRANSPORT, VISITOR, true)).toEqual([
      { hash: hashIp(VISITOR), limit: RATE_LIMIT },
      { hash: TRANSPORT, limit: ORIGIN_RATE_LIMIT },
    ]);
  });

  it("signed and equal: the site naming its own address is one budget of five, not two on one hash", () => {
    expect(budgetsFor(TRANSPORT, "203.0.113.7", true)).toEqual([
      { hash: TRANSPORT, limit: RATE_LIMIT },
    ]);
  });

  it("gives two different buyers two different budgets — the whole point of the fix", () => {
    const a = budgetsFor(TRANSPORT, "198.51.100.22", true)[0]!.hash;
    const b = budgetsFor(TRANSPORT, "198.51.100.23", true)[0]!.hash;
    expect(a).not.toBe(b);
  });

  it("gives the SAME buyer the same budget twice, or nothing would ever accumulate", () => {
    const a = budgetsFor(TRANSPORT, VISITOR, true)[0]!.hash;
    const b = budgetsFor(TRANSPORT, VISITOR, true)[0]!.hash;
    expect(a).toBe(b);
  });

  it("takes the client from the front of an x-forwarded-for chain, not a proxy", () => {
    const chained = budgetsFor(TRANSPORT, "198.51.100.22, 70.41.3.18, 150.172.238.178", true);
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

  it("changes with IP_HASH_SALT, so the salt is what makes a fingerprint name nobody", () => {
    const before = hashIp("203.0.113.7");
    const prior = process.env.IP_HASH_SALT;
    process.env.IP_HASH_SALT = "a-different-salt";
    try {
      expect(hashIp("203.0.113.7")).not.toBe(before);
    } finally {
      if (prior === undefined) delete process.env.IP_HASH_SALT;
      else process.env.IP_HASH_SALT = prior;
    }
  });
});
