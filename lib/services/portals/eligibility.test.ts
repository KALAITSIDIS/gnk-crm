import { describe, expect, it } from "vitest";
import { DIALECT_RENDERERS } from "./dialects";
import { SALE_VILLA, RENT_FLAT, LAND_PLOT, SHOP_UNIT } from "./dialects/__fixtures__/listings";
import {
  eligibilityFor,
  eligibilityInputFromFeed,
  eligibilityInputFromProperty,
  reasonText,
  REASON_TEXT,
  type EligibilityInput,
  type EligibilityReason,
  type PropertyEligibilityInput,
} from "./eligibility";
import { PORTALS, portalById } from "./registry";

const je = portalById("jamesedition")!;
const ok: EligibilityInput = {
  isPublic: true,
  hasPrice: true,
  currency: "EUR",
  descriptionEn: "A villa",
  photoCount: 2,
  coords: { lat: 34.8, lng: 32.4, approx: false },
  propertyType: "villa",
  districtEn: "Paphos",
  areaEn: "Peyia",
};

const ALL_REASONS: EligibilityReason[] = [
  "not_public",
  "no_price",
  "currency_unsupported",
  "no_description_en",
  "too_few_photos",
  "no_coords",
  "type_unmapped",
  "no_location_text",
  "city_unmapped",
];

describe("eligibilityFor", () => {
  it("passes a complete public listing", () => {
    expect(eligibilityFor(je, ok)).toEqual({ ok: true });
  });

  it.each([
    ["not_public", { isPublic: false }],
    ["no_price", { hasPrice: false }],
    ["currency_unsupported", { currency: "RUB" }],
    ["no_description_en", { descriptionEn: "   " }],
    ["too_few_photos", { photoCount: 1 }],
    ["type_unmapped", { propertyType: "mixed_use" }],
    ["no_location_text", { districtEn: null, areaEn: "  " }],
  ] as const)("reports %s", (reason, patch) => {
    const r = eligibilityFor(je, { ...ok, ...patch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toEqual([reason]);
  });

  it("one of district or area is enough location text", () => {
    expect(eligibilityFor(je, { ...ok, districtEn: null })).toEqual({ ok: true });
    expect(eligibilityFor(je, { ...ok, areaEn: null })).toEqual({ ok: true });
  });

  it("reports every failing reason, not just the first", () => {
    const r = eligibilityFor(je, { ...ok, hasPrice: false, photoCount: 0 });
    if (r.ok) throw new Error("expected failure");
    expect(r.reasons).toEqual(["no_price", "too_few_photos"]);
  });

  it("needsCoords is a per-portal requirement", () => {
    const strict = { ...je, requirements: { ...je.requirements, needsCoords: true } };
    const r = eligibilityFor(strict, { ...ok, coords: null });
    if (r.ok) throw new Error("expected failure");
    expect(r.reasons).toEqual(["no_coords"]);
  });

  it("a type that only exists on Object.prototype is not a mapped type", () => {
    const r = eligibilityFor(je, { ...ok, propertyType: "constructor" });
    if (r.ok) throw new Error("expected failure");
    expect(r.reasons).toEqual(["type_unmapped"]);
  });

  it("a pending portal maps no types, so nothing is eligible for it", () => {
    const r = eligibilityFor(portalById("bazaraki")!, ok);
    if (r.ok) throw new Error("expected failure");
    expect(r.reasons).toContain("type_unmapped");
  });

  it("every reason has words for the desk", () => {
    for (const k of ALL_REASONS) expect(REASON_TEXT[k].length, k).toBeGreaterThan(10);
    expect(Object.keys(REASON_TEXT).sort()).toEqual([...ALL_REASONS].sort());
  });

  it("registry `spec` and the renderer table agree", () => {
    for (const p of PORTALS) {
      expect(DIALECT_RENDERERS[p.dialect] !== null, `${p.id}: spec=${p.spec}`).toBe(p.spec === "public");
    }
  });

  it("reports every reason it can, in a fixed order, when everything fails (JamesEdition needs no coords)", () => {
    const allBad: EligibilityInput = {
      isPublic: false,
      hasPrice: false,
      currency: "RUB",
      descriptionEn: "",
      photoCount: 0,
      coords: null,
      propertyType: "mixed_use",
      districtEn: null,
      areaEn: null,
    };
    const r = eligibilityFor(je, allBad);
    if (r.ok) throw new Error("expected failure");
    expect(r.reasons).toEqual([
      "not_public",
      "no_price",
      "currency_unsupported",
      "no_description_en",
      "too_few_photos",
      "type_unmapped",
      "no_location_text",
    ]);
  });

  it("a dialect with no currency restriction never reports currency_unsupported", () => {
    const r = eligibilityFor(portalById("thribee")!, { ...ok, currency: "RUB" });
    if (r.ok) throw new Error("expected failure");
    expect(r.reasons).not.toContain("currency_unsupported");
    expect(r.reasons).toContain("type_unmapped");
  });
});

describe("reasonText", () => {
  it("fills in the portal's own photo threshold", () => {
    expect(reasonText(je, "too_few_photos")).toContain("2 photos");
  });

  it("fills in the dialect's supported currencies", () => {
    expect(reasonText(je, "currency_unsupported")).toContain("EUR, GBP, USD");
  });

  it("falls back to the base text for a reason with no numbers", () => {
    expect(reasonText(je, "no_price")).toBe(REASON_TEXT.no_price);
  });
});

describe("eligibilityInputFromFeed", () => {
  it("reads the feed listing: a feed row is public by construction", () => {
    expect(eligibilityInputFromFeed(SALE_VILLA)).toEqual({
      isPublic: true,
      hasPrice: true,
      currency: "EUR",
      descriptionEn: "Detached villa <200 m from the coast> & pool.",
      photoCount: 2,
      coords: { lat: 34.8821, lng: 32.3789, approx: false },
      propertyType: "villa",
      districtEn: "Paphos",
      areaEn: "Peyia",
    });
  });

  it("a rent listing has a price when the monthly rent is set; land has coords null", () => {
    expect(eligibilityInputFromFeed(RENT_FLAT).hasPrice).toBe(true);
    expect(eligibilityInputFromFeed(LAND_PLOT).coords).toBeNull();
  });

  it("the shop fixture maps for Kyero but has too few photos for JamesEdition", () => {
    const r = eligibilityFor(je, eligibilityInputFromFeed(SHOP_UNIT));
    if (r.ok) throw new Error("expected failure");
    expect(r.reasons).toEqual(["too_few_photos"]);
  });
});

describe("eligibilityInputFromProperty", () => {
  const base: PropertyEligibilityInput = {
    visibility: "public",
    status: "available",
    transaction_type: "sale",
    asking_price: 300000,
    rent_price_month: null,
    currency: "EUR",
    public_description: { en: "Text" },
    property_type: "apartment",
    districtName: { en: "Paphos" },
    areaName: null,
    jpegPhotoCount: 3,
    coords: null,
  };

  it("reads the page's row; private or reserved is not public", () => {
    expect(eligibilityInputFromProperty(base).isPublic).toBe(true);
    expect(eligibilityInputFromProperty({ ...base, visibility: "private" }).isPublic).toBe(false);
    expect(eligibilityInputFromProperty({ ...base, status: "reserved" }).isPublic).toBe(false);
  });

  it("uses the one price rule: a rental needs its monthly rent", () => {
    expect(eligibilityInputFromProperty({ ...base, transaction_type: "rent" }).hasPrice).toBe(false);
    expect(eligibilityInputFromProperty({ ...base, transaction_type: "rent", rent_price_month: 900 }).hasPrice).toBe(true);
  });

  it("reads district and area names from the page's joined JSON", () => {
    const i = eligibilityInputFromProperty({ ...base, areaName: { en: "Tala", el: "Τάλα" } });
    expect(i.districtEn).toBe("Paphos");
    expect(i.areaEn).toBe("Tala");
    expect(eligibilityInputFromProperty(base).areaEn).toBeNull();
  });

  it("passes through what it doesn't compute: photo count, currency, type and coords", () => {
    expect(
      eligibilityInputFromProperty({ ...base, coords: { lat: 34.7, lng: 32.4, approx: true } }),
    ).toEqual({
      isPublic: true,
      hasPrice: true,
      currency: "EUR",
      descriptionEn: "Text",
      photoCount: 3,
      coords: { lat: 34.7, lng: 32.4, approx: true },
      propertyType: "apartment",
      districtEn: "Paphos",
      areaEn: null,
    });
  });
});
