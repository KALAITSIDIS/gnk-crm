"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import { generateReference } from "@/lib/services/reference";
import { createClient } from "@/lib/supabase/server";
import { createPropertySchema } from "@/lib/validators/properties";

export type PropertyActionState = { error: string | null };

export async function createProperty(
  _prev: PropertyActionState,
  formData: FormData,
): Promise<PropertyActionState> {
  const parsed = createPropertySchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const input = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  if (!["admin", "listing_manager", "agent"].includes(profile.role)) {
    return { error: "Your role cannot create properties" };
  }

  const { data: district, error: districtErr } = await supabase
    .from("districts")
    .select("code")
    .eq("id", input.district_id)
    .single();
  if (districtErr || !district) return { error: "District not found" };

  // Reference is generated here — at final submit, atomically with the insert —
  // so abandoned wizards never burn sequence numbers (DECISIONS.md, T1.2).
  const reference = await generateReference(supabase, profile.orgId, district.code);

  const { data: created, error: insertErr } = await supabase
    .from("properties")
    .insert({
      org_id: profile.orgId,
      reference,
      kind: input.kind,
      property_type: input.property_type,
      transaction_type: input.transaction_type,
      district_id: input.district_id,
      area_id: input.area_id ?? null,
      title: input.title_en ? { en: input.title_en } : {},
      address: input.address ?? null,
      asking_price: input.asking_price ?? null,
      rent_price_month: input.rent_price_month ?? null,
      bedrooms: input.bedrooms ?? null,
      bathrooms: input.bathrooms ?? null,
      covered_area_sqm: input.covered_area_sqm ?? null,
      plot_area_sqm: input.plot_area_sqm ?? null,
      internal_notes: input.internal_notes ?? null,
      // agents are auto-assigned to themselves (RLS with-check enforces it)
      assigned_agent_id: profile.role === "agent" ? profile.id : null,
      created_by: profile.id,
    })
    .select("id")
    .single();
  if (insertErr || !created) {
    return { error: insertErr?.message ?? "Insert failed" };
  }

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "property",
    entityId: created.id,
    eventType: "created",
    payload: {
      reference,
      kind: input.kind,
      property_type: input.property_type,
    },
  });

  revalidatePath("/properties");
  redirect(`/properties/${created.id}`);
}
