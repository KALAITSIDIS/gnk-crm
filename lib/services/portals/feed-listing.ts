/**
 * The shape every dialect renderer consumes: a `public_listings()` row joined
 * to its `portal_feed_supplement()` row, with absolute JPEG URLs.
 *
 * The row is kept as-is — the site feed's own row — rather than re-mapped
 * into a portal-specific DTO. That is deliberate: a listing being ON a
 * portal feed is then structurally a subset of a listing being on the site
 * feed (the same 36 public columns, nothing more), instead of a rule a
 * renderer author has to remember and could get wrong. The supplement adds
 * only what a portal may see beyond the site feed — coordinates, and only
 * for listings selected for that portal, plus JPEG image paths (the site
 * feed serves WebP) with each photo's original pixel size.
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

export interface SupplementImage {
  jpeg: string | null;
  alt: unknown;
  /** the ORIGINAL photo's pixel size (property_media.width / height); null when never measured */
  width: number | null;
  height: number | null;
}

/** One row of `portal_feed_supplement()` (0150): what a portal may see beyond the public feed. */
export interface SupplementRow {
  reference: string;
  lat: number | null;
  lng: number | null;
  location_approx: boolean;
  images: SupplementImage[];
}

// Keep SupplementRow hand-declared (honest nullability, typed images); this only pins its KEYS to the generated function.
type GeneratedSupplement = Database["public"]["Functions"]["portal_feed_supplement"]["Returns"][number];
type _SupplementKeysMatch = [keyof SupplementRow] extends [keyof GeneratedSupplement]
  ? [keyof GeneratedSupplement] extends [keyof SupplementRow]
    ? true
    : never
  : never;
const _supplementKeysMatch: _SupplementKeysMatch = true;
void _supplementKeysMatch;

const isFiniteOrNull = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isFinite(v));
const isPositiveIntOrNull = (v: unknown): v is number | null =>
  v === null || v === undefined || (typeof v === "number" && Number.isInteger(v) && v > 0);

/**
 * The supplement as the database actually answered it, CHECKED — or null when
 * any row is not the shape 0150 returns. The generated type is a promise the
 * codegen makes, not one the wire keeps: a hollow, re-routed or skewed answer
 * must become a refusal (503), never rows with no reference that silently
 * select nothing — which is an empty feed, which a portal reads as "withdraw
 * everything".
 */
export function parseSupplementRows(data: unknown): SupplementRow[] | null {
  if (!Array.isArray(data)) return null;
  const out: SupplementRow[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.reference !== "string" || r.reference === "") return null;
    if (!isFiniteOrNull(r.lat) || !isFiniteOrNull(r.lng)) return null;
    if (typeof r.location_approx !== "boolean") return null;
    if (!Array.isArray(r.images)) return null;
    const images: SupplementImage[] = [];
    for (const img of r.images) {
      if (!img || typeof img !== "object") return null;
      const i = img as Record<string, unknown>;
      if (i.jpeg !== null && typeof i.jpeg !== "string") return null;
      if (!isPositiveIntOrNull(i.width) || !isPositiveIntOrNull(i.height)) return null;
      images.push({
        jpeg: (i.jpeg as string | null) ?? null,
        alt: i.alt ?? null,
        width: (i.width as number | null | undefined) ?? null,
        height: (i.height as number | null | undefined) ?? null,
      });
    }
    out.push({ reference: r.reference, lat: r.lat, lng: r.lng, location_approx: r.location_approx, images });
  }
  return out;
}

/**
 * A page of `public_listings()` checked for the one thing the assembler keys
 * on — a string reference on every row — or null. A row without one would be
 * a listing the scan can never find, reported as "missing" and served as an
 * empty or short feed.
 */
export function parseListingRows(data: unknown): FeedRow[] | null {
  if (!Array.isArray(data)) return null;
  for (const raw of data) {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.reference !== "string" || r.reference === "") return null;
    if (typeof r.updated_at !== "string") return null;
    if (!Array.isArray(r.features)) return null;
  }
  return data as FeedRow[];
}

export interface FeedCoords {
  lat: number;
  lng: number;
  /** true → a dialect must not emit these as an exact point (spec §Coordinates) */
  approx: boolean;
}

export interface PortalFeedImage {
  url: string;
  alt: string | null;
  /** the ORIGINAL photo's size — what the portal's minimum is checked against (eligibility.ts) */
  width: number | null;
  height: number | null;
}

/** What every dialect renders from. Nothing here is not already public or selected. */
export interface FeedListing {
  row: FeedRow;
  coords: FeedCoords | null;
  images: PortalFeedImage[];
  /**
   * When what this portal receives for the listing last changed
   * (0150 portal_export_state) — the dialect's update date. Null until the
   * assembler has synced it; a renderer then falls back to `row.updated_at`.
   */
  revisionAt: string | null;
  /** the listing's page on the public website, when the site's address is configured (site-url.ts) */
  url: string | null;
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
  listingUrl: (reference: string) => string | null = () => null,
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
      if (url) {
        images.push({
          url,
          alt: textIn(img.alt, "en") || textIn(img.alt, "ru") || null,
          width: img.width,
          height: img.height,
        });
      }
    }
    out.push({ row, coords, images, revisionAt: null, url: listingUrl(row.reference) });
  }
  return out;
}
