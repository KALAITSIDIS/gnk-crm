import { describe, expect, it } from "vitest";
import { toCsv } from "./csv";
import { propertyCsvColumns, type PropertyExportRow } from "./property-export";

const base: PropertyExportRow = {
  reference: "PAF0001",
  kind: "standalone",
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
  title_deed_status: "separate",
  permit_status: "full",
  location: null,
  owner: { display_name: "Andreas Georgiou" },
  developer: null,
  agent: { full_name: "Maria Christodoulou" },
  districts: { name: { en: "Paphos" } },
  areas: { name: { en: "Kato Paphos" } },
  mandates: [{ type: "exclusive", status: "active" }],
};

const line = (csv: string, i = 1) => csv.replace(/^﻿/, "").split("\r\n")[i];

describe("propertyCsvColumns", () => {
  it("names every exported column in the header", () => {
    const header = line(toCsv(propertyCsvColumns(), []), 0);
    expect(header).toBe(
      "Reference,Kind,Type,Transaction,Status,Visibility,Title,District,Area,Address,Bedrooms,Bathrooms,Covered m²,Plot m²,Asking price,Rent/month,Mandate,Owner,Developer,Agent,Title deed,Permit,Latitude,Longitude,Quality",
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

describe("propertyCsvColumns — relationships (audit finding 14)", () => {
  const value = (header: string, row = base) =>
    propertyCsvColumns().find((c) => c.header === header)!.value(row);

  it("carries the parties an export gets grouped by", () => {
    expect(value("Owner")).toBe("Andreas Georgiou");
    expect(value("Agent")).toBe("Maria Christodoulou");
    expect(value("Developer")).toBe(""); // absent, not "null"
  });

  it("carries the legal status the desk chases", () => {
    expect(value("Title deed")).toBe("separate");
    expect(value("Permit")).toBe("full");
  });

  it("splits coordinates into two columns a spreadsheet can plot", () => {
    // one "34.77, 32.42" string would make somebody parse it back out
    const withPoint = { ...base, location: "0101000020E6100000D0D556EC2FCA4040D0D556EC2FCA4140" };
    expect(value("Latitude", withPoint)).not.toBe("");
    expect(value("Longitude", withPoint)).not.toBe("");
  });

  it("leaves both coordinate cells empty when there is no point", () => {
    // an empty cell is "unknown"; a 0 would be a place in the Gulf of Guinea
    expect(value("Latitude")).toBe("");
    expect(value("Longitude")).toBe("");
  });
});
