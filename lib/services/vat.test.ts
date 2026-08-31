import { describe, it, expect } from "vitest";
import { deriveVat, type VatConfigRow } from "./vat";

/**
 * The real row, as verified on 2026-08-27 by migration 0058. Tests are written
 * against these values deliberately: if someone edits the config in Settings to
 * something incoherent, that is a data problem the panel should reflect, but if
 * someone changes the SHAPE this file should fail loudly.
 */
const CONFIG: VatConfigRow = {
  standard_rate: 0.19,
  reduced_rate: 0.05,
  reduced_rules_post_2023: {
    reduced_area_cap_sqm: 130,
    reduced_value_cap_eur: 350000,
    max_total_area_sqm: 190,
    max_total_value_eur: 475000,
    disability_area_cap_sqm: 190,
  },
  transitional: {
    deadline: "2026-12-31",
    old_rule: "5% on the first 200 sqm, no value cap",
    condition: "permit-date condition (0079)",
  },
};

const ok = { config: CONFIG, configVerifiedAt: "2026-08-27" };

describe("deriveVat — it refuses rather than invents", () => {
  it("returns cannot_derive with no config, and no numbers at all", () => {
    const t = deriveVat({ coveredAreaSqm: 100, price: 300000, vatStatus: "new_vat", config: null });
    expect(t.outcome).toBe("cannot_derive");
    expect(t.totalVat).toBeNull();
    expect(t.bands).toEqual([]);
    expect(t.reasons[0]).toMatch(/Settings/);
  });

  it("names every missing threshold instead of falling back to a constant", () => {
    const t = deriveVat({
      coveredAreaSqm: 100,
      price: 300000,
      vatStatus: "new_vat",
      config: { standard_rate: 0.19, reduced_rules_post_2023: {} },
    });
    expect(t.outcome).toBe("cannot_derive");
    expect(t.totalVat).toBeNull();
    // the point: a plausible number is never produced from a hardcoded rate
    expect(t.reasons[0]).toContain("reduced_rate");
    expect(t.reasons[0]).toContain("max_total_value_eur");
  });

  it("rejects a zero or negative threshold as unusable", () => {
    const t = deriveVat({
      coveredAreaSqm: 100,
      price: 300000,
      vatStatus: "new_vat",
      config: { ...CONFIG, standard_rate: 0 },
    });
    expect(t.outcome).toBe("cannot_derive");
    expect(t.reasons[0]).toContain("standard_rate");
  });

  it("flags an unverified config as an assumption rather than refusing", () => {
    const t = deriveVat({ coveredAreaSqm: 100, price: 300000, vatStatus: "new_vat", config: CONFIG });
    expect(t.assumptions.some((a) => /not been marked verified/.test(a))).toBe(true);
  });
});

describe("deriveVat — resale", () => {
  it("says VAT does not arise, and points at transfer fees instead", () => {
    const t = deriveVat({ coveredAreaSqm: 100, price: 300000, vatStatus: "resale_no_vat", ...ok });
    expect(t.outcome).toBe("no_vat");
    expect(t.totalVat).toBeNull();
    expect(t.reasons.join(" ")).toMatch(/[Tt]ransfer fees apply instead/);
  });
});

describe("deriveVat — the split when the reduced rate can apply", () => {
  it("puts the whole price in the reduced band for a small, cheap dwelling", () => {
    // 100 m², €300,000: inside 130 m² and inside €350,000
    const t = deriveVat({ coveredAreaSqm: 100, price: 300000, vatStatus: "new_vat", ...ok });
    expect(t.outcome).toBe("reduced_possible");
    expect(t.bands).toHaveLength(1);
    expect(t.bands[0].base).toBe(300000);
    expect(t.bands[0].rate).toBe(0.05);
    expect(t.totalVat).toBe(15000);
    expect(t.totalWithVat).toBe(315000);
  });

  it("apportions by area when the dwelling is larger than the area cap", () => {
    // 190 m² at €380,000. First 130 m² is 130/190 of the price = €260,000,
    // which is under the €350,000 value cap, so that is the reduced base.
    const t = deriveVat({ coveredAreaSqm: 190, price: 380000, vatStatus: "new_vat", ...ok });
    expect(t.outcome).toBe("reduced_possible");
    expect(t.bands[0].base).toBe(260000);
    expect(t.bands[1].base).toBe(120000);
    expect(t.totalVat).toBe(260000 * 0.05 + 120000 * 0.19);
  });

  it("caps the reduced band at the value cap, not just the area share", () => {
    // 130 m² at €460,000: the whole area is inside the cap, so the area share is
    // 100%, but the reduced band is still limited to €350,000.
    const t = deriveVat({ coveredAreaSqm: 130, price: 460000, vatStatus: "new_vat", ...ok });
    expect(t.bands[0].base).toBe(350000);
    expect(t.bands[1].base).toBe(110000);
    expect(t.totalVat).toBe(round2(350000 * 0.05 + 110000 * 0.19));
  });

  it("reads numerics that arrive from PostgREST as strings", () => {
    const t = deriveVat({ coveredAreaSqm: "100.00", price: "300000.00", vatStatus: "new_vat", ...ok });
    expect(t.outcome).toBe("reduced_possible");
    expect(t.totalVat).toBe(15000);
  });
});

describe("deriveVat — THE CLIFF, which is the number worth knowing", () => {
  it("just under the value cap keeps the relief", () => {
    const under = deriveVat({ coveredAreaSqm: 120, price: 475000, vatStatus: "new_vat", ...ok });
    expect(under.outcome).toBe("reduced_possible");
    expect(under.cliff).toBeNull();
    // €350,000 at 5% + €125,000 at 19%
    expect(under.totalVat).toBe(round2(350000 * 0.05 + 125000 * 0.19));
  });

  // CALC-VAT-3 (2026-09-02): the cliff seen from below — 5% is the panel's
  // judgment call; the caps themselves stay config-only.
  it("within 5% under the VALUE cap warns, with the relief at stake priced", () => {
    const near = deriveVat({ coveredAreaSqm: 100, price: 470000, vatStatus: "new_vat", ...ok });
    expect(near.outcome).toBe("reduced_possible");
    expect(near.cliff).toBeNull();
    expect(near.nearCliff).not.toBeNull();
    expect(near.nearCliff!.kind).toBe("value");
    // €475,000 − €470,000
    expect(near.nearCliff!.headroom).toBe(5000);
    // relief enjoyed: €350,000 reduced base × (19% − 5%)
    expect(near.nearCliff!.wouldCostEur).toBe(round2(350000 * 0.14));
  });

  it("within 5% under the AREA cap warns too", () => {
    const near = deriveVat({ coveredAreaSqm: 185, price: 300000, vatStatus: "new_vat", ...ok });
    expect(near.outcome).toBe("reduced_possible");
    expect(near.nearCliff).not.toBeNull();
    expect(near.nearCliff!.kind).toBe("area");
    expect(near.nearCliff!.headroom).toBe(5);
  });

  it("comfortably inside both caps carries no warning — the panel must not cry wolf", () => {
    const calm = deriveVat({ coveredAreaSqm: 100, price: 300000, vatStatus: "new_vat", ...ok });
    expect(calm.nearCliff).toBeNull();
  });

  it("the 5% boundary is exclusive — €451,250 exactly is not yet near", () => {
    // 0.95 × 475,000 = 451,250; the band is (451,250, 475,000]
    const atLine = deriveVat({
      coveredAreaSqm: 100,
      price: 451250,
      vatStatus: "new_vat",
      ...ok,
    });
    expect(atLine.nearCliff).toBeNull();
    const justOver = deriveVat({
      coveredAreaSqm: 100,
      price: 451251,
      vatStatus: "new_vat",
      ...ok,
    });
    expect(justOver.nearCliff).not.toBeNull();
  });

  it("both dimensions near reports value first, the both-crossed precedent", () => {
    const both = deriveVat({ coveredAreaSqm: 185, price: 470000, vatStatus: "new_vat", ...ok });
    expect(both.nearCliff!.kind).toBe("value");
  });

  it("the near warning agrees with the over side: the same dwelling one euro over loses what the warning priced", () => {
    const near = deriveVat({ coveredAreaSqm: 120, price: 475000, vatStatus: "new_vat", ...ok });
    const over = deriveVat({ coveredAreaSqm: 120, price: 475001, vatStatus: "new_vat", ...ok });
    expect(near.nearCliff!.wouldCostEur).toBe(over.cliff!.costsEur);
  });

  it("ONE EURO over the cap standard-rates the WHOLE purchase", () => {
    const over = deriveVat({ coveredAreaSqm: 120, price: 475001, vatStatus: "new_vat", ...ok });
    expect(over.outcome).toBe("standard_only");
    expect(over.bands).toHaveLength(1);
    expect(over.bands[0].rate).toBe(0.19);
    expect(over.cliff).not.toBeNull();
    expect(over.cliff!.kind).toBe("value");
    expect(over.cliff!.over).toBe(1);
  });

  it("and that one euro costs €49,000 of relief — the whole reason to show it", () => {
    const under = deriveVat({ coveredAreaSqm: 120, price: 475000, vatStatus: "new_vat", ...ok });
    const over = deriveVat({ coveredAreaSqm: 120, price: 475001, vatStatus: "new_vat", ...ok });

    // €350,000 moves from 5% to 19% => 350000 * 0.14
    expect(over.cliff!.costsEur).toBe(49000);

    // and the real bills differ by very nearly that, for one euro more of price
    const jump = over.totalVat! - under.totalVat!;
    expect(jump).toBeGreaterThan(48000);
    expect(jump).toBeLessThan(49100);
  });

  it("reports an area cliff too, and says which cap was crossed", () => {
    const t = deriveVat({ coveredAreaSqm: 191, price: 300000, vatStatus: "new_vat", ...ok });
    expect(t.outcome).toBe("standard_only");
    expect(t.cliff!.kind).toBe("area");
    expect(t.cliff!.over).toBe(1);
    expect(t.reasons.join(" ")).toMatch(/WHOLE purchase/);
  });

  it("the area cliff costs the TRUE under-vs-over delta, not a €475k hypothetical", () => {
    // The pre-fix formula substituted the value cap as the price for both
    // cliff kinds, showing ≈€45,262 here — a scenario no eligible dwelling
    // could occupy. The honest figure is what the same PRICE would have
    // yielded at the cap area: 300,000 × 130/190 = €205,263.16 in the reduced
    // band, × 14% = €28,736.84 (audit finding CALC-VAT-1).
    const under = deriveVat({ coveredAreaSqm: 190, price: 300000, vatStatus: "new_vat", ...ok });
    const over = deriveVat({ coveredAreaSqm: 191, price: 300000, vatStatus: "new_vat", ...ok });

    expect(over.cliff!.costsEur).toBe(28736.84);
    // and it must equal the real difference between the two bills, to the cent
    expect(round2(over.totalVat! - under.totalVat!)).toBe(over.cliff!.costsEur);
  });

  it("both caps crossed: the hypothetical sits at BOTH caps", () => {
    // 200 m² at €500,000 — eligibility at the boundary means 190 m² AND
    // €475,000: 475,000 × 130/190 = €325,000 reduced, × 14% = €45,500.
    const t = deriveVat({ coveredAreaSqm: 200, price: 500000, vatStatus: "new_vat", ...ok });
    expect(t.cliff!.kind).toBe("value"); // value reported first when both crossed
    expect(t.cliff!.costsEur).toBe(45500);
  });

  it("offers the transitional regime exactly where it would help", () => {
    const t = deriveVat({ coveredAreaSqm: 191, price: 300000, vatStatus: "new_vat", ...ok });
    expect(t.transitionalMayHelp).toEqual({
      deadline: "2026-12-31",
      oldRule: "5% on the first 200 sqm, no value cap",
      condition: "permit-date condition (0079)",
    });
  });

  it("a pre-0079 config without the condition still renders — condition null, never dropped", () => {
    const legacy = {
      ...CONFIG,
      transitional: { deadline: "2026-12-31", old_rule: "5% on the first 200 sqm, no value cap" },
    };
    const t = deriveVat({
      coveredAreaSqm: 191,
      price: 300000,
      vatStatus: "new_vat",
      config: legacy,
      configVerifiedAt: "2026-08-27",
    });
    expect(t.transitionalMayHelp).toEqual({
      deadline: "2026-12-31",
      oldRule: "5% on the first 200 sqm, no value cap",
      condition: null,
    });
  });

  it("does not raise the transitional regime when the current rules already work", () => {
    const t = deriveVat({ coveredAreaSqm: 100, price: 300000, vatStatus: "new_vat", ...ok });
    expect(t.transitionalMayHelp).toBeNull();
  });
});

describe("deriveVat — contradicting the stored declaration", () => {
  it("flags a reduced_rate_eligible property that the caps refuse", () => {
    const t = deriveVat({
      coveredAreaSqm: 250,
      price: 900000,
      vatStatus: "reduced_rate_eligible",
      ...ok,
    });
    expect(t.outcome).toBe("standard_only");
    expect(t.conflictsWithDeclaration).toBe(true);
  });

  it("does not flag one the caps allow", () => {
    const t = deriveVat({
      coveredAreaSqm: 100,
      price: 300000,
      vatStatus: "reduced_rate_eligible",
      ...ok,
    });
    expect(t.conflictsWithDeclaration).toBe(false);
  });

  it("flags it when there is no area to judge by, rather than staying silent", () => {
    const t = deriveVat({
      coveredAreaSqm: null,
      price: 300000,
      vatStatus: "reduced_rate_eligible",
      ...ok,
    });
    expect(t.outcome).toBe("standard_only");
    expect(t.conflictsWithDeclaration).toBe(true);
  });
});

describe("deriveVat — incomplete property", () => {
  it("asks for a price rather than showing zero", () => {
    const t = deriveVat({ coveredAreaSqm: 100, price: null, vatStatus: "new_vat", ...ok });
    expect(t.outcome).toBe("cannot_derive");
    expect(t.totalVat).toBeNull();
    expect(t.reasons[0]).toMatch(/price/i);
  });

  it("falls back to standard-only when the area is missing, and says why", () => {
    const t = deriveVat({ coveredAreaSqm: null, price: 300000, vatStatus: "new_vat", ...ok });
    expect(t.outcome).toBe("standard_only");
    expect(t.totalVat).toBe(57000);
    expect(t.reasons[0]).toMatch(/No covered area/);
  });

  it("always states the covered-area assumption when it used one", () => {
    const t = deriveVat({ coveredAreaSqm: 100, price: 300000, vatStatus: "new_vat", ...ok });
    expect(t.assumptions.some((a) => /Covered area/.test(a))).toBe(true);
  });
});

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
