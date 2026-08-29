import { describe, expect, it } from "vitest";
import { DEFAULT_LIMIT, MAX_LIMIT, parseFeedParams } from "./public-listings";

const q = (s: string) => new URLSearchParams(s);

describe("public listing feed params", () => {
  it("an ABSENT limit takes the default, not zero", () => {
    // The regression this file exists for. `Number(null)` is 0, so the first
    // version answered a plain `?org=gnk` with limit 0 — a 200 and an empty
    // feed, which is exactly the failure a marketing site cannot diagnose.
    expect(parseFeedParams(q("org=gnk"))).toEqual({ limit: DEFAULT_LIMIT, offset: 0 });
  });

  it("an EMPTY limit also takes the default", () => {
    expect(parseFeedParams(q("limit=&offset=")).limit).toBe(DEFAULT_LIMIT);
    expect(parseFeedParams(q("limit=   ")).limit).toBe(DEFAULT_LIMIT);
  });

  it("an explicit limit is honoured, and zero is honoured when it is asked for", () => {
    expect(parseFeedParams(q("limit=10")).limit).toBe(10);
    // asking for nothing is a legitimate request — it is only the ABSENT case
    // that must not collapse to zero
    expect(parseFeedParams(q("limit=0")).limit).toBe(0);
  });

  it("the limit is capped server-side", () => {
    expect(parseFeedParams(q("limit=9999")).limit).toBe(MAX_LIMIT);
    expect(parseFeedParams(q("limit=101")).limit).toBe(MAX_LIMIT);
  });

  it("nonsense falls back rather than erroring", () => {
    // A feed that 400s on a stray query string goes dark for a reason nobody
    // can see from a browser.
    expect(parseFeedParams(q("limit=abc")).limit).toBe(DEFAULT_LIMIT);
    expect(parseFeedParams(q("limit=-5")).limit).toBe(DEFAULT_LIMIT);
    expect(parseFeedParams(q("limit=NaN")).limit).toBe(DEFAULT_LIMIT);
    expect(parseFeedParams(q("limit=Infinity")).limit).toBe(DEFAULT_LIMIT);
    expect(parseFeedParams(q("offset=abc")).offset).toBe(0);
    expect(parseFeedParams(q("offset=-1")).offset).toBe(0);
  });

  it("fractional values floor rather than reaching SQL as a float", () => {
    expect(parseFeedParams(q("limit=10.9")).limit).toBe(10);
    expect(parseFeedParams(q("offset=2.7")).offset).toBe(2);
  });

  it("offset is not capped at the limit's ceiling", () => {
    // paging deep into a large feed is legitimate; only page SIZE is capped
    expect(parseFeedParams(q("offset=5000")).offset).toBe(5000);
  });
});
