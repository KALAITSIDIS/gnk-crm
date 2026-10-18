import { describe, expect, it } from "vitest";
import {
  buildStampSummary,
  buildTransferSummary,
  computeStampDuty,
  computeTransferFees,
  computeTransferScenario,
  parseStampDutyConfig,
  parseTransferFeesConfig,
  SUMMARY_SCENARIO,
  VAT_SCENARIO_LABELS,
  VAT_SCENARIOS,
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
    const withRelief = computeTransferFees(85000, TRANSFER, { relief: true, subjectToVat: false });
    expect(withRelief.gross).toBe(2550);
    expect(withRelief.reliefAmount).toBe(1275);
    expect(withRelief.total).toBe(1275);

    const noRelief = computeTransferFees(85000, TRANSFER, { relief: false, subjectToVat: false });
    expect(noRelief.total).toBe(2550);
  });

  it("€170,000: two bands (6,800 gross / 3,400 with relief)", () => {
    const r = computeTransferFees(170000, TRANSFER, { relief: true, subjectToVat: false });
    expect(r.rows.map((b) => b.fee)).toEqual([2550, 4250]);
    expect(r.gross).toBe(6800);
    expect(r.total).toBe(3400);
  });

  it("€300,000: three bands (17,200 gross / 8,600 with relief)", () => {
    const r = computeTransferFees(300000, TRANSFER, { relief: true, subjectToVat: false });
    expect(r.rows.map((b) => b.fee)).toEqual([2550, 4250, 10400]);
    expect(r.gross).toBe(17200);
    expect(r.total).toBe(8600);

    const noRelief = computeTransferFees(300000, TRANSFER, { relief: false, subjectToVat: false });
    expect(noRelief.total).toBe(17200);
  });

  it("a transaction subject to VAT owes no transfer fee at all", () => {
    const r = computeTransferFees(300000, TRANSFER, { relief: true, subjectToVat: true });
    expect(r.vatExempt).toBe(true);
    expect(r.total).toBe(0);
    expect(r.rows).toHaveLength(0);
  });

  it("price inside the top band splits at both boundaries", () => {
    const r = computeTransferFees(200000, TRANSFER, { relief: false, subjectToVat: false });
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

  it("keeps the config's own wording for the VAT exemption, and never fails on it", () => {
    const seeded = parseTransferFeesConfig({
      ...TRANSFER,
      vat_paid_note: "No transfer fees when the transaction was subject to VAT",
    });
    expect(seeded?.vat_paid_note).toBe("No transfer fees when the transaction was subject to VAT");
    // prose never decides a figure, so an odd note is dropped, not fatal
    const odd = parseTransferFeesConfig({ ...TRANSFER, vat_paid_note: 42 });
    expect(odd).not.toBeNull();
    expect(odd).not.toHaveProperty("vat_paid_note");
    expect(parseTransferFeesConfig({ ...TRANSFER, vat_paid_note: "  " })).not.toHaveProperty(
      "vat_paid_note",
    );
  });
});

/* ------------------------------------------------- F01: the VAT scenario -- */

const COMPUTED = new Date("2026-10-18T09:00:00Z");
const TAIL = "Rates verified 27 Aug 2026 · computed 18 Oct 2026 — verify current legislation.";
const meta = (reference: string | null = null) => ({
  reference,
  verifiedAt: "2026-08-27",
  computedAt: COMPUTED,
});

describe("the scenario choice says 'subject to VAT', never 'paid' (F01)", () => {
  it("offers the three scenarios, the bare default first", () => {
    expect(VAT_SCENARIOS).toEqual(["does_not_apply", "applies", "unconfirmed"]);
  });

  it("no label or summary line confuses 'subject to VAT' with 'VAT paid'", () => {
    for (const s of VAT_SCENARIOS) {
      expect(VAT_SCENARIO_LABELS[s], s).not.toMatch(/paid/i);
      expect(SUMMARY_SCENARIO[s], s).not.toMatch(/paid/i);
    }
    expect(VAT_SCENARIO_LABELS.applies).toMatch(/^Subject to VAT/);
    expect(VAT_SCENARIO_LABELS.does_not_apply).toMatch(/^Not subject to VAT/);
  });
});

describe("computeTransferScenario (F01)", () => {
  const opts = { relief: true, purchasers: 1 };

  it("not subject to VAT: today's figure, and no second branch", () => {
    const s = computeTransferScenario(300000, TRANSFER, { ...opts, scenario: "does_not_apply" });
    expect(s.primary.total).toBe(8600);
    expect(s.primary.vatExempt).toBe(false);
    expect(s.ifSubject).toBeNull();
  });

  it("subject to VAT: the nil assessment", () => {
    const s = computeTransferScenario(300000, TRANSFER, { ...opts, scenario: "applies" });
    expect(s.primary.vatExempt).toBe(true);
    expect(s.primary.total).toBe(0);
    expect(s.ifSubject).toBeNull();
  });

  it("not confirmed: BOTH branches, the not-subject one leading", () => {
    const s = computeTransferScenario(300000, TRANSFER, { ...opts, scenario: "unconfirmed" });
    expect(s.primary.vatExempt).toBe(false);
    expect(s.primary.total).toBe(8600);
    expect(s.ifSubject?.vatExempt).toBe(true);
    expect(s.ifSubject?.total).toBe(0);
  });

  it("a config that does not exempt VAT sales charges fees in every scenario", () => {
    const noExempt = { ...TRANSFER, vat_paid_exempt: false };
    const s = computeTransferScenario(300000, noExempt, { ...opts, scenario: "applies" });
    expect(s.primary.vatExempt).toBe(false);
    expect(s.primary.total).toBe(8600);
  });
});

describe("buildTransferSummary — the quote that reaches a buyer (F01)", () => {
  it("not subject to VAT: today's lines plus the scenario line", () => {
    const s = computeTransferScenario(300000, TRANSFER, {
      relief: true,
      purchasers: 1,
      scenario: "does_not_apply",
    });
    expect(buildTransferSummary(300000, s, meta())).toBe(
      [
        "Transfer fees for €300.000:",
        "Scenario: not subject to VAT",
        "  €0 – €85.000 @ 3% = €2.550",
        "  €85.000 – €170.000 @ 5% = €4.250",
        "  above €170.000 @ 8% = €10.400",
        "Gross: €17.200",
        "50% relief: −€8.600",
        "Total: €8.600",
        TAIL,
      ].join("\n"),
    );
  });

  it("not confirmed: the reference, the scenario, both branches, and no bare Total line", () => {
    const s = computeTransferScenario(200000, TRANSFER, {
      relief: true,
      purchasers: 1,
      scenario: "unconfirmed",
    });
    const text = buildTransferSummary(200000, s, meta("PAF0001"));
    const lines = text.split("\n");
    expect(lines[0]).toBe("Transfer fees for €200.000 — PAF0001:");
    expect(lines[1]).toBe("Scenario: VAT status not confirmed — confirm before quoting");
    expect(text).toContain("If subject to VAT: no transfer fees.");
    expect(text).toContain("If not subject to VAT:");
    // 2,550 + 4,250 + 30,000 × 8% = 9,200 gross; 4,600 after relief
    expect(text).toContain("Total (if not subject to VAT): €4.600");
    expect(text, "an unqualified total would read as the answer").not.toMatch(/^Total:/m);
    expect(lines.at(-1)).toBe(TAIL);
  });

  it("not confirmed, under a config that charges VAT sales too: says what that branch costs", () => {
    const noExempt = { ...TRANSFER, vat_paid_exempt: false };
    const s = computeTransferScenario(300000, noExempt, {
      relief: true,
      purchasers: 1,
      scenario: "unconfirmed",
    });
    const text = buildTransferSummary(300000, s, meta());
    expect(text).toContain("If subject to VAT: €8.600.");
    expect(text).not.toContain("no transfer fees");
  });

  it("subject to VAT: the nil line, the scenario, no total", () => {
    const s = computeTransferScenario(300000, TRANSFER, {
      relief: true,
      purchasers: 1,
      scenario: "applies",
    });
    const text = buildTransferSummary(300000, s, meta("PAF0002"));
    expect(text).toBe(
      [
        "Transfer fees for €300.000 — PAF0002:",
        "Scenario: subject to VAT",
        "No transfer fees — the transaction is subject to VAT.",
        TAIL,
      ].join("\n"),
    );
  });

  it("a joint purchase keeps its per-share lines (CALC-1)", () => {
    const s = computeTransferScenario(300000, TRANSFER, {
      relief: true,
      purchasers: 2,
      scenario: "does_not_apply",
    });
    const text = buildTransferSummary(300000, s, meta());
    expect(text.split("\n")[0]).toBe("Transfer fees for €300.000 (2 purchasers):");
    expect(text).toContain("Assessed per purchaser on €150.000 each:");
    expect(text).toContain("× 2 purchasers = €11.600");
    expect(text).toContain("Total: €5.800");
  });

  it("an unverified config says so in the tail", () => {
    const s = computeTransferScenario(300000, TRANSFER, {
      relief: true,
      purchasers: 1,
      scenario: "does_not_apply",
    });
    const text = buildTransferSummary(300000, s, { ...meta(), verifiedAt: null });
    expect(text.split("\n").at(-1)).toMatch(/^Rates verified never · computed 18 Oct 2026/);
  });
});

describe("buildStampSummary (F01 moved it out of the component)", () => {
  const ABOLISHED: StampDutyConfig = {
    ...STAMP,
    abolished: { from: "2026-01-01", law: "Law 239(I)/2025" },
  };

  it("under the abolition: explains the repeal, names the property and the scenario, carries no total", () => {
    const text = buildStampSummary(300000, ABOLISHED, meta("PAF0001"), "unconfirmed")!;
    expect(text.split("\n").slice(0, 2)).toEqual([
      "Stamp duty for PAF0001: none — abolished for documents signed on or after 1 Jan 2026 (Law 239(I)/2025).",
      "Scenario: VAT status not confirmed — confirm before quoting",
    ]);
    expect(text).not.toMatch(/Total:/);
    // and with no price at all — the notice does not wait for one
    expect(buildStampSummary(null, ABOLISHED, meta(), "does_not_apply")!.split("\n").slice(0, 2)).toEqual([
      "Stamp duty: none — abolished for documents signed on or after 1 Jan 2026 (Law 239(I)/2025).",
      "Scenario: not subject to VAT",
    ]);
  });

  it("before an abolition: the scale and its total under a Scenario line, or nothing without a price", () => {
    const text = buildStampSummary(300000, STAMP, meta("PAF0001"), "applies")!;
    expect(text.split("\n").slice(0, 2)).toEqual(["Stamp duty for €300.000 — PAF0001:", "Scenario: subject to VAT"]);
    expect(text).toContain("Total: €507,50");
    // the duty does not move with the scenario — only the line naming it does
    const other = buildStampSummary(300000, STAMP, meta("PAF0001"), "does_not_apply")!;
    expect(other.replace("Scenario: not subject to VAT", "Scenario: subject to VAT")).toBe(text);
    expect(buildStampSummary(null, STAMP, meta(), "applies")).toBeNull();
  });

  it("every copied stamp-duty summary carries exactly one Scenario line, for every scenario (F01 binding)", () => {
    for (const s of VAT_SCENARIOS) {
      for (const config of [STAMP, ABOLISHED]) {
        const lines = buildStampSummary(300000, config, meta(), s)!.split("\n");
        expect(lines.filter((l) => l.startsWith("Scenario: ")), s).toEqual([`Scenario: ${SUMMARY_SCENARIO[s]}`]);
      }
    }
  });
});
