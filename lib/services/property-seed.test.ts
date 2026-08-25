import { describe, expect, it } from "vitest";
import { buildPropertySeed, type SeedSource } from "./property-seed";

const src = (over: Partial<SeedSource> = {}): SeedSource => ({
  reference: "PAF0001",
  kind: "standalone",
  property_type: "villa",
  transaction_type: "sale",
  district_id: "d-paphos",
  area_id: "a-chloraka",
  address: "12 Sea View",
  title: { en: "Seafront villa" },
  asking_price: 750000,
  rent_price_month: null,
  plot_area_sqm: 600,
  covered_area_sqm: 240,
  bedrooms: 4,
  bathrooms: 3,
  internal_notes: "Owner abroad until March",
  owner_contact_id: "c-owner",
  developer_contact_id: null,
  ...over,
});

describe("buildPropertySeed carries the descriptive fields", () => {
  it("copies what makes two listings similar", () => {
    const s = buildPropertySeed(src());
    expect(s).toMatchObject({
      fromReference: "PAF0001",
      source: "owner",
      partyId: "c-owner",
      kind: "standalone",
      propertyType: "villa",
      transactionType: "sale",
      districtId: "d-paphos",
      areaId: "a-chloraka",
      address: "12 Sea View",
      titleEn: "Seafront villa",
      askingPrice: "750000",
      plotAreaSqm: "600",
      coveredAreaSqm: "240",
      bedrooms: "4",
      bathrooms: "3",
      internalNotes: "Owner abroad until March",
    });
  });

  it("reads a developer listing as a developer listing", () => {
    const s = buildPropertySeed(
      src({ owner_contact_id: null, developer_contact_id: "c-dev", kind: "project" }),
    );
    expect(s.source).toBe("developer");
    expect(s.partyId).toBe("c-dev");
    expect(s.kind).toBe("project");
  });

  it("lets the developer link win when a row somehow carries both", () => {
    // the row is the authority on what it is; a listing with a developer is a
    // developer listing whatever else is set
    const s = buildPropertySeed(src({ owner_contact_id: "c-owner", developer_contact_id: "c-dev" }));
    expect(s.source).toBe("developer");
    expect(s.partyId).toBe("c-dev");
  });
});

describe("buildPropertySeed refuses to carry what must not travel", () => {
  it("always drops reference, status and coordinates", () => {
    const s = buildPropertySeed(src());
    expect(s.dropped.join(" ")).toMatch(/reference/);
    expect(s.dropped.join(" ")).toMatch(/status/);
    expect(s.dropped.join(" ")).toMatch(/coordinates/);
    // and none of them is smuggled in under another name
    expect(Object.keys(s)).not.toContain("reference");
    expect(Object.keys(s)).not.toContain("status");
  });

  it("turns a unit into a standalone rather than an orphan, and says so", () => {
    // reachable only by hand-typing the URL — the button is not offered on
    // units — but an orphan unit with no parent would be a real mess
    const s = buildPropertySeed(src({ kind: "unit" }));
    expect(s.kind).toBe("standalone");
    expect(s.dropped.join(" ")).toMatch(/unit/);
  });

  it("does the same for a phase", () => {
    const s = buildPropertySeed(src({ kind: "phase" }));
    expect(s.kind).toBe("standalone");
    expect(s.dropped.join(" ")).toMatch(/phase/);
  });
});

describe("buildPropertySeed survives the shapes a real row arrives in", () => {
  it("keeps a numeric that came over as a STRING", () => {
    // PostgREST hands `numeric` over as a string; String() must not mangle it
    const s = buildPropertySeed(src({ asking_price: "750000.00", covered_area_sqm: "240.50" }));
    expect(s.askingPrice).toBe("750000.00");
    expect(s.coveredAreaSqm).toBe("240.50");
  });

  it("keeps a legitimate ZERO instead of blanking it", () => {
    // `|| ""` would erase these; a studio really does have 0 bedrooms
    const s = buildPropertySeed(src({ bedrooms: 0, plot_area_sqm: 0 }));
    expect(s.bedrooms).toBe("0");
    expect(s.plotAreaSqm).toBe("0");
  });

  it("turns every null into an empty string, never the text 'null'", () => {
    const s = buildPropertySeed(
      src({
        property_type: null,
        district_id: null,
        area_id: null,
        address: null,
        title: null,
        asking_price: null,
        rent_price_month: null,
        plot_area_sqm: null,
        covered_area_sqm: null,
        bedrooms: null,
        bathrooms: null,
        internal_notes: null,
        owner_contact_id: null,
      }),
    );
    for (const [k, v] of Object.entries(s)) {
      if (k === "dropped" || k === "partyId") continue;
      expect(String(v), `${k} must not read as null/undefined`).not.toMatch(/^(null|undefined)$/);
    }
    expect(s.partyId).toBeNull();
    expect(s.titleEn).toBe("");
    expect(s.askingPrice).toBe("");
  });

  it("defaults a missing transaction type to sale", () => {
    expect(buildPropertySeed(src({ transaction_type: null })).transactionType).toBe("sale");
  });

  it("handles a title that is not the shape it should be", () => {
    expect(buildPropertySeed(src({ title: "just a string" })).titleEn).toBe("");
    expect(buildPropertySeed(src({ title: { el: "Βίλα" } })).titleEn).toBe("");
  });
});
