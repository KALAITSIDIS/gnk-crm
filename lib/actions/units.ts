"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent, logEvents } from "@/lib/services/events";
import { createClient } from "@/lib/supabase/server";
import {
  emptyToUndefined,
  isStatusRegression,
  PROPERTY_STATUSES,
  PROPERTY_TYPES,
} from "@/lib/validators/properties";
import {
  INHERITED_UNIT_FIELDS,
  inheritedFieldsWithValues,
  resolveInheritedUnitFields,
  UNIT_PARENT_SELECT,
} from "@/lib/services/unit-inheritance";
import { writeGeneratedUnits } from "@/lib/services/unit-writer";
import { refreshContainerScores } from "@/lib/services/quality-score";
import {
  generateUnits,
  generateVillaUnits,
  generatedCount,
  villaCount,
  MAX_FLOOR,
  MAX_GENERATED_UNITS,
  MAX_PER_FLOOR,
} from "@/lib/services/unit-generator";
import { inScope, previewUplift, type UpliftMode } from "@/lib/services/price-uplift";
import { stampOf, type UnitType } from "@/lib/services/unit-type";

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

  // the containers above now have one more unit — their stored score moved
  await refreshContainerScores(supabase, project.id);

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

  // DB-01: same admin gate as the details form — leaving sold/rented is a
  // regression the grid must not offer listing managers implicitly
  if (isStatusRegression(unit.status, status) && profile.role !== "admin") {
    return { error: "Only an admin can move a sold or rented unit back to market." };
  }

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

  if (isStatusRegression(unit.status, status)) {
    await logEvent(supabase, {
      orgId: unit.org_id,
      actorId: profile.id,
      entityType: "property",
      entityId: unitId,
      eventType: "status_regression_override",
      payload: { from: unit.status, to: status },
    });
  }

  // DB-01's other leg: the prompt raised at deal-win completes the moment the
  // status it asked for is set (review 2026-09-01 — it used to stay open forever)
  const { completeListingStatusChecks } = await import("@/lib/services/followup-tasks");
  const closed = await completeListingStatusChecks(supabase, {
    propertyId: unitId,
    orgId: unit.org_id,
    actorId: profile.id,
    newStatus: status,
  });
  if (closed > 0) {
    revalidatePath("/tasks");
    revalidatePath("/dashboard");
  }

  if (unit.parent_id) revalidatePath(`/properties/${unit.parent_id}/units`);
  revalidatePath("/properties");
  return { error: null };
}

/**
 * Two layouts, one action. `layout` defaults to "floors" so every existing
 * caller — and the e2e that predates villas — parses unchanged. The floor
 * fields go optional because a villa form does not render them, and
 * `Object.fromEntries` simply omits what is not in the DOM.
 */
const generateUnitsSchema = z
  .object({
    project_id: z.guid("Missing project"),
    layout: z.enum(["floors", "villas"]).default("floors"),
    property_type: z.enum(PROPERTY_TYPES),
    // shared across both layouts
    bedrooms: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).optional()),
    bathrooms: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).optional()),
    covered_area_sqm: z.preprocess(emptyToUndefined, z.coerce.number().positive().optional()),
    base_price: z.preprocess(emptyToUndefined, z.coerce.number().positive().optional()),
    // floors
    block: z.preprocess(emptyToUndefined, z.string().max(20).optional()),
    floor_from: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).max(MAX_FLOOR).optional()),
    floor_to: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).max(MAX_FLOOR).optional()),
    per_floor: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(MAX_PER_FLOOR).optional()),
    start_index: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).max(MAX_PER_FLOOR).optional()),
    price_per_floor: z.preprocess(emptyToUndefined, z.coerce.number().min(0).optional()),
    // villas — capped by the run ceiling, never by MAX_PER_FLOOR, which is a
    // floor-scheme limit and has nothing to say about how many villas exist
    villa_count: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(MAX_GENERATED_UNITS).optional()),
    villa_prefix: z.preprocess(emptyToUndefined, z.string().max(10).optional()),
    start_number: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).optional()),
    plot_area_sqm: z.preprocess(emptyToUndefined, z.coerce.number().positive().optional()),
    price_per_villa: z.preprocess(emptyToUndefined, z.coerce.number().min(0).optional()),
  })
  .refine((d) => d.layout !== "floors" || (d.floor_from !== undefined && d.floor_to !== undefined && d.per_floor !== undefined), {
    message: "Floors from, floors to and units per floor are all required",
    path: ["floor_to"],
  })
  .refine((d) => d.layout !== "floors" || (d.floor_to ?? 0) >= (d.floor_from ?? 0), {
    message: "Top floor must not be below the bottom floor",
    path: ["floor_to"],
  })
  .refine((d) => d.layout !== "villas" || d.villa_count !== undefined, {
    message: "How many villas?",
    path: ["villa_count"],
  })
  .refine(
    (d) =>
      (d.layout === "villas"
        ? villaCount({ count: d.villa_count ?? 0 })
        : generatedCount({
            floorFrom: d.floor_from ?? 0,
            floorTo: d.floor_to ?? 0,
            perFloor: d.per_floor ?? 0,
          })) <= MAX_GENERATED_UNITS,
    {
      message: `That would create more than ${MAX_GENERATED_UNITS} units — narrow the range`,
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

  // The ONE dispatch point. Everything below — reference minting, the
  // collision pre-check, the insert and the per-unit events — is shared, which
  // is why the villa path is a second pure function rather than a second action.
  const generated =
    input.layout === "villas"
      ? generateVillaUnits({
          prefix: input.villa_prefix ?? null,
          count: input.villa_count ?? 0,
          startNumber: input.start_number,
          bedrooms: input.bedrooms ?? null,
          bathrooms: input.bathrooms ?? null,
          coveredAreaSqm: input.covered_area_sqm ?? null,
          plotAreaSqm: input.plot_area_sqm ?? null,
          basePrice: input.base_price ?? null,
          pricePerVilla: input.price_per_villa ?? null,
        })
      : generateUnits({
          block: input.block ?? null,
          floorFrom: input.floor_from ?? 0,
          floorTo: input.floor_to ?? 0,
          perFloor: input.per_floor ?? 0,
          startIndex: input.start_index,
          bedrooms: input.bedrooms ?? null,
          bathrooms: input.bathrooms ?? null,
          coveredAreaSqm: input.covered_area_sqm ?? null,
          basePrice: input.base_price ?? null,
          pricePerFloor: input.price_per_floor ?? null,
        });
  // The write lives in lib/services/unit-writer.ts, shared with the wizard's
  // create-and-generate path — one insert shape, one collision check, one
  // event statement, so the two callers cannot drift.
  const written = await writeGeneratedUnits(supabase, project, generated, {
    propertyType: input.property_type,
    actorId: profile.id,
  });
  if (written.error) return { error: written.error, savedAt: null };

  await refreshContainerScores(supabase, project.id);

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

  // a phase is not a unit, but the new row's own stored score starts at 0
  await refreshContainerScores(supabase, created.id);

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

const upliftSchema = z.object({
  project_id: z.guid("Missing project"),
  block: z.preprocess(emptyToUndefined, z.string().max(20).optional()),
  mode: z.enum(["percent", "fixed"]),
  amount: z.coerce.number().refine((n) => n !== 0, "Enter a change other than zero"),
  notes: z.preprocess(emptyToUndefined, z.string().max(200).optional()),
});

/**
 * Raise or cut a block's prices and mint the price-list version that records it
 * (BACKLOG audit finding 4, the other half).
 *
 * Reading a version shipped earlier; minting the next one still meant editing
 * sixty unit prices by hand and then snapshotting. "Raise the C block by 3% from
 * 1 September" is one sentence and is now one action.
 *
 * IT CHANGES THE UNITS AND THEN SNAPSHOTS, in that order and in one go. The
 * asking price IS the current price, so a version that recorded new numbers
 * while the units still held the old ones would be a lie in the record — and
 * the snapshot exists precisely to be quoted from later.
 *
 * Each unit keeps its own trail: the 0005 trigger writes a `price_history` row
 * per unit automatically, and a `price_changed` event per unit is written here.
 * A single project-level "repriced 60 units" row would leave sixty timelines
 * with an unexplained number.
 *
 * Unpriced units are skipped, never treated as zero — see `upliftPrice`.
 */
export async function applyPriceUplift(
  _prev: UnitActionState,
  formData: FormData,
): Promise<UnitActionState> {
  const parsed = upliftSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
  }
  const input = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: project } = await supabase
    .from("properties")
    .select("id, org_id, kind, reference")
    .eq("id", input.project_id)
    .maybeSingle();
  if (!project) return { error: "Project not found", savedAt: null };
  if (project.kind !== "project" && project.kind !== "phase") {
    return { error: "Prices are managed on a project", savedAt: null };
  }

  const { data: units } = await supabase
    .from("properties")
    .select("id, reference, block, asking_price")
    .eq("parent_id", input.project_id)
    .eq("kind", "unit");

  const targets = inScope(
    (units ?? []).map((u) => ({
      id: u.id,
      reference: u.reference,
      block: u.block,
      asking_price: u.asking_price,
    })),
    input.block ?? null,
  );
  if (targets.length === 0) {
    return { error: "No units in that scope", savedAt: null };
  }

  const preview = previewUplift(targets, {
    mode: input.mode as UpliftMode,
    amount: input.amount,
  });
  if (preview.rows.length === 0) {
    return {
      error:
        preview.skipped === targets.length
          ? "None of those units has a price to change."
          : "That change rounds to nothing — no price would move.",
      savedAt: null,
    };
  }

  // One update per unit: the prices differ per row, and the 0005 trigger has to
  // see each old→new pair to write its price_history entry.
  for (const row of preview.rows) {
    const { error } = await supabase
      .from("properties")
      .update({ asking_price: row.to })
      .eq("id", row.id);
    if (error) return { error: error.message, savedAt: null };
  }

  await logEvents(
    supabase,
    preview.rows.map((row) => ({
      orgId: project.org_id,
      actorId: profile.id,
      entityType: "property" as const,
      entityId: row.id,
      eventType: "price_changed",
      payload: {
        source: "bulk_uplift",
        from: row.from,
        to: row.to,
        mode: input.mode,
        amount: input.amount,
        scope: input.block ?? "all units",
        project: project.reference,
      },
    })),
  );

  // …then record it as a version, so the change is quotable later
  const label =
    input.mode === "percent"
      ? `${input.amount > 0 ? "+" : ""}${input.amount}%`
      : `${input.amount > 0 ? "+" : ""}${input.amount}`;
  const scope = input.block ? `block ${input.block}` : "all units";
  const snapshot = new FormData();
  snapshot.set("project_id", input.project_id);
  snapshot.set(
    "notes",
    input.notes ?? `${label} on ${scope} (${preview.rows.length} units)`,
  );
  const versioned = await createPriceListVersion(
    { error: null, savedAt: null },
    snapshot,
  );
  if (versioned.error) {
    // the prices ARE changed at this point; say so rather than implying a
    // rollback that did not happen
    return {
      error: `Prices updated, but the version was not created: ${versioned.error}`,
      savedAt: null,
    };
  }

  // A block reprice can bring buyers into range across several units. ONE task
  // against the project, not one per unit: it was one act and it is one phone
  // call. Best effort — the prices ARE changed and versioned by this point, so
  // an alert failure must never be reported as a failed reprice.
  try {
    const { raiseBulkPriceDropAlert } = await import("@/lib/services/match-alerts");
    const { data: projectRow } = await supabase
      .from("properties")
      .select("id, reference, assigned_agent_id")
      .eq("id", input.project_id)
      .single();
    if (projectRow) {
      await raiseBulkPriceDropAlert(supabase, {
        orgId: project.org_id,
        actorId: profile.id,
        project: projectRow,
        changes: preview.rows,
      });
    }
  } catch (err) {
    // logged, never swallowed — an earlier alert bug was invisible precisely
    // because a discarded error left nothing anywhere to say the feature had
    // stopped working
    console.error("bulk price-drop alert failed", { projectId: input.project_id, err });
  }

  revalidatePath(`/properties/${input.project_id}/units`);
  revalidatePath("/properties");
  return { error: null, savedAt: Date.now() };
}

const unitTypeSchema = z.object({
  project_id: z.guid("Missing project"),
  code: z
    .string()
    .trim()
    .min(1, "Type code is required")
    .max(10, "Keep the type code short")
    .regex(/^[A-Za-z0-9-]+$/, "Type code: letters, numbers and hyphens only"),
  name: z.preprocess(emptyToUndefined, z.string().max(80).optional()),
  bedrooms: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).max(20).optional()),
  bathrooms: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).max(20).optional()),
  covered_area_sqm: z.preprocess(emptyToUndefined, z.coerce.number().positive().optional()),
  veranda_sqm: z.preprocess(emptyToUndefined, z.coerce.number().positive().optional()),
  price_per_sqm: z.preprocess(emptyToUndefined, z.coerce.number().positive().optional()),
});

/**
 * Define a layout once (migration 0039).
 *
 * Scoped to the project: layout codes are a project's own vocabulary, and every
 * developer has an "A1" that is not the same flat.
 */
export async function createUnitType(
  _prev: UnitActionState,
  formData: FormData,
): Promise<UnitActionState> {
  const parsed = unitTypeSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
  }
  const input = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: project } = await supabase
    .from("properties")
    .select("id, org_id, kind, reference")
    .eq("id", input.project_id)
    .maybeSingle();
  if (!project) return { error: "Project not found", savedAt: null };
  if (project.kind !== "project" && project.kind !== "phase") {
    return { error: "Unit types belong to a project", savedAt: null };
  }

  const { data: created, error } = await supabase
    .from("unit_types")
    .insert({
      org_id: project.org_id,
      project_id: project.id,
      code: input.code.toUpperCase(),
      name: input.name ?? null,
      bedrooms: input.bedrooms ?? null,
      bathrooms: input.bathrooms ?? null,
      covered_area_sqm: input.covered_area_sqm ?? null,
      veranda_sqm: input.veranda_sqm ?? null,
      price_per_sqm: input.price_per_sqm ?? null,
      created_by: profile.id,
    })
    .select("id")
    .single();
  if (error) {
    return {
      error:
        error.code === "23505"
          ? `Type ${input.code.toUpperCase()} already exists on this project`
          : error.message,
      savedAt: null,
    };
  }

  await logEvent(supabase, {
    orgId: project.org_id,
    actorId: profile.id,
    entityType: "property",
    entityId: project.id,
    eventType: "unit_type_created",
    payload: { code: input.code.toUpperCase(), unit_type_id: created.id },
  });

  revalidatePath(`/properties/${project.id}/units`);
  return { error: null, savedAt: Date.now() };
}

/**
 * Stamp a layout onto the units in a scope (migration 0039).
 *
 * A STAMP, NOT A LINK. It copies the type's values now; the unit is not bound
 * to the type afterwards, so a later edit to either one does not chase the
 * other. That is deliberate — two units of one layout legitimately diverge, and
 * beds/area/price are in DELIBERATELY_NOT_INHERITED for exactly that reason.
 *
 * One update per unit, because a price change has to pass the 0005 trigger
 * old→new pair by pair for its price_history row.
 */
export async function applyUnitType(
  _prev: UnitActionState,
  formData: FormData,
): Promise<UnitActionState> {
  const projectId = formData.get("project_id");
  const typeId = formData.get("unit_type_id");
  const blockRaw = formData.get("block");
  if (typeof projectId !== "string" || typeof typeId !== "string") {
    return { error: "Missing project or type", savedAt: null };
  }
  const block = typeof blockRaw === "string" && blockRaw !== "" ? blockRaw : null;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: type } = await supabase
    .from("unit_types")
    .select("id, code, name, bedrooms, bathrooms, covered_area_sqm, veranda_sqm, price_per_sqm")
    .eq("id", typeId)
    .eq("project_id", projectId)
    .maybeSingle();
  if (!type) return { error: "Type not found on this project", savedAt: null };

  let query = supabase
    .from("properties")
    .select("id, reference, asking_price")
    .eq("parent_id", projectId)
    .eq("kind", "unit");
  if (block) query = query.eq("block", block);
  const { data: units } = await query;

  if (!units || units.length === 0) return { error: "No units in that scope", savedAt: null };

  const { data: project } = await supabase
    .from("properties")
    .select("org_id, reference")
    .eq("id", projectId)
    .single();

  const applied: { id: string; reference: string }[] = [];
  for (const u of units) {
    const stamp = stampOf(type as UnitType, u.asking_price);
    const { data: rows, error } = await supabase
      .from("properties")
      .update(stamp)
      .eq("id", u.id)
      .select("id");
    if (error) return { error: error.message, savedAt: null };
    if (rows && rows.length > 0) applied.push({ id: u.id, reference: u.reference });
  }

  if (applied.length === 0) {
    return {
      error: "Nothing was changed — only admins and listing managers manage units.",
      savedAt: null,
    };
  }

  await logEvents(
    supabase,
    applied.map((u) => ({
      orgId: project!.org_id,
      actorId: profile.id,
      entityType: "property" as const,
      entityId: u.id,
      eventType: "updated",
      payload: {
        section: "unit_type",
        source: "type_applied",
        unit_type: type.code,
        scope: block ?? "all units",
        project: project!.reference,
      },
    })),
  );

  revalidatePath(`/properties/${projectId}/units`);
  revalidatePath("/properties");
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
