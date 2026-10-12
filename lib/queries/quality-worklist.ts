import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { fetchAll } from "@/lib/supabase/fetch-all";
import {
  buildQualityInput,
  computeQualityScore,
  type QualityScoreSource,
} from "@/lib/services/quality-score";
import { buildWorklist, type ScoredProperty, type Worklist } from "@/lib/services/quality-worklist";
import { tallyContainerUnits } from "@/lib/services/container-units";
import { sharedPhotoReferences } from "@/lib/services/shared-photos";
import { RETIRED_PROPERTY_VISIBILITY } from "@/lib/validators/properties";

/**
 * Score every live listing and aggregate what they are missing.
 *
 * TWO PAGED READS FOR THE WHOLE LIST, not three per property. `recomputeQualityScore`
 * makes three round trips for ONE property, which is right when saving one and
 * ruinous across a portfolio — sixty units would be a hundred and eighty
 * queries. The facts it needs per property (cover photo, photo count, active
 * mandate) ride with each live listing in one read (T-worklist-id-lists).
 *
 * `mandates_safe`, NOT `mandates`, for the same reason the app path uses it: a
 * listing manager has no base-table SELECT, so reading `mandates` would score
 * their properties ten points low and put every one of them in the "Active
 * mandate" bucket. This runs as the signed-in user, so the view is correct.
 *
 * NOTHING IS PERSISTED. The scores here are computed fresh for display and the
 * stored `quality_score` column is untouched — this is a report, and a report
 * that quietly rewrites what it reports on is not one. (It also means the
 * numbers can differ from the column if a weight changed without
 * `npm run recompute:scores` having been run; that is a pre-existing condition
 * this surfaces rather than causes.)
 */

/** Statuses still worth completing. A sold listing needs no more photos. */
const LIVE_STATUSES = ["draft", "available", "reserved", "under_offer"] as const;

export async function fetchQualityWorklist(
  supabase: SupabaseClient<Database>,
): Promise<Worklist> {
  // TWO paged reads of the listings (T-worklist-id-lists). Paged, because
  // PostgREST caps a select at 1000 rows SILENTLY and a worklist that quietly
  // forgot the tail of the portfolio would report it complete (2026-09-02
  // fix-wave review); fetchAll (lib/supabase/fetch-all.ts) is the shared loop.
  //
  // 1. The LIVE listings — the ones scored — each with its own photos and its
  //    active mandate embedded, so each listing's facts come from the same
  //    statement as the listing. They used to be two more reads keyed by
  //    `.in("property_id", ids)` with every live listing's id: past about 208
  //    listings (units included) the gateway answered 414 and the page fell
  //    over; and the photo read was unpaged, so past 1,000 photos max_rows cut
  //    it silently and those listings were chased for covers and photos they
  //    have. Driving the facts from the listings keeps the request the same
  //    size and the cost in proportion to the live listings (the review
  //    measured a media-driven read, joined back to its listing, at 15 s for
  //    1,000 live listings with sold history; this shape at 160 ms).
  //    PostgREST caps an EMBEDDED array at max_rows too (measured: 1,200
  //    photos on one listing → 1,000), so the photos come cover first — a
  //    listing past 1,000 photos keeps its cover and its count still clears 6.
  const live = await fetchAll(
    (from, to) =>
      supabase
        .from("properties")
        .select(
          "id, reference, title, quality_score, status, visibility, published_at, property_type, kind, parent_id, public_description, asking_price, rent_price_month, covered_area_sqm, plot_area_sqm, bedrooms, bathrooms, planning_zone_code, building_density_pct, location, location_approx, title_deed_status, permit_status, assigned_agent_id, owner_contact_id, developer_contact_id, year_built, construction_status, delivery_date, photos:property_media(is_cover, content_sha256), active_mandate:mandates_safe(id)",
        )
        .in("status", [...LIVE_STATUSES])
        .neq("visibility", RETIRED_PROPERTY_VISIBILITY)
        // photos only (MEDIA-K) — must agree with recomputeQualityScore's filter
        .eq("photos.kind", "photo")
        .order("is_cover", { ascending: false, referencedTable: "photos" })
        // `mandates_safe`, as before (a listing manager has no base-table SELECT)
        .eq("active_mandate.status", "active")
        .order("id")
        .range(from, to),
    "worklist live listings",
  );
  // 2. The rest of the unarchived portfolio, only so a container's SOLD units
  //    still count for it (2026-09-02 review, critic pass: a sold-out
  //    development was being chased for "at least one unit"). A listing whose
  //    status changes between the two reads can be tallied twice or not at
  //    all for one render — a unit count, never a listing's own facts.
  const rest = await fetchAll(
    (from, to) =>
      supabase
        .from("properties")
        .select("id, reference, kind, parent_id, asking_price, rent_price_month")
        .not("status", "in", `(${LIVE_STATUSES.join(",")})`)
        .neq("visibility", RETIRED_PROPERTY_VISIBILITY)
        .order("id")
        .range(from, to),
    "worklist other listings",
  );

  const properties = live;
  if (properties.length === 0) return buildWorklist([]);
  const allRows = [...live, ...rest];

  const photoCount = new Map<string, number>();
  const hasCover = new Set<string>();
  const mandated = new Set<string>();
  for (const p of live) {
    photoCount.set(p.id, p.photos.length);
    if (p.photos.some((m) => m.is_cover)) hasCover.add(p.id);
    if (p.active_mandate.length > 0) mandated.add(p.id);
  }

  // 0088: which listings carry the same photograph — grouped here, in
  // memory, over the live listings' photos (shared-photos.ts is the one
  // definition; the property page asks the database the same question).
  const referenceOf = new Map(allRows.map((r) => [r.id, r.reference]));
  const shared = sharedPhotoReferences(
    live.flatMap((p) => p.photos.map((m) => ({ property_id: p.id, content_sha256: m.content_sha256 }))),
    referenceOf,
  );

  // Unit counts WITHOUT another query: units are properties, so a container's
  // units are already in the two reads unless they are archived. Undercounting
  // that way is the safe direction; the detail page and the publish gate both
  // count exactly (container-units.ts).
  //
  // Same DEFINITION as those, though (2026-09-02 review): only kind = unit
  // counts — a phase is a child row, not a unit — and a unit under a phase
  // counts for the phase AND for the project above it.
  const units = tallyContainerUnits(allRows);

  const scored: ScoredProperty[] = properties.map((p) => {
    const result = computeQualityScore(
      buildQualityInput(p as unknown as QualityScoreSource, {
        hasCoverPhoto: hasCover.has(p.id),
        photoCount: photoCount.get(p.id) ?? 0,
        sharedPhotoWith: shared.get(p.id) ?? [],
        unitCount: units.get(p.id)?.unitCount ?? 0,
        pricedUnitCount: units.get(p.id)?.pricedUnitCount ?? 0,
        mandateActive: mandated.has(p.id),
      }),
    );
    return {
      property: {
        id: p.id,
        reference: p.reference,
        title: (p.title as { en?: string } | null)?.en ?? null,
        score: result.score,
      },
      listing: { visibility: p.visibility, status: p.status, publishedAt: p.published_at },
      result,
    };
  });

  return buildWorklist(scored);
}
