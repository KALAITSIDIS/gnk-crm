"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import { createClient } from "@/lib/supabase/server";
import {
  emptyToUndefined,
  PROPERTY_STATUSES,
  PROPERTY_TYPES,
} from "@/lib/validators/properties";

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

  const { data: project } = await supabase
    .from("properties")
    .select("id, org_id, kind, reference, district_id, area_id, address, postal_code, transaction_type")
    .eq("id", input.project_id)
    .maybeSingle();
  if (!project) return { error: "Project not found", savedAt: null };
  if (project.kind !== "project" && project.kind !== "phase") {
    return { error: "Units can only be added to a project", savedAt: null };
  }

  // Unit reference per doc 02 §A6: parent ref + unit number (GNK-PAF-0007-B203)
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
      transaction_type: project.transaction_type,
      // units inherit location from the parent (doc 02 §C1)
      district_id: project.district_id,
      area_id: project.area_id,
      address: project.address,
      postal_code: project.postal_code,
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
    payload: { reference, kind: "unit", parent: project.reference },
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
