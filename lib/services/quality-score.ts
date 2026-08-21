import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Property Quality Score (doc 02 §A8 + §C1). Computed in app code on every
 * property save; stored in properties.quality_score. Publishing to visibility
 * `public` is blocked below PUBLISH_THRESHOLD unless an admin override is
 * logged (event property.publish_override).
 *
 * Weights (total 100):
 *   cover photo 5 · ≥6 photos 10 · title EN 5 · public description EN ≥300
 *   chars 10 · price 10 · covered/plot area 10 · bedrooms+bathrooms 5 (land:
 *   planning zone + density instead) · exact coords 10 · title-deed status 10
 *   · permit status 5 · active mandate 10 · assigned agent 5 · owner or
 *   developer linked 5
 *
 * REBALANCED 2026-08-21 (BACKLOG audit finding 15). Two responsibility items
 * were added and paid for out of imagery, which carried 25 of the 100 points —
 * more than any other dimension — across two items that overlap almost
 * completely, since a listing cannot have six photos without a cover. Imagery
 * now carries 15, still joint-largest. Nothing about price, location or legal
 * status was weakened to pay for this.
 *
 * The two new items were deliberately NOT added before now: `assigned_agent_id`
 * and the party columns had no way in until findings 1 and 2 shipped, and a
 * score item for a field nobody can fill is a permanent deduction rather than a
 * prompt.
 *
 * CHANGING A WEIGHT MAKES EVERY STORED `quality_score` STALE. The detail page
 * computes fresh on render, but the list and the CSV read the column, so the
 * two would disagree until each property was next saved. `npm run
 * recompute:scores` exists for exactly this.
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
  /** somebody is responsible for this listing (also what RLS reads) */
  hasAssignedAgent: boolean;
  /** a private owner, a developer, or both */
  hasOwnerOrDeveloper: boolean;
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
    { key: "cover", label: "Cover photo", points: 5, earned: input.hasCoverPhoto },
    { key: "photos6", label: "At least 6 photos", points: 10, earned: input.photoCount >= 6 },
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
    // Who is responsible for it, and whose it is (audit finding 15). Both were
    // unfillable until findings 1 and 2 shipped.
    { key: "agent", label: "Agent assigned", points: 5, earned: input.hasAssignedAgent },
    {
      key: "party",
      label: "Owner or developer linked",
      points: 5,
      earned: input.hasOwnerOrDeveloper,
    },
  ];

  const score = items.reduce((sum, item) => sum + (item.earned ? item.points : 0), 0);
  return { score, items, missing: items.filter((i) => !i.earned) };
}

type Client = SupabaseClient<Database>;

/**
 * Fetch everything the score needs, compute, and persist quality_score.
 *
 * `persist: false` computes and returns without writing — what a dry run needs.
 * The alternative was a caller that writes and then restores, which is not a
 * dry run at all and leaves a wrong score behind if it dies mid-loop.
 *
 * `mandateSource` exists because the two callers need OPPOSITE tables and each
 * is blind to the other's:
 *
 *   * The app reads `mandates_safe`. Listing managers have no base-table
 *     SELECT, so reading `mandates` scored their saves 10 points low — that is
 *     the bug the view was introduced to fix.
 *   * A script running as `service_role` reads NOTHING through the view: its
 *     WHERE tests `current_org_id()` and `current_role_gnk()`, which are null
 *     outside a user session, so every property with an active mandate scores
 *     10 points low instead. Caught by a dry run before it wrote anything.
 *
 * There is no single source that is right for both, so the caller says which.
 * The default is the app's.
 */
export async function recomputeQualityScore(
  supabase: Client,
  propertyId: string,
  options: { persist?: boolean; mandateSource?: "view" | "base" } = {},
): Promise<QualityScoreResult | null> {
  const persist = options.persist ?? true;

  const [{ data: p }, { data: media }, { data: mandates }] = await Promise.all([
    supabase
      .from("properties")
      .select(
        `property_type, title, public_description, asking_price, rent_price_month,
         covered_area_sqm, plot_area_sqm, bedrooms, bathrooms, planning_zone_code,
         building_density_pct, location, title_deed_status, permit_status, quality_score,
         assigned_agent_id, owner_contact_id, developer_contact_id`,
      )
      .eq("id", propertyId)
      .maybeSingle(),
    supabase.from("property_media").select("id, is_cover").eq("property_id", propertyId),
    // see `mandateSource` above — neither table is right for both callers.
    // Branched rather than parameterised: Supabase infers the row type from a
    // LITERAL table name, and a variable collapses it (same trap as a built
    // select string).
    options.mandateSource === "base"
      ? supabase
          .from("mandates")
          .select("id")
          .eq("property_id", propertyId)
          .eq("status", "active")
      : supabase
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
    hasAssignedAgent: p.assigned_agent_id !== null,
    hasOwnerOrDeveloper: p.owner_contact_id !== null || p.developer_contact_id !== null,
  });

  if (persist && result.score !== p.quality_score) {
    await supabase
      .from("properties")
      .update({ quality_score: result.score })
      .eq("id", propertyId);
  }
  return result;
}
