import { describe, expect, it } from "vitest";
import { toCsv } from "./csv";
import { propertyCsvColumns, type PropertyExportRow } from "./property-export";

const base: PropertyExportRow = {
  reference: "GNK-PAF-0001",
  property_type: "villa",
  transaction_type: "sale",
  status: "available",
  visibility: "vip",
  title: { en: "Sea-view villa" },
  address: "12 Poseidonos Ave",
  bedrooms: 3,
  bathrooms: 2,
  covered_area_sqm: "180.00",
  plot_area_sqm: "600.00",
  asking_price: "750000.00",
  rent_price_month: null,
  quality_score: 82,
  districts: { name: { en: "Paphos" } },
  areas: { name: { en: "Kato Paphos" } },
  mandates: [{ type: "exclusive", status: "active" }],
};

const line = (csv: string, i = 1) => csv.replace(/^﻿/, "").split("\r\n")[i];

describe("propertyCsvColumns", () => {
  it("names every exported column in the header", () => {
    const header = line(toCsv(propertyCsvColumns(), []), 0);
    expect(header).toBe(
      "Reference,Type,Transaction,Status,Visibility,Title,District,Area,Address,Bedrooms,Bathrooms,Covered m²,Plot m²,Asking price,Rent/month,Mandate,Quality",
    );
  });

  it("writes money and area as raw numbers so a spreadsheet can sum them", () => {
    const csv = toCsv(propertyCsvColumns(), [base]);
    expect(csv).toContain("750000.00");
    expect(csv).toContain("180.00");
    expect(csv).not.toContain("€"); // not currency-formatted
  });

  it("derives the mandate badge: active wins, else expired, else none", () => {
    const active = toCsv(propertyCsvColumns(), [base]);
    expect(active).toContain(",exclusive,"); // active mandate → its type

    const expired = toCsv(propertyCsvColumns(), [
      { ...base, mandates: [{ type: "open", status: "expired" }] },
    ]);
    expect(expired).toContain(",expired,");

    const none = toCsv(propertyCsvColumns(), [{ ...base, mandates: [] }]);
    expect(none).toContain(",none,");

    // an active mandate outranks an expired one on the same property
    const both = toCsv(propertyCsvColumns(), [
      { ...base, mandates: [{ type: "open", status: "expired" }, { type: "exclusive", status: "active" }] },
    ]);
    expect(both).toContain(",exclusive,");
  });

  it("takes the English title/district/area and leaves a missing number blank", () => {
    const csv = toCsv(propertyCsvColumns(), [
      { ...base, rent_price_month: null, bedrooms: null },
    ]);
    const row = line(csv);
    expect(row).toContain("Sea-view villa");
    expect(row).toContain("Paphos");
    // rent (null) and bedrooms (null) render as empty cells, not 0
    expect(row).toContain(",Kato Paphos,12 Poseidonos Ave,,"); // area,address,bedrooms(empty)
  });
});
