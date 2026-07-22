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

});

/**
 * FINDING CALC-1 (fixed 2026-07-22). The DLS scale is assessed on each
 * PURCHASER'S SHARE — the seeded config says so ("per purchaser share") —
 * so the bands RESTART for every purchaser. Assessing the whole price once
 * over-quotes every joint purchase, which in Paphos is most of them.
 *
 * Equal shares are assumed: that is the ordinary case and the only one the
 * screen collects. Unequal shares would need a per-share price list.
 */
describe("[CALC-1] transfer fees are assessed per purchaser share", () => {
  it("a couple buying at EUR 300,000 pays on two shares of 150,000", () => {
    // one share: 2,550 + (65,000 x 5%) = 5,800 -> x2 = 11,600 gross
    const joint = computeTransferFees(300000, TRANSFER, {
      relief: true,
      vatPaid: false,
      purchasers: 2,
    });
    expect(joint.gross).toBe(11600);
    expect(joint.reliefAmount).toBe(5800);
    expect(joint.total).toBe(5800);
  });

  it("the joint assessment is cheaper than the single one — the whole point", () => {
    const single = computeTransferFees(300000, TRANSFER, { relief: true, vatPaid: false });
    const joint = computeTransferFees(300000, TRANSFER, {
      relief: true,
      vatPaid: false,
      purchasers: 2,
    });
    expect(single.total).toBe(8600);
    expect(joint.total).toBe(5800);
    expect(single.total - joint.total).toBe(2800); // the amount previously over-quoted
  });

  it("omitting purchasers is identical to a single purchaser (back-compatible)", () => {
    const implicit = computeTransferFees(300000, TRANSFER, { relief: false, vatPaid: false });
    const explicit = computeTransferFees(300000, TRANSFER, {
      relief: false,
      vatPaid: false,
      purchasers: 1,
    });
    expect(implicit.total).toBe(17200);
    expect(explicit.total).toBe(17200);
    expect(implicit.purchasers).toBe(1);
  });

  it("three purchasers at EUR 255,000 each take the 3% band only", () => {
    // 255,000 / 3 = 85,000 per share -> 2,550 each -> 7,650 gross
    const r = computeTransferFees(255000, TRANSFER, {
      relief: false,
      vatPaid: false,
      purchasers: 3,
    });
    expect(r.perShareGross).toBe(2550);
    expect(r.gross).toBe(7650);
    expect(r.rows.map((b) => b.fee)).toEqual([2550]); // a single band, per share
  });

  it("reports the per-share breakdown, not the combined one", () => {
    const r = computeTransferFees(300000, TRANSFER, {
      relief: false,
      vatPaid: false,
      purchasers: 2,
    });
    // rows describe ONE share of 150,000: 85,000 @ 3% then 65,000 @ 5%
    expect(r.rows.map((b) => b.taxable)).toEqual([85000, 65000]);
    expect(r.perShareGross).toBe(5800);
    expect(r.gross).toBe(11600);
    expect(r.purchasers).toBe(2);
  });

  it("handles a share that does not divide evenly", () => {
    // 300,001 / 2 = 150,000.50 -> 2,550 + (65,000.50 x 5%) = 5,800.03 per share
    const r = computeTransferFees(300001, TRANSFER, {
      relief: false,
      vatPaid: false,
      purchasers: 2,
    });
    expect(r.perShareGross).toBe(5800.03);
    expect(r.gross).toBe(11600.06);
  });

  it("coerces a nonsensical purchaser count to a single share", () => {
    for (const bad of [0, -3, 0.4, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = computeTransferFees(300000, TRANSFER, {
        relief: false,
        vatPaid: false,
        purchasers: bad,
      });
      expect(r.purchasers, `purchasers=${bad}`).toBe(1);
      expect(r.total).toBe(17200);
    }
  });

  it("truncates a fractional purchaser count rather than splitting a person", () => {
    const r = computeTransferFees(300000, TRANSFER, {
      relief: false,
      vatPaid: false,
      purchasers: 2.9,
    });
    expect(r.purchasers).toBe(2);
  });

  it("a VAT-paid purchase is nil however many purchasers there are", () => {
    const r = computeTransferFees(300000, TRANSFER, {
      relief: true,
      vatPaid: true,
      purchasers: 4,
    });
    expect(r.vatExempt).toBe(true);
    expect(r.total).toBe(0);
    expect(r.gross).toBe(0);
  });

  it("more purchasers never costs more than fewer", () => {
    let prev = Number.POSITIVE_INFINITY;
    for (let n = 1; n <= 6; n++) {
      const total = computeTransferFees(600000, TRANSFER, {
        relief: false,
        vatPaid: false,
        purchasers: n,
      }).total;
      expect(total).toBeLessThanOrEqual(prev);
      prev = total;
    }
  });

  it("STAMP DUTY is per contract and must NOT be split per purchaser", () => {
    // Cyprus stamp duty is charged on the document, capped per contract —
    // unlike transfer fees it does not restart for each buyer. This test
    // exists so nobody "helpfully" threads purchasers into it later.
    expect(computeStampDuty(300000, STAMP).total).toBe(507.5);
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
