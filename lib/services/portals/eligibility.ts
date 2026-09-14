import type { Database } from "@/lib/supabase/database.types";
import { DIALECT_CURRENCIES, DIALECT_TYPE_MAPS } from "./dialects";
import { feedPrice, textIn, type FeedCoords, type FeedListing } from "./feed-listing";
import type { PortalDefinition } from "./registry";

type PropertyRow = Database["public"]["Tables"]["properties"]["Row"];

/**
 * Why a listing may or may not go to a portal (spec §Eligibility). ONE
 * function, two consumers: the feed route silently excludes, the property
 * card shows the reasons. `city_unmapped` is reserved for the RERA dialect
 * (milestone 2) and is listed so the desk text exists when it lands.
 */
export type EligibilityReason =
  | "not_public"
  | "no_price"
  | "currency_unsupported"
  | "no_description_en"
  | "too_few_photos"
  | "no_coords"
  | "type_unmapped"
  | "no_location_text"
  | "city_unmapped";

export interface EligibilityInput {
  /** visibility public AND status available — would the site feed show it */
  isPublic: boolean;
  hasPrice: boolean;
  currency: string;
  descriptionEn: string;
  /** photos with a JPEG rendition — what the portal will actually receive */
  photoCount: number;
  coords: FeedCoords | null;
  propertyType: string;
  districtEn: string | null;
  areaEn: string | null;
}

export type Eligibility = { ok: true } | { ok: false; reasons: EligibilityReason[] };

export const REASON_TEXT: Record<EligibilityReason, string> = {
  not_public: "Not on the website: the listing must be public and available.",
  no_price: "No asking price, or no monthly rent for a rental.",
  currency_unsupported: "This portal cannot show the listing's currency.",
  no_description_en: "No English public description.",
  too_few_photos: "Not enough photos available in the format this portal accepts (JPEG).",
  no_coords: "This portal requires map coordinates.",
  type_unmapped: "This portal has no category for this property type.",
  no_location_text: "No district or area name to give the portal as the town.",
  city_unmapped: "This portal does not recognise the listing's town.",
};

/** Desk text with the portal's own numbers filled in, for the two reasons that have them. */
export function reasonText(portal: PortalDefinition, reason: EligibilityReason): string {
  if (reason === "too_few_photos") {
    const n = portal.requirements.minPhotos;
    return `Fewer than ${n} photo${n === 1 ? "" : "s"} available in the format this portal accepts (JPEG).`;
  }
  if (reason === "currency_unsupported") {
    const c = DIALECT_CURRENCIES[portal.dialect];
    return c ? `This portal shows prices only in ${c.join(", ")}.` : REASON_TEXT[reason];
  }
  return REASON_TEXT[reason];
}

const blank = (s: string | null | undefined) => !s || s.trim() === "";

export function eligibilityFor(portal: PortalDefinition, input: EligibilityInput): Eligibility {
  const reasons: EligibilityReason[] = [];
  if (!input.isPublic) reasons.push("not_public");
  if (!input.hasPrice) reasons.push("no_price");
  const currencies = DIALECT_CURRENCIES[portal.dialect];
  if (currencies && !currencies.includes(input.currency)) reasons.push("currency_unsupported");
  if (blank(input.descriptionEn)) reasons.push("no_description_en");
  if (input.photoCount < portal.requirements.minPhotos) reasons.push("too_few_photos");
  if (portal.requirements.needsCoords && !input.coords) reasons.push("no_coords");
  // Object.hasOwn, never `in`: "constructor" in {} is true.
  if (!Object.hasOwn(DIALECT_TYPE_MAPS[portal.dialect], input.propertyType)) reasons.push("type_unmapped");
  if (blank(input.districtEn) && blank(input.areaEn)) reasons.push("no_location_text");
  return reasons.length ? { ok: false, reasons } : { ok: true };
}

/** The feed route's adapter. A `public_listings` row is public by construction. */
export function eligibilityInputFromFeed(l: FeedListing): EligibilityInput {
  const r = l.row;
  return {
    isPublic: true,
    hasPrice: feedPrice(r) != null,
    currency: r.currency,
    descriptionEn: textIn(r.public_description, "en"),
    photoCount: l.images.length,
    coords: l.coords,
    propertyType: r.property_type,
    districtEn: textIn(r.district, "en") || null,
    areaEn: textIn(r.area, "en") || null,
  };
}

/** What `eligibilityInputFromProperty` reads: a slice of `properties.Row` plus what the page computes from it. */
export type PropertyEligibilityInput = Pick<
  PropertyRow,
  | "visibility"
  | "status"
  | "transaction_type"
  | "asking_price"
  | "rent_price_month"
  | "currency"
  | "public_description"
  | "property_type"
> & { districtName: unknown; areaName: unknown; jpegPhotoCount: number; coords: FeedCoords | null };

/** The property page's adapter — from the row the page already holds, plus what it computes. */
export function eligibilityInputFromProperty(p: PropertyEligibilityInput): EligibilityInput {
  return {
    // A deliberate second copy of THE PREDICATE in public_listings (0088, lines 128-132) and
    // portal_supplement (0095): the toggle must answer for rows the feed never sees.
    // supabase/tests/portals.test.ts compares the two against the same row.
    isPublic: p.visibility === "public" && p.status === "available",
    hasPrice: feedPrice(p) != null,
    currency: p.currency,
    descriptionEn: textIn(p.public_description, "en"),
    photoCount: p.jpegPhotoCount,
    coords: p.coords,
    propertyType: p.property_type,
    districtEn: textIn(p.districtName, "en") || null,
    areaEn: textIn(p.areaName, "en") || null,
  };
}
