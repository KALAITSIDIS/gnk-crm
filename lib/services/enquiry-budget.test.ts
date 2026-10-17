import { describe, expect, it } from "vitest";
import { hashIp } from "./ip-hash";
import { budgetsFor, ORIGIN_RATE_LIMIT, RATE_LIMIT } from "./enquiry-budget";

const TRANSPORT = hashIp("203.0.113.7");
/** What the route hands in for the site's ceiling: callerIpHash("site") at the same address. */
const SITE = hashIp("site:203.0.113.7");
const VISITOR = "198.51.100.22";

describe("whose budget an enquiry spends", () => {
  it("spends ONE budget when the caller is the visitor — spending two would halve the limit", () => {
    // The regression this exists to catch: metering the same hash twice per
    // request quietly turns a limit of five into a limit of two.
    const budgets = budgetsFor(TRANSPORT, undefined, true, SITE);
    expect(budgets).toHaveLength(1);
    expect(budgets[0]).toEqual({ kind: "visitor", hash: TRANSPORT, limit: RATE_LIMIT });
  });

  it("treats a blank or whitespace header as no header at all", () => {
    expect(budgetsFor(TRANSPORT, "", true, SITE)).toHaveLength(1);
    expect(budgetsFor(TRANSPORT, "   ", true, SITE)).toHaveLength(1);
    expect(budgetsFor(TRANSPORT, null, true, SITE)).toHaveLength(1);
  });

  // The table the audit's A02 asked for, one row each.
  it("unsigned: a request with no proof spends the caller's own budget of five", () => {
    expect(budgetsFor(TRANSPORT, undefined, false, SITE)).toEqual([
      { kind: "visitor", hash: TRANSPORT, limit: RATE_LIMIT },
    ]);
  });

  it("forged: a visitor header from an unproven caller is IGNORED — no fresh budget for a header", () => {
    // Before 2026-09-06 this row read [visitor 5, transport 60]: every forged
    // value bought a personal budget, so one address could be as many as it
    // liked. Now the caller is metered as itself, tightly.
    expect(budgetsFor(TRANSPORT, VISITOR, false, SITE)).toEqual([
      { kind: "visitor", hash: TRANSPORT, limit: RATE_LIMIT },
    ]);
  });

  it("signed: our site's visitor gets the tight budget and the site keeps a ceiling of its OWN", () => {
    // P3B1-1 (2026-10-17): the ceiling was metered on TRANSPORT — the row
    // every caller at the site's egress spends — so strangers there could
    // fill it and refuse every buyer on the site. It is the site's own row now.
    expect(budgetsFor(TRANSPORT, VISITOR, true, SITE)).toEqual([
      { kind: "visitor", hash: hashIp(VISITOR), limit: RATE_LIMIT },
      { kind: "origin", hash: SITE, limit: ORIGIN_RATE_LIMIT },
    ]);
  });

  it("the site's ceiling is never the row an unproven caller at the same address spends", () => {
    const stranger = budgetsFor(TRANSPORT, VISITOR, false, SITE).map((b) => b.hash);
    const ceiling = budgetsFor(TRANSPORT, VISITOR, true, SITE).find((b) => b.kind === "origin")!.hash;
    expect(stranger).not.toContain(ceiling);
  });

  it("signed and equal: the site naming its own address is one budget of five, not two on one hash", () => {
    expect(budgetsFor(TRANSPORT, "203.0.113.7", true, SITE)).toEqual([
      { kind: "visitor", hash: TRANSPORT, limit: RATE_LIMIT },
    ]);
  });

  it("the visitor's budget is always first: the route answers a honeypot after it and before any ceiling", () => {
    for (const [header, trusted] of [[undefined, false], [VISITOR, false], [VISITOR, true], ["203.0.113.7", true]] as const) {
      const budgets = budgetsFor(TRANSPORT, header, trusted, SITE);
      expect(budgets[0]!.kind).toBe("visitor");
      expect(budgets.slice(1).every((b) => b.kind === "origin")).toBe(true);
    }
  });

  it("gives two different buyers two different budgets — the whole point of the fix", () => {
    const a = budgetsFor(TRANSPORT, "198.51.100.22", true, SITE)[0]!.hash;
    const b = budgetsFor(TRANSPORT, "198.51.100.23", true, SITE)[0]!.hash;
    expect(a).not.toBe(b);
  });

  it("gives the SAME buyer the same budget twice, or nothing would ever accumulate", () => {
    const a = budgetsFor(TRANSPORT, VISITOR, true, SITE)[0]!.hash;
    const b = budgetsFor(TRANSPORT, VISITOR, true, SITE)[0]!.hash;
    expect(a).toBe(b);
  });

  it("takes the client from the front of an x-forwarded-for chain, not a proxy", () => {
    const chained = budgetsFor(TRANSPORT, "198.51.100.22, 70.41.3.18, 150.172.238.178", true, SITE);
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
