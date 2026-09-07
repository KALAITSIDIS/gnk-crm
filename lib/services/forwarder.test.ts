import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isTrustedForwarder,
  isTrustedForwarderLoudly,
  resetForwarderMismatchLatch,
} from "./forwarder";

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

describe("a key that was presented and rejected is not silent", () => {
  afterEach(() => {
    resetForwarderMismatchLatch();
    vi.restoreAllMocks();
  });

  it("says so once, at error level, and never says the value", () => {
    // The failure this closes has no symptom of its own: a trailing newline
    // from a piped `vercel env add` meters every forwarded visitor on the
    // site's egress address and refuses the sixth genuine buyer, blaming an
    // address that is not theirs.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(isTrustedForwarderLoudly("wrong-key", KEY)).toBe(false);
    expect(err).toHaveBeenCalledTimes(1);
    const said = String(err.mock.calls[0]![0]);
    expect(said).toContain("did not match ENQUIRY_FORWARD_KEY");
    expect(said).not.toContain("wrong-key");
    expect(said).not.toContain(KEY);
  });

  it("says it ONCE per instance, not once per request", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < 5; i++) isTrustedForwarderLoudly("wrong-key", KEY);
    expect(err).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when no key was presented — that is an ordinary stranger, not a misconfiguration", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(isTrustedForwarderLoudly(undefined, KEY)).toBe(false);
    expect(isTrustedForwarderLoudly("", KEY)).toBe(false);
    expect(err).not.toHaveBeenCalled();
  });

  it("stays quiet when this side has no key configured — nothing to mismatch", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(isTrustedForwarderLoudly("some-key", undefined)).toBe(false);
    expect(err).not.toHaveBeenCalled();
  });

  it("decides exactly what the quiet one decides", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const [presented, expected] of [
      [KEY, KEY],
      ["wrong", KEY],
      [undefined, KEY],
      [KEY, undefined],
    ] as const) {
      expect(isTrustedForwarderLoudly(presented, expected)).toBe(
        isTrustedForwarder(presented, expected),
      );
      resetForwarderMismatchLatch();
    }
  });
});
