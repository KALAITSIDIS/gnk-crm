import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Property Quality Score (doc 02 §A8 + §C1). Computed in app code on every
 * property save; stored in properties.quality_score. Publishing to visibility
 * `public` is blocked below PUBLISH_THRESHOLD unless an admin override is
 * logged (event property.publish_override).
 *
 * Weights (total 100):
 *   cover photo 10 · ≥6 photos 15 · title EN 5 · public description EN ≥300
 *   chars 10 · price 10 · covered/plot area 10 · bedrooms+bathrooms 5 (land:
 *   planning zone + density instead) · exact coords 10 · title-deed status 10
 *   · permit status 5 · active mandate 10
 */

export const PUBLISH_THRESHOLD = 70;

export interface QualityScoreInput {
  isLand: boolean;
  hasCoverPhoto: boolean;
  photoCount: number;
  titleEn: string | null | undefined;
  publicDescriptionEn: string | null | undefined;
  hasPrice: boolean;
  hasArea: boolean; // covered area (non-land) or plot area (land)
  hasBedroomsAndBathrooms: boolean;
  hasPlanningZoneAndDensity: boolean;
  hasCoords: boolean;
  titleDeedSet: boolean; // status ≠ unknown
  permitSet: boolean; // status ≠ unknown
  mandateActive: boolean;
}

export interface QualityScoreItem {
  key: string;
  label: string;
  points: number;
  earned: boolean;
}

export interface QualityScoreResult {
  score: number;
  items: QualityScoreItem[];
  missing: QualityScoreItem[];
}

export function computeQualityScore(input: QualityScoreInput): QualityScoreResult {
  const items: QualityScoreItem[] = [
    { key: "cover", label: "Cover photo", points: 10, earned: input.hasCoverPhoto },
    { key: "photos6", label: "At least 6 photos", points: 15, earned: input.photoCount >= 6 },
    {
      key: "title_en",
      label: "English title",
      points: 5,
      earned: Boolean(input.titleEn && input.titleEn.trim().length > 0),
    },
    {
      key: "description_en",
      label: "English description ≥ 300 chars",
      points: 10,
      earned: Boolean(
        input.publicDescriptionEn && input.publicDescriptionEn.trim().length >= 300,
      ),
    },
    { key: "price", label: "Price set", points: 10, earned: input.hasPrice },
    {
      key: "area",
      label: input.isLand ? "Plot area set" : "Covered area set",
      points: 10,
      earned: input.hasArea,
    },
    input.isLand
      ? {
          key: "planning",
          label: "Planning zone + building density",
          points: 5,
          earned: input.hasPlanningZoneAndDensity,
        }
      : {
          key: "rooms",
          label: "Bedrooms + bathrooms",
          points: 5,
          earned: input.hasBedroomsAndBathrooms,
        },
    { key: "coords", label: "Exact map location", points: 10, earned: input.hasCoords },
    { key: "deed", label: "Title deed status known", points: 10, earned: input.titleDeedSet },
    { key: "permit", label: "Permit status known", points: 5, earned: input.permitSet },
    { key: "mandate", label: "Active mandate", points: 10, earned: input.mandateActive },
  ];

  const score = items.reduce((sum, item) => sum + (item.earned ? item.points : 0), 0);
  return { score, items, missing: items.filter((i) => !i.earned) };
}

type Client = SupabaseClient<Database>;

/** Fetch everything the score needs, compute, and persist quality_score. */
export async function recomputeQualityScore(
  supabase: Client,
  propertyId: string,
): Promise<QualityScoreResult | null> {
  const [{ data: p }, { data: media }, { data: mandates }] = await Promise.all([
    supabase
      .from("properties")
      .select(
        `property_type, title, public_description, asking_price, rent_price_month,
         covered_area_sqm, plot_area_sqm, bedrooms, bathrooms, planning_zone_code,
         building_density_pct, location, title_deed_status, permit_status, quality_score`,
      )
      .eq("id", propertyId)
      .maybeSingle(),
    supabase.from("property_media").select("id, is_cover").eq("property_id", propertyId),
    // mandates_safe, not the base table: listing managers have no base-table
    // SELECT, so reading `mandates` here scored their saves 10 points low
    supabase
      .from("mandates_safe")
      .select("id")
      .eq("property_id", propertyId)
      .eq("status", "active"),
  ]);
  if (!p) return null;

  const isLand = p.property_type === "land";
  const result = computeQualityScore({
    isLand,
    hasCoverPhoto: (media ?? []).some((m) => m.is_cover),
    photoCount: (media ?? []).length,
    titleEn: (p.title as { en?: string } | null)?.en,
    publicDescriptionEn: (p.public_description as { en?: string } | null)?.en,
    hasPrice: p.asking_price !== null || p.rent_price_month !== null,
    hasArea: isLand ? p.plot_area_sqm !== null : p.covered_area_sqm !== null,
    hasBedroomsAndBathrooms: p.bedrooms !== null && p.bathrooms !== null,
    hasPlanningZoneAndDensity:
      p.planning_zone_code !== null && p.building_density_pct !== null,
    hasCoords: p.location !== null,
    titleDeedSet: p.title_deed_status !== "unknown",
    permitSet: p.permit_status !== "unknown",
    mandateActive: (mandates ?? []).length > 0,
  });

  if (result.score !== p.quality_score) {
    await supabase
      .from("properties")
      .update({ quality_score: result.score })
      .eq("id", propertyId);
  }
  return result;
}
