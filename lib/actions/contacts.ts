"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Database } from "@/lib/supabase/database.types";
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

export type ContactSectionState = { error: string | null; savedAt: number | null };

function normEq(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) =>
    v === undefined || v === null || v === ""
      ? null
      : typeof v === "object"
        ? JSON.stringify(v)
        : String(v);
  return norm(a) === norm(b);
}

export async function updateContactSection(
  _prev: ContactSectionState,
  formData: FormData,
): Promise<ContactSectionState> {
  const contactId = formData.get("contact_id");
  const section = formData.get("section");
  if (typeof contactId !== "string" || typeof section !== "string") {
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
          .eq("phone_e164", phoneE164)
          .eq("is_archived", false)
          .neq("id", contactId)
          .limit(1);
        if (dup?.[0]) {
          return { error: `Duplicate phone — belongs to ${dup[0].display_name}`, savedAt: null };
        }
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
      email: d.email ?? null,
      telegram_username: d.telegram_username ?? null,
      has_whatsapp: d.has_whatsapp,
      languages: d.languages.length ? d.languages : ["en"],
      nationality: d.nationality ?? null,
      contact_types: d.contact_types,
      temperature: d.temperature,
      source: d.source ?? null,
      source_detail: d.source_detail ?? null,
      psychology: d.psychology ?? null,
      consent_marketing: d.consent_marketing,
      // consent timestamp only moves when the flag flips (doc 02 §C3)
      consent_at: consentChanged
        ? d.consent_marketing
          ? new Date().toISOString()
          : null
        : current.consent_at,
      notes: d.notes ?? null,
    };
  } else if (section === "preferences") {
    const num = (v: unknown) => {
      const n = Number(v);
      return v !== "" && v !== null && Number.isFinite(n) ? n : undefined;
    };
    const preferences = {
      areas: formData.getAll("pref_areas").map(String).filter(Boolean),
      budget_min: num(raw.budget_min),
      budget_max: num(raw.budget_max),
      bedrooms_min: num(raw.bedrooms_min),
      property_types: formData.getAll("pref_property_types").map(String).filter(Boolean),
      purpose: typeof raw.purpose === "string" && raw.purpose ? raw.purpose : undefined,
    };
    updates = { preferences: JSON.parse(JSON.stringify(preferences)) };
  } else if (section === "kyc_banking") {
    const { KYC_ITEMS } = await import("@/lib/constants/checklists");
    const kyc: Record<string, { done: boolean; note?: string; doc_link?: string }> = {};
    for (const [key] of KYC_ITEMS) {
      const done = raw[`kyc_${key}_done`] === "on";
      const note = typeof raw[`kyc_${key}_note`] === "string" ? String(raw[`kyc_${key}_note`]).trim() : "";
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
      bank_pre_check_done: raw.bank_pre_check_done === "on" ? true : undefined,
      account_feasibility: ["yes", "maybe", "no"].includes(feasibility) ? feasibility : undefined,
    };
    updates = {
      kyc,
      banking_readiness: JSON.parse(JSON.stringify(banking)),
    };
  } else {
    return { error: `Unknown section: ${section}`, savedAt: null };
  }

  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, next] of Object.entries(updates)) {
    const prev = (current as Record<string, unknown>)[key];
    if (!normEq(prev, next)) changed[key] = { from: prev ?? null, to: next ?? null };
  }
  if (Object.keys(changed).length === 0) return { error: null, savedAt: Date.now() };

  const { error: updateErr } = await supabase
    .from("contacts")
    .update(updates)
    .eq("id", contactId);
  if (updateErr) return { error: updateErr.message, savedAt: null };

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "contact",
    entityId: contactId,
    eventType: "updated",
    payload: JSON.parse(JSON.stringify({ section, changed })),
  });

  revalidatePath(`/contacts/${contactId}`);
  revalidatePath("/contacts");
  return { error: null, savedAt: Date.now() };
}
