import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import {
  assessLineage,
  needsGrandparent,
  type AncestorRead,
  type Lineage,
  type LineageRow,
} from "@/lib/services/property-lineage";

/**
 * The ancestors of one property, on the CALLER's client (review 2026-10-18,
 * A05) — what the breadcrumb and the Overview's "Part of" show.
 *
 * AT MOST TWO READS, each by primary key, and never an id list: the parent,
 * and — only for a unit whose parent is a phase — the phase's parent. It never
 * follows further, so a self-parent or a cycle in the data cannot loop it; a
 * further ancestor is known to exist from the second row's own `parent_id`,
 * which lib/services/property-lineage.ts reports as "too deep".
 *
 * On the caller's client on purpose: a parent RLS hides (another
 * organisation's row — properties.parent_id is not yet org-bound, BACKLOG) is
 * reported as not visible, never shown.
 *
 * DOES NOT THROW. A failed read becomes the "could not be loaded" issue, which
 * the page shows in words: the trail is secondary to the record, so its
 * failure must not take the record page down — and must not read as "no
 * parent" either.
 */
const LINEAGE_SELECT = "id, reference, kind, title, visibility, parent_id";

async function readAncestor(supabase: SupabaseClient<Database>, id: string): Promise<AncestorRead> {
  try {
    const res = await supabase.from("properties").select(LINEAGE_SELECT).eq("id", id).limit(1);
    if (res.error) return { state: "failed" };
    // an answer with no rows array is not "no row" (T-null-answer-guard)
    if (!Array.isArray(res.data)) return { state: "failed" };
    const row = res.data[0];
    if (!row) return { state: "absent" };
    return {
      state: "found",
      node: {
        id: row.id,
        reference: row.reference,
        kind: row.kind,
        title: (row.title as { en?: string } | null)?.en ?? null,
        visibility: row.visibility,
        parent_id: row.parent_id,
      },
    };
  } catch {
    return { state: "failed" };
  }
}

export async function fetchLineage(supabase: SupabaseClient<Database>, row: LineageRow): Promise<Lineage> {
  if (row.parent_id === null) return assessLineage(row);
  const parent = await readAncestor(supabase, row.parent_id);
  if (parent.state === "found" && needsGrandparent(row, parent.node)) {
    const grandparent = await readAncestor(supabase, parent.node.parent_id!);
    return assessLineage(row, parent, grandparent);
  }
  return assessLineage(row, parent);
}
