"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent, logEvents } from "@/lib/services/events";
import { createClient } from "@/lib/supabase/server";
import {
  emptyToUndefined,
  PROPERTY_STATUSES,
  PROPERTY_TYPES,
} from "@/lib/validators/properties";
import {
  INHERITED_UNIT_FIELDS,
  inheritedFieldsWithValues,
  resolveInheritedUnitFields,
  UNIT_PARENT_SELECT,
} from "@/lib/services/unit-inheritance";
import {
  generateUnits,
  generatedCount,
  MAX_FLOOR,
  MAX_GENERATED_UNITS,
  MAX_PER_FLOOR,
} from "@/lib/services/unit-generator";

export type UnitActionState = { error: string | null; savedAt: number | null };

const createUnitSchema = z.object({
  project_id: z.string().uuid(),
  unit_number: z.string().trim().min(1, "Unit number is required").max(20),
  block: z.preprocess(emptyToUndefined, z.string().max(20).optional()),
  property_type: z.enum(PROPERTY_TYPES),
  bedrooms: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).optional()),
  bathrooms: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).optional()),
  covered_area_sqm: z.preprocess(emptyToUndefined, z.coerce.number().positive().optional()),
  asking_price: z.preprocess(emptyToUndefined, z.coerce.number().positive().optional()),
  floor_number: z.preprocess(emptyToUndefined, z.coerce.number().int().optional()),
});

export async function createUnit(
  _prev: UnitActionState,
  formData: FormData,
): Promise<UnitActionState> {
  const parsed = createUnitSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
  }
  const input = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  // Every column a unit inherits, plus the four this action needs for itself.
  // Driven off INHERITED_UNIT_FIELDS so the select and the insert cannot drift.
  const { data: project } = await supabase
    .from("properties")
    .select(UNIT_PARENT_SELECT)
    .eq("id", input.project_id)
    .maybeSingle();
  if (!project) return { error: "Project not found", savedAt: null };
  if (project.kind !== "project" && project.kind !== "phase") {
    return { error: "Units can only be added to a project", savedAt: null };
  }

  // Unit reference per doc 02 §A6: parent ref + unit number (PAF0007-B203)
  const unitLabel = [input.block, input.unit_number].filter(Boolean).join("");
  const reference = `${project.reference}-${unitLabel}`;

  const { data: created, error: insertErr } = await supabase
    .from("properties")
    .insert({
      org_id: project.org_id,
      reference,
      kind: "unit",
      parent_id: project.id,
      property_type: input.property_type,
      // doc 02 §C1: a unit inherits its project's truths. NOT visibility — a
      // `public` project would otherwise mint already-published units with no
      // photos, price or description, straight past the quality gate.
      ...resolveInheritedUnitFields(project),
      // every inherited column starts as the project's opinion; editing one on
      // the unit removes it from this list and the unit stops following (0035)
      inherited_fields: [...INHERITED_UNIT_FIELDS],
      unit_number: input.unit_number,
      block: input.block ?? null,
      bedrooms: input.bedrooms ?? null,
      bathrooms: input.bathrooms ?? null,
      covered_area_sqm: input.covered_area_sqm ?? null,
      asking_price: input.asking_price ?? null,
      floor_number: input.floor_number ?? null,
      status: "available",
      created_by: profile.id,
    })
    .select("id")
    .single();
  if (insertErr) {
    return {
      error: insertErr.code === "23505" ? `Unit ${reference} already exists` : insertErr.message,
      savedAt: null,
    };
  }

  await logEvent(supabase, {
    orgId: project.org_id,
    actorId: profile.id,
    entityType: "property",
    entityId: created.id,
    eventType: "created",
    payload: {
      reference,
      kind: "unit",
      parent: project.reference,
      // what the unit took from its project, so a later "where did this come
      // from" has an answer in the timeline rather than a guess
      inherited: inheritedFieldsWithValues(project),
    },
  });

  revalidatePath(`/properties/${project.id}/units`);
  return { error: null, savedAt: Date.now() };
}

/** Result object, not throw — thrown server-action messages are stripped in
 * prod, and RLS filters a denied update to 0 rows with no error at all. */
export async function updateUnitStatus(
  unitId: string,
  status: string,
): Promise<{ error: string | null }> {
  if (!(PROPERTY_STATUSES as readonly string[]).includes(status)) {
    return { error: `Invalid status: ${status}` };
  }
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: unit } = await supabase
    .from("properties")
    .select("id, org_id, parent_id, reference, status")
    .eq("id", unitId)
    .maybeSingle();
  if (!unit) return { error: "Unit not found" };
  if (unit.status === status) return { error: null };

  const { data: updatedRows, error } = await supabase
    .from("properties")
    .update({ status: status as (typeof PROPERTY_STATUSES)[number] })
    .eq("id", unitId)
    .select("id");
  if (error) return { error: error.message };
  if (!updatedRows || updatedRows.length === 0) {
    return {
      error: "Status not changed — only admins and listing managers manage units.",
    };
  }

  await logEvent(supabase, {
    orgId: unit.org_id,
    actorId: profile.id,
    entityType: "property",
    entityId: unitId,
    eventType: "status_changed",
    payload: { reference: unit.reference, from: unit.status, to: status },
  });

  if (unit.parent_id) revalidatePath(`/properties/${unit.parent_id}/units`);
  revalidatePath("/properties");
  return { error: null };
}

const generateUnitsSchema = z
  .object({
    project_id: z.guid("Missing project"),
    block: z.preprocess(emptyToUndefined, z.string().max(20).optional()),
    floor_from: z.coerce.number().int().min(0).max(MAX_FLOOR),
    floor_to: z.coerce.number().int().min(0).max(MAX_FLOOR),
    per_floor: z.coerce.number().int().min(1).max(MAX_PER_FLOOR),
    start_index: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).max(MAX_PER_FLOOR).optional()),
    property_type: z.enum(PROPERTY_TYPES),
    bedrooms: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).optional()),
    bathrooms: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).optional()),
    covered_area_sqm: z.preprocess(emptyToUndefined, z.coerce.number().positive().optional()),
    base_price: z.preprocess(emptyToUndefined, z.coerce.number().positive().optional()),
    price_per_floor: z.preprocess(emptyToUndefined, z.coerce.number().min(0).optional()),
  })
  .refine((d) => d.floor_to >= d.floor_from, {
    message: "Top floor must not be below the bottom floor",
    path: ["floor_to"],
  })
  .refine(
    (d) =>
      generatedCount({ floorFrom: d.floor_from, floorTo: d.floor_to, perFloor: d.per_floor }) <=
      MAX_GENERATED_UNITS,
    {
      message: `That would create more than ${MAX_GENERATED_UNITS} units — narrow the floor range`,
      path: ["floor_to"],
    },
  );

/**
 * Create a whole block in one submit (BACKLOG proposal, follow-on to finding 5).
 *
 * A 60-unit project was 60 trips through the Add-unit dialog, which is the main
 * reason developer inventory does not get entered. A block is regular by
 * construction, so the desk describes the pattern once.
 *
 * ALL OR NOTHING ON COLLISION. If any generated reference already exists the
 * whole run is refused, naming the clashes. A partial generation is the worst
 * outcome: you cannot tell by looking which half of a block landed, and the
 * obvious retry then collides with the half that did. Adding floor 6 to an
 * existing block is `floor_from: 6, floor_to: 6`, which is both correct and
 * obvious — whereas a "skip what exists" rule would silently absorb a typo in
 * the floor range and leave nothing to notice.
 *
 * Units inherit exactly what a single created unit inherits, via the same
 * resolveInheritedUnitFields — a second inheritance rule that could drift from
 * the first would be worse than none.
 */
export async function generateProjectUnits(
  _prev: UnitActionState,
  formData: FormData,
): Promise<UnitActionState> {
  const parsed = generateUnitsSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
  }
  const input = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: project } = await supabase
    .from("properties")
    .select(UNIT_PARENT_SELECT)
    .eq("id", input.project_id)
    .maybeSingle();
  if (!project) return { error: "Project not found", savedAt: null };
  if (project.kind !== "project" && project.kind !== "phase") {
    return { error: "Units can only be added to a project", savedAt: null };
  }

  const generated = generateUnits({
    block: input.block ?? null,
    floorFrom: input.floor_from,
    floorTo: input.floor_to,
    perFloor: input.per_floor,
    startIndex: input.start_index,
    bedrooms: input.bedrooms ?? null,
    bathrooms: input.bathrooms ?? null,
    coveredAreaSqm: input.covered_area_sqm ?? null,
    basePrice: input.base_price ?? null,
    pricePerFloor: input.price_per_floor ?? null,
  });
  if (generated.length === 0) return { error: "That range produces no units", savedAt: null };

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
      savedAt: null,
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
        property_type: input.property_type,
        ...inherited,
        inherited_fields: [...INHERITED_UNIT_FIELDS],
        unit_number: u.unit_number,
        block: u.block,
        floor_number: u.floor_number,
        bedrooms: u.bedrooms,
        bathrooms: u.bathrooms,
        covered_area_sqm: u.covered_area_sqm,
        asking_price: u.asking_price,
        status: "available" as const,
        created_by: profile.id,
      })),
    )
    .select("id, reference");
  if (insertErr) return { error: insertErr.message, savedAt: null };
  if (!created || created.length === 0) {
    return { error: "Nothing was created — only admins and listing managers manage units.", savedAt: null };
  }

  // One event per unit, in ONE statement. Each unit is its own entity and owes
  // its own `created` row; the chain survives a multi-row insert (see logEvents).
  const inheritedNames = inheritedFieldsWithValues(project);
  await logEvents(
    supabase,
    created.map((row) => ({
      orgId: project.org_id,
      actorId: profile.id,
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

  revalidatePath(`/properties/${project.id}/units`);
  revalidatePath("/properties");
  return { error: null, savedAt: Date.now() };
}

const createPhaseSchema = z.object({
  project_id: z.guid("Missing project"),
  code: z
    .string()
    .trim()
    .min(1, "Phase code is required")
    .max(6, "Keep the phase code short — it goes into every unit reference")
    .regex(/^[A-Za-z0-9]+$/, "Phase code: letters and numbers only"),
  name: z.preprocess(emptyToUndefined, z.string().max(120).optional()),
  delivery_date: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Delivery date must be YYYY-MM-DD")
      .optional(),
  ),
});

/**
 * Create a phase under a project (BACKLOG audit finding 11).
 *
 * `phase` has been in the property_kind enum since 0001, with a
 * `phase_has_parent` constraint, and three read paths branching on it — and
 * NOTHING could create one. Units already accept a phase as their parent, so
 * this is the missing middle of a hierarchy the schema always described.
 *
 * A PHASE IS A CHILD OF A PROJECT AND NOTHING ELSE. Doc 01 §C1 describes
 * project → phase → unit, one level; phases inside phases would make the
 * reference unbounded (`PAF0002-P1-P2-B203`) and give the units matrix no
 * single place to live.
 *
 * The reference composes: a phase is `PAF0002-P1`, and `createUnit` already
 * builds a unit reference from its parent's, so a unit under it lands at
 * `PAF0002-P1-B203` with no change to that code.
 *
 * It inherits from its project exactly as a unit does, `inherited_fields`
 * included — so the drift panel keeps a phase in step with its project, and
 * editing the phase's delivery date severs just that field. That last part is
 * the point of phases: phase 1 hands over a year before phase 2.
 */
export async function createPhase(
  _prev: UnitActionState,
  formData: FormData,
): Promise<UnitActionState> {
  const parsed = createPhaseSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
  }
  const input = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: project } = await supabase
    .from("properties")
    .select(UNIT_PARENT_SELECT)
    .eq("id", input.project_id)
    .maybeSingle();
  if (!project) return { error: "Project not found", savedAt: null };
  if (project.kind === "phase") {
    return { error: "A phase cannot contain another phase.", savedAt: null };
  }
  if (project.kind !== "project") {
    return { error: "Phases can only be added to a project", savedAt: null };
  }

  const reference = `${project.reference}-${input.code.toUpperCase()}`;

  const { data: created, error: insertErr } = await supabase
    .from("properties")
    .insert({
      org_id: project.org_id,
      reference,
      kind: "phase" as const,
      parent_id: project.id,
      property_type: project.property_type,
      ...resolveInheritedUnitFields(project),
      inherited_fields: [...INHERITED_UNIT_FIELDS],
      // a phase usually hands over on its own date — that is what phases ARE —
      // so an entered one is the phase's own and does not follow the project
      ...(input.delivery_date
        ? {
            delivery_date: input.delivery_date,
            inherited_fields: INHERITED_UNIT_FIELDS.filter((f) => f !== "delivery_date"),
          }
        : {}),
      title: input.name ? { en: input.name } : {},
      status: "available" as const,
      created_by: profile.id,
    })
    .select("id")
    .single();
  if (insertErr) {
    return {
      error:
        insertErr.code === "23505"
          ? `${reference} already exists`
          : insertErr.message,
      savedAt: null,
    };
  }

  await logEvent(supabase, {
    orgId: project.org_id,
    actorId: profile.id,
    entityType: "property",
    entityId: created.id,
    eventType: "created",
    payload: {
      reference,
      kind: "phase",
      parent: project.reference,
      inherited: inheritedFieldsWithValues(project),
    },
  });

  revalidatePath(`/properties/${project.id}/units`);
  revalidatePath("/properties");
  return { error: null, savedAt: Date.now() };
}

export async function createPriceListVersion(
  _prev: UnitActionState,
  formData: FormData,
): Promise<UnitActionState> {
  const projectId = formData.get("project_id");
  const notes = formData.get("notes");
  if (typeof projectId !== "string") return { error: "Missing project", savedAt: null };

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: project } = await supabase
    .from("properties")
    .select("id, org_id, reference")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) return { error: "Project not found", savedAt: null };

  const { data: units } = await supabase
    .from("properties")
    .select("id, asking_price")
    .eq("parent_id", projectId)
    .eq("kind", "unit")
    .not("asking_price", "is", null);
  if (!units || units.length === 0) {
    return { error: "No units with prices to snapshot", savedAt: null };
  }

  const { data: latest } = await supabase
    .from("price_lists")
    .select("version")
    .eq("project_id", projectId)
    .order("version", { ascending: false })
    .limit(1);
  const version = (latest?.[0]?.version ?? 0) + 1;

  const { data: list, error: listErr } = await supabase
    .from("price_lists")
    .insert({
      org_id: project.org_id,
      project_id: projectId,
      version,
      notes: typeof notes === "string" && notes.trim() ? notes.trim() : null,
      created_by: profile.id,
    })
    .select("id")
    .single();
  if (listErr) return { error: listErr.message, savedAt: null };

  const { error: itemsErr } = await supabase.from("price_list_items").insert(
    units.map((u) => ({
      price_list_id: list.id,
      unit_id: u.id,
      list_price: u.asking_price!,
    })),
  );
  if (itemsErr) return { error: itemsErr.message, savedAt: null };

  await logEvent(supabase, {
    orgId: project.org_id,
    actorId: profile.id,
    entityType: "property",
    entityId: projectId,
    eventType: "price_list_created",
    payload: { version, units: units.length },
  });

  revalidatePath(`/properties/${projectId}/units`);
  return { error: null, savedAt: Date.now() };
}

const paymentPlanSchema = z.object({
  project_id: z.string().uuid(),
  name: z.string().trim().min(1, "Plan name required").max(100),
  installments: z
    .array(
      z.object({
        label: z.string().min(1),
        pct: z.number().positive().max(100),
        due: z.string().min(1),
      }),
    )
    .min(1, "Add at least one installment")
    .refine(
      (rows) => Math.abs(rows.reduce((s, r) => s + r.pct, 0) - 100) < 0.01,
      "Installments must total 100%",
    ),
});

export async function createPaymentPlan(
  _prev: UnitActionState,
  formData: FormData,
): Promise<UnitActionState> {
  let installments: unknown;
  try {
    installments = JSON.parse(String(formData.get("installments") ?? "[]"));
  } catch {
    return { error: "Invalid installments", savedAt: null };
  }
  const parsed = paymentPlanSchema.safeParse({
    project_id: formData.get("project_id"),
    name: formData.get("name"),
    installments,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
  }

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: project } = await supabase
    .from("properties")
    .select("id, org_id")
    .eq("id", parsed.data.project_id)
    .maybeSingle();
  if (!project) return { error: "Project not found", savedAt: null };

  const { error } = await supabase.from("payment_plans").insert({
    org_id: project.org_id,
    project_id: parsed.data.project_id,
    name: parsed.data.name,
    installments: parsed.data.installments,
  });
  if (error) return { error: error.message, savedAt: null };

  await logEvent(supabase, {
    orgId: project.org_id,
    actorId: profile.id,
    entityType: "property",
    entityId: parsed.data.project_id,
    eventType: "payment_plan_created",
    payload: { name: parsed.data.name, installments: parsed.data.installments.length },
  });

  revalidatePath(`/properties/${parsed.data.project_id}/units`);
  return { error: null, savedAt: Date.now() };
}
