import { describe, expect, it } from "vitest";
import {
  CONSTRUCTION_MILESTONES,
  buildProgress,
  hasBuildInfo,
} from "./construction";

// mid-month, mid-morning UTC — safely inside the Cyprus day
const NOW = new Date("2026-08-25T09:00:00Z");

describe("the milestone weighting", () => {
  it("is ordered and spans 0 to 100", () => {
    expect(CONSTRUCTION_MILESTONES[0]!.pct).toBe(0);
    expect(CONSTRUCTION_MILESTONES[CONSTRUCTION_MILESTONES.length - 1]!.pct).toBe(100);
    for (let i = 1; i < CONSTRUCTION_MILESTONES.length; i++) {
      expect(
        CONSTRUCTION_MILESTONES[i]!.pct,
        `${CONSTRUCTION_MILESTONES[i]!.key} must not go backwards`,
      ).toBeGreaterThan(CONSTRUCTION_MILESTONES[i - 1]!.pct);
    }
  });

  it("KEEPS PAPERWORK LOW — the whole reason it is not eight equal steps", () => {
    // eight even stages would put permit_granted at 37.5%, for a project where
    // nothing has been built. That is the lie this weighting exists to avoid.
    const permit = buildProgress("permit_granted", null, NOW);
    expect(permit.stage).toBe(3);
    expect(permit.pct).toBe(10);
    expect(permit.pct).toBeLessThan(37.5);
  });

  it("gives the three BUILDING stages 75 of the 100 between them", () => {
    // this replaced a claim that starting on site was the single largest jump.
    // It is not — completing the structure is the same 25 — and the test said
    // so. The weights were right; the sentence describing them was not.
    const step = (key: string) => {
      const i = CONSTRUCTION_MILESTONES.findIndex((m) => m.key === key);
      return CONSTRUCTION_MILESTONES[i]!.pct - CONSTRUCTION_MILESTONES[i - 1]!.pct;
    };
    expect(step("under_construction")).toBe(25);
    expect(step("structure_complete")).toBe(25);
    expect(step("finishing")).toBe(25);
    // and paperwork gets ten points across its three stages
    expect(buildProgress("permit_granted", null, NOW).pct).toBe(10);
  });
});

describe("a non-standard status is a state, not an error", () => {
  it("shows the stored value with NO stage and NO percentage", () => {
    // construction_status is free text and finding 10 deliberately preserves
    // whatever a row holds; inventing a position for it would undo that
    const b = buildProgress("waiting on the archaeologist", null, NOW);
    expect(b.status).toBe("waiting on the archaeologist");
    expect(b.known).toBe(false);
    expect(b.stage).toBeNull();
    expect(b.pct).toBeNull();
    expect(b.label).toBe("Waiting on the archaeologist");
  });

  it("humanises an underscored value it does not recognise", () => {
    expect(buildProgress("roof_on", null, NOW).label).toBe("Roof on");
  });

  it("treats blank and whitespace as absent", () => {
    for (const v of [null, undefined, "", "   "]) {
      const b = buildProgress(v, null, NOW);
      expect(b.status).toBeNull();
      expect(b.label).toBeNull();
      expect(hasBuildInfo(b)).toBe(false);
    }
  });
});

describe("months to delivery", () => {
  it("counts whole months ahead", () => {
    expect(buildProgress(null, "2027-03-25", NOW).monthsToDelivery).toBe(7);
  });

  it("does not round a part-month up", () => {
    // 25 Aug to 24 Sep is not yet a month
    expect(buildProgress(null, "2026-09-24", NOW).monthsToDelivery).toBe(0);
    expect(buildProgress(null, "2026-09-25", NOW).monthsToDelivery).toBe(1);
  });

  it("goes negative once the date has passed", () => {
    expect(buildProgress(null, "2026-05-25", NOW).monthsToDelivery).toBe(-3);
  });

  it("crosses a year boundary", () => {
    expect(buildProgress(null, "2027-01-25", NOW).monthsToDelivery).toBe(5);
    expect(buildProgress(null, "2025-11-25", NOW).monthsToDelivery).toBe(-9);
  });

  it("uses the CYPRUS day, not the UTC one", () => {
    // 31 Aug 22:00 UTC is 1 Sep in Cyprus (EEST, UTC+3), so a 1 Oct delivery is
    // one month out and not two
    const lateAug = new Date("2026-08-31T22:00:00Z");
    expect(buildProgress(null, "2026-10-01", lateAug).monthsToDelivery).toBe(1);
  });
});

describe("overdue", () => {
  it("flags an unfinished build past its date", () => {
    const b = buildProgress("under_construction", "2026-05-25", NOW);
    expect(b.overdue).toBe(true);
    expect(b.mismatch).toMatch(/has passed/);
  });

  it("does NOT call a delivered project overdue", () => {
    // the date passing is exactly what is supposed to happen once handed over
    const b = buildProgress("delivered", "2026-05-25", NOW);
    expect(b.overdue).toBe(false);
    expect(b.mismatch).toBeNull();
  });

  it("does not call a completed project overdue either", () => {
    expect(buildProgress("completed", "2026-05-25", NOW).overdue).toBe(false);
  });

  it("cannot be overdue without a date", () => {
    expect(buildProgress("under_construction", null, NOW).overdue).toBe(false);
  });

  it("does not judge an unknown status as overdue", () => {
    // no idea whether "roof on" means finished, so no claim is made
    const b = buildProgress("roof_on", "2026-05-25", NOW);
    expect(b.overdue).toBe(true);
    expect(b.mismatch, "and no mismatch claim for a status we cannot read").toBeNull();
  });
});

describe("mismatches are surfaced as something to look at, not as errors", () => {
  it("notices delivered with a future date", () => {
    const b = buildProgress("delivered", "2027-03-25", NOW);
    expect(b.mismatch).toMatch(/still in the future/);
    expect(b.overdue).toBe(false);
  });

  it("stays quiet when status and date agree", () => {
    expect(buildProgress("under_construction", "2027-03-25", NOW).mismatch).toBeNull();
    expect(buildProgress("delivered", "2026-05-25", NOW).mismatch).toBeNull();
  });

  it("makes no claim with only one of the two", () => {
    expect(buildProgress("delivered", null, NOW).mismatch).toBeNull();
    expect(buildProgress(null, "2020-01-01", NOW).mismatch).toBeNull();
  });
});

describe("hasBuildInfo", () => {
  it("is true with either half", () => {
    expect(hasBuildInfo(buildProgress("planning", null, NOW))).toBe(true);
    expect(hasBuildInfo(buildProgress(null, "2027-01-01", NOW))).toBe(true);
    expect(hasBuildInfo(buildProgress(null, null, NOW))).toBe(false);
  });

  it("is true for planning, whose pct is a legitimate ZERO", () => {
    // `0` must not be mistaken for "nothing recorded"
    const b = buildProgress("planning", null, NOW);
    expect(b.pct).toBe(0);
    expect(hasBuildInfo(b)).toBe(true);
  });
});
