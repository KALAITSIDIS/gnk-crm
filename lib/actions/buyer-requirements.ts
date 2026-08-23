"use server";

import { revalidatePath } from "next/cache";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import { createClient } from "@/lib/supabase/server";
import {
  archiveBuyerRequirementSchema,
  deleteBuyerRequirementSchema,
  saveBuyerRequirementSchema,
} from "@/lib/validators/buyer-requirements";

/**
 * Saved buyer searches (0043, T-B3).
 *
 * EVENTS ARE WRITTEN AGAINST THE CONTACT, not against the requirement.
 * `ENTITY_TYPES` in lib/services/events.ts has no `buyer_requirement` member,
 * and adding one would put a requirement's history on a timeline nobody opens.
 * The buyer's timeline is where "they started looking for a bigger plot"
 * belongs, so `entity_type: "contact"` with the contact's id it is.
 *
 * Guardrail 1: every mutation here writes its event.
 */

export type RequirementActionState = { error: string | null; savedAt: number | null };

const ok = (): RequirementActionState => ({ error: null, savedAt: Date.now() });
const fail = (error: string): RequirementActionState => ({ error, savedAt: null });

/** Re-render both surfaces a requirement can appear on. */
function revalidateFor(contactId: string) {
  revalidatePath(`/contacts/${contactId}`);
  revalidatePath("/contacts");
}

/**
 * Create a requirement, or edit one in place.
 *
 * The contact is re-read under RLS before anything is written: a form can post
 * any `contact_id`, and while RLS would refuse the insert anyway, failing here
 * gives the user a sentence instead of a driver error.
 */
export async function saveBuyerRequirement(
  _prev: RequirementActionState,
  formData: FormData,
): Promise<RequirementActionState> {
  const parsed = saveBuyerRequirementSchema.safeParse({
    ...Object.fromEntries(formData.entries()),
    // repeated keys are lost by fromEntries — it keeps only the last value
    property_types: formData.getAll("property_types").map(String).filter(Boolean),
    district_ids: formData.getAll("district_ids").map(String).filter(Boolean),
    area_ids: formData.getAll("area_ids").map(String).filter(Boolean),
    features_required: formData.getAll("features_required").map(String).filter(Boolean),
  });
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid requirement");
  }
  const d = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: contact } = await supabase
    .from("contacts")
    .select("id, display_name")
    .eq("id", d.contact_id)
    .maybeSingle();
  if (!contact) return fail("That contact is no longer available to you.");

  const row = {
    org_id: profile.orgId,
    contact_id: d.contact_id,
    label: d.label ?? null,
    transaction_type: d.transaction_type,
    property_types: d.property_types,
    district_ids: d.district_ids,
    area_ids: d.area_ids,
    budget_min: d.budget_min ?? null,
    budget_max: d.budget_max ?? null,
    bedrooms_min: d.bedrooms_min ?? null,
    bedrooms_max: d.bedrooms_max ?? null,
    bathrooms_min: d.bathrooms_min ?? null,
    covered_area_min_sqm: d.covered_area_min_sqm ?? null,
    plot_area_min_sqm: d.plot_area_min_sqm ?? null,
    title_deed_required: d.title_deed_required,
    vat_preference: d.vat_preference ?? null,
    max_sea_distance_m: d.max_sea_distance_m ?? null,
    delivery_by: d.delivery_by ?? null,
    features_required: d.features_required,
    notes: d.notes ?? null,
  };

  if (d.requirement_id) {
    const { data: existing } = await supabase
      .from("buyer_requirements")
      .select("id, contact_id")
      .eq("id", d.requirement_id)
      .maybeSingle();
    if (!existing) return fail("That requirement no longer exists.");
    // A requirement cannot be moved to another buyer by posting a different
    // contact_id — that would silently reassign someone else's search.
    if (existing.contact_id !== d.contact_id) {
      return fail("A requirement cannot be moved to another contact.");
    }

    const { data: updated, error } = await supabase
      .from("buyer_requirements")
      .update({ ...row, updated_at: new Date().toISOString() })
      .eq("id", d.requirement_id)
      .select("id");
    if (error) return fail(error.message);
    if (!updated?.length) return fail("Requirement changed underneath — refresh and retry.");

    await logEvent(supabase, {
      orgId: profile.orgId,
      actorId: profile.id,
      entityType: "contact",
      entityId: d.contact_id,
      eventType: "requirement_updated",
      payload: { requirement_id: d.requirement_id, label: d.label ?? null },
    });
    revalidateFor(d.contact_id);
    return ok();
  }

  const { data: created, error } = await supabase
    .from("buyer_requirements")
    .insert({ ...row, created_by: profile.id })
    .select("id")
    .single();
  if (error) return fail(error.message);

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "contact",
    entityId: d.contact_id,
    eventType: "requirement_added",
    payload: { requirement_id: created.id, label: d.label ?? null },
  });
  revalidateFor(d.contact_id);
  return ok();
}

/**
 * Archive or restore. This is the normal way a search is retired — any agent
 * may do it, and the row survives so "they used to want a 2-bed" stays true.
 */
export async function setBuyerRequirementActive(
  _prev: RequirementActionState,
  formData: FormData,
): Promise<RequirementActionState> {
  const parsed = archiveBuyerRequirementSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) return fail("Invalid request");
  const { requirement_id, is_active } = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: existing } = await supabase
    .from("buyer_requirements")
    .select("id, contact_id, label")
    .eq("id", requirement_id)
    .maybeSingle();
  if (!existing) return fail("That requirement no longer exists.");

  const { data: updated, error } = await supabase
    .from("buyer_requirements")
    .update({ is_active, updated_at: new Date().toISOString() })
    .eq("id", requirement_id)
    .select("id");
  if (error) return fail(error.message);
  if (!updated?.length) return fail("Requirement changed underneath — refresh and retry.");

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "contact",
    entityId: existing.contact_id,
    eventType: is_active ? "requirement_restored" : "requirement_archived",
    payload: { requirement_id, label: existing.label },
  });
  revalidateFor(existing.contact_id);
  return ok();
}

/**
 * Hard delete — admin and listing manager only, matching the RLS policy.
 *
 * RLS filters a denied DELETE to zero rows rather than erroring, so a plain
 * "no error" here would report success while nothing happened. The row count
 * is the check, and RLS test 30 pins the same distinction.
 */
export async function deleteBuyerRequirement(
  _prev: RequirementActionState,
  formData: FormData,
): Promise<RequirementActionState> {
  const parsed = deleteBuyerRequirementSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) return fail("Invalid request");
  const { requirement_id } = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: existing } = await supabase
    .from("buyer_requirements")
    .select("id, contact_id, label")
    .eq("id", requirement_id)
    .maybeSingle();
  if (!existing) return fail("That requirement no longer exists.");

  const { error, count } = await supabase
    .from("buyer_requirements")
    .delete({ count: "exact" })
    .eq("id", requirement_id);
  if (error) return fail(error.message);
  if (!count) {
    return fail("Only an admin or listing manager can delete a requirement. Archive it instead.");
  }

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "contact",
    entityId: existing.contact_id,
    eventType: "requirement_deleted",
    payload: { requirement_id, label: existing.label },
  });
  revalidateFor(existing.contact_id);
  return ok();
}
