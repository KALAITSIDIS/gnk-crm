import { DIALECT_CURRENCIES, DIALECT_TYPE_MAPS } from "./dialects";
import { feedPrice, textIn, type FeedCoords, type FeedListing } from "./feed-listing";
import type { PortalDefinition } from "./registry";

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
  /** would the site feed show it: visibility public AND status available */
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
  too_few_photos: "Too few photos with a JPEG rendition for this portal.",
  no_coords: "This portal requires map coordinates.",
  type_unmapped: "This portal has no category for this property type.",
  no_location_text: "No district or area name to give the portal as the town.",
  city_unmapped: "This portal does not recognise the listing's town.",
};

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

/** The property page's adapter — from the row the page already holds. */
export function eligibilityInputFromProperty(p: {
  visibility: string;
  status: string;
  transaction_type: string;
  asking_price: number | null;
  rent_price_month: number | null;
  currency: string;
  public_description: unknown;
  property_type: string;
  districtName: unknown;
  areaName: unknown;
  jpegPhotoCount: number;
  coords: FeedCoords | null;
}): EligibilityInput {
  return {
    isPublic: p.visibility === "public" && p.status === "available",
    hasPrice:
      feedPrice({
        transaction_type: p.transaction_type,
        asking_price: p.asking_price,
        rent_price_month: p.rent_price_month,
      } as Parameters<typeof feedPrice>[0]) != null,
    currency: p.currency,
    descriptionEn: textIn(p.public_description, "en"),
    photoCount: p.jpegPhotoCount,
    coords: p.coords,
    propertyType: p.property_type,
    districtEn: textIn(p.districtName, "en") || null,
    areaEn: textIn(p.areaName, "en") || null,
  };
}
