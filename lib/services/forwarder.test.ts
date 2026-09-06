import { describe, expect, it } from "vitest";
import { isTrustedForwarder } from "./forwarder";

const KEY = "5f1c9e2a0b7d4c6e8a9f0b1c2d3e4f50";

describe("whether the caller is our own site", () => {
  it("trusts the configured key, exactly", () => {
    expect(isTrustedForwarder(KEY, KEY)).toBe(true);
  });

  it("trusts nothing when no key is configured — never everything", () => {
    // The pre-2026-09-06 behaviour was to honour the visitor header from
    // anyone. An unset key must fall to the safer side, not back to that.
    expect(isTrustedForwarder(KEY, undefined)).toBe(false);
    expect(isTrustedForwarder(KEY, "")).toBe(false);
    expect(isTrustedForwarder(KEY, null)).toBe(false);
  });

  it("rejects an absent, empty or wrong presentation", () => {
    expect(isTrustedForwarder(undefined, KEY)).toBe(false);
    expect(isTrustedForwarder(null, KEY)).toBe(false);
    expect(isTrustedForwarder("", KEY)).toBe(false);
    expect(isTrustedForwarder(KEY.slice(0, -1), KEY)).toBe(false);
    expect(isTrustedForwarder(KEY + "0", KEY)).toBe(false);
    expect(isTrustedForwarder(KEY.toUpperCase(), KEY)).toBe(false);
  });

  it("does not throw on lengths that differ — that is what the digest is for", () => {
    // timingSafeEqual itself throws on unequal buffer lengths; comparing
    // digests keeps the comparison constant-time AND total.
    expect(() => isTrustedForwarder("x", KEY)).not.toThrow();
    expect(isTrustedForwarder("x", KEY)).toBe(false);
  });
});
