import { describe, expect, it } from "vitest";
import {
  buildFeedListings,
  feedPrice,
  parseListingRows,
  parseSupplementRows,
  textIn,
  type FeedRow,
  type SupplementRow,
} from "./feed-listing";

const row = (reference: string): FeedRow => ({
  reference,
  kind: "standalone",
  property_type: "villa",
  transaction_type: "sale",
  title: { en: "Villa" },
  short_description: {},
  adviser_view: {},
  public_description: { en: "Sea views" },
  district: { en: "Paphos" },
  area: { en: "Peyia" },
  sea_distance_m: 800,
  currency: "EUR",
  asking_price: 450000,
  rent_price_month: null,
  vat_status: "resale_no_vat",
  covered_area_sqm: 180,
  plot_area_sqm: 600,
  veranda_sqm: null,
  roof_garden_sqm: null,
  basement_sqm: null,
  bedrooms: 3,
  bathrooms: 2,
  wc: null,
  parking_spaces: 2,
  has_storage: null,
  floor_number: null,
  total_floors: null,
  year_built: 2015,
  energy_class: "B",
  features: ["pool"],
  title_deed_status: "separate",
  construction_status: null,
  delivery_date: null,
  published_at: "2026-09-01T10:00:00+00:00",
  updated_at: "2026-09-10T08:30:00+00:00",
  images: [],
});

const sup = (reference: string, extra: Partial<SupplementRow> = {}): SupplementRow => ({
  reference,
  lat: 34.88,
  lng: 32.38,
  location_approx: false,
  images: [{ jpeg: "properties/x/1_jpeg.jpg", alt: { en: "Front" }, width: 4000, height: 3000 }],
  ...extra,
});

/** One supplement row exactly as 0150 portal_feed_supplement puts it on the wire. */
const wireSupplement = () => ({
  reference: "PAF0001",
  lat: 34.8821,
  lng: 32.3789,
  location_approx: false,
  images: [
    { jpeg: "properties/p1/1_jpeg.jpg", alt: { en: "Front" }, width: 4000, height: 3000 },
    { jpeg: "properties/p1/2_jpeg.jpg", alt: null, width: null, height: null },
  ],
});

/** Swap one image's field on an otherwise valid answer. */
const withImage = (patch: Record<string, unknown>) => {
  const w = wireSupplement();
  return [{ ...w, images: [{ ...w.images[0], ...patch }] }];
};

describe("textIn", () => {
  it("reads a language from the CRM's {en, el, ru} JSON and trims", () => {
    expect(textIn({ en: "  Hi ", ru: "Привет" }, "en")).toBe("Hi");
    expect(textIn({ en: "Hi" }, "ru")).toBe("");
    expect(textIn(null, "en")).toBe("");
    expect(textIn("not an object", "en")).toBe("");
  });
});

describe("feedPrice", () => {
  it("takes the monthly rent for a rental and the asking price otherwise, sale-or-rent included", () => {
    const priced = (over: Partial<FeedRow>) => feedPrice({ ...row("A"), ...over });
    expect(priced({ transaction_type: "rent", asking_price: 450000, rent_price_month: 1400 })).toBe(1400);
    expect(priced({ transaction_type: "sale", asking_price: 450000, rent_price_month: 1400 })).toBe(450000);
    expect(priced({ transaction_type: "sale_or_rent", asking_price: 450000, rent_price_month: 1400 })).toBe(450000);
    expect(priced({ transaction_type: "rent", asking_price: 450000, rent_price_month: null })).toBeNull();
  });
});

/**
 * The supplement decides WHICH listings a portal receives. A hollow or skewed
 * answer that slipped through as rows without references would select
 * nothing — an empty feed, which a portal reads as "withdraw everything" — so
 * the whole answer is refused (null → the route's 503), never trimmed.
 */
describe("parseSupplementRows", () => {
  it("accepts 0150's answer and keeps every field, unmeasured photos as null", () => {
    expect(parseSupplementRows([wireSupplement()])).toEqual([wireSupplement()]);
  });

  it("an empty array is a legitimate answer (nothing selected), not a refusal", () => {
    expect(parseSupplementRows([])).toEqual([]);
  });

  it("refuses an answer that is not an array", () => {
    for (const data of [null, undefined, {}, "[]", 0, { data: [wireSupplement()] }]) {
      expect(parseSupplementRows(data), JSON.stringify(data)).toBeNull();
    }
  });

  it("refuses a row that is not an object", () => {
    expect(parseSupplementRows([wireSupplement(), null])).toBeNull();
    expect(parseSupplementRows(["PAF0001"])).toBeNull();
  });

  it("refuses a row without a string reference — one bad row refuses the whole answer", () => {
    const { reference: _drop, ...noReference } = wireSupplement();
    void _drop;
    for (const bad of [noReference, { ...wireSupplement(), reference: 1 }, { ...wireSupplement(), reference: "" }]) {
      expect(parseSupplementRows([wireSupplement(), bad]), JSON.stringify(bad)).toBeNull();
    }
  });

  it("refuses a location_approx that is not a boolean", () => {
    for (const v of ["false", null, undefined, 0]) {
      expect(parseSupplementRows([{ ...wireSupplement(), location_approx: v }]), String(v)).toBeNull();
    }
  });

  it("refuses coordinates that are not finite numbers or null", () => {
    expect(parseSupplementRows([{ ...wireSupplement(), lat: "34.88" }])).toBeNull();
    expect(parseSupplementRows([{ ...wireSupplement(), lng: Number.POSITIVE_INFINITY }])).toBeNull();
    expect(parseSupplementRows([{ ...wireSupplement(), lat: null, lng: null }])).not.toBeNull();
  });

  it("refuses images that are not an array", () => {
    for (const v of [null, undefined, {}, "[]"]) {
      expect(parseSupplementRows([{ ...wireSupplement(), images: v }]), String(v)).toBeNull();
    }
  });

  it("refuses an image that is not an object, or whose jpeg is neither a string nor null", () => {
    const w = wireSupplement();
    expect(parseSupplementRows([{ ...w, images: [null] }])).toBeNull();
    expect(parseSupplementRows([{ ...w, images: ["properties/p1/1_jpeg.jpg"] }])).toBeNull();
    expect(parseSupplementRows(withImage({ jpeg: 5 }))).toBeNull();
    expect(parseSupplementRows(withImage({ jpeg: { path: "x" } }))).toBeNull();
    // a photo whose rendition is missing is still the supplement's shape
    expect(parseSupplementRows(withImage({ jpeg: null }))).not.toBeNull();
  });

  it("refuses a width or height that is not a positive integer", () => {
    // the size decides whether JamesEdition (800×600) receives the photo; a
    // wrong-typed size must not pass as "unknown, so accepted"
    for (const v of [0, -800, 1600.5, "1600", Number.NaN, true]) {
      expect(parseSupplementRows(withImage({ width: v })), `width ${String(v)}`).toBeNull();
      expect(parseSupplementRows(withImage({ height: v })), `height ${String(v)}`).toBeNull();
    }
  });

  it("accepts a null width and height — a photo measured before 0150 is unknown, not invalid", () => {
    const [r] = parseSupplementRows(withImage({ width: null, height: null }))!;
    expect(r!.images[0]).toEqual({ jpeg: "properties/p1/1_jpeg.jpg", alt: { en: "Front" }, width: null, height: null });
  });
});

describe("parseListingRows", () => {
  it("accepts a page of public_listings rows and returns them as they are", () => {
    const page = [row("A"), row("B")];
    expect(parseListingRows(page)).toBe(page);
    expect(parseListingRows([])).toEqual([]);
  });

  it("refuses a page that is not an array", () => {
    for (const data of [null, undefined, {}, "[]"]) expect(parseListingRows(data), String(data)).toBeNull();
  });

  it("refuses a row without a string reference — the scan could never find it", () => {
    const { reference: _drop, ...noReference } = row("A");
    void _drop;
    expect(parseListingRows([row("B"), noReference])).toBeNull();
    expect(parseListingRows([{ ...row("A"), reference: "" }])).toBeNull();
    expect(parseListingRows([{ ...row("A"), reference: 7 }])).toBeNull();
    expect(parseListingRows([null])).toBeNull();
  });

  it("refuses a row without a string updated_at — the fallback date of every listing", () => {
    expect(parseListingRows([{ ...row("A"), updated_at: null }])).toBeNull();
    const { updated_at: _drop, ...noDate } = row("A");
    void _drop;
    expect(parseListingRows([noDate])).toBeNull();
  });

  it("refuses a row whose features are not an array", () => {
    expect(parseListingRows([{ ...row("A"), features: null }])).toBeNull();
    expect(parseListingRows([{ ...row("A"), features: "pool" }])).toBeNull();
  });
});

describe("buildFeedListings", () => {
  it("joins rows to supplements by reference, absolutises JPEG paths, keeps row order", () => {
    const out = buildFeedListings([row("B"), row("A")], [sup("A"), sup("B")], "https://p.supabase.co/");
    expect(out.map((l) => l.row.reference)).toEqual(["B", "A"]);
    // updated for 0150: each image now carries the original photo's size too
    expect(out[0]!.images[0]).toEqual({
      url: "https://p.supabase.co/storage/v1/object/public/media/properties/x/1_jpeg.jpg",
      alt: "Front",
      width: 4000,
      height: 3000,
    });
  });

  it("carries each photo's width and height through, null when unmeasured", () => {
    const [l] = buildFeedListings(
      [row("A")],
      [
        sup("A", {
          images: [
            { jpeg: "p/1_jpeg.jpg", alt: null, width: 1200, height: 900 },
            { jpeg: "p/2_jpeg.jpg", alt: null, width: null, height: null },
          ],
        }),
      ],
      "https://p",
    );
    expect(l!.images.map((i) => [i.width, i.height])).toEqual([
      [1200, 900],
      [null, null],
    ]);
  });

  it("takes each listing's website page from listingUrl, by its own reference; null without one", () => {
    const asked: string[] = [];
    const out = buildFeedListings([row("A"), row("B")], [sup("A"), sup("B")], "https://p", (ref) => {
      asked.push(ref);
      return ref === "A" ? `https://site.example/properties/${ref}` : null;
    });
    expect(asked).toEqual(["A", "B"]);
    expect(out.map((l) => l.url)).toEqual(["https://site.example/properties/A", null]);
    const [plain] = buildFeedListings([row("A")], [sup("A")], "https://p");
    expect(plain!.url).toBeNull();
  });

  it("leaves revisionAt null — only the assembler's sync dates a listing", () => {
    const [l] = buildFeedListings([row("A")], [sup("A")], "https://p");
    expect(l!.revisionAt).toBeNull();
  });

  it("drops a row with no supplement — it was not selected", () => {
    expect(buildFeedListings([row("A")], [], "https://p")).toEqual([]);
  });

  it("an approximate location yields coords with approx=true; a missing one yields null", () => {
    const [approx] = buildFeedListings([row("A")], [sup("A", { location_approx: true })], "https://p");
    expect(approx!.coords).toEqual({ lat: 34.88, lng: 32.38, approx: true });
    const [none] = buildFeedListings([row("A")], [sup("A", { lat: null, lng: null })], "https://p");
    expect(none!.coords).toBeNull();
  });

  it("what portal_feed_supplement actually sends for an approximate listing (0150 withholds the point): approx=true with null lat/lng yields no coords", () => {
    const [withheld] = buildFeedListings(
      [row("A")],
      [sup("A", { lat: null, lng: null, location_approx: true })],
      "https://p",
    );
    expect(withheld!.coords).toBeNull();
  });

  it("an exact location yields approx=false — the coordinate-privacy rule's other half", () => {
    const [exact] = buildFeedListings([row("A")], [sup("A", { location_approx: false })], "https://p");
    expect(exact!.coords).toEqual({ lat: 34.88, lng: 32.38, approx: false });
  });

  it("half a coordinate is no coordinate", () => {
    const [half] = buildFeedListings([row("A")], [sup("A", { lng: null })], "https://p");
    expect(half!.coords).toBeNull();
  });

  it("keeps image order, drops images without a JPEG, and falls back en → ru → null for alt", () => {
    const [l] = buildFeedListings(
      [row("A")],
      [
        sup("A", {
          images: [
            { jpeg: "p/1_jpeg.jpg", alt: { en: "Front" }, width: 2000, height: 1500 },
            { jpeg: null, alt: { en: "No jpeg yet" }, width: 2000, height: 1500 },
            { jpeg: "p/3_jpeg.jpg", alt: { ru: "Сад" }, width: 2000, height: 1500 },
            { jpeg: "p/4_jpeg.jpg", alt: { en: "   " }, width: 2000, height: 1500 },
          ],
        }),
      ],
      "https://p",
    );
    expect(l!.images.map((i) => i.url.split("/media/")[1])).toEqual(["p/1_jpeg.jpg", "p/3_jpeg.jpg", "p/4_jpeg.jpg"]);
    expect(l!.images.map((i) => i.alt)).toEqual(["Front", "Сад", null]);
  });
});
