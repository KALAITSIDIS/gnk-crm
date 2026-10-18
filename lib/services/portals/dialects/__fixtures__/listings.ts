import type { FeedListing, FeedRow, PortalFeedImage } from "@/lib/services/portals/feed-listing";

/**
 * Fixtures of the shape production writes (memory: "an assertion that can
 * only fail rarely is not coverage"). Dates are fixed: no clock in a golden.
 *
 * `features` holds KEYS (lib/constants/features.ts), because that is what the
 * property form stores in `properties.features` and what `public_listings()`
 * returns. An earlier version of this file held the English labels
 * ("Private pool"), which made the renderer look right while production fed
 * Kyero the raw keys ("private_pool").
 *
 * Every listing in ALL carries a `revisionAt` and a `url`: that is the steady
 * production state — the assembler synced the export revisions (0150
 * portal_export_state) and PUBLIC_SITE_URL is set. The fallbacks (no revision,
 * no site address) are pinned case by case in kyero.test.ts. A revision is
 * spelled the way Postgres writes a timestamptz into jsonb: microseconds with
 * trailing zeros trimmed, explicit offset.
 */
const base = (over: Partial<FeedRow>): FeedRow => ({
  reference: "PAF0001",
  kind: "standalone",
  property_type: "villa",
  transaction_type: "sale",
  title: { en: "Sea-view villa in Peyia", el: "Βίλα με θέα", ru: "Вилла с видом на море" },
  short_description: { en: "Three-bed villa" },
  adviser_view: {},
  public_description: {
    en: "Detached villa <200 m from the coast> & pool.",
    el: "Μονοκατοικία κοντά στη θάλασσα.",
    ru: "Отдельная вилла у моря.",
  },
  district: { en: "Paphos", el: "Πάφος", ru: "Пафос" },
  area: { en: "Peyia", el: "Πέγεια", ru: "Пейя" },
  sea_distance_m: 200,
  currency: "EUR",
  asking_price: 650000,
  rent_price_month: null,
  vat_status: "resale_no_vat",
  covered_area_sqm: 210,
  plot_area_sqm: 780,
  veranda_sqm: 40,
  roof_garden_sqm: null,
  basement_sqm: null,
  bedrooms: 3,
  bathrooms: 2,
  wc: 1,
  parking_spaces: 2,
  has_storage: true,
  floor_number: null,
  total_floors: 2,
  year_built: 2016,
  energy_class: "B",
  features: ["private_pool", "sea_view"],
  title_deed_status: "separate",
  construction_status: null,
  delivery_date: null,
  published_at: "2026-09-01T10:00:00+00:00",
  updated_at: "2026-09-10T08:30:15+00:00",
  images: [],
  ...over,
});

/**
 * A photo as the assembler builds it from the supplement: the JPEG
 * rendition's absolute URL and the ORIGINAL photo's pixel size
 * (property_media.width / height, 0150) — 2400×1600 by default, comfortably
 * above JamesEdition's 800×600 once scaled to the 1600-wide rendition.
 */
export const img = (n: number, width: number | null = 2400, height: number | null = 1600): PortalFeedImage => ({
  url: `https://p.supabase.co/storage/v1/object/public/media/properties/p1/${n}_jpeg.jpg`,
  alt: n === 1 ? "Front elevation" : null,
  width,
  height,
});

/** The listing's page on the public website, as site-url.ts builds it once PUBLIC_SITE_URL is set. */
export const siteUrl = (reference: string) => `https://www.example.com/properties/${reference}`;

/** Sale villa, three languages, exact coordinates, two photos, private pool, declared resale. */
export const SALE_VILLA: FeedListing = {
  row: base({}),
  coords: { lat: 34.8821, lng: 32.3789, approx: false },
  images: [img(1), img(2)],
  revisionAt: "2026-09-10T08:41:02.318204+00:00",
  url: siteUrl("PAF0001"),
};

/**
 * Rent apartment, English only, a two-line description (the property form's
 * textarea keeps the desk's line break), communal pool, one photo.
 *
 * The location is approximate WITH numbers. 0150's supplement already nulls
 * an approximate point, so production hands the renderer `coords: null`; the
 * numbers are kept here on purpose, as the defence-in-depth case
 * `FeedCoords.approx` exists for (buildFeedListings still accepts it).
 */
export const RENT_FLAT: FeedListing = {
  row: base({
    reference: "PAF0002",
    property_type: "apartment",
    transaction_type: "rent",
    title: { en: "Two-bed apartment, Kato Paphos" },
    public_description: { en: "Furnished, second floor, lift.\nCommunal pool and covered parking." },
    area: { en: "Kato Paphos" },
    asking_price: null,
    rent_price_month: 1400,
    covered_area_sqm: 85,
    plot_area_sqm: null,
    bedrooms: 2,
    bathrooms: 1,
    floor_number: 2,
    total_floors: 4,
    year_built: 2009,
    energy_class: null,
    features: ["communal_pool", "furnished", "air_conditioning", "elevator", "covered_parking"],
    updated_at: "2026-09-11T12:00:00+00:00",
  }),
  coords: { lat: 34.75, lng: 32.41, approx: true },
  images: [img(1)],
  revisionAt: "2026-09-11T12:15:47.000913+00:00",
  url: siteUrl("PAF0002"),
};

/** Land: plot only, no bedrooms, no coordinates, no features; a declared resale that still sends no new_build (no dwelling). */
export const LAND_PLOT: FeedListing = {
  row: base({
    reference: "PAF0003",
    property_type: "land",
    title: { en: "Residential plot, Tala" },
    public_description: { en: "Plot with planning zone Ka6." },
    area: { en: "Tala" },
    asking_price: 180000,
    covered_area_sqm: null,
    plot_area_sqm: 1200,
    veranda_sqm: null,
    bedrooms: null,
    bathrooms: null,
    wc: null,
    parking_spaces: null,
    has_storage: null,
    total_floors: null,
    year_built: null,
    energy_class: null,
    features: [],
    updated_at: "2026-09-12T09:00:00+00:00",
  }),
  coords: null,
  images: [img(1)],
  revisionAt: "2026-09-12T09:20:00.5+00:00",
  url: siteUrl("PAF0003"),
};

/** Sale-or-rent with both prices: goes out once, as a sale. A first, VAT-bearing supply: a new build. */
export const SALE_OR_RENT: FeedListing = {
  row: base({
    reference: "PAF0004",
    property_type: "townhouse",
    transaction_type: "sale_or_rent",
    asking_price: 320000,
    rent_price_month: 1600,
    vat_status: "new_vat",
    year_built: 2025,
    features: ["communal_pool", "garden", "air_conditioning", "solar_water_heater"],
    updated_at: "2026-09-12T10:00:00+00:00",
  }),
  coords: { lat: 34.77, lng: 32.43, approx: false },
  images: [img(1), img(2)],
  revisionAt: "2026-09-12T10:05:31.77402+00:00",
  url: siteUrl("PAF0004"),
};

/**
 * Commercial unit: shop with covered area only, no bedrooms, energy class B+
 * (folds to B), one photo. Its revision is OLDER than `updated_at`: the desk
 * edited something the portal does not receive after the last change it does,
 * which is exactly why the feed's date is the revision and not the row's.
 */
export const SHOP_UNIT: FeedListing = {
  row: base({
    reference: "PAF0005",
    property_type: "shop",
    title: { en: "Corner shop, Kato Paphos" },
    public_description: { en: "Ground-floor retail unit with frontage." },
    area: { en: "Kato Paphos" },
    asking_price: 240000,
    covered_area_sqm: 60,
    plot_area_sqm: null,
    veranda_sqm: null,
    bedrooms: null,
    bathrooms: null,
    wc: 1,
    parking_spaces: null,
    has_storage: null,
    total_floors: null,
    year_built: 2001,
    energy_class: "B+",
    features: [],
    updated_at: "2026-09-12T11:00:00+00:00",
  }),
  coords: { lat: 34.76, lng: 32.42, approx: false },
  images: [img(1)],
  revisionAt: "2026-09-02T07:30:00.12+00:00",
  url: siteUrl("PAF0005"),
};

/**
 * Order and length are pinned by the Kyero golden; appending a fixture means
 * regenerating it with UPDATE_GOLDEN=1 and reading the diff.
 */
export const ALL = [SALE_VILLA, RENT_FLAT, LAND_PLOT, SALE_OR_RENT, SHOP_UNIT];

/** As the settings form saves them (registry.ts kyeroSettingsFormSchema accepts a `+` number). */
export const KYERO_SETTINGS = {
  contact_number: "+357 26 000000",
  whatsapp_number: "+357 99 000000",
  email: "sales@example.com",
};
