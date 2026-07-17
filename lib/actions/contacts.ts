"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { Database } from "@/lib/supabase/database.types";
import { KYC_ITEMS } from "@/lib/constants/checklists";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import { recomputeDealsFor } from "@/lib/services/health-score";
import { normalizePhone } from "@/lib/services/phone";
import { createClient } from "@/lib/supabase/server";
import { changedValue } from "@/lib/utils/diff";
import {
  bankingReadinessSchema,
  contactPreferencesSchema,
  createContactSchema,
  kycStateSchema,
} from "@/lib/validators/contacts";

export interface DuplicateMatch {
  id: string;
  display_name: string;
  matched_on: "phone" | "email";
}

export type ContactActionState = {
  error: string | null;
  duplicate: DuplicateMatch | null;
};

const sorted = (values: string[]) => [...values].sort();

/** Live dedup check used by the create form (doc 02 §C3). Also matches numbers
 *  parked in `additional_phones` (e.g. inherited through a merge). */
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
      .or(`phone_e164.eq.${e164},additional_phones.cs.{"${e164}"}`)
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
      languages: sorted(input.languages.length ? input.languages : ["en"]),
      nationality: input.nationality ?? null,
      contact_types: sorted(input.contact_types),
      temperature: input.temperature,
      source: input.source ?? null,
      source_detail: input.source_detail ?? null,
      preferred_channel: input.preferred_channel ?? null,
      psychology: input.psychology ?? null,
      consent_marketing: input.consent_marketing,
      consent_at: input.consent_marketing ? new Date().toISOString() : null,
      gdpr_notes: input.gdpr_notes ?? null,
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

export type ContactSectionState = { error: string | null; savedAt: number | null };

export async function updateContactSection(
  _prev: ContactSectionState,
  formData: FormData,
): Promise<ContactSectionState> {
  const contactId = formData.get("contact_id");
  const section = formData.get("section");
  if (
    typeof contactId !== "string" ||
    !z.guid().safeParse(contactId).success ||
    typeof section !== "string"
  ) {
    return { error: "Missing contact or section", savedAt: null };
  }

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: current } = await supabase
    .from("contacts")
    .select("*")
    .eq("id", contactId)
    .maybeSingle();
  if (!current) return { error: "Contact not found", savedAt: null };
  if (current.is_archived) {
    return { error: "This contact is archived — unarchive it before editing.", savedAt: null };
  }

  const raw = Object.fromEntries(formData.entries());
  let updates: Database["public"]["Tables"]["contacts"]["Update"];

  if (section === "profile") {
    const parsed = createContactSchema.safeParse({
      ...raw,
      languages: formData.getAll("languages").map(String),
      contact_types: formData.getAll("contact_types").map(String),
    });
    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
    }
    const d = parsed.data;

    let phoneE164: string | null = null;
    if (d.phone) {
      const normalized = normalizePhone(d.phone);
      if (!normalized) return { error: "Phone number is not valid", savedAt: null };
      phoneE164 = normalized.e164;
      if (phoneE164 !== current.phone_e164) {
        const { data: dup } = await supabase
          .from("contacts")
          .select("id, display_name")
          .or(`phone_e164.eq.${phoneE164},additional_phones.cs.{"${phoneE164}"}`)
          .eq("is_archived", false)
          .neq("id", contactId)
          .limit(1);
        if (dup?.[0]) {
          return { error: `Duplicate phone — belongs to ${dup[0].display_name}`, savedAt: null };
        }
      }
    }
    const email = d.email ?? null;
    if (email && email !== current.email) {
      const { data: dup } = await supabase
        .from("contacts")
        .select("id, display_name")
        .eq("email", email)
        .eq("is_archived", false)
        .neq("id", contactId)
        .limit(1);
      if (dup?.[0]) {
        return { error: `Duplicate email — belongs to ${dup[0].display_name}`, savedAt: null };
      }
    }

    const consentChanged = d.consent_marketing !== current.consent_marketing;
    updates = {
      contact_kind: d.contact_kind,
      first_name: d.first_name ?? null,
      last_name: d.last_name ?? null,
      company_name: d.company_name ?? null,
      phone_e164: phoneE164,
      phone_raw: d.phone ?? null,
      email,
      telegram_username: d.telegram_username ?? null,
      has_whatsapp: d.has_whatsapp,
      languages: sorted(d.languages.length ? d.languages : ["en"]),
      nationality: d.nationality ?? null,
      contact_types: sorted(d.contact_types),
      temperature: d.temperature,
      source: d.source ?? null,
      source_detail: d.source_detail ?? null,
      preferred_channel: d.preferred_channel ?? null,
      psychology: d.psychology ?? null,
      consent_marketing: d.consent_marketing,
      // consent timestamp only moves when the flag flips (doc 02 §C3)
      consent_at: consentChanged
        ? d.consent_marketing
          ? new Date().toISOString()
          : null
        : current.consent_at,
      gdpr_notes: d.gdpr_notes ?? null,
      notes: d.notes ?? null,
      // reassignment is an admin call (doc 04: agents only ever hold their own)
      assigned_agent_id:
        profile.role === "admin" ? (d.assigned_agent_id ?? null) : current.assigned_agent_id,
    };
  } else if (section === "preferences") {
    const parsed = contactPreferencesSchema.safeParse({
      areas: formData.getAll("pref_areas").map(String).filter(Boolean),
      budget_min: raw.budget_min,
      budget_max: raw.budget_max,
      bedrooms_min: raw.bedrooms_min,
      property_types: formData.getAll("pref_property_types").map(String).filter(Boolean),
      purpose: typeof raw.purpose === "string" ? raw.purpose : undefined,
    });
    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? "Invalid preferences", savedAt: null };
    }
    updates = { preferences: JSON.parse(JSON.stringify(parsed.data)) };
  } else if (section === "kyc_banking") {
    const kyc: Record<string, { done: boolean; note?: string; doc_link?: string }> = {};
    for (const [key] of KYC_ITEMS) {
      const done = raw[`kyc_${key}_done`] === "on";
      const note =
        typeof raw[`kyc_${key}_note`] === "string" ? String(raw[`kyc_${key}_note`]).trim() : "";
      const docLink =
        typeof raw[`kyc_${key}_doc`] === "string" ? String(raw[`kyc_${key}_doc`]).trim() : "";
      if (done || note || docLink) {
        kyc[key] = {
          done,
          ...(note ? { note } : {}),
          ...(docLink ? { doc_link: docLink } : {}),
        };
      }
    }
    const feasibility = typeof raw.account_feasibility === "string" ? raw.account_feasibility : "";
    const banking = {
      nationality_risk_note:
        typeof raw.nationality_risk_note === "string" && raw.nationality_risk_note.trim()
          ? raw.nationality_risk_note.trim()
          : undefined,
      funds_origin_country:
        typeof raw.funds_origin_country === "string" && raw.funds_origin_country.trim()
          ? raw.funds_origin_country.trim()
          : undefined,
      bank_pre_check_done: raw.bank_pre_check_done === "on" ? (true as const) : undefined,
      account_feasibility: ["yes", "maybe", "no"].includes(feasibility)
        ? (feasibility as "yes" | "maybe" | "no")
        : undefined,
    };
    const kycParsed = kycStateSchema.safeParse(kyc);
    const bankingParsed = bankingReadinessSchema.safeParse(banking);
    if (!kycParsed.success || !bankingParsed.success) {
      return { error: "Invalid checklist input", savedAt: null };
    }
    updates = {
      kyc: JSON.parse(JSON.stringify(kycParsed.data)),
      banking_readiness: JSON.parse(JSON.stringify(bankingParsed.data)),
    };
  } else {
    return { error: `Unknown section: ${section}`, savedAt: null };
  }

  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, next] of Object.entries(updates)) {
    const prev = (current as Record<string, unknown>)[key];
    if (changedValue(prev, next)) changed[key] = { from: prev ?? null, to: next ?? null };
  }
  if (Object.keys(changed).length === 0) return { error: null, savedAt: Date.now() };

  // RLS filters forbidden updates to 0 rows — the returned rows are the proof
  // (doc 04: agents update own/created contacts only, listing managers none)
  const { data: updatedRows, error: updateErr } = await supabase
    .from("contacts")
    .update(updates)
    .eq("id", contactId)
    .select("id");
  if (updateErr) return { error: updateErr.message, savedAt: null };
  if (!updatedRows || updatedRows.length === 0) {
    return { error: "You don't have permission to edit this contact.", savedAt: null };
  }

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "contact",
    entityId: contactId,
    eventType: "updated",
    payload: JSON.parse(JSON.stringify({ section, changed })),
  });

  // KYC completion is a deal-health factor (doc 02 §C5) — refresh buyer deals
  if (section === "kyc_banking") {
    await recomputeDealsFor(supabase, { buyerContactId: contactId });
  }

  revalidatePath(`/contacts/${contactId}`);
  revalidatePath("/contacts");
  return { error: null, savedAt: Date.now() };
}

/** Archive = the contacts "delete" (doc 04: DELETE ❌, archive flag instead).
 *  RLS decides who may: admins any org contact, agents their own/created. */
export async function archiveContact(contactId: string): Promise<{ error: string | null }> {
  if (!z.guid().safeParse(contactId).success) return { error: "Missing contact" };

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: current } = await supabase
    .from("contacts")
    .select("id, is_archived")
    .eq("id", contactId)
    .maybeSingle();
  if (!current) return { error: "Contact not found" };
  if (current.is_archived) return { error: "Already archived" };

  const { data: rows, error } = await supabase
    .from("contacts")
    .update({ is_archived: true })
    .eq("id", contactId)
    .eq("is_archived", false)
    .select("id");
  if (error) return { error: error.message };
  if (!rows || rows.length === 0) {
    return { error: "You don't have permission to archive this contact." };
  }

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "contact",
    entityId: contactId,
    eventType: "archived",
    payload: { manual: true },
  });

  revalidatePath(`/contacts/${contactId}`);
  revalidatePath("/contacts");
  return { error: null };
}

export async function unarchiveContact(contactId: string): Promise<{ error: string | null }> {
  if (!z.guid().safeParse(contactId).success) return { error: "Missing contact" };

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: current } = await supabase
    .from("contacts")
    .select("id, is_archived, merged_into_id")
    .eq("id", contactId)
    .maybeSingle();
  if (!current) return { error: "Contact not found" };
  if (!current.is_archived) return { error: "Not archived" };
  if (current.merged_into_id) {
    return { error: "This contact was merged into another — it stays archived." };
  }

  const { data: rows, error } = await supabase
    .from("contacts")
    .update({ is_archived: false })
    .eq("id", contactId)
    .eq("is_archived", true)
    .select("id");
  if (error) {
    // partial unique index: another active contact may hold the phone by now
    if (error.code === "23505") {
      return { error: "Cannot unarchive — another active contact now uses this phone number." };
    }
    return { error: error.message };
  }
  if (!rows || rows.length === 0) {
    return { error: "You don't have permission to unarchive this contact." };
  }

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "contact",
    entityId: contactId,
    eventType: "unarchived",
    payload: {},
  });

  revalidatePath(`/contacts/${contactId}`);
  revalidatePath("/contacts");
  return { error: null };
}
