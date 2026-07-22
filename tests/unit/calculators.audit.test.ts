/**
 * QA audit suite — Cyprus calculator correctness (Phase 6).
 *
 * These tests exist to FAIL LOUDLY if a Cyprus constant or formula drifts.
 * They are deliberately independent of lib/services/calculators.test.ts:
 * that file pins the doc-02 §C8 acceptance boundaries, this one pins the
 * statutory scale itself plus the config-validation guards found missing
 * during the 2026-07-22 audit (findings CALC-1 … CALC-4 in TEST_REPORT.md).
 */
import { describe, expect, it } from "vitest";
import {
  computeBandRows,
  computeStampDuty,
  computeTransferFees,
  parseStampDutyConfig,
  parseTransferFeesConfig,
  type StampDutyConfig,
  type TransferFeesConfig,
} from "@/lib/services/calculators";

/**
 * The statutory scales as at 2026-07-22. If Cyprus changes the law, THIS
 * block is what must be edited (and cyprus_config re-seeded) — a test failure
 * here means the seeded config and the law have diverged.
 *
 * Transfer fees — Dept. of Lands & Surveys progressive scale, assessed on
 *   each purchaser's share: 3% to €85,000, 5% to €170,000, 8% above.
 *   50% relief on transfers not subject to VAT; nil where VAT was paid.
 * Stamp duty — nil on the first €5,000, 0.15% to €170,000, 0.20% above,
 *   capped at €20,000 per contract.
 */
const TRANSFER: TransferFeesConfig = {
  bands: [
    { up_to: 85000, rate: 0.03 },
    { up_to: 170000, rate: 0.05 },
    { up_to: null, rate: 0.08 },
  ],
  relief_pct: 0.5,
  vat_paid_exempt: true,
};

const STAMP: StampDutyConfig = {
  bands: [
    { up_to: 5000, rate: 0 },
    { up_to: 170000, rate: 0.0015 },
    { up_to: null, rate: 0.002 },
  ],
  cap: 20000,
};

describe("transfer fees — statutory scale, hand-computed", () => {
  // Each expectation is worked out longhand so a reviewer can check it
  // against the DLS scale without running the code.
  const cases: Array<{ price: number; gross: number; why: string }> = [
    { price: 1, gross: 0.03, why: "1 x 3%" },
    { price: 85000, gross: 2550, why: "85,000 x 3%" },
    { price: 85001, gross: 2550.05, why: "2,550 + 1 x 5%" },
    { price: 170000, gross: 6800, why: "2,550 + 85,000 x 5%" },
    { price: 170001, gross: 6800.08, why: "6,800 + 1 x 8%" },
    { price: 250000, gross: 13200, why: "6,800 + 80,000 x 8%" },
    { price: 300000, gross: 17200, why: "6,800 + 130,000 x 8%" },
    { price: 1_000_000, gross: 73200, why: "6,800 + 830,000 x 8%" },
  ];

  for (const { price, gross, why } of cases) {
    it(`EUR ${price.toLocaleString("en-GB")} -> ${gross} gross (${why})`, () => {
      const r = computeTransferFees(price, TRANSFER, { relief: false, vatPaid: false });
      expect(r.total).toBe(gross);
    });
  }

  it("relief halves the gross exactly, never the band rows", () => {
    const r = computeTransferFees(300000, TRANSFER, { relief: true, vatPaid: false });
    expect(r.gross).toBe(17200);
    expect(r.reliefAmount).toBe(8600);
    expect(r.total).toBe(8600);
    // the rows are the pre-relief breakdown the agent shows the buyer
    expect(r.rows.map((b) => b.fee)).toEqual([2550, 4250, 10400]);
  });

  it("VAT-paid wins over relief and returns a nil assessment", () => {
    const r = computeTransferFees(300000, TRANSFER, { relief: true, vatPaid: true });
    expect(r.vatExempt).toBe(true);
    expect(r.total).toBe(0);
    expect(r.reliefApplied).toBe(false);
  });

  it("vat_paid_exempt=false makes the VAT tick a no-op (config drives behaviour)", () => {
    const noExempt = { ...TRANSFER, vat_paid_exempt: false };
    const r = computeTransferFees(300000, noExempt, { relief: false, vatPaid: true });
    expect(r.vatExempt).toBe(false);
    expect(r.total).toBe(17200);
  });

  /**
   * FINDING CALC-1 (High, open). The DLS scale is assessed on each
   * PURCHASER'S SHARE — the seeded config even says so ("per purchaser
   * share") — but neither computeTransferFees nor the Calculators screen
   * accepts a purchaser count, so a joint purchase is over-quoted.
   *
   * This test pins the CURRENT single-assessment behaviour so the defect is
   * visible and so implementing the fix has to come here and change it.
   * The commented figures are what a two-purchaser assessment should yield.
   */
  it("[CALC-1] assesses the whole price once, ignoring joint purchasers", () => {
    const joint = computeTransferFees(300000, TRANSFER, { relief: true, vatPaid: false });
    expect(joint.total).toBe(8600); // current: 300,000 assessed as one share

    // Correct for a couple buying jointly: two shares of 150,000 each ->
    // (2,550 + 65,000 x 5%) = 5,800 each -> 11,600 gross -> 5,800 after relief.
    const oneShare = computeTransferFees(150000, TRANSFER, { relief: false, vatPaid: false });
    expect(oneShare.total).toBe(5800);
    const correctJointTotal = (oneShare.total * 2) / 2; // gross 11,600, less 50% relief
    expect(correctJointTotal).toBe(5800);
    expect(joint.total).toBeGreaterThan(correctJointTotal); // over-quoted by 2,800
  });
});

describe("stamp duty — statutory scale, hand-computed", () => {
  const cases: Array<{ price: number; total: number; why: string }> = [
    { price: 5000, total: 0, why: "wholly inside the nil band" },
    { price: 5001, total: 0, why: "1 x 0.15% = 0.0015 -> rounds to 0.00" },
    { price: 100000, total: 142.5, why: "95,000 x 0.15%" },
    { price: 170000, total: 247.5, why: "165,000 x 0.15%" },
    { price: 300000, total: 507.5, why: "247.50 + 130,000 x 0.20%" },
    { price: 1_000_000, total: 1907.5, why: "247.50 + 830,000 x 0.20%" },
  ];

  for (const { price, total, why } of cases) {
    it(`EUR ${price.toLocaleString("en-GB")} -> ${total} (${why})`, () => {
      expect(computeStampDuty(price, STAMP).total).toBe(total);
    });
  }

  it("caps at EUR 20,000 and reports the uncapped figure alongside", () => {
    const r = computeStampDuty(12_000_000, STAMP);
    expect(r.uncapped).toBe(23907.5);
    expect(r.capApplied).toBe(true);
    expect(r.total).toBe(20000);
  });

  it("the cap is a ceiling, not a floor", () => {
    const r = computeStampDuty(300000, STAMP);
    expect(r.capApplied).toBe(false);
    expect(r.total).toBeLessThan(20000);
  });
});

describe("banded arithmetic invariants", () => {
  it("band slices tile the price with no gap and no overlap", () => {
    const rows = computeBandRows(250000, TRANSFER.bands);
    expect(rows.reduce((s, r) => s + r.taxable, 0)).toBe(250000);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].from).toBe(rows[i - 1].to);
    }
  });

  it("is monotonic — a higher price never costs less", () => {
    let prev = -1;
    for (let price = 0; price <= 400000; price += 4321) {
      const total = computeTransferFees(price, TRANSFER, { relief: false, vatPaid: false }).total;
      expect(total).toBeGreaterThanOrEqual(prev);
      prev = total;
    }
  });

  it("emits no rows and no fee for a zero price", () => {
    const r = computeTransferFees(0, TRANSFER, { relief: false, vatPaid: false });
    expect(r.rows).toHaveLength(0);
    expect(r.total).toBe(0);
  });

  it("never returns a negative fee for any non-negative price", () => {
    for (const price of [0, 1, 4999, 5000, 85000, 170000, 999999]) {
      expect(computeStampDuty(price, STAMP).total).toBeGreaterThanOrEqual(0);
      expect(
        computeTransferFees(price, TRANSFER, { relief: false, vatPaid: false }).total,
      ).toBeGreaterThanOrEqual(0);
    }
  });
});

/**
 * FINDING CALC-2 (High). cyprus_config is admin-editable in Settings and the
 * only gate is parseTransferFeesConfig / parseStampDutyConfig, which check
 * each band is {up_to:number|null, rate:number} and nothing else. A typo that
 * survives that check produces a wrong fee QUOTED TO A CLIENT with no error.
 *
 * These are the malformed shapes the audit reached through the Settings form.
 */
describe("[CALC-2] config validation rejects unsafe band tables", () => {
  it("rejects descending bands (they yield negative slices)", () => {
    const descending = {
      ...TRANSFER,
      bands: [
        { up_to: 170000, rate: 0.05 },
        { up_to: 85000, rate: 0.03 },
        { up_to: null, rate: 0.08 },
      ],
    };
    expect(parseTransferFeesConfig(descending)).toBeNull();
  });

  it("rejects a rate entered as a percentage instead of a fraction", () => {
    // "3" meaning 3% -> a 300% fee. The single most likely Settings typo.
    const percentTyped = {
      ...TRANSFER,
      bands: [
        { up_to: 85000, rate: 3 },
        { up_to: null, rate: 8 },
      ],
    };
    expect(parseTransferFeesConfig(percentTyped)).toBeNull();
  });

  it("rejects a negative rate", () => {
    expect(
      parseTransferFeesConfig({ ...TRANSFER, bands: [{ up_to: null, rate: -0.03 }] }),
    ).toBeNull();
  });

  it("rejects an open-ended band that is not last (silently drops later bands)", () => {
    const openInMiddle = {
      ...TRANSFER,
      bands: [
        { up_to: null, rate: 0.03 },
        { up_to: 170000, rate: 0.05 },
      ],
    };
    expect(parseTransferFeesConfig(openInMiddle)).toBeNull();
  });

  it("rejects a negative or zero upper bound", () => {
    expect(
      parseTransferFeesConfig({ ...TRANSFER, bands: [{ up_to: -1, rate: 0.03 }] }),
    ).toBeNull();
    expect(
      parseTransferFeesConfig({ ...TRANSFER, bands: [{ up_to: 0, rate: 0.03 }] }),
    ).toBeNull();
  });

  it("rejects a relief_pct outside 0..1", () => {
    expect(parseTransferFeesConfig({ ...TRANSFER, relief_pct: 50 })).toBeNull();
    expect(parseTransferFeesConfig({ ...TRANSFER, relief_pct: -0.5 })).toBeNull();
  });

  it("rejects a negative stamp-duty cap", () => {
    expect(parseStampDutyConfig({ ...STAMP, cap: -1 })).toBeNull();
  });

  it("still accepts the seeded production shapes", () => {
    expect(parseTransferFeesConfig(TRANSFER)).not.toBeNull();
    expect(parseStampDutyConfig(STAMP)).not.toBeNull();
    // and a single open-ended band is legitimate
    expect(
      parseStampDutyConfig({ bands: [{ up_to: null, rate: 0.002 }], cap: null }),
    ).not.toBeNull();
  });

  it("still rejects the shapes the original guard caught", () => {
    expect(parseTransferFeesConfig(null)).toBeNull();
    expect(parseTransferFeesConfig({ bands: "no" })).toBeNull();
    expect(parseStampDutyConfig({ bands: [] })).toBeNull();
    expect(parseTransferFeesConfig({ bands: [{ up_to: 1, rate: 0.1 }] })).toBeNull(); // no relief_pct
  });
});
