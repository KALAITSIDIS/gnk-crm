"use server";

import * as Sentry from "@sentry/nextjs";
import { revalidatePath } from "next/cache";
import { NOT_RECORDED_NOTICE } from "@/lib/services/optimistic-save";
import { z } from "zod";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import { createClient } from "@/lib/supabase/server";
import {
  emptyToUndefined,
  isStatusRegression,
  measuredArea,
  measuredFloor,
  PROPERTY_STATUSES,
  PROPERTY_TYPES,
} from "@/lib/validators/properties";
import { AREA_LABELS } from "@/lib/validators/property-measurements";
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
import type { UpliftRow } from "@/lib/services/price-uplift";
import { certainlyRolledBack } from "@/lib/services/rpc-outcome";
import {
  PRICES_BUSY,
  PRICES_NOTHING_CHANGED,
  PRICES_OUT_OF_DATE,
  PRICES_STALE,
  PRICES_UNCONFIRMED,
} from "@/lib/validators/price-lists";
import {
  UNIT_TYPE_BUSY,
  UNIT_TYPE_NOTHING_CHANGED,
  UNIT_TYPE_OUT_OF_DATE,
  UNIT_TYPE_UNCONFIRMED,
} from "@/lib/validators/unit-types";

export type UnitActionState = {
  error: string | null;
  savedAt: number | null;
  /** a save that happened but could not be recorded in the timeline (OPS-01) */
  notice?: string | null;
  /** price-list actions (0141): the version this submission recorded */
  version?: number | null;
  /** price-list actions (0141): this answer repeats an earlier commit of the same submission */
  replayed?: boolean;
  /** price-list actions (0141): the outcome is unknown — the request may have committed */
  unconfirmed?: boolean;
  /**
   * applyUnitType (0142): THIS request met a lock (55P03) or lost a deadlock
   * (40P01) and wrote nothing — but an earlier request of the same submission
   * may still be running, so a form re-sending an unconfirmed submission
   * keeps treating it as unknown
   */
  busy?: boolean;
};

const createUnitSchema = z.object({
  project_id: z.string().uuid(),
  unit_number: z.string().trim().min(1, "Unit number is required").max(20),
  block: z.preprocess(emptyToUndefined, z.string().max(20).optional()),
  property_type: z.enum(PROPERTY_TYPES),
  bedrooms: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).optional()),
  bathrooms: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).optional()),
  // the property forms' measurement rules (LST-07): positive as stored,
  // blank = unknown; a floor may be 0 (ground) or negative (basement)
  covered_area_sqm: measuredArea(AREA_LABELS.covered_area_sqm),
  asking_price: z.preprocess(emptyToUndefined, z.coerce.number().positive().optional()),
  floor_number: measuredFloor,
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
    covered_area_sqm: measuredArea(AREA_LABELS.covered_area_sqm),
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
    plot_area_sqm: measuredArea(AREA_LABELS.plot_area_sqm),
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
  // Written but not recorded is a SAVE with a notice (OPS-01): an error would
  // invite a resubmit the unique reference index would refuse anyway.
  return { error: null, savedAt: Date.now(), notice: written.recorded ? null : NOT_RECORDED_NOTICE };
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

/* ------------------------------------------------------------------ */
/* Price-list versions and bulk repricing — ONE database transaction   */
/* (T-price-uplift-atomic, migration 0141).                            */
/*                                                                     */
/* Both actions call `record_price_list_version`, which locks the      */
/* project or phase, checks the caller, writes the units, the version, */
/* its items and its event, and either commits all of it or none. The */
/* per-unit trail (price_history + one `price_changed` event per unit) */
/* is written by trg_price_history (0005) inside that transaction —    */
/* the actions no longer write a second copy of it.                    */
/*                                                                     */
/* An operation id, minted by the form once per submission, makes a    */
/* retry answer what the first request committed ("replayed") instead */
/* of applying again. NEVER throws: Next strips a thrown Server Action */
/* message in production.                                              */
/* ------------------------------------------------------------------ */

const PRICE_LIST_RPC = "record_price_list_version";

/** What `record_price_list_version` answers when it did not raise (0141). */
type PriceListAnswer = {
  result: "applied" | "replayed" | "stale";
  kind: "snapshot" | "reprice";
  project_id: string;
  org_id?: string;
  actor_id?: string;
  version?: number;
  price_list_id?: string;
  units?: number;
  changed?: number;
  changes?: UpliftRow[];
};

function readPriceListAnswer(data: unknown): PriceListAnswer | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.result !== "applied" && d.result !== "replayed" && d.result !== "stale") return null;
  if (d.kind !== "snapshot" && d.kind !== "reprice") return null;
  if (typeof d.project_id !== "string") return null;
  if (d.result !== "stale" && typeof d.version !== "number") return null;
  return d as PriceListAnswer;
}

/** The answer's changes, only if every row has the shape the alert reads. */
function changesOf(answer: PriceListAnswer): UpliftRow[] | null {
  const rows = answer.changes;
  if (!Array.isArray(rows)) return null;
  const ok = rows.every(
    (r) =>
      r &&
      typeof r.id === "string" &&
      typeof r.reference === "string" &&
      typeof r.from === "number" &&
      typeof r.to === "number",
  );
  return ok ? rows : null;
}

/** The sentence for a request that did not commit — or might have (`unknown`). */
function priceListRefusal(error: { code?: string; message?: string }): { text: string; unknown: boolean } {
  // P0001 is `raise exception` — the function's own sentence, meant to be read
  if (error.code === "P0001" && error.message) return { text: error.message, unknown: false };
  // lock_timeout, or a deadlock with a writer that took the same units in
  // another order (0141's LOCKS): this side was rolled back, nothing written
  if (error.code === "55P03" || error.code === "40P01") return { text: PRICES_BUSY, unknown: false };
  return certainlyRolledBack(error.code)
    ? { text: PRICES_NOTHING_CHANGED, unknown: false }
    : { text: PRICES_UNCONFIRMED, unknown: true };
}

/**
 * The console line is for the runtime log; Sentry is where a human is paged.
 * SHAPE ONLY — the step and the error code or name, never a database message.
 */
function reportPriceList(message: string, tags: Record<string, string>, projectId: string): void {
  console.error(`${message} (${Object.values(tags).join(", ")}) for project ${projectId}`);
  try {
    Sentry.captureMessage(message, { level: "error", tags, extra: { projectId } });
  } catch {
    // Sentry is best-effort; the console line stands
  }
}

/**
 * After every DEFINITE answer, so the screen matches the rows; a failed
 * refresh never turns a commit into an error. NOT after an unconfirmed one:
 * the form keeps what it showed, so pressing again sends the same submission
 * and is answered with what was committed — a redraw would put the committed
 * prices in front of the same amount (review of T-price-uplift-atomic).
 */
function refreshPricePages(projectId: string): void {
  for (const path of [`/properties/${projectId}/units`, "/properties"]) {
    try {
      revalidatePath(path);
    } catch (e) {
      console.error(`[units] revalidatePath(${path}) failed:`, e instanceof Error ? e.message : e);
    }
  }
}

type PriceListCall = {
  p_project_id: string;
  p_operation_id: string;
  p_notes?: string;
  p_mode?: "percent" | "fixed";
  p_amount?: number;
  p_block?: string;
  p_expected?: { id: string; price: number | null }[];
};

/** One call of the function; every way it can end, classified. */
async function recordPriceList(
  call: PriceListCall,
): Promise<{ answer: PriceListAnswer; supabase: Awaited<ReturnType<typeof createClient>> } | { error: string; unknown: boolean }> {
  const step = call.p_mode ? "reprice" : "snapshot";
  let supabase: Awaited<ReturnType<typeof createClient>>;
  try {
    supabase = await createClient();
  } catch (e) {
    reportPriceList("price list: no client", { step, error: e instanceof Error ? e.name : "threw" }, call.p_project_id);
    return { error: PRICES_NOTHING_CHANGED, unknown: false };
  }
  let res: Awaited<ReturnType<typeof supabase.rpc<typeof PRICE_LIST_RPC>>>;
  try {
    res = await supabase.rpc(PRICE_LIST_RPC, call);
  } catch (e) {
    reportPriceList("price list: request threw", { step, error: e instanceof Error ? e.name : "threw" }, call.p_project_id);
    return { error: PRICES_UNCONFIRMED, unknown: true };
  }
  if (res.error) {
    const refusal = priceListRefusal(res.error);
    if (res.error.code !== "P0001") {
      reportPriceList("price list: not recorded", { step, code: res.error.code || "none" }, call.p_project_id);
    }
    return { error: refusal.text, unknown: refusal.unknown };
  }
  const answer = readPriceListAnswer(res.data);
  if (!answer) {
    reportPriceList("price list: unreadable answer", { step, code: "unreadable_answer" }, call.p_project_id);
    return { error: PRICES_UNCONFIRMED, unknown: true };
  }
  return { answer, supabase };
}

const operationId = z.guid(PRICES_OUT_OF_DATE);
const trimmedNote = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" ? v.trim() || undefined : emptyToUndefined(v)),
    z.string().max(max, `Keep the version note under ${max} characters`).optional(),
  );

const snapshotSchema = z.object({
  project_id: z.guid("Missing project"),
  notes: trimmedNote(2000),
  operation_id: operationId,
});

/**
 * "New version": snapshot every priced unit of the project or phase as the
 * next price-list version — header, items and event in ONE transaction, the
 * version number taken under the project's lock (0141).
 */
export async function createPriceListVersion(
  _prev: UnitActionState,
  formData: FormData,
): Promise<UnitActionState> {
  const parsed = snapshotSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
  }
  const input = parsed.data;

  const outcome = await recordPriceList({
    p_project_id: input.project_id,
    p_operation_id: input.operation_id,
    p_notes: input.notes,
  });
  if ("error" in outcome) {
    // unconfirmed: no refresh — the form re-sends this same submission (header)
    return outcome.unknown
      ? { error: outcome.error, savedAt: null, unconfirmed: true }
      : { error: outcome.error, savedAt: null };
  }
  const { answer } = outcome;
  refreshPricePages(input.project_id);
  if (answer.result === "stale") {
    // a plain snapshot reviews nothing — unreachable, but never reported as saved
    return { error: PRICES_NOTHING_CHANGED, savedAt: null };
  }
  return {
    error: null,
    savedAt: Date.now(),
    version: answer.version ?? null,
    replayed: answer.result === "replayed",
  };
}

/** The scope the form previewed, as it sent it: every unit, with the price it showed. */
const reviewedField = z
  .string(PRICES_OUT_OF_DATE)
  .transform((s, ctx) => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      ctx.addIssue({ code: "custom", message: PRICES_OUT_OF_DATE });
      return z.NEVER;
    }
  })
  .pipe(
    z
      .array(
        z.object(
          {
            id: z.guid(PRICES_OUT_OF_DATE),
            price: z.number(PRICES_OUT_OF_DATE).nonnegative(PRICES_OUT_OF_DATE).nullable(),
          },
          PRICES_OUT_OF_DATE,
        ),
        PRICES_OUT_OF_DATE,
      )
      .max(10000, PRICES_OUT_OF_DATE),
  );

const upliftSchema = z.object({
  project_id: z.guid("Missing project"),
  block: z.preprocess(emptyToUndefined, z.string().max(20).optional()),
  mode: z.enum(["percent", "fixed"]),
  amount: z.coerce.number().refine((n) => n !== 0, "Enter a change other than zero"),
  notes: trimmedNote(200),
  operation_id: operationId,
  expected: reviewedField,
});

/**
 * Raise or cut a block's prices and mint the price-list version that records it
 * (BACKLOG audit finding 4, the other half).
 *
 * Reading a version shipped earlier; minting the next one still meant editing
 * sixty unit prices by hand and then snapshotting. "Raise the C block by 3%
 * from 1 September" is one sentence and is one action.
 *
 * ONE TRANSACTION (0141). The units change and the version that records them
 * commits with them, or nothing does — the asking price IS the current price,
 * and a version is quoted from later. The database applies the change only to
 * the prices the form showed: if any unit in the scope has moved, been added,
 * archived or removed since the preview was drawn, it answers `stale` and
 * changes nothing. Each unit keeps its own trail: trg_price_history writes one
 * price_history row and one `price_changed` event per unit that actually moves;
 * the version's `price_list_created` event carries the operation (mode, amount,
 * scope, how many changed). Unpriced units are skipped, never treated as zero.
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

  const outcome = await recordPriceList({
    p_project_id: input.project_id,
    p_operation_id: input.operation_id,
    p_notes: input.notes,
    p_mode: input.mode,
    p_amount: input.amount,
    p_block: input.block,
    p_expected: input.expected,
  });
  if ("error" in outcome) {
    // unconfirmed: no refresh — the form re-sends this same submission (header)
    return outcome.unknown
      ? { error: outcome.error, savedAt: null, unconfirmed: true }
      : { error: outcome.error, savedAt: null };
  }
  const { answer, supabase } = outcome;

  if (answer.result === "stale") {
    // nothing was written; the refresh redraws the preview from the current prices
    refreshPricePages(input.project_id);
    return { error: PRICES_STALE, savedAt: null };
  }

  {
    // A block reprice can bring buyers into range across several units. ONE
    // task against the project, not one per unit: it was one act and it is one
    // phone call. Best effort — the prices ARE changed and versioned here, so
    // an alert failure is never reported as a failed reprice. A REPLAY raises
    // it too, from the changes the database read back out of price_history:
    // the request that committed may have lost its answer before it got this
    // far, and the alert's own guard (one open task per project) keeps a
    // repeat from raising a second task.
    try {
      const changes = changesOf(answer);
      if (!changes) throw new Error("the answer carried no readable changes");
      const { raiseBulkPriceDropAlert } = await import("@/lib/services/match-alerts");
      const { data: projectRow, error: projectErr } = await supabase
        .from("properties")
        .select("id, reference, assigned_agent_id")
        .eq("id", input.project_id)
        .single();
      if (projectErr) throw new Error(`project read: ${projectErr.code || projectErr.message}`);
      if (projectRow && answer.org_id && answer.actor_id) {
        await raiseBulkPriceDropAlert(supabase, {
          orgId: answer.org_id,
          actorId: answer.actor_id,
          project: projectRow,
          changes,
        });
      }
    } catch (err) {
      // logged, never swallowed — an earlier alert bug was invisible precisely
      // because a discarded error left nothing anywhere to say the feature had
      // stopped working
      console.error("bulk price-drop alert failed", { projectId: input.project_id, err });
    }
  }

  refreshPricePages(input.project_id);
  return {
    error: null,
    savedAt: Date.now(),
    version: answer.version ?? null,
    replayed: answer.result === "replayed",
  };
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
  // stamped onto units by applyUnitType, so it obeys the units' own rule
  covered_area_sqm: measuredArea(AREA_LABELS.covered_area_sqm),
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

/* ------------------------------------------------------------------ */
/* Applying a unit type — ONE database transaction                     */
/* (T-unit-type-apply-atomic, migration 0142).                         */
/* ------------------------------------------------------------------ */

const UNIT_TYPE_RPC = "apply_unit_type";

/** What `apply_unit_type` answers when it did not raise (0142). */
type UnitTypeAnswer = {
  result: "applied" | "replayed";
  project_id: string;
  units: number;
  price_changed: number;
};

function readUnitTypeAnswer(data: unknown): UnitTypeAnswer | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.result !== "applied" && d.result !== "replayed") return null;
  if (typeof d.project_id !== "string" || typeof d.units !== "number") return null;
  return d as UnitTypeAnswer;
}

/** The sentence for a request that did not commit — or might have (`unknown`). */
function unitTypeRefusal(error: { code?: string; message?: string }): { text: string; unknown: boolean; busy?: true } {
  // P0001 is `raise exception` — the function's own sentence, meant to be read
  if (error.code === "P0001" && error.message) return { text: error.message, unknown: false };
  // lock_timeout (the function's own 3 s), or a deadlock with a writer that
  // took the same units in another order (0142's LOCKS): THIS request wrote
  // nothing (flagged: an earlier request of the same submission may still be
  // in flight — the form decides)
  if (error.code === "55P03" || error.code === "40P01") return { text: UNIT_TYPE_BUSY, unknown: false, busy: true };
  return certainlyRolledBack(error.code)
    ? { text: UNIT_TYPE_NOTHING_CHANGED, unknown: false }
    : { text: UNIT_TYPE_UNCONFIRMED, unknown: true };
}

/** Shape only — the step and the error code or name, never a database message. */
function reportUnitType(message: string, tags: Record<string, string>, projectId: string): void {
  console.error(`${message} (${Object.values(tags).join(", ")}) for project ${projectId}`);
  try {
    Sentry.captureMessage(message, { level: "error", tags, extra: { projectId } });
  } catch {
    // Sentry is best-effort; the console line stands
  }
}

const applyUnitTypeSchema = z.object({
  project_id: z.guid("Missing project or type"),
  unit_type_id: z.guid("Missing project or type"),
  block: z.preprocess(emptyToUndefined, z.string().max(20, "No units in that scope").optional()),
  operation_id: z.guid(UNIT_TYPE_OUT_OF_DATE),
});

/**
 * Stamp a layout onto the units in a scope (migrations 0039, 0142).
 *
 * A STAMP, NOT A LINK. It copies the type's values now; the unit is not bound
 * to the type afterwards, so a later edit to either one does not chase the
 * other. That is deliberate — two units of one layout legitimately diverge, and
 * beds/area/price are in DELIBERATELY_NOT_INHERITED for exactly that reason.
 *
 * ONE TRANSACTION (0142). `apply_unit_type` checks the caller (admin or
 * listing manager, aal2, active), locks the project, the type and every unit
 * in scope, stamps them in one statement and writes one `updated` line per
 * unit — or nothing at all. A type with no rate leaves each price as the
 * database holds it; nothing this action read is written back. Each unit whose
 * price moves keeps its own trail (trg_price_history, 0005).
 *
 * An operation id, minted by the form once per submission, makes a retry
 * answer what the first request committed ("replayed") instead of applying
 * again. NEVER throws: Next strips a thrown Server Action message in
 * production, and an unknown outcome must say so rather than "nothing changed".
 */
export async function applyUnitType(
  _prev: UnitActionState,
  formData: FormData,
): Promise<UnitActionState> {
  const parsed = applyUnitTypeSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
  }
  const input = parsed.data;

  let supabase: Awaited<ReturnType<typeof createClient>>;
  try {
    supabase = await createClient();
  } catch (e) {
    reportUnitType("unit type: no client", { error: e instanceof Error ? e.name : "threw" }, input.project_id);
    return { error: UNIT_TYPE_NOTHING_CHANGED, savedAt: null };
  }

  let res: Awaited<ReturnType<typeof supabase.rpc<typeof UNIT_TYPE_RPC>>>;
  try {
    res = await supabase.rpc(UNIT_TYPE_RPC, {
      p_project_id: input.project_id,
      p_unit_type_id: input.unit_type_id,
      p_operation_id: input.operation_id,
      p_block: input.block,
    });
  } catch (e) {
    // the request may have reached the database and committed; no refresh —
    // the form re-sends this same submission (lib/utils/operation-id.ts)
    reportUnitType("unit type: request threw", { error: e instanceof Error ? e.name : "threw" }, input.project_id);
    return { error: UNIT_TYPE_UNCONFIRMED, savedAt: null, unconfirmed: true };
  }
  if (res.error) {
    const refusal = unitTypeRefusal(res.error);
    if (res.error.code !== "P0001") {
      reportUnitType("unit type: not applied", { code: res.error.code || "none" }, input.project_id);
    }
    if (refusal.unknown) return { error: refusal.text, savedAt: null, unconfirmed: true };
    return refusal.busy ? { error: refusal.text, savedAt: null, busy: true } : { error: refusal.text, savedAt: null };
  }
  const answer = readUnitTypeAnswer(res.data);
  if (!answer) {
    reportUnitType("unit type: unreadable answer", { code: "unreadable_answer" }, input.project_id);
    return { error: UNIT_TYPE_UNCONFIRMED, savedAt: null, unconfirmed: true };
  }

  // committed: a failed refresh never turns the commit into an error
  for (const path of [`/properties/${input.project_id}/units`, "/properties"]) {
    try {
      revalidatePath(path);
    } catch (e) {
      console.error(`[units] revalidatePath(${path}) failed:`, e instanceof Error ? e.message : e);
    }
  }
  return { error: null, savedAt: Date.now(), replayed: answer.result === "replayed" };
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
