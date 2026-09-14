/**
 * The shape every dialect renderer consumes: a `public_listings()` row joined
 * to its `portal_supplement()` row, with absolute JPEG URLs.
 *
 * The row is kept as-is — the site feed's own row — rather than re-mapped
 * into a portal-specific DTO. That is deliberate: a listing being ON a
 * portal feed is then structurally a subset of a listing being on the site
 * feed (the same 36 public columns, nothing more), instead of a rule a
 * renderer author has to remember and could get wrong. The supplement adds
 * only what a portal may see beyond the site feed — coordinates, and only
 * for listings selected for that portal, plus JPEG image paths (the site
 * feed serves WebP).
 */
import type { Database } from "@/lib/supabase/database.types";
import { publicMediaUrl } from "@/lib/services/public-listings";

/** One row of `public_listings()` as `npm run db:types` last wrote it — the site feed's shape. */
export type PublicListingRow = Database["public"]["Functions"]["public_listings"]["Returns"][number];

/** Columns `public_listings()` never returns null for (NOT NULL on `properties`, or coalesced in SQL). */
type NonNullFeedKey =
  | "reference"
  | "kind"
  | "property_type"
  | "transaction_type"
  | "title"
  | "short_description"
  | "adviser_view"
  | "public_description"
  | "currency"
  | "vat_status"
  | "features"
  | "title_deed_status"
  | "updated_at"
  | "images";

/**
 * A feed row with honest nullability. The generated type marks every column
 * non-null because the codegen cannot see NOT NULL through a setof function;
 * in SQL (0088_feed_reference_media_fk_hash.sql lines 57-92, the live definition; images coalesced at line 116) every column outside NonNullFeedKey is nullable —
 * `asking_price` on a rental, `bedrooms` on land, `district` when unset.
 */
export type FeedRow = {
  [K in keyof PublicListingRow]: K extends NonNullFeedKey ? PublicListingRow[K] : PublicListingRow[K] | null;
};

/** One row of `portal_supplement()` (0095): what a portal may see beyond the public feed. */
export interface SupplementRow {
  reference: string;
  lat: number | null;
  lng: number | null;
  location_approx: boolean;
  images: { jpeg: string | null; alt: unknown }[];
}

// Keep SupplementRow hand-declared (honest nullability, typed images); this only pins its KEYS to the generated function.
type GeneratedSupplement = Database["public"]["Functions"]["portal_supplement"]["Returns"][number];
type _SupplementKeysMatch = [keyof SupplementRow] extends [keyof GeneratedSupplement]
  ? [keyof GeneratedSupplement] extends [keyof SupplementRow]
    ? true
    : never
  : never;
const _supplementKeysMatch: _SupplementKeysMatch = true;
void _supplementKeysMatch;

export interface FeedCoords {
  lat: number;
  lng: number;
  /** true → a dialect must not emit these as an exact point (spec §Coordinates) */
  approx: boolean;
}

export interface PortalFeedImage {
  url: string;
  alt: string | null;
}

/** What every dialect renders from. Nothing here is not already public or selected. */
export interface FeedListing {
  row: FeedRow;
  coords: FeedCoords | null;
  images: PortalFeedImage[];
}

export type Lang = "en" | "el" | "ru";

/** The CRM stores `title`, `public_description` etc. as `{en, el, ru}` JSON. */
export function textIn(json: unknown, lang: Lang): string {
  if (!json || typeof json !== "object" || Array.isArray(json)) return "";
  const v = (json as Record<string, unknown>)[lang];
  return typeof v === "string" ? v.trim() : "";
}

/** The one definition of "the price a portal shows": monthly rent for a rental, the asking price otherwise (sale-or-rent goes out as a sale). */
export function feedPrice(
  row: Pick<FeedRow, "transaction_type" | "asking_price" | "rent_price_month">,
): number | null {
  return row.transaction_type === "rent" ? row.rent_price_month : row.asking_price;
}

export function buildFeedListings(
  rows: readonly FeedRow[],
  supplements: readonly SupplementRow[],
  supabaseUrl: string,
): FeedListing[] {
  const byRef = new Map(supplements.map((s) => [s.reference, s]));
  const out: FeedListing[] = [];
  for (const row of rows) {
    const s = byRef.get(row.reference);
    if (!s) continue;
    const coords =
      typeof s.lat === "number" && typeof s.lng === "number"
        ? { lat: s.lat, lng: s.lng, approx: s.location_approx }
        : null;
    const images: PortalFeedImage[] = [];
    for (const img of s.images) {
      const url = publicMediaUrl(supabaseUrl, img.jpeg);
      if (url) images.push({ url, alt: textIn(img.alt, "en") || textIn(img.alt, "ru") || null });
    }
    out.push({ row, coords, images });
  }
  return out;
}
