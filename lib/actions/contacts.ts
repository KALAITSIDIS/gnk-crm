"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import { normalizePhone } from "@/lib/services/phone";
import { createClient } from "@/lib/supabase/server";
import { createContactSchema } from "@/lib/validators/contacts";

export interface DuplicateMatch {
  id: string;
  display_name: string;
  matched_on: "phone" | "email";
}

export type ContactActionState = {
  error: string | null;
  duplicate: DuplicateMatch | null;
};

/** Live dedup check used by the create form (doc 02 §C3). */
export async function checkContactDuplicate(
  phone: string | null,
  email: string | null,
): Promise<DuplicateMatch | null> {
  const supabase = await createClient();

  const e164 = phone ? (normalizePhone(phone)?.e164 ?? null) : null;
  if (e164) {
    const { data } = await supabase
      .from("contacts")
      .select("id, display_name")
      .eq("phone_e164", e164)
      .eq("is_archived", false)
      .limit(1);
    if (data?.[0]) {
      return { id: data[0].id, display_name: data[0].display_name ?? "Unnamed", matched_on: "phone" };
    }
  }
  if (email) {
    const { data } = await supabase
      .from("contacts")
      .select("id, display_name")
      .eq("email", email.toLowerCase().trim())
      .eq("is_archived", false)
      .limit(1);
    if (data?.[0]) {
      return { id: data[0].id, display_name: data[0].display_name ?? "Unnamed", matched_on: "email" };
    }
  }
  return null;
}

export async function createContact(
  _prev: ContactActionState,
  formData: FormData,
): Promise<ContactActionState> {
  const parsed = createContactSchema.safeParse({
    ...Object.fromEntries(formData.entries()),
    languages: formData.getAll("languages").map(String),
    contact_types: formData.getAll("contact_types").map(String),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", duplicate: null };
  }
  const input = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  // phone-first normalization + dedup (doc 02 §A12/§C3)
  let phoneE164: string | null = null;
  if (input.phone) {
    const normalized = normalizePhone(input.phone);
    if (!normalized) {
      return { error: "Phone number is not valid", duplicate: null };
    }
    phoneE164 = normalized.e164;
  }

  const duplicate = await checkContactDuplicate(input.phone ?? null, input.email ?? null);
  if (duplicate) {
    return {
      error: `Duplicate: a contact with this ${duplicate.matched_on} already exists`,
      duplicate,
    };
  }

  const { data: created, error: insertErr } = await supabase
    .from("contacts")
    .insert({
      org_id: profile.orgId,
      contact_kind: input.contact_kind,
      first_name: input.first_name ?? null,
      last_name: input.last_name ?? null,
      company_name: input.company_name ?? null,
      phone_e164: phoneE164,
      phone_raw: input.phone ?? null,
      email: input.email ?? null,
      telegram_username: input.telegram_username ?? null,
      has_whatsapp: input.has_whatsapp,
      languages: input.languages.length ? input.languages : ["en"],
      nationality: input.nationality ?? null,
      contact_types: input.contact_types,
      temperature: input.temperature,
      source: input.source ?? null,
      source_detail: input.source_detail ?? null,
      psychology: input.psychology ?? null,
      consent_marketing: input.consent_marketing,
      consent_at: input.consent_marketing ? new Date().toISOString() : null,
      notes: input.notes ?? null,
      assigned_agent_id: profile.role === "agent" ? profile.id : null,
      created_by: profile.id,
    })
    .select("id")
    .single();
  if (insertErr) {
    // race with the unique index — surface as a duplicate rather than a raw error
    if (insertErr.code === "23505") {
      const race = await checkContactDuplicate(input.phone ?? null, input.email ?? null);
      return { error: "Duplicate: this phone already exists", duplicate: race };
    }
    return { error: insertErr.message, duplicate: null };
  }

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "contact",
    entityId: created.id,
    eventType: "created",
    payload: { phone: phoneE164, email: input.email ?? null },
  });

  revalidatePath("/contacts");
  redirect(`/contacts/${created.id}`);
}
