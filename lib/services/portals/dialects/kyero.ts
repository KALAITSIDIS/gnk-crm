import { textIn, type FeedListing } from "@/lib/services/portals/feed-listing";
import { kyeroSettingsSchema, type KyeroSettings } from "@/lib/services/portals/registry";
import type { DialectRenderer } from "./index";
import { XML_HEADER, tag } from "./xml";

/**
 * Kyero XML v3.9 (help.kyero.com/estate-agents/xml-import-specification,
 * 2024-09-03). The lingua franca: JamesEdition, A Place in the Sun, Properstar
 * and the UK feed providers all ingest it. Absolute feed, all lowercase tags,
 * UTF-8, ≤ 50 photos, `date` drives updates, absence means removal.
 */
export const KYERO_TYPES: Readonly<Record<string, string>> = {
  apartment: "Apartment",
  villa: "Villa",
  townhouse: "Town House",
  house: "House",
  land: "Land",
  shop: "Commercial",
  office: "Commercial",
  warehouse: "Commercial",
  building: "Building",
  hotel: "Hotel",
};

export const KYERO_CURRENCIES = ["EUR", "GBP", "USD"] as const;

const MAX_IMAGES = 50;

/** `2026-09-10T08:30:15+00:00` → `2026-09-10 08:30:15` (UTC; Kyero wants a wall-clock string). */
function kyeroDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 19).replace("T", " ");
}

function renderProperty(l: FeedListing, s: KyeroSettings): string {
  const r = l.row;
  const isRent = r.transaction_type === "rent";
  const price = isRent ? r.rent_price_month : r.asking_price;
  // filter first, then gate: a features array holding only blanks is no feature
  // at all, and `<features></features>` would be a container with no children.
  const features = r.features.filter((f) => f.trim());
  const children = [
    tag("id", r.reference),
    tag("date", kyeroDate(r.updated_at)),
    tag("ref", r.reference),
    tag("price", price == null ? null : Math.round(price)),
    tag("currency", r.currency),
    tag("price_freq", isRent ? "month" : "sale"),
    tag("type", KYERO_TYPES[r.property_type] ?? null),
    tag("town", textIn(r.area, "en") || textIn(r.district, "en")),
    tag("province", textIn(r.district, "en")),
    tag("country", "Cyprus"),
    l.coords && !l.coords.approx
      ? tag("location", [tag("latitude", l.coords.lat), tag("longitude", l.coords.lng)])
      : null,
    tag("beds", r.bedrooms),
    tag("baths", r.bathrooms),
    tag("surface_area", [
      tag("built", r.covered_area_sqm == null ? null : Math.round(r.covered_area_sqm)),
      tag("plot", r.plot_area_sqm == null ? null : Math.round(r.plot_area_sqm)),
    ]),
    r.energy_class ? tag("energy_rating", [tag("consumption", r.energy_class)]) : null,
    tag("desc", [tag("en", textIn(r.public_description, "en")), tag("ru", textIn(r.public_description, "ru"))]),
    features.length ? tag("features", features.map((f) => tag("feature", f))) : null,
    tag(
      "images",
      l.images.slice(0, MAX_IMAGES).map((img, i) => tag("image", [tag("url", img.url)], { id: i + 1 })),
    ),
    tag("contact_number", s.contact_number),
    tag("whatsapp_number", s.whatsapp_number),
    tag("email", s.email),
  ];
  return tag("property", children);
}

const HEADER = tag("kyero", [tag("feed_version", 3)]);

export const kyero: DialectRenderer = {
  contentType: "application/xml; charset=utf-8",
  render(listings, settings) {
    const s = kyeroSettingsSchema.parse(settings);
    const body = listings.map((l) => renderProperty(l, s)).join("\n");
    return `${XML_HEADER}<root>\n${HEADER}\n${body}\n</root>\n`;
  },
  empty() {
    return `${XML_HEADER}<root>\n${HEADER}\n</root>\n`;
  },
};
