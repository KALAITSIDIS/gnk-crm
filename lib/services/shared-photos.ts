import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
// RELATIVE and WITH the extension, not "@/": quality-score.ts loads this file,
// and scripts/recompute-scores.mts and the importers load that under plain
// Node, which resolves neither a tsconfig alias nor an extensionless path
import { fetchAll } from "../supabase/fetch-all.ts";

type Client = SupabaseClient<Database>;

/**
 * "This photograph is already on another listing" (0088, audit A03's cousin).
 *
 * Every upload hashes the ORIGINAL bytes into property_media.content_sha256,
 * so two listings carrying the same picture are a fact the database can state
 * rather than something a buyer notices on the site first. It is a WARNING and
 * never a score change: a development's units legitimately share exteriors, a
 * resale may reuse the developer's brochure shot with permission, and the
 * quality score gates publishing — a point withheld here would block a listing
 * a person had every reason to publish. So the desk is told, by reference, and
 * decides.
 *
 * ONE definition, two shapes. The worklist already holds every live listing's
 * media in memory, so it groups by hash there (`sharedPhotoReferences`); the
 * property page and the recompute look at one listing and ask the database
 * for the others (`fetchSharedPhotoReferences`). Both say "another property
 * in this org carries one of this property's hashes", and the test pins the
 * pure one to that sentence.
 */

export interface HashedMediaRow {
  property_id: string;
  content_sha256: string | null;
}

/**
 * For every property with a hashed photograph, the OTHER properties — by
 * reference, sorted — carrying one of its hashes. Properties with nothing
 * shared are absent from the map. Pure.
 */
export function sharedPhotoReferences(
  rows: readonly HashedMediaRow[],
  referenceOf: ReadonlyMap<string, string>,
): Map<string, string[]> {
  const byHash = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.content_sha256) continue;
    const set = byHash.get(r.content_sha256) ?? new Set<string>();
    set.add(r.property_id);
    byHash.set(r.content_sha256, set);
  }
  const out = new Map<string, Set<string>>();
  for (const ids of byHash.values()) {
    if (ids.size < 2) continue;
    for (const id of ids) {
      const others = out.get(id) ?? new Set<string>();
      for (const other of ids) {
        if (other === id) continue;
        const ref = referenceOf.get(other);
        if (ref) others.add(ref);
      }
      out.set(id, others);
    }
  }
  const result = new Map<string, string[]>();
  for (const [id, refs] of out) {
    if (refs.size > 0) result.set(id, [...refs].sort());
  }
  return result;
}

/**
 * Hashes asked about per request: 64 hex characters and a comma each, so
 * ~2.7 KB of URL whatever the listing's photo count (T-shared-photo-references).
 */
const HASHES_PER_READ = 40;

/**
 * The same question for ONE property, asked of the database: which other
 * properties (by reference, sorted) carry one of these hashes. RLS scopes the
 * answer to the caller's org, which is the org the question is about. Throws
 * on a failed read — "nobody shares this" and "the read failed" are different
 * facts (lib/supabase/fetch-all.ts says why).
 *
 * The hashes go out in slices of HASHES_PER_READ, each read paged, and the
 * sharing listing's reference rides with each row (its property embedded) —
 * no id list. It used to send every hash in one URL and every sharing
 * listing's id in a second, unpaged: past about 122 hashes or 210 sharing
 * listings the gateway answered 414, the property page fell over, and
 * set-cover / delete-photo threw after their write had committed
 * (T-shared-photo-references). That cause is gone; a read that fails for
 * another reason still throws there (BACKLOG "Shared photographs — 2026-10-12").
 */
export async function fetchSharedPhotoReferences(
  supabase: Client,
  propertyId: string,
  /**
   * The property's organisation. Under a session RLS scopes the answer to it
   * anyway; under the service role (the nightly score recompute, the
   * importers) this filter is what lets the planner use the
   * (org_id, content_sha256) index instead of walking the whole table — and
   * what keeps another organisation's listing out of the answer.
   */
  orgId: string,
  hashes: readonly string[],
): Promise<string[]> {
  const wanted = [...new Set(hashes.filter(Boolean))];
  if (wanted.length === 0) return [];
  const slices: string[][] = [];
  for (let i = 0; i < wanted.length; i += HASHES_PER_READ) slices.push(wanted.slice(i, i + HASHES_PER_READ));
  // the slices are independent: asked together (any failure still throws)
  const pages = await Promise.all(
    slices.map((slice) =>
      fetchAll(
        (from, to) =>
          supabase
            .from("property_media")
            .select("id, listing:properties(reference)")
            .eq("org_id", orgId)
            .in("content_sha256", slice)
            .neq("property_id", propertyId)
            .order("id")
            .range(from, to),
        "shared photographs",
      ),
    ),
  );
  const references = new Set<string>();
  for (const r of pages.flat()) {
    const ref = (r.listing as { reference: string } | null)?.reference;
    if (ref) references.add(ref);
  }
  return [...references].sort();
}
