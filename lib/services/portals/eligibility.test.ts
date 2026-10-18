import { describe, expect, it } from "vitest";
import { RENDITIONS } from "@/lib/services/media";
import { DIALECT_RENDERERS } from "./dialects";
import { SALE_VILLA, RENT_FLAT, LAND_PLOT, SHOP_UNIT } from "./dialects/__fixtures__/listings";
import {
  acceptedPhotoCount,
  advisoriesFor,
  deliveredJpegSize,
  eligibilityFor,
  eligibilityInputFromFeed,
  eligibilityInputFromProperty,
  JPEG_RENDITION_WIDTH,
  REASON_FIX_TAB,
  reasonText,
  REASON_TEXT,
  type EligibilityInput,
  type EligibilityReason,
  type PhotoSize,
  type PropertyEligibilityInput,
} from "./eligibility";
import { PORTALS, portalById } from "./registry";

const je = portalById("jamesedition")!;
const apits = portalById("aplaceinthesun")!;

const photo = (width: number | null, height: number | null): PhotoSize => ({ width, height });
/** A typical 3:2 photo, already at the rendition width: JamesEdition accepts it. */
const SHARP = photo(1600, 1067);

const ok: EligibilityInput = {
  isPublic: true,
  price: 650_000,
  transactionType: "sale",
  currency: "EUR",
  descriptionEn: "A villa",
  photos: [SHARP, SHARP],
  coords: { lat: 34.8, lng: 32.4, approx: false },
  propertyType: "villa",
  districtEn: "Paphos",
  areaEn: "Peyia",
};

const ALL_REASONS: EligibilityReason[] = [
  "not_public",
  "no_price",
  "price_unsupported",
  "currency_unsupported",
  "no_description_en",
  "too_few_photos",
  "no_coords",
  "type_unmapped",
  "type_not_accepted",
  "no_location_text",
  "city_unmapped",
];

describe("eligibilityFor", () => {
  it("passes a complete public listing", () => {
    expect(eligibilityFor(je, ok)).toEqual({ ok: true });
  });

  // Updated to the new input shape: `hasPrice: false` is now `price: null`,
  // `photoCount: 1` is now one photo in `photos`.
  it.each([
    ["not_public", { isPublic: false }],
    ["no_price", { price: null }],
    ["currency_unsupported", { currency: "RUB" }],
    ["no_description_en", { descriptionEn: "   " }],
    ["too_few_photos", { photos: [SHARP] }],
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
    const r = eligibilityFor(je, { ...ok, price: null, photos: [] });
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
    // price_unsupported needs a price and type_not_accepted needs a MAPPED
    // type, so neither can join no_price / type_unmapped; the next test pins
    // where those two sit in the order.
    const allBad: EligibilityInput = {
      isPublic: false,
      price: null,
      transactionType: "sale",
      currency: "RUB",
      descriptionEn: "",
      photos: [],
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

  it("the two portal-rule reasons take their place in the same fixed order", () => {
    const r = eligibilityFor(je, {
      ...ok,
      price: 100_000_000,
      currency: "RUB",
      propertyType: "hotel",
      photos: [photo(4000, 1000), photo(4000, 1000)],
    });
    if (r.ok) throw new Error("expected failure");
    expect(r.reasons).toEqual(["price_unsupported", "currency_unsupported", "too_few_photos", "type_not_accepted"]);
  });

  it("a dialect with no currency restriction never reports currency_unsupported", () => {
    const r = eligibilityFor(portalById("thribee")!, { ...ok, currency: "RUB" });
    if (r.ok) throw new Error("expected failure");
    expect(r.reasons).not.toContain("currency_unsupported");
    expect(r.reasons).toContain("type_unmapped");
  });
});

describe("price", () => {
  // A price of 0 would advertise the listing as free; a negative or
  // non-finite one is not a price at all. Infinity in particular must not
  // slip through as "a price, just too large" (price_unsupported).
  it.each([0, -1, -650_000, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "a price of %s is no price",
    (price) => {
      const r = eligibilityFor(je, { ...ok, price });
      if (r.ok) throw new Error("expected failure");
      expect(r.reasons).toEqual(["no_price"]);
    },
  );

  it("Kyero carries a whole price of up to eight digits, judged as the renderer rounds it", () => {
    // kyero.ts emits Math.round(price): 99,999,999.4 goes out as 99999999
    // (eight characters), 99,999,999.5 as 100000000 (nine).
    expect(eligibilityFor(je, { ...ok, price: 99_999_999 })).toEqual({ ok: true });
    expect(eligibilityFor(je, { ...ok, price: 99_999_999.4 })).toEqual({ ok: true });
    for (const price of [99_999_999.5, 100_000_000, 250_000_000]) {
      const r = eligibilityFor(je, { ...ok, price });
      if (r.ok) throw new Error(`expected ${price} to fail`);
      expect(r.reasons, String(price)).toEqual(["price_unsupported"]);
    }
  });

  it("the limit is the dialect's, so every Kyero portal applies it", () => {
    const r = eligibilityFor(apits, { ...ok, price: 100_000_000 });
    if (r.ok) throw new Error("expected failure");
    expect(r.reasons).toEqual(["price_unsupported"]);
  });

  it("a dialect with no stated limit never reports price_unsupported", () => {
    const r = eligibilityFor(portalById("thribee")!, { ...ok, price: 1e12 });
    if (r.ok) throw new Error("expected failure");
    expect(r.reasons).not.toContain("price_unsupported");
  });

  it("the desk text names Kyero's limit", () => {
    expect(reasonText(je, "price_unsupported")).toContain("99,999,999");
    expect(reasonText(portalById("thribee")!, "price_unsupported")).toBe(REASON_TEXT.price_unsupported);
  });
});

describe("property types a portal refuses", () => {
  it.each(["shop", "office", "warehouse", "building", "hotel"])(
    "JamesEdition refuses %s although Kyero can name it",
    (propertyType) => {
      const r = eligibilityFor(je, { ...ok, propertyType });
      if (r.ok) throw new Error("expected failure");
      expect(r.reasons).toEqual(["type_not_accepted"]);
    },
  );

  it.each(["villa", "land", "apartment", "townhouse", "house"])("JamesEdition accepts %s", (propertyType) => {
    // land is residential on JamesEdition (its property_type "Land")
    expect(eligibilityFor(je, { ...ok, propertyType })).toEqual({ ok: true });
  });

  it("the refusal is JamesEdition's, not Kyero's: A Place in the Sun takes a shop", () => {
    expect(eligibilityFor(apits, { ...ok, propertyType: "shop" })).toEqual({ ok: true });
  });

  it("the desk text is JamesEdition's own sentence, and the base text where a portal has none", () => {
    expect(reasonText(je, "type_not_accepted")).toBe(je.requirements.excludedTypesNote);
    expect(reasonText(je, "type_not_accepted")).toMatch(/residential/);
    expect(reasonText(apits, "type_not_accepted")).toBe(REASON_TEXT.type_not_accepted);
  });
});

describe("photo size (JamesEdition: at least 800×600)", () => {
  it("the JPEG rendition width is the one the media pipeline produces", () => {
    // eligibility restates it so it does not import sharp; this pins the two together
    expect(JPEG_RENDITION_WIDTH).toBe(RENDITIONS.find((r) => r.name === "jpeg")!.width);
  });

  it("deliveredJpegSize scales to min(1600, width), keeping the aspect ratio and never enlarging", () => {
    expect(deliveredJpegSize(photo(1000, 700))).toEqual({ width: 1000, height: 700 });
    expect(deliveredJpegSize(photo(4000, 1800))).toEqual({ width: 1600, height: 720 });
    expect(deliveredJpegSize(photo(4000, 1000))).toEqual({ width: 1600, height: 400 });
    expect(deliveredJpegSize(photo(700, 500))).toEqual({ width: 700, height: 500 });
    // 2001 × 1600 / 3000 = 1067.2 → a whole pixel
    expect(deliveredJpegSize(photo(3000, 2001))).toEqual({ width: 1600, height: 1067 });
  });

  it("deliveredJpegSize answers null for a size never measured or impossible", () => {
    expect(deliveredJpegSize(photo(null, null))).toBeNull();
    expect(deliveredJpegSize(photo(1600, null))).toBeNull();
    expect(deliveredJpegSize(photo(null, 1067))).toBeNull();
    expect(deliveredJpegSize(photo(0, 600))).toBeNull();
    expect(deliveredJpegSize(photo(-800, 600))).toBeNull();
    expect(deliveredJpegSize(photo(800, -600))).toBeNull();
  });

  it("judges the JPEG the portal receives, not the original", () => {
    // 1000×700 → 1000×700 ok; 4000×1800 → 1600×720 ok
    expect(eligibilityFor(je, { ...ok, photos: [photo(1000, 700), photo(4000, 1800)] })).toEqual({ ok: true });
    // 4000×1000 is wide enough as uploaded but delivers 1600×400: too short
    const short = eligibilityFor(je, { ...ok, photos: [photo(4000, 1000), photo(4000, 1000)] });
    if (short.ok) throw new Error("expected failure");
    expect(short.reasons).toEqual(["too_few_photos"]);
    // 700×500 is too small either way round; one acceptable photo is fewer than JamesEdition's two
    const narrow = eligibilityFor(je, { ...ok, photos: [photo(700, 500), SHARP] });
    if (narrow.ok) throw new Error("expected failure");
    expect(narrow.reasons).toEqual(["too_few_photos"]);
  });

  it("judges long and short sides, so a portrait meets 800×600 — the stored size predates the EXIF rotation", () => {
    // a phone photo stored 1024×768 may be delivered 768×1024: either way it passes
    expect(eligibilityFor(je, { ...ok, photos: [photo(600, 800), photo(768, 1024)] })).toEqual({ ok: true });
    // a portrait too narrow on its short side still fails
    const thin = eligibilityFor(je, { ...ok, photos: [photo(590, 1200), SHARP] });
    if (thin.ok) throw new Error("expected failure");
    expect(thin.reasons).toEqual(["too_few_photos"]);
  });

  it("the minimum is inclusive and checked after rounding", () => {
    expect(eligibilityFor(je, { ...ok, photos: [photo(800, 600), photo(800, 600)] })).toEqual({ ok: true });
    // 2400×900 delivers exactly 1600×600; 2400×899 delivers 1600×599
    expect(eligibilityFor(je, { ...ok, photos: [photo(2400, 900), photo(2400, 900)] })).toEqual({ ok: true });
    const r = eligibilityFor(je, { ...ok, photos: [photo(2400, 899), photo(2400, 899)] });
    if (r.ok) throw new Error("expected failure");
    expect(r.reasons).toEqual(["too_few_photos"]);
  });

  it("a photo whose size was never measured counts as accepted — too small would be an invented fact", () => {
    expect(eligibilityFor(je, { ...ok, photos: [photo(null, null), photo(null, null)] })).toEqual({ ok: true });
  });

  it("acceptedPhotoCount filters by the portal's minimum, and counts everything for a portal with none", () => {
    const photos = [photo(1000, 700), photo(4000, 1800), photo(4000, 1000), photo(700, 500), photo(null, null)];
    expect(acceptedPhotoCount(je, photos)).toBe(3);
    expect(acceptedPhotoCount(apits, photos)).toBe(5);
    expect(eligibilityFor(apits, { ...ok, photos: [photo(700, 500)] })).toEqual({ ok: true });
  });

  it("too_few_photos names the size for JamesEdition and no size for A Place in the Sun", () => {
    expect(reasonText(je, "too_few_photos")).toContain("of at least 800×600 px");
    expect(reasonText(apits, "too_few_photos")).not.toMatch(/×|px/);
    expect(reasonText(apits, "too_few_photos")).toContain("Fewer than 1 photo available");
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

describe("advisoriesFor", () => {
  it("warns that JamesEdition's moderation refuses a sale under EUR 450,000", () => {
    const a = advisoriesFor(je, { ...ok, price: 449_999 });
    expect(a).toHaveLength(1);
    expect(a[0]).toMatch(/^JamesEdition's moderation/);
    expect(a[0]).toContain("EUR 450,000");
  });

  it("the floor is per currency and strict: at the floor there is nothing to warn about", () => {
    expect(advisoriesFor(je, { ...ok, price: 450_000 })).toEqual([]);
    expect(advisoriesFor(je, { ...ok, currency: "GBP", price: 399_999 })[0]).toContain("GBP 400,000");
    expect(advisoriesFor(je, { ...ok, currency: "GBP", price: 449_999 })).toEqual([]);
  });

  it("a rental is not a sale: no floor warning", () => {
    expect(advisoriesFor(je, { ...ok, transactionType: "rent", price: 2_000 })).toEqual([]);
  });

  it("a listing with no price gets a reason, not an advisory", () => {
    expect(advisoriesFor(je, { ...ok, price: null })).toEqual([]);
    expect(advisoriesFor(je, { ...ok, price: 0 })).toEqual([]);
  });

  it("sale-or-rent warns that only the sale goes out — on any portal", () => {
    expect(advisoriesFor(je, { ...ok, transactionType: "sale_or_rent", price: 300_000 })).toEqual([
      expect.stringContaining("EUR 450,000"),
      expect.stringMatching(/sale only/),
    ]);
    expect(advisoriesFor(je, { ...ok, transactionType: "sale_or_rent", price: 1_000_000 })).toEqual([
      expect.stringMatching(/sale only/),
    ]);
    expect(advisoriesFor(apits, { ...ok, transactionType: "sale_or_rent", price: 300_000 })).toEqual([
      expect.stringMatching(/sale only/),
    ]);
  });

  it("a portal with no stated moderation has no floor", () => {
    expect(advisoriesFor(apits, { ...ok, price: 50_000 })).toEqual([]);
  });

  it("an advisory never keeps a listing out of the feed", () => {
    const below = { ...ok, price: 300_000 };
    expect(advisoriesFor(je, below)).not.toEqual([]);
    expect(eligibilityFor(je, below)).toEqual({ ok: true });
  });
});

describe("REASON_FIX_TAB", () => {
  it("covers every reason", () => {
    expect(Object.keys(REASON_FIX_TAB).sort()).toEqual([...ALL_REASONS].sort());
  });

  it("a dialect or portal rule has no field on the listing to fix, so no link", () => {
    expect(REASON_FIX_TAB.price_unsupported).toBeNull();
    expect(REASON_FIX_TAB.type_unmapped).toBeNull();
    expect(REASON_FIX_TAB.type_not_accepted).toBeNull();
    expect(REASON_FIX_TAB.city_unmapped).toBeNull();
  });

  // SOURCE DEFECT: REASON_FIX_TAB.currency_unsupported is "details", but no tab
  // holds a currency field — DetailsForm has none, and properties.currency is
  // pinned to EUR by the properties_currency_eur CHECK (0087: "no application
  // path writes anything else"). The Fix link opens a tab with nothing to fix.
  // Drop `.fails` when the table says null.
  it("currency has no desk field either (the column is pinned to EUR), so no link", () => {
    expect(REASON_FIX_TAB.currency_unsupported).toBeNull();
  });

  it("each reason the desk can fix points at the tab holding its field", () => {
    expect(REASON_FIX_TAB.no_price).toBe("details"); // asking_price / rent_price_month
    expect(REASON_FIX_TAB.no_coords).toBe("details"); // the map location fields
    expect(REASON_FIX_TAB.no_location_text).toBe("details"); // area
    expect(REASON_FIX_TAB.no_description_en).toBe("marketing"); // public_description
    expect(REASON_FIX_TAB.too_few_photos).toBe("media");
  });

  // SOURCE DEFECT: REASON_FIX_TAB.not_public is "marketing", but the Status and
  // Visibility selects that make a listing public and available are on the
  // Details tab (components/features/properties/detail-forms.tsx DetailsForm);
  // MarketingForm holds title and descriptions only. Drop `.fails` when fixed.
  it("not_public points at the Details tab, where Status and Visibility are", () => {
    expect(REASON_FIX_TAB.not_public).toBe("details");
  });
});

describe("eligibilityInputFromFeed", () => {
  // Images built here rather than read from the shared fixture, so the
  // adapter's size pass-through is pinned with sizes this test chose.
  const villa = {
    ...SALE_VILLA,
    images: [
      { url: "https://p.example/1_jpeg.jpg", alt: "Front", width: 4000, height: 2667 },
      { url: "https://p.example/2_jpeg.jpg", alt: null, width: null, height: null },
    ],
  };

  it("reads the feed listing: a feed row is public by construction", () => {
    // Updated to the new shape: hasPrice/photoCount became price,
    // transactionType and the photos' original sizes.
    expect(eligibilityInputFromFeed(villa)).toEqual({
      isPublic: true,
      price: 650000,
      transactionType: "sale",
      currency: "EUR",
      descriptionEn: "Detached villa <200 m from the coast> & pool.",
      photos: [
        { width: 4000, height: 2667 },
        { width: null, height: null },
      ],
      coords: { lat: 34.8821, lng: 32.3789, approx: false },
      propertyType: "villa",
      districtEn: "Paphos",
      areaEn: "Peyia",
    });
  });

  it("a rent listing's price is its monthly rent; land has coords null", () => {
    expect(eligibilityInputFromFeed(RENT_FLAT).price).toBe(1400);
    expect(eligibilityInputFromFeed(RENT_FLAT).transactionType).toBe("rent");
    expect(eligibilityInputFromFeed(LAND_PLOT).coords).toBeNull();
  });

  it("the shop fixture is refused by JamesEdition twice over: one photo, and commercial", () => {
    // Updated: before type_not_accepted existed this listed too_few_photos alone.
    const r = eligibilityFor(je, eligibilityInputFromFeed(SHOP_UNIT));
    if (r.ok) throw new Error("expected failure");
    expect(r.reasons).toEqual(["too_few_photos", "type_not_accepted"]);
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
    jpegPhotos: [photo(1600, 1067), photo(null, null), photo(700, 500)],
    coords: null,
  };

  it("reads the page's row; private or reserved is not public", () => {
    expect(eligibilityInputFromProperty(base).isPublic).toBe(true);
    expect(eligibilityInputFromProperty({ ...base, visibility: "private" }).isPublic).toBe(false);
    expect(eligibilityInputFromProperty({ ...base, status: "reserved" }).isPublic).toBe(false);
  });

  it("uses the one price rule: a rental needs its monthly rent", () => {
    // Updated: asserts the price itself rather than a hasPrice flag.
    expect(eligibilityInputFromProperty({ ...base, transaction_type: "rent" }).price).toBeNull();
    expect(eligibilityInputFromProperty({ ...base, transaction_type: "rent", rent_price_month: 900 }).price).toBe(900);
    // sale-or-rent goes out as a sale
    expect(
      eligibilityInputFromProperty({ ...base, transaction_type: "sale_or_rent", rent_price_month: 1500 }).price,
    ).toBe(300000);
  });

  it("reads district and area names from the page's joined JSON", () => {
    const i = eligibilityInputFromProperty({ ...base, areaName: { en: "Tala", el: "Τάλα" } });
    expect(i.districtEn).toBe("Paphos");
    expect(i.areaEn).toBe("Tala");
    expect(eligibilityInputFromProperty(base).areaEn).toBeNull();
  });

  it("passes through what it doesn't compute: photos, currency, type and coords", () => {
    expect(
      eligibilityInputFromProperty({ ...base, coords: { lat: 34.7, lng: 32.4, approx: true } }),
    ).toEqual({
      isPublic: true,
      price: 300000,
      transactionType: "sale",
      currency: "EUR",
      descriptionEn: "Text",
      photos: [photo(1600, 1067), photo(null, null), photo(700, 500)],
      coords: { lat: 34.7, lng: 32.4, approx: true },
      propertyType: "apartment",
      districtEn: "Paphos",
      areaEn: null,
    });
  });

  it("the page's photos keep their sizes, so the card judges them as the feed does", () => {
    // 1600×1067 and the unmeasured photo pass JamesEdition's minimum; 700×500 does not
    expect(acceptedPhotoCount(je, eligibilityInputFromProperty(base).photos)).toBe(2);
  });
});
