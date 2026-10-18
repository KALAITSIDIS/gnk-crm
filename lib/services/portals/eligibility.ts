import type { Database } from "@/lib/supabase/database.types";
import { DIALECT_CURRENCIES, DIALECT_MAX_PRICE, DIALECT_TYPE_MAPS } from "./dialects";
import { feedPrice, textIn, type FeedCoords, type FeedListing } from "./feed-listing";
import type { PortalDefinition } from "./registry";

type PropertyRow = Database["public"]["Tables"]["properties"]["Row"];

/**
 * Why a listing may or may not go to a portal (spec §Eligibility). ONE
 * function, three consumers: the feed route silently excludes, the property
 * card shows the reasons, and Settings → Portals lists every selected listing
 * a portal is not receiving. `city_unmapped` is reserved for the RERA dialect
 * and is listed so the desk text exists when it lands.
 *
 * REASONS keep a listing OUT of the document. ADVISORIES (advisoriesFor,
 * below) are what the portal's own moderation may refuse AFTER it receives
 * the listing — the CRM never hears about that refusal, so it says so in
 * advance rather than letting "in the feed" read as "published".
 */
export type EligibilityReason =
  | "not_public"
  | "no_price"
  | "price_unsupported"
  | "currency_unsupported"
  | "no_description_en"
  | "too_few_photos"
  | "no_coords"
  | "type_unmapped"
  | "type_not_accepted"
  | "no_location_text"
  | "city_unmapped";

/**
 * One prepared photograph: its ORIGINAL pixel size (property_media.width /
 * height), from which the JPEG the portal receives is derived. Null when the
 * row predates the measurement — an unknown size is never counted as too
 * small, which would invent a fact.
 */
export interface PhotoSize {
  width: number | null;
  height: number | null;
}

export interface EligibilityInput {
  /** visibility public AND status available — would the site feed show it */
  isPublic: boolean;
  /** feedPrice(): the monthly rent for a rental, the asking price otherwise */
  price: number | null;
  transactionType: string;
  currency: string;
  descriptionEn: string;
  /** photos with a JPEG rendition — what the portal will actually receive */
  photos: readonly PhotoSize[];
  coords: FeedCoords | null;
  propertyType: string;
  districtEn: string | null;
  areaEn: string | null;
}

export type Eligibility = { ok: true } | { ok: false; reasons: EligibilityReason[] };

export const REASON_TEXT: Record<EligibilityReason, string> = {
  not_public: "Not on the website: the listing must be public and available.",
  no_price: "No asking price, or no monthly rent for a rental.",
  price_unsupported: "This portal cannot carry a price this large.",
  currency_unsupported: "This portal cannot show the listing's currency.",
  no_description_en: "No English public description.",
  too_few_photos: "Not enough photos available in the format this portal accepts (JPEG).",
  no_coords: "This portal requires map coordinates.",
  type_unmapped: "This portal has no category for this property type.",
  type_not_accepted: "This portal does not accept this kind of property.",
  no_location_text: "No district or area name to give the portal as the town.",
  city_unmapped: "This portal does not recognise the listing's town.",
};

/**
 * The JPEG rendition's width (lib/services/media.ts RENDITIONS, `jpeg`):
 * resized to this width WITHOUT enlargement. Restated here rather than
 * imported so eligibility does not drag sharp into everything that reads it;
 * eligibility.test.ts pins the two together.
 */
export const JPEG_RENDITION_WIDTH = 1600;

/** The size of the JPEG a portal receives for a photo of this original size; null when unknown. */
export function deliveredJpegSize(p: PhotoSize): { width: number; height: number } | null {
  if (!p.width || !p.height || p.width <= 0 || p.height <= 0) return null;
  const width = Math.min(JPEG_RENDITION_WIDTH, p.width);
  return { width, height: Math.round((p.height * width) / p.width) };
}

/**
 * Whether the portal accepts this photo's JPEG: always, unless it states a
 * minimum size — then the delivered JPEG's LONG side must reach the minimum's
 * long side and its SHORT side the minimum's short side (800×600 accepts a
 * 600×800 portrait).
 *
 * WHY LONG AND SHORT, not width and height: the stored size is sharp's header
 * size, taken BEFORE the EXIF rotation the pipeline applies (media.ts
 * `.rotate()`), so a phone photo stored 1024×768 may be delivered 768×1024.
 * Comparing sides is exact for every photo up to 1600 px either way round
 * (no scaling); only a rotated photo wider than 1600 px with an extreme
 * aspect ratio can be judged on the wrong scaling — and a genuine 4000×1000
 * panorama, delivered 1600×400, is still refused, as the portal would.
 */
export function photoMeetsMinimum(portal: PortalDefinition, p: PhotoSize): boolean {
  const min = portal.requirements.minImage;
  if (!min) return true;
  const size = deliveredJpegSize(p);
  if (size === null) return true;
  return (
    Math.max(size.width, size.height) >= Math.max(min.width, min.height) &&
    Math.min(size.width, size.height) >= Math.min(min.width, min.height)
  );
}

/** How many of these photos the portal will accept (photoMeetsMinimum). */
export function acceptedPhotoCount(portal: PortalDefinition, photos: readonly PhotoSize[]): number {
  return photos.filter((p) => photoMeetsMinimum(portal, p)).length;
}

/** Desk text with the portal's own numbers filled in, for the reasons that have them. */
export function reasonText(portal: PortalDefinition, reason: EligibilityReason): string {
  if (reason === "too_few_photos") {
    const n = portal.requirements.minPhotos;
    const min = portal.requirements.minImage;
    const size = min ? ` of at least ${min.width}×${min.height} px` : "";
    return `Fewer than ${n} photo${n === 1 ? "" : "s"}${size} available in the format this portal accepts (JPEG).`;
  }
  if (reason === "currency_unsupported") {
    const c = DIALECT_CURRENCIES[portal.dialect];
    return c ? `This portal shows prices only in ${c.join(", ")}.` : REASON_TEXT[reason];
  }
  if (reason === "price_unsupported") {
    const max = DIALECT_MAX_PRICE[portal.dialect];
    return max != null ? `This portal cannot carry a price above ${max.toLocaleString("en-GB")}.` : REASON_TEXT[reason];
  }
  if (reason === "type_not_accepted" && portal.requirements.excludedTypesNote) {
    return portal.requirements.excludedTypesNote;
  }
  return REASON_TEXT[reason];
}

/**
 * Where on the property page the desk fixes each reason (`?tab=`), or null
 * when nothing on the listing can fix it (a dialect or portal rule).
 */
export const REASON_FIX_TAB: Record<EligibilityReason, "details" | "marketing" | "media" | null> = {
  // Status and Visibility are on the Details tab (detail-forms.tsx DetailsForm)
  not_public: "details",
  no_price: "details",
  price_unsupported: null,
  // no form edits currency: 0087 pins the column to EUR
  currency_unsupported: null,
  no_description_en: "marketing",
  too_few_photos: "media",
  no_coords: "details",
  type_unmapped: null,
  type_not_accepted: null,
  no_location_text: "details",
  city_unmapped: null,
};

const blank = (s: string | null | undefined) => !s || s.trim() === "";

export function eligibilityFor(portal: PortalDefinition, input: EligibilityInput): Eligibility {
  const reasons: EligibilityReason[] = [];
  if (!input.isPublic) reasons.push("not_public");
  // A price of 0 is not a price: the advert would read as free. Not positive,
  // not finite → no price.
  const hasPrice = input.price != null && Number.isFinite(input.price) && input.price > 0;
  if (!hasPrice) reasons.push("no_price");
  const maxPrice = DIALECT_MAX_PRICE[portal.dialect];
  if (hasPrice && maxPrice != null && Math.round(input.price!) > maxPrice) reasons.push("price_unsupported");
  const currencies = DIALECT_CURRENCIES[portal.dialect];
  if (currencies && !currencies.includes(input.currency)) reasons.push("currency_unsupported");
  if (blank(input.descriptionEn)) reasons.push("no_description_en");
  if (acceptedPhotoCount(portal, input.photos) < portal.requirements.minPhotos) reasons.push("too_few_photos");
  if (portal.requirements.needsCoords && !input.coords) reasons.push("no_coords");
  // Object.hasOwn, never `in`: "constructor" in {} is true.
  if (!Object.hasOwn(DIALECT_TYPE_MAPS[portal.dialect], input.propertyType)) reasons.push("type_unmapped");
  else if (portal.requirements.excludedPropertyTypes?.includes(input.propertyType)) reasons.push("type_not_accepted");
  if (blank(input.districtEn) && blank(input.areaEn)) reasons.push("no_location_text");
  return reasons.length ? { ok: false, reasons } : { ok: true };
}

/**
 * What the portal may still refuse once it has the listing — its moderation,
 * which the CRM never hears back from — and what the format cannot carry.
 * Never a reason to keep the listing out of the feed.
 */
export function advisoriesFor(portal: PortalDefinition, input: EligibilityInput): string[] {
  const out: string[] = [];
  const floor = portal.moderation?.minSalePrice?.[input.currency];
  if (
    floor != null &&
    input.transactionType !== "rent" &&
    input.price != null &&
    input.price > 0 &&
    input.price < floor
  ) {
    out.push(
      `${portal.name}'s moderation refuses sale listings under ${input.currency} ${floor.toLocaleString("en-GB")}, so it may not publish this one.`,
    );
  }
  if (input.transactionType === "sale_or_rent") {
    out.push("Goes out as a sale only: a portal advert carries one price, so the monthly rent is not sent.");
  }
  return out;
}

/** The feed route's adapter. A `public_listings` row is public by construction. */
export function eligibilityInputFromFeed(l: FeedListing): EligibilityInput {
  const r = l.row;
  return {
    isPublic: true,
    price: feedPrice(r),
    transactionType: r.transaction_type,
    currency: r.currency,
    descriptionEn: textIn(r.public_description, "en"),
    photos: l.images.map((i) => ({ width: i.width, height: i.height })),
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
> & { districtName: unknown; areaName: unknown; jpegPhotos: readonly PhotoSize[]; coords: FeedCoords | null };

/** The property page's adapter — from the row the page already holds, plus what it computes. */
export function eligibilityInputFromProperty(p: PropertyEligibilityInput): EligibilityInput {
  return {
    // A deliberate second copy of THE PREDICATE in public_listings (0088, lines 128-132) and
    // portal_feed_supplement (0150): the toggle must answer for rows the feed never sees.
    // supabase/tests/portals.test.ts compares the two against the same row.
    isPublic: p.visibility === "public" && p.status === "available",
    price: feedPrice(p),
    transactionType: p.transaction_type,
    currency: p.currency,
    descriptionEn: textIn(p.public_description, "en"),
    photos: p.jpegPhotos,
    coords: p.coords,
    propertyType: p.property_type,
    districtEn: textIn(p.districtName, "en") || null,
    areaEn: textIn(p.areaName, "en") || null,
  };
}
