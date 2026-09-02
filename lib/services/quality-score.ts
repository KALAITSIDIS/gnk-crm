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
 *   planning zone + density instead; CONTAINER: one item worth 15 in place of
 *   both — see below) · exact coords 10 · title-deed status 10 · permit
 *   status 5 · active mandate 10 · assigned agent 5 · owner or developer
 *   linked 5
 *
 * CONTAINERS SCORE DIFFERENTLY (2026-09-02). A project or phase is not a
 * dwelling: units carry the prices, a container cannot be reserved
 * (reservations.ts) and is excluded from buyer matching (queries/matches.ts).
 * Grading it on bedrooms and covered area asked the wrong question and got a
 * wrong answer — a real project was created with NO UNITS, scored 100/100,
 * and went Public on the strength of that score. The two dwelling items
 * (area 10 + rooms/planning 5) are replaced by a single "At least one unit"
 * worth their combined 15, so every branch still totals exactly 100.
 *
 * NOTE the 15 is not enough on its own: an otherwise-complete empty project
 * still reaches 75 (85 before the price item became "Units priced" in the
 * 2026-09-02 review), above PUBLISH_THRESHOLD. The publish gate refuses an
 * empty container separately (lib/actions/properties.ts) — the score informs,
 * the gate enforces. Do not remove one believing the other covers it.
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

// What counts as a unit lives in ONE place (2026-09-02 review): a phase is
// not a unit, and a project's units may sit under its phases. RELATIVE and
// WITH the extension, not "@/": scripts/recompute-scores.mts and the media
// importer load this file under plain Node, which resolves neither a
// tsconfig alias nor an extensionless path — the alias broke both for a day.
import { countContainerUnits } from "./container-units.ts";

export interface QualityScoreInput {
  isLand: boolean;
  /** kind is project or phase — graded on units, not on rooms and area. */
  isContainer: boolean;
  /**
   * Sellable units under the container, directly or through its phases —
   * see container-units.ts for the definition. A threshold like photoCount,
   * so "≥ N" stays free.
   */
  unitCount: number;
  /**
   * Of those, the ones carrying an asking price. A container's "Price set"
   * (2026-09-02 review): the units carry the prices, so grading a project on
   * its own asking price contradicted every line of copy that says so.
   */
  pricedUnitCount?: number;
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
    // A container's price is its units' prices. The container's own
    // asking_price is a "from" figure — informative, not the thing a buyer
    // can act on. Same key, so the worklist groups both under one gap.
    input.isContainer
      ? {
          key: "price",
          label: "Units priced",
          points: 10,
          earned: (input.pricedUnitCount ?? 0) >= 1,
        }
      : { key: "price", label: "Price set", points: 10, earned: input.hasPrice },
    // The dwelling pair — area + rooms/planning, 15 together — or, for a
    // container, the one thing that actually makes it a listing.
    ...(input.isContainer
      ? [
          {
            key: "units",
            label: "At least one unit",
            points: 15,
            earned: input.unitCount >= 1,
          },
        ]
      : [
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
        ]),
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

/**
 * The property columns the score reads, and the three facts that come from
 * elsewhere. Exported so the WORKLIST can build the same input in bulk.
 */
export interface QualityScoreSource {
  property_type: string;
  /** standalone | project | phase | unit — containers are graded on units. */
  kind: string;
  title: unknown;
  public_description: unknown;
  asking_price: number | string | null;
  rent_price_month: number | string | null;
  covered_area_sqm: number | string | null;
  plot_area_sqm: number | string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  planning_zone_code: string | null;
  building_density_pct: number | string | null;
  location: unknown;
  location_approx: boolean | null;
  title_deed_status: string;
  permit_status: string;
  assigned_agent_id: string | null;
  owner_contact_id: string | null;
  developer_contact_id: string | null;
}

/**
 * Build the score input from a row plus its media and mandate facts.
 *
 * ONE DEFINITION, TWO CALLERS. `recomputeQualityScore` scores a single property
 * from three per-property queries; the worklist scores a whole list from three
 * queries TOTAL. If each built its own input they would drift, and the drift
 * would be invisible — a worklist saying "12 missing coordinates" while the
 * detail pages disagree is worse than no worklist, because it looks
 * authoritative. Every rule lives here.
 */
export function buildQualityInput(
  p: QualityScoreSource,
  facts: {
    hasCoverPhoto: boolean;
    photoCount: number;
    mandateActive: boolean;
    /** Sellable units under a container — only read for containers. */
    unitCount?: number;
    /** …of which priced — only read for containers. */
    pricedUnitCount?: number;
  },
): QualityScoreInput {
  const isLand = p.property_type === "land";
  const isContainer = p.kind === "project" || p.kind === "phase";
  return {
    isLand,
    isContainer,
    unitCount: facts.unitCount ?? 0,
    pricedUnitCount: facts.pricedUnitCount ?? 0,
    hasCoverPhoto: facts.hasCoverPhoto,
    photoCount: facts.photoCount,
    titleEn: (p.title as { en?: string } | null)?.en,
    publicDescriptionEn: (p.public_description as { en?: string } | null)?.en,
    hasPrice: p.asking_price !== null || p.rent_price_month !== null,
    hasArea: isLand ? p.plot_area_sqm !== null : p.covered_area_sqm !== null,
    hasBedroomsAndBathrooms: p.bedrooms !== null && p.bathrooms !== null,
    hasPlanningZoneAndDensity:
      p.planning_zone_code !== null && p.building_density_pct !== null,
    // 0054: a centroid taken as a stand-in is NOT an exact map location. Ten
    // points for a coordinate nobody surveyed would make this score a lie.
    hasCoords: p.location !== null && !p.location_approx,
    titleDeedSet: p.title_deed_status !== "unknown",
    permitSet: p.permit_status !== "unknown",
    mandateActive: facts.mandateActive,
    hasAssignedAgent: p.assigned_agent_id !== null,
    hasOwnerOrDeveloper: p.owner_contact_id !== null || p.developer_contact_id !== null,
  };
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
        `property_type, kind, title, public_description, asking_price, rent_price_month,
         covered_area_sqm, plot_area_sqm, bedrooms, bathrooms, planning_zone_code,
         building_density_pct, location, location_approx, title_deed_status, permit_status, quality_score,
         assigned_agent_id, owner_contact_id, developer_contact_id`,
      )
      .eq("id", propertyId)
      .maybeSingle(),
    // photos only (MEDIA-K): a floor plan must not inflate the photo score
    supabase
      .from("property_media")
      .select("id, is_cover")
      .eq("property_id", propertyId)
      .eq("kind", "photo"),
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

  // Containers are graded on units (2026-09-02) — the ONE definition, which
  // reaches through phases and ignores archived units (container-units.ts).
  const isContainer = p.kind === "project" || p.kind === "phase";
  const units = isContainer
    ? await countContainerUnits(supabase, propertyId)
    : { unitCount: 0, pricedUnitCount: 0 };

  const result = computeQualityScore(
    buildQualityInput(p as unknown as QualityScoreSource, {
      hasCoverPhoto: (media ?? []).some((m) => m.is_cover),
      photoCount: (media ?? []).length,
      unitCount: units.unitCount,
      pricedUnitCount: units.pricedUnitCount,
      mandateActive: (mandates ?? []).length > 0,
    }),
  );

  if (persist && result.score !== p.quality_score) {
    await supabase
      .from("properties")
      .update({ quality_score: result.score })
      .eq("id", propertyId);
  }
  return result;
}

/**
 * A unit landed, changed or was archived: the STORED score of everything
 * above it is stale (2026-09-02 review). The list and the CSV read the
 * column, the detail page computes live, and the two disagreed for any
 * container whose units were generated rather than edited. Recomputes the
 * parent and, when the parent is a phase, the project above it.
 */
export async function refreshContainerScores(
  supabase: Client,
  parentId: string | null | undefined,
): Promise<void> {
  if (!parentId) return;
  const { data: parent } = await supabase
    .from("properties")
    .select("kind, parent_id")
    .eq("id", parentId)
    .maybeSingle();
  await recomputeQualityScore(supabase, parentId);
  if (parent?.kind === "phase" && parent.parent_id) {
    await recomputeQualityScore(supabase, parent.parent_id);
  }
}
