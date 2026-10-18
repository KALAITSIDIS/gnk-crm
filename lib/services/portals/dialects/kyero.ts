import { featureLabel } from "@/lib/constants/features";
import { feedPrice, textIn, type FeedListing } from "@/lib/services/portals/feed-listing";
import { internationalPhoneDigits } from "@/lib/services/portals/phone";
import { kyeroSettingsSchema, type KyeroSettings } from "@/lib/services/portals/registry";
import type { DialectRenderer } from "./types";
import { XML_HEADER, escapeXml, tag } from "./xml";

/**
 * Kyero XML v3.9 (help.kyero.com/estate-agents/xml-import-specification,
 * 2024-09-03; the annotated feeds.kyero.com/assets/kyero_v3_import_spec.txt
 * and kyeroV3.0.xsd, read 2026-10-18). The lingua franca: JamesEdition, A
 * Place in the Sun, Properstar and the UK feed providers all ingest it.
 * Absolute feed, all lowercase tags, UTF-8, ≤ 50 photos and ≤ 50 features,
 * `date` drives updates ("if the date does not change, we will not update the
 * property"), absence means removal.
 *
 * LAYOUT. One element per line: Kyero's parser has a single-line character
 * limit (unpublished) and its sample feed puts every tag on its own line. A
 * value never carries a raw line break — a description's breaks go out as
 * `&#13;`, Kyero's own spelling, and every other text has them folded to a
 * space.
 *
 * ONLY WHAT THE CRM STATES. `pool` is emitted when the listing's features say
 * private or communal pool, never "0" for a pool nobody ticked (a missing tag
 * is Kyero's "unknown"). `new_build` says exactly what the public website
 * says (newBuild, below), and nothing where the site says nothing. `url`
 * only when PUBLIC_SITE_URL tells the CRM where the website
 * is. VAT, delivery dates, floor plans (internal by decision, A07), video and
 * virtual tours (no field holds them) are not sent: Kyero has no node for the
 * first two, and the CRM holds nothing for the rest.
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

/** Kyero's <consumption> takes a plain A–G letter; Cyprus's "B+" folds to B, anything else is omitted. */
const KYERO_ENERGY: Readonly<Record<string, string>> = {
  A: "A",
  "B+": "B",
  B: "B",
  C: "C",
  D: "D",
  E: "E",
  F: "F",
  G: "G",
};

export const KYERO_CURRENCIES = ["EUR", "GBP", "USD"] as const;

const MAX_IMAGES = 50;
const MAX_FEATURES = 50;
/** Kyero: "max 35 characters … No line breaks or punctuation" per feature. */
const MAX_FEATURE_LENGTH = 35;

/** Construction statuses that mean the dwelling is not built yet (validators/properties.ts CONSTRUCTION_STATUSES). */
const OFF_PLAN = new Set([
  "planning",
  "permit_applied",
  "permit_granted",
  "under_construction",
  "structure_complete",
  "finishing",
]);

/** `2026-09-10T08:30:15+00:00` → `2026-09-10 08:30:15` (UTC; Kyero wants a wall-clock string). */
function kyeroDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 19).replace("T", " ");
}

/** Six decimals (~0.1 m): within Kyero's 15-character limit, and finer than any survey the CRM holds. */
const coordinate = (v: number) => Math.round(v * 1e6) / 1e6;

/** Every text but the description: a line break inside a value is folded to one space. */
const oneLine = (v: string | null | undefined) => (v ?? "").replace(/[\r\n]+/g, " ").trim();

/** A feature key as the English words Kyero translates from (lib/constants/features.ts). */
function featureWords(key: string): string {
  return featureLabel(key)
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_FEATURE_LENGTH)
    .trim();
}

/**
 * Kyero's new_build, stated exactly as far as the public website states it
 * (gnk-web lib/format.ts vatLabel / isUnderConstruction), and no further:
 *   - `new_vat` is "New build — VAT applies" on the site → 1;
 *   - `resale_no_vat` is "Resale" on the site → 0;
 *   - a dwelling still being built (an off-plan stage, no build year — a stage
 *     left stale on a finished villa is exactly what the year catches) → 1;
 *   - otherwise nothing: `reduced_rate_eligible` is a claim about the BUYER
 *     the site withholds, and `unknown` is an internal sentinel.
 * Never for land (no dwelling) or a rental (Kyero: sale only).
 */
function newBuild(r: FeedListing["row"]): string | null {
  if (r.transaction_type === "rent" || r.property_type === "land") return null;
  if (r.vat_status === "new_vat") return "1";
  if (r.vat_status === "resale_no_vat") return "0";
  return !r.year_built && r.construction_status && OFF_PLAN.has(r.construction_status) ? "1" : null;
}

const PAD = "  ";
const line = (depth: number, s: string) => (s ? `${PAD.repeat(depth)}${s}` : "");

/** A container with each child on its own line; nothing at all when no child survives. */
function block(depth: number, name: string, children: readonly string[], attrs = ""): string {
  const kept = children.filter((c) => c !== "");
  if (!kept.length) return "";
  return `${PAD.repeat(depth)}<${name}${attrs}>\n${kept.join("\n")}\n${PAD.repeat(depth)}</${name}>`;
}

/** A description as Kyero takes it: escaped, with its line breaks as `&#13;`. */
function descText(depth: number, lang: string, text: string): string {
  if (!text) return "";
  return line(depth, tag(lang, [escapeXml(text).replace(/\r\n|\r|\n/g, "&#13;")]));
}

function renderProperty(l: FeedListing, s: KyeroSettings, withDate: boolean): string {
  const r = l.row;
  const price = feedPrice(r);
  const keys = [...new Set(r.features.filter((f) => f.trim()))];
  const features = [...new Set(keys.map(featureWords).filter(Boolean))].slice(0, MAX_FEATURES);
  // the form writes private_pool / communal_pool; the importer's own template
  // writes the plain word (docs/samples/properties_import.csv)
  const pool = keys.some((k) => k === "private_pool" || k === "communal_pool" || k.trim().toLowerCase() === "pool")
    ? "1"
    : null;
  const built = r.covered_area_sqm == null ? null : Math.round(r.covered_area_sqm);
  const plot = r.plot_area_sqm == null ? null : Math.round(r.plot_area_sqm);
  const energy = KYERO_ENERGY[r.energy_class ?? ""];
  const images = l.images.slice(0, MAX_IMAGES);
  const exactPoint = l.coords && !l.coords.approx ? l.coords : null;
  const d = 2;
  const children = [
    // identity and price
    line(1, tag("id", r.reference)),
    withDate ? line(1, tag("date", kyeroDate(l.revisionAt ?? r.updated_at))) : "",
    line(1, tag("ref", r.reference)),
    line(1, tag("price", price == null ? null : Math.round(price))),
    line(1, tag("currency", r.currency)),
    line(1, tag("price_freq", r.transaction_type === "rent" ? "month" : "sale")),
    line(1, tag("new_build", newBuild(r))),
    line(1, tag("type", KYERO_TYPES[r.property_type] ?? null)),
    // location — an approximate point is never emitted as coordinates
    line(1, tag("town", oneLine(textIn(r.area, "en") || textIn(r.district, "en")))),
    line(1, tag("province", oneLine(textIn(r.district, "en") || textIn(r.area, "en")))),
    line(1, tag("country", "Cyprus")),
    exactPoint
      ? block(1, "location", [
          line(d, tag("latitude", coordinate(exactPoint.lat))),
          line(d, tag("longitude", coordinate(exactPoint.lng))),
        ])
      : "",
    // size and amenities
    line(1, tag("beds", r.bedrooms)),
    line(1, tag("baths", r.bathrooms)),
    line(1, tag("pool", pool)),
    block(1, "surface_area", [line(d, tag("built", built)), line(d, tag("plot", plot))]),
    energy ? block(1, "energy_rating", [line(d, tag("consumption", energy))]) : "",
    // the listing on the agency's own website
    l.url ? block(1, "url", [line(d, tag("en", l.url))]) : "",
    // text — Kyero has no Greek node
    block(1, "desc", [
      descText(d, "en", textIn(r.public_description, "en")),
      descText(d, "ru", textIn(r.public_description, "ru")),
    ]),
    block(1, "features", features.map((f) => line(d, tag("feature", f)))),
    // media, cover first (0150 orders them)
    block(
      1,
      "images",
      images.map((img, i) => block(d, "image", [line(d + 1, tag("url", img.url))], ` id="${i + 1}"`)),
    ),
    // contact, from the portal's settings — Kyero wants 00 + country code, digits only
    line(1, tag("contact_number", internationalPhoneDigits(s.contact_number))),
    line(1, tag("whatsapp_number", internationalPhoneDigits(s.whatsapp_number))),
    line(1, tag("email", oneLine(s.email))),
  ];
  return block(0, "property", children);
}

const HEADER = block(0, "kyero", [line(1, tag("feed_version", 3))]);

export const kyero: DialectRenderer = {
  contentType: "application/xml; charset=utf-8",
  render(listings, settings) {
    const s = kyeroSettingsSchema.parse(settings);
    const body = listings.map((l) => renderProperty(l, s, true)).join("\n");
    return `${XML_HEADER}<root>\n${HEADER}\n${body}\n</root>\n`;
  },
  fingerprint(listing, settings) {
    return renderProperty(listing, kyeroSettingsSchema.parse(settings), false);
  },
  empty() {
    return `${XML_HEADER}<root>\n${HEADER}\n</root>\n`;
  },
};
