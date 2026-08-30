"use server";

import { z } from "zod";
import { checkContactDuplicate, type DuplicateMatch } from "@/lib/actions/contacts";
import type { EntityOption } from "@/lib/actions/entity-search";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import { splitEnquirerName } from "@/lib/services/lead-contact";
import { normalizePhone } from "@/lib/services/phone";
import { createClient } from "@/lib/supabase/server";
import { LISTING_SOURCES, type ListingSource } from "@/lib/validators/properties";

/**
 * Inline owner/developer creation for the property wizard (audit WF-10) —
 * new-owner intake was a two-trip flow (leave the wizard, create the
 * contact, come back) while lead capture already had the inline
 * dedup-checked pattern. This is `createLead`'s create branch, minus the
 * lead: §C3/§C4 duplicate check FIRST (the match is returned so the wizard
 * can offer "link instead"), 23505 race surfaced as a duplicate, one
 * `created` event. `createContact` itself is not reusable here — it
 * redirect()s to the new contact's page, which is exactly the trip this
 * removes.
 *
 * `contact_types` is set from the wizard's source, and that is load-bearing:
 * the party picker filters on it, so a contact created without the type
 * could never be re-found by the picker that just created it.
 */
const createPartySchema = z.object({
  source: z.enum(LISTING_SOURCES),
  name: z.string().trim().min(2, "Name is required").max(200),
  phone: z
    .string()
    .trim()
    .max(30)
    .optional()
    .transform((v) => v || undefined),
  email: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((v) => (v ? v.toLowerCase() : undefined)),
});

export type CreatePartyResult = {
  error: string | null;
  duplicate: DuplicateMatch | null;
  option: EntityOption | null;
};

export async function createPartyContact(input: {
  source: ListingSource;
  name: string;
  phone?: string;
  email?: string;
}): Promise<CreatePartyResult> {
  const parsed = createPartySchema.safeParse(input);
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "Invalid input",
      duplicate: null,
      option: null,
    };
  }
  const d = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  let phoneE164: string | null = null;
  if (d.phone) {
    const normalized = normalizePhone(d.phone);
    if (!normalized) return { error: "Phone number is not valid", duplicate: null, option: null };
    phoneE164 = normalized.e164;
  }

  const duplicate = await checkContactDuplicate(d.phone ?? null, d.email ?? null);
  if (duplicate) {
    // do NOT create — surface the match so the wizard links the existing contact
    return {
      error: `A contact with this ${duplicate.matched_on} already exists.`,
      duplicate,
      option: null,
    };
  }

  const { firstName, lastName } = splitEnquirerName(d.name);
  const contactType = d.source === "developer" ? "developer" : "owner";
  const { data: created, error: insertErr } = await supabase
    .from("contacts")
    .insert({
      org_id: profile.orgId,
      contact_kind: d.source === "developer" ? "company" : "person",
      first_name: firstName,
      last_name: lastName,
      ...(d.source === "developer" ? { company_name: d.name } : {}),
      phone_e164: phoneE164,
      phone_raw: d.phone ?? null,
      email: d.email ?? null,
      contact_types: [contactType],
      assigned_agent_id: profile.role === "agent" ? profile.id : null,
      created_by: profile.id,
    })
    .select("id, display_name")
    .single();
  if (insertErr) {
    // race with a unique index (phone, or email since 0077) → a duplicate, not a raw error
    if (insertErr.code === "23505") {
      const race = await checkContactDuplicate(d.phone ?? null, d.email ?? null);
      return {
        error: `A contact with this ${race?.matched_on ?? "phone or email"} already exists.`,
        duplicate: race,
        option: null,
      };
    }
    return { error: insertErr.message, duplicate: null, option: null };
  }

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "contact",
    entityId: created.id,
    eventType: "created",
    payload: { phone: phoneE164, email: d.email ?? null, via: "property_wizard" },
  });

  return {
    error: null,
    duplicate: null,
    option: {
      id: created.id,
      label: created.display_name ?? d.name,
      sublabel: phoneE164 ?? d.email ?? null,
    },
  };
}
