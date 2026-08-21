"use server";

import { revalidatePath } from "next/cache";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvents } from "@/lib/services/events";
import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";
import {
  INHERITED_UNIT_FIELDS,
  UNIT_PARENT_SELECT,
  type InheritedUnitField,
} from "@/lib/services/unit-inheritance";

export type SyncState = { error: string | null; savedAt: number | null; synced: number };

/**
 * Push one project field down onto the units that still inherit it
 * (BACKLOG audit finding 5, the drift half).
 *
 * Copy-on-create means a project edit does not reach units that already exist.
 * This is the other end of that: `inherited_fields` records which columns are
 * still the project's opinion, so this can update exactly those and leave alone
 * the ones somebody set deliberately.
 *
 * ONE FIELD PER CALL, on purpose. "Sync everything" reads as a single decision
 * but is several, and the one nobody meant to make is the one that hurts —
 * pushing a delivery date over units that were re-dated for a phased handover,
 * say. The panel lists each drifted field with its own count and its own button.
 *
 * Admin + listing manager only, matching who may manage units at all.
 */
export async function syncInheritedField(
  projectId: string,
  field: string,
): Promise<SyncState> {
  if (!(INHERITED_UNIT_FIELDS as readonly string[]).includes(field)) {
    return { error: `${field} is not an inherited field`, savedAt: null, synced: 0 };
  }
  const column = field as InheritedUnitField;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  if (profile.role !== "admin" && profile.role !== "listing_manager") {
    return {
      error: "Only admins and listing managers manage units.",
      savedAt: null,
      synced: 0,
    };
  }

  const { data: project } = await supabase
    .from("properties")
    .select(UNIT_PARENT_SELECT)
    .eq("id", projectId)
    .maybeSingle();
  if (!project) return { error: "Project not found", savedAt: null, synced: 0 };
  if (project.kind !== "project" && project.kind !== "phase") {
    return { error: "Not a project", savedAt: null, synced: 0 };
  }

  const value = (project as Record<string, unknown>)[column] ?? null;

  // `contains` on inherited_fields is the guard that makes this safe: a unit
  // that dropped the field has an opinion and must not be touched.
  const { data: updated, error } = await supabase
    .from("properties")
    // a computed key cannot satisfy the generated Update type; the column name
    // is checked against INHERITED_UNIT_FIELDS above, so the cast is bounded
    .update({ [column]: value } as Database["public"]["Tables"]["properties"]["Update"])
    .eq("parent_id", projectId)
    .eq("kind", "unit")
    .contains("inherited_fields", [column])
    .select("id, reference");
  if (error) return { error: error.message, savedAt: null, synced: 0 };

  const rows = updated ?? [];
  if (rows.length === 0) {
    return { error: null, savedAt: Date.now(), synced: 0 };
  }

  // Each unit is its own entity and owes its own event — a single project-level
  // "synced 58 units" row would leave 58 timelines with an unexplained change.
  await logEvents(
    supabase,
    rows.map((u) => ({
      orgId: profile.orgId,
      actorId: profile.id,
      entityType: "property" as const,
      entityId: u.id,
      eventType: "updated",
      // round-tripped through JSON for the Json type, same as
      // updatePropertySection — a computed key does not satisfy it directly
      payload: JSON.parse(
        JSON.stringify({
          section: "inheritance",
          source: "project_sync",
          field: column,
          from_project: project.reference,
          changed: { [column]: { to: value ?? null } },
        }),
      ),
    })),
  );

  revalidatePath(`/properties/${projectId}/units`);
  revalidatePath("/properties");
  return { error: null, savedAt: Date.now(), synced: rows.length };
}
