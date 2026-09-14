import { describe, expect, it } from "vitest";
import { buildFeedListings, textIn, type PublicListingRow, type SupplementRow } from "./feed-listing";

const row = (reference: string): PublicListingRow =>
  ({
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
  }) as unknown as PublicListingRow;

const sup = (reference: string, extra: Partial<SupplementRow> = {}): SupplementRow => ({
  reference,
  lat: 34.88,
  lng: 32.38,
  location_approx: false,
  images: [{ jpeg: "properties/x/1_jpeg.jpg", alt: { en: "Front" } }],
  ...extra,
});

describe("textIn", () => {
  it("reads a language from the CRM's {en, el, ru} JSON and trims", () => {
    expect(textIn({ en: "  Hi ", ru: "Привет" }, "en")).toBe("Hi");
    expect(textIn({ en: "Hi" }, "ru")).toBe("");
    expect(textIn(null, "en")).toBe("");
    expect(textIn("not an object", "en")).toBe("");
  });
});

describe("buildFeedListings", () => {
  it("joins rows to supplements by reference, absolutises JPEG paths, keeps row order", () => {
    const out = buildFeedListings([row("B"), row("A")], [sup("A"), sup("B")], "https://p.supabase.co/");
    expect(out.map((l) => l.row.reference)).toEqual(["B", "A"]);
    expect(out[0].images[0]).toEqual({
      url: "https://p.supabase.co/storage/v1/object/public/media/properties/x/1_jpeg.jpg",
      alt: "Front",
    });
  });

  it("drops a row with no supplement — it was not selected", () => {
    expect(buildFeedListings([row("A")], [], "https://p")).toEqual([]);
  });

  it("an approximate location yields coords with approx=true; a missing one yields null", () => {
    const [approx] = buildFeedListings([row("A")], [sup("A", { location_approx: true })], "https://p");
    expect(approx.coords).toEqual({ lat: 34.88, lng: 32.38, approx: true });
    const [none] = buildFeedListings([row("A")], [sup("A", { lat: null, lng: null })], "https://p");
    expect(none.coords).toBeNull();
  });
});
