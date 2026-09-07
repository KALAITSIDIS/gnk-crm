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
 * THREE QUERIES FOR THE WHOLE LIST, not three per property. `recomputeQualityScore`
 * makes three round trips for ONE property, which is right when saving one and
 * ruinous across a portfolio — sixty units would be a hundred and eighty
 * queries. The facts it needs per property (cover photo, photo count, active
 * mandate) are fetched once for all of them and indexed in memory.
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
  // Paged, because PostgREST caps a select at 1000 rows SILENTLY and a
  // worklist that quietly forgot the tail of the portfolio would report it
  // complete (2026-09-02 fix-wave review). Pre-existing, but the tally now
  // loads sold rows too, so the cap got closer. The loop that lived here was
  // the first of its kind; it is now lib/supabase/fetch-all.ts, shared with
  // the match alerts and the mandate exclusion (2026-09-06, A08a).
  const rows = await fetchAll(
    (from, to) =>
      supabase
        .from("properties")
        .select(
          "id, reference, title, quality_score, status, property_type, kind, parent_id, public_description, asking_price, rent_price_month, covered_area_sqm, plot_area_sqm, bedrooms, bathrooms, planning_zone_code, building_density_pct, location, location_approx, title_deed_status, permit_status, assigned_agent_id, owner_contact_id, developer_contact_id",
        )
        .neq("visibility", RETIRED_PROPERTY_VISIBILITY)
        .order("id")
        .range(from, to),
    "worklist properties",
  );

  // Every non-archived row is loaded so a container's SOLD units still count
  // for it (2026-09-02 review, critic pass: a sold-out development was being
  // chased for "at least one unit"). Only live rows are SCORED — a sold
  // listing needs no more photos. `as const` gives the literal union the
  // typed client wants; a string[] cast would throw that away for nothing.
  const allRows = rows ?? [];
  const live = new Set<string>(LIVE_STATUSES);
  const properties = allRows.filter((r) => live.has(r.status));
  if (properties.length === 0) return buildWorklist([]);

  const ids = properties.map((p) => p.id);

  const [mediaRes, mandateRes] = await Promise.all([
    // photos only (MEDIA-K) — must agree with recomputeQualityScore's filter
    supabase
      .from("property_media")
      .select("property_id, is_cover, content_sha256")
      .in("property_id", ids)
      .eq("kind", "photo"),
    supabase.from("mandates_safe").select("property_id").eq("status", "active").in("property_id", ids),
  ]);
  if (mediaRes.error) throw new Error(`Worklist media query failed: ${mediaRes.error.message}`);
  if (mandateRes.error) {
    throw new Error(`Worklist mandate query failed: ${mandateRes.error.message}`);
  }

  const photoCount = new Map<string, number>();
  const hasCover = new Set<string>();
  for (const m of mediaRes.data ?? []) {
    if (!m.property_id) continue;
    photoCount.set(m.property_id, (photoCount.get(m.property_id) ?? 0) + 1);
    if (m.is_cover) hasCover.add(m.property_id);
  }

  const mandated = new Set(
    (mandateRes.data ?? []).map((m) => m.property_id).filter((v): v is string => Boolean(v)),
  );

  // 0088: which listings carry the same photograph — grouped here, in
  // memory, over the media already loaded (shared-photos.ts is the one
  // definition; the property page asks the database the same question).
  const referenceOf = new Map(allRows.map((r) => [r.id, r.reference]));
  const shared = sharedPhotoReferences(
    (mediaRes.data ?? []).filter((m): m is typeof m & { property_id: string } => Boolean(m.property_id)),
    referenceOf,
  );

  // Unit counts WITHOUT a fourth query: units are properties, so a container's
  // units are already in `properties` unless they are sold/archived — and a
  // container whose every unit has sold is not one the worklist should chase.
  // Undercounting that way is the safe direction; the detail page and the
  // publish gate both count exactly (container-units.ts).
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
      result,
    };
  });

  return buildWorklist(scored);
}
