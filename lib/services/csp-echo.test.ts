import { describe, expect, it } from "vitest";
import { describeRequestHeaders } from "./csp-echo";

const NONCE = "4b405d35f8b84b6f88daed7a5b3e60ea";
const policy = (nonce: string) =>
  `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`;

describe("describeRequestHeaders", () => {
  it("reports every header arriving, and that the nonce is the same one", () => {
    const result = describeRequestHeaders(
      new Headers({
        "x-nonce": NONCE,
        "content-security-policy": policy(NONCE),
        "content-security-policy-report-only": policy(NONCE),
      }),
    );

    expect(result).toMatchObject({
      xNonce: true,
      contentSecurityPolicy: true,
      contentSecurityPolicyReportOnly: true,
      cspCarriesNonce: true,
      nonceMatches: true,
    });
    expect(result.verdict).toContain("OVERRIDE INTACT");
  });

  it("separates the two candidates: x-nonce through, CSP names filtered", () => {
    const result = describeRequestHeaders(new Headers({ "x-nonce": NONCE }));

    expect(result).toMatchObject({
      xNonce: true,
      contentSecurityPolicy: false,
      contentSecurityPolicyReportOnly: false,
      cspCarriesNonce: false,
      nonceMatches: false,
    });
    expect(result.verdict).toContain("filtered specifically");
  });

  it("says the override is dead when nothing arrives", () => {
    const result = describeRequestHeaders(new Headers());

    expect(result.xNonce).toBe(false);
    expect(result.verdict).toContain("NOTHING ARRIVED");
  });

  // The whole point of the diagnostic is telling these two apart, so a
  // mismatched pair must not read as a match.
  it("does not call it a match when the policy carries a DIFFERENT nonce", () => {
    const result = describeRequestHeaders(
      new Headers({
        "x-nonce": NONCE,
        "content-security-policy": policy("deadbeefdeadbeefdeadbeefdeadbeef"),
      }),
    );

    expect(result.cspCarriesNonce).toBe(true);
    expect(result.nonceMatches).toBe(false);
  });

  // Next reads `content-security-policy || content-security-policy-report-only`;
  // if this helper preferred the other order it could report a match the
  // renderer would not see.
  it("prefers the enforcing header, exactly as the renderer does", () => {
    const result = describeRequestHeaders(
      new Headers({
        "x-nonce": NONCE,
        "content-security-policy": policy(NONCE),
        "content-security-policy-report-only": policy("deadbeefdeadbeefdeadbeefdeadbeef"),
      }),
    );

    expect(result.nonceMatches).toBe(true);
  });

  it("falls back to report-only when only that one arrives", () => {
    const result = describeRequestHeaders(
      new Headers({
        "x-nonce": NONCE,
        "content-security-policy-report-only": policy(NONCE),
      }),
    );

    expect(result.contentSecurityPolicy).toBe(false);
    expect(result.nonceMatches).toBe(true);
  });

  it("never reflects a value back — the result is booleans and a verdict", () => {
    const result = describeRequestHeaders(
      new Headers({
        "x-nonce": NONCE,
        cookie: "sb-access-token=super-secret",
        authorization: "Bearer super-secret",
      }),
    );

    expect(JSON.stringify(result)).not.toContain("super-secret");
    expect(JSON.stringify(result)).not.toContain(NONCE);
  });
});
