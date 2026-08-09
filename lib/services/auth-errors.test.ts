import { describe, expect, it } from "vitest";
import { isCredentialRejection } from "./auth-errors";

/**
 * The whole value of this helper is the NEGATIVE cases. Getting them wrong
 * reintroduces the 2026-08-09 outage, where a disabled API key was shown to the
 * operator as "Invalid email or password" and read as a forgotten password for
 * hours. Each non-credential case below is one this app has actually produced.
 */
describe("isCredentialRejection", () => {
  it("is true for a genuine wrong-password answer", () => {
    expect(isCredentialRejection({ status: 400, code: "invalid_credentials" })).toBe(true);
    expect(isCredentialRejection({ status: 400, code: "invalid_grant" })).toBe(true);
    // GoTrue's older shape: a bare 400 with no code.
    expect(isCredentialRejection({ status: 400 })).toBe(true);
  });

  it("is FALSE for disabled API keys — the 2026-08-09 outage", () => {
    // "Legacy API keys are disabled" — 401. Showing this as a bad password is
    // what made a total auth outage look like a forgotten one.
    expect(isCredentialRejection({ status: 401 })).toBe(false);
    expect(isCredentialRejection({ status: 401, code: "bad_jwt" })).toBe(false);
  });

  it("is FALSE for rate limiting", () => {
    // A locked-out user retyping a CORRECT password must not be told it is wrong.
    expect(isCredentialRejection({ status: 429, code: "over_request_rate_limit" })).toBe(false);
  });

  it("is FALSE for an outage", () => {
    expect(isCredentialRejection({ status: 500 })).toBe(false);
    expect(isCredentialRejection({ status: 503 })).toBe(false);
  });

  it("is FALSE when there is no status at all — a network failure", () => {
    // fetch rejects before GoTrue is reached; there is no evidence about the
    // password either way, so it must not be blamed.
    expect(isCredentialRejection({})).toBe(false);
    expect(isCredentialRejection({ message: "fetch failed" } as never)).toBe(false);
  });

  it("is FALSE for no error at all", () => {
    expect(isCredentialRejection(null)).toBe(false);
    expect(isCredentialRejection(undefined)).toBe(false);
  });

  it("does not treat a 400 that carries another code as a credential failure", () => {
    // e.g. validation_failed — real, but not "your password is wrong".
    expect(isCredentialRejection({ status: 400, code: "validation_failed" })).toBe(false);
  });
});
