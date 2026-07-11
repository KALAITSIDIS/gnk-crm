import { describe, expect, it } from "vitest";
import { computeHealth, type HealthInputs } from "./health-score";

const NOW = new Date("2026-07-11T12:00:00Z");

const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

const base: HealthInputs = {
  budgetConfirmed: false,
  buyerKycPct: 0,
  titleDeedKnown: false,
  mandateActive: false,
  lastActivityAt: null,
};

describe("computeHealth", () => {
  it("scores 0 with nothing met and 100 with everything met", () => {
    expect(computeHealth(base, NOW).score).toBe(0);
    expect(
      computeHealth(
        {
          budgetConfirmed: true,
          buyerKycPct: 100,
          titleDeedKnown: true,
          mandateActive: true,
          lastActivityAt: daysAgo(0),
        },
        NOW,
      ).score,
    ).toBe(100);
  });

  // Playbook T3.3 acceptance: activity decay at 7 / 14 days
  it("decays activity: full 30 through day 7, 15 through day 14, then 0", () => {
    const at = (days: number) =>
      computeHealth({ ...base, lastActivityAt: daysAgo(days) }, NOW).score;
    expect(at(0)).toBe(30);
    expect(at(6.9)).toBe(30);
    expect(at(7)).toBe(30); // ≤7d full (doc 02 §C5)
    expect(at(7.1)).toBe(15);
    expect(at(14)).toBe(15); // ≤14d partial
    expect(at(14.1)).toBe(0);
    expect(at(30)).toBe(0);
    expect(computeHealth({ ...base, lastActivityAt: null }, NOW).score).toBe(0);
  });

  // Playbook T3.3 acceptance: logging a conversation raises the score
  it("raises the score when activity lands now (conversation logged)", () => {
    const stale = computeHealth({ ...base, lastActivityAt: daysAgo(20) }, NOW).score;
    const fresh = computeHealth({ ...base, lastActivityAt: daysAgo(0) }, NOW).score;
    expect(stale).toBe(0);
    expect(fresh).toBe(30);
    expect(fresh).toBeGreaterThan(stale);
  });

  it("awards KYC only at ≥50% and treats a missing buyer as unmet", () => {
    const kyc = (pct: number | null) => computeHealth({ ...base, buyerKycPct: pct }, NOW).score;
    expect(kyc(50)).toBe(15);
    expect(kyc(100)).toBe(15);
    expect(kyc(33)).toBe(0);
    expect(kyc(null)).toBe(0);
  });

  it("weights budget 25, title deed 15, mandate 15", () => {
    expect(computeHealth({ ...base, budgetConfirmed: true }, NOW).score).toBe(25);
    expect(computeHealth({ ...base, titleDeedKnown: true }, NOW).score).toBe(15);
    expect(computeHealth({ ...base, mandateActive: true }, NOW).score).toBe(15);
    expect(
      computeHealth({ ...base, titleDeedKnown: null, mandateActive: null }, NOW).score,
    ).toBe(0);
  });

  it("returns a five-factor breakdown whose points sum to the score", () => {
    const result = computeHealth(
      {
        budgetConfirmed: true,
        buyerKycPct: 67,
        titleDeedKnown: false,
        mandateActive: true,
        lastActivityAt: daysAgo(10),
      },
      NOW,
    );
    expect(result.factors).toHaveLength(5);
    expect(result.factors.reduce((s, f) => s + f.points, 0)).toBe(result.score);
    expect(result.score).toBe(25 + 15 + 0 + 15 + 15);
    const activity = result.factors.find((f) => f.key === "activity");
    expect(activity?.detail).toBe("10d since last activity");
  });
});
