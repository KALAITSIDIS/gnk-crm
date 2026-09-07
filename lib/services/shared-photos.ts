import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

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
 * The same question for ONE property, asked of the database: which other
 * properties (by reference, sorted) carry one of these hashes. RLS scopes the
 * answer to the caller's org, which is the org the question is about. Throws
 * on a failed read — "nobody shares this" and "the read failed" are different
 * facts (lib/supabase/fetch-all.ts says why).
 */
export async function fetchSharedPhotoReferences(
  supabase: Client,
  propertyId: string,
  hashes: readonly string[],
): Promise<string[]> {
  const wanted = [...new Set(hashes.filter(Boolean))];
  if (wanted.length === 0) return [];
  const media = await supabase
    .from("property_media")
    .select("property_id")
    .in("content_sha256", wanted)
    .neq("property_id", propertyId);
  if (media.error) throw new Error(`Query failed (shared photographs): ${media.error.message}`);
  const ids = [...new Set((media.data ?? []).map((m) => m.property_id))];
  if (ids.length === 0) return [];
  const props = await supabase.from("properties").select("reference").in("id", ids);
  if (props.error) throw new Error(`Query failed (shared photographs): ${props.error.message}`);
  return (props.data ?? []).map((p) => p.reference).sort();
}
