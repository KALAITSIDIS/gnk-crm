import type { Database } from "@/lib/supabase/database.types";
import { publicMediaUrl } from "@/lib/services/public-listings";

/** One row of `public_listings()` as `npm run db:types` last wrote it — the site feed's shape. */
export type PublicListingRow = Database["public"]["Functions"]["public_listings"]["Returns"][number];

/** One row of `portal_supplement()` (0095): what a portal may see beyond the public feed. */
export interface SupplementRow {
  reference: string;
  lat: number | null;
  lng: number | null;
  location_approx: boolean;
  images: { jpeg: string | null; alt: unknown }[];
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
}

/** What every dialect renders from. Nothing here is not already public or selected. */
export interface FeedListing {
  row: PublicListingRow;
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

export function buildFeedListings(
  rows: readonly PublicListingRow[],
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
    for (const img of s.images ?? []) {
      const url = publicMediaUrl(supabaseUrl, img.jpeg);
      if (url) images.push({ url, alt: textIn(img.alt, "en") || null });
    }
    out.push({ row, coords, images });
  }
  return out;
}
