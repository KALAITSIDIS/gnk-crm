import { describe, expect, it } from "vitest";
import { mfaSessionState, needsMfaChallenge, hasVerifiedFactor } from "./mfa";

describe("mfaSessionState — the AAL matrix from the Supabase docs", () => {
  it("aal1/aal1 = the user has no MFA enrolled", () => {
    expect(mfaSessionState("aal1", "aal1")).toBe("not_enrolled");
  });

  it("aal1/aal2 = enrolled but not yet verified THIS session", () => {
    expect(mfaSessionState("aal1", "aal2")).toBe("challenge_required");
  });

  it("aal2/aal2 = verified", () => {
    expect(mfaSessionState("aal2", "aal2")).toBe("verified");
  });

  it("aal2/aal1 = factor was removed and the JWT is stale — not a challenge", () => {
    // Downgrading only takes effect after a refresh; treating this as
    // challenge_required would lock the user out of an account with no factor.
    expect(mfaSessionState("aal2", "aal1")).toBe("verified");
  });

  it("treats a missing level as aal1 (JWTs without an aal claim)", () => {
    expect(mfaSessionState(null, null)).toBe("not_enrolled");
    expect(mfaSessionState(undefined, "aal2")).toBe("challenge_required");
  });
});

describe("needsMfaChallenge", () => {
  it("is true only when a second factor is owed for this session", () => {
    expect(needsMfaChallenge("aal1", "aal2")).toBe(true);
    expect(needsMfaChallenge("aal1", "aal1")).toBe(false);
    expect(needsMfaChallenge("aal2", "aal2")).toBe(false);
    expect(needsMfaChallenge("aal2", "aal1")).toBe(false);
  });
});

describe("hasVerifiedFactor", () => {
  it("counts only verified factors — an abandoned enrolment must not gate login", () => {
    // enroll() creates an `unverified` factor immediately; if that counted, a
    // user who closed the tab mid-enrolment could never log in again.
    expect(hasVerifiedFactor([{ status: "unverified" }])).toBe(false);
    expect(hasVerifiedFactor([{ status: "verified" }])).toBe(true);
    expect(hasVerifiedFactor([{ status: "unverified" }, { status: "verified" }])).toBe(true);
    expect(hasVerifiedFactor([])).toBe(false);
  });
});
