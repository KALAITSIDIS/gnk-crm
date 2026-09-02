import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { logEvents } from "@/lib/services/events";
import type { GeneratedUnit } from "@/lib/services/unit-generator";
import {
  INHERITED_UNIT_FIELDS,
  inheritedFieldsWithValues,
  resolveInheritedUnitFields,
  type ProjectRow,
} from "@/lib/services/unit-inheritance";
import type { PROPERTY_TYPES } from "@/lib/validators/properties";

/**
 * The one place generated units are WRITTEN (2026-09-02).
 *
 * Two callers produce unit rows — the units-matrix generator and, since the
 * wizard learned what a project is, `createProperty` itself. Both used to be
 * one call site; the moment there were two, the reference minting, the
 * collision pre-check, the insert shape and the per-unit events would have
 * become two copies that drift (the `visibility` exclusion alone has bitten
 * before — see unit-inheritance.ts DELIBERATELY_NOT_INHERITED). So the tail
 * lives here and the actions only decide WHAT to generate.
 *
 * A service, not a helper inside the action file: a "use server" module may
 * only export async server actions, and this must be importable by two of
 * them.
 *
 * All-or-nothing: the pre-check refuses the whole run on any clash, the insert
 * is one statement, the events are one statement. A half-landed block is the
 * worst outcome — nobody can tell which half arrived, and the retry collides
 * with it.
 */

/** What the writer needs from the parent: identity + every inheritable column. */
export type UnitParent = ProjectRow & { id: string; org_id: string; reference: string };

export type WriteUnitsResult =
  | { error: string; created?: undefined }
  | { error: null; created: { id: string; reference: string }[] };

export async function writeGeneratedUnits(
  supabase: SupabaseClient<Database>,
  project: UnitParent,
  generated: GeneratedUnit[],
  opts: { propertyType: (typeof PROPERTY_TYPES)[number]; actorId: string },
): Promise<WriteUnitsResult> {
  if (generated.length === 0) return { error: "That range produces no units" };

  // Unit reference per doc 02 §A6: parent ref + label (PAF0007-B203, PAF0002-V01).
  const references = generated.map((u) => `${project.reference}-${u.label}`);

  // Check before writing rather than relying on the unique violation: a 23505
  // names one reference, and the desk needs to know the shape of the clash.
  const { data: clashing } = await supabase
    .from("properties")
    .select("reference")
    .in("reference", references);
  if (clashing && clashing.length > 0) {
    const names = clashing.map((c) => c.reference).sort();
    const shown = names.slice(0, 5).join(", ");
    return {
      error:
        names.length === 1
          ? `${shown} already exists — nothing was created.`
          : `${names.length} of these already exist (${shown}${names.length > 5 ? ", …" : ""}) — nothing was created.`,
    };
  }

  const inherited = resolveInheritedUnitFields(project);
  const { data: created, error: insertErr } = await supabase
    .from("properties")
    .insert(
      generated.map((u, i) => ({
        org_id: project.org_id,
        reference: references[i],
        kind: "unit" as const,
        parent_id: project.id,
        property_type: opts.propertyType,
        ...inherited,
        inherited_fields: [...INHERITED_UNIT_FIELDS],
        unit_number: u.unit_number,
        block: u.block,
        floor_number: u.floor_number,
        bedrooms: u.bedrooms,
        bathrooms: u.bathrooms,
        covered_area_sqm: u.covered_area_sqm,
        ...(u.plot_area_sqm !== null ? { plot_area_sqm: u.plot_area_sqm } : {}),
        // asking_price, whatever the development's transaction type. The
        // units subsystem is SALE-SHAPED end to end — the matrix, price
        // lists, the uplift, the public availability share (SQL, 0041) and
        // sales velocity all read this column as THE unit price. A same-day
        // attempt to write a rent development's figure to rent_price_month
        // made its units invisible to every one of them; reverted. Making
        // the subsystem rent-aware is a real feature with a migration, gated
        // on the first rental development (DECISIONS T-container-review).
        asking_price: u.asking_price,
        // `visibility` deliberately absent — the column defaults to private, and
        // a public project must never mint sixty already-published empty units
        status: "available" as const,
        created_by: opts.actorId,
      })),
    )
    .select("id, reference");
  if (insertErr) {
    // The pre-check above is not atomic: two people generating the same run
    // at once both pass it and the (org_id, reference) unique index refuses
    // the second insert — with a message that named a constraint, not a
    // situation. Same wording as the pre-check, so the two cannot drift.
    return {
      error:
        insertErr.code === "23505"
          ? "One of these references was created a moment ago by someone else — nothing was created. Reload the page and generate again."
          : insertErr.message,
    };
  }
  if (!created || created.length === 0) {
    return { error: "Nothing was created — only admins and listing managers manage units." };
  }

  // One event per unit, in ONE statement. Each unit is its own entity and owes
  // its own `created` row; the chain survives a multi-row insert (see logEvents).
  const inheritedNames = inheritedFieldsWithValues(project);
  await logEvents(
    supabase,
    created.map((row) => ({
      orgId: project.org_id,
      actorId: opts.actorId,
      entityType: "property" as const,
      entityId: row.id,
      eventType: "created",
      payload: {
        reference: row.reference,
        kind: "unit",
        parent: project.reference,
        inherited: inheritedNames,
        generated: true,
      },
    })),
  );

  return { error: null, created };
}
