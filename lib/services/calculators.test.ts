import { describe, expect, it } from "vitest";
import {
  computeStampDuty,
  computeTransferFees,
  parseStampDutyConfig,
  parseTransferFeesConfig,
  type StampDutyConfig,
  type TransferFeesConfig,
} from "./calculators";

// Mirrors the seeded cyprus_config (0003_seed.sql) — the acceptance boundary
// values in doc 02 §C8 are computed against exactly these bands.
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

describe("computeTransferFees — doc 02 §C8 boundaries", () => {
  it("€85,000: first band only (2,550 gross / 1,275 with relief)", () => {
    const withRelief = computeTransferFees(85000, TRANSFER, { relief: true, vatPaid: false });
    expect(withRelief.gross).toBe(2550);
    expect(withRelief.reliefAmount).toBe(1275);
    expect(withRelief.total).toBe(1275);

    const noRelief = computeTransferFees(85000, TRANSFER, { relief: false, vatPaid: false });
    expect(noRelief.total).toBe(2550);
  });

  it("€170,000: two bands (6,800 gross / 3,400 with relief)", () => {
    const r = computeTransferFees(170000, TRANSFER, { relief: true, vatPaid: false });
    expect(r.rows.map((b) => b.fee)).toEqual([2550, 4250]);
    expect(r.gross).toBe(6800);
    expect(r.total).toBe(3400);
  });

  it("€300,000: three bands (17,200 gross / 8,600 with relief)", () => {
    const r = computeTransferFees(300000, TRANSFER, { relief: true, vatPaid: false });
    expect(r.rows.map((b) => b.fee)).toEqual([2550, 4250, 10400]);
    expect(r.gross).toBe(17200);
    expect(r.total).toBe(8600);

    const noRelief = computeTransferFees(300000, TRANSFER, { relief: false, vatPaid: false });
    expect(noRelief.total).toBe(17200);
  });

  it("VAT-paid transaction zeroes the fee entirely", () => {
    const r = computeTransferFees(300000, TRANSFER, { relief: true, vatPaid: true });
    expect(r.vatExempt).toBe(true);
    expect(r.total).toBe(0);
    expect(r.rows).toHaveLength(0);
  });

  it("price inside the top band splits at both boundaries", () => {
    const r = computeTransferFees(200000, TRANSFER, { relief: false, vatPaid: false });
    expect(r.rows.map((b) => b.taxable)).toEqual([85000, 85000, 30000]);
    expect(r.total).toBe(2550 + 4250 + 2400);
  });
});

describe("computeStampDuty — doc 02 §C8 boundaries", () => {
  it("€5,000: fully inside the zero band", () => {
    const r = computeStampDuty(5000, STAMP);
    expect(r.total).toBe(0);
    expect(r.capApplied).toBe(false);
  });

  it("€170,000: 0 + 165,000 × 0.15% = 247.50", () => {
    const r = computeStampDuty(170000, STAMP);
    expect(r.total).toBe(247.5);
  });

  it("€300,000: 247.50 + 130,000 × 0.20% = 507.50", () => {
    const r = computeStampDuty(300000, STAMP);
    expect(r.total).toBe(507.5);
  });

  it("cap hit: €12,000,000 would be 23,907.50 → capped at €20,000", () => {
    const r = computeStampDuty(12_000_000, STAMP);
    expect(r.uncapped).toBe(23907.5);
    expect(r.capApplied).toBe(true);
    expect(r.total).toBe(20000);
  });
});

describe("config parsers tolerate malformed config", () => {
  it("accepts the seeded shapes", () => {
    expect(parseTransferFeesConfig(TRANSFER)).not.toBeNull();
    expect(parseStampDutyConfig(STAMP)).not.toBeNull();
  });

  it("rejects garbage instead of computing nonsense", () => {
    expect(parseTransferFeesConfig({ bands: "no" })).toBeNull();
    expect(parseTransferFeesConfig(null)).toBeNull();
    expect(parseStampDutyConfig({ bands: [] })).toBeNull();
  });
});
