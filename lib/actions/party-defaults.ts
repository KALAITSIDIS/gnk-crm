"use server";

import { revalidatePath } from "next/cache";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import { createClient } from "@/lib/supabase/server";
import { changedValue } from "@/lib/utils/diff";
import {
  partyDefaultsSchema,
  resolvePartyDefaults,
  type PartyDefaults,
} from "@/lib/validators/party-defaults";

export type PartyDefaultsState = { error: string | null; savedAt: number | null };

/** The office-wide fallback row, or null when it has been removed. */
async function readOfficeDefaults(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<PartyDefaults | null> {
  const { data } = await supabase
    .from("cyprus_config")
    .select("value")
    .eq("key", "default_mandate_terms")
    .maybeSingle();
  if (!data?.value) return null;
  const parsed = partyDefaultsSchema.safeParse(data.value);
  // A malformed config row must not take the forms down; it just stops being
  // a fallback until somebody fixes it.
  return parsed.success ? parsed.data : null;
}

/**
 * The terms to prefill a form with for this party (migration 0038).
 *
 * Returns the merge of the party's own standard terms over the office's, plus
 * which layer each value came from — the form says so beside each field,
 * because a prefilled value that does not explain itself is one people distrust
 * and retype.
 *
 * A missing contact returns the office defaults rather than nothing: the form
 * is still better off with them than blank.
 */
export async function getPartyDefaults(contactId: string | null): Promise<{
  defaults: PartyDefaults;
  source: Record<string, "party" | "office">;
  partyName: string | null;
}> {
  const supabase = await createClient();
  const office = await readOfficeDefaults(supabase);

  if (!contactId) {
    return {
      defaults: resolvePartyDefaults(null, office),
      source: office ? Object.fromEntries(Object.keys(office).map((k) => [k, "office" as const])) : {},
      partyName: null,
    };
  }

  const { data: contact } = await supabase
    .from("contacts")
    .select("display_name, party_defaults")
    .eq("id", contactId)
    .maybeSingle();

  const parsed = partyDefaultsSchema.safeParse(contact?.party_defaults ?? {});
  const party = parsed.success ? parsed.data : null;

  const { defaultsProvenance } = await import("@/lib/validators/party-defaults");
  return {
    defaults: resolvePartyDefaults(party, office),
    source: defaultsProvenance(party, office),
    partyName: contact?.display_name ?? null,
  };
}

/**
 * Save a party's standard terms.
 *
 * Admin + listing manager, matching who manages mandates and listings — these
 * values prefill a commission rate, and a commission rate is not an agent's to
 * set for the office.
 *
 * Absent fields are stored as ABSENT, not as null: the resolver treats
 * undefined as "no opinion" and lets the office fallback through, so writing
 * nulls would silently pin every field to blank.
 */
export async function savePartyDefaults(
  _prev: PartyDefaultsState,
  formData: FormData,
): Promise<PartyDefaultsState> {
  const contactId = formData.get("contact_id");
  if (typeof contactId !== "string") {
    return { error: "Missing contact", savedAt: null };
  }

  const parsed = partyDefaultsSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
  }

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  if (profile.role !== "admin" && profile.role !== "listing_manager") {
    return {
      error: "Only admins and listing managers set standard terms.",
      savedAt: null,
    };
  }

  const { data: current } = await supabase
    .from("contacts")
    .select("party_defaults")
    .eq("id", contactId)
    .maybeSingle();
  if (!current) return { error: "Contact not found", savedAt: null };

  // strip undefined so "no opinion" is genuinely absent from the stored object
  const next = Object.fromEntries(
    Object.entries(parsed.data).filter(([, v]) => v !== undefined),
  );
  const previous = (current.party_defaults ?? {}) as Record<string, unknown>;

  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (changedValue(previous[key], next[key])) {
      changed[key] = { from: previous[key] ?? null, to: next[key] ?? null };
    }
  }
  if (Object.keys(changed).length === 0) return { error: null, savedAt: Date.now() };

  const { data: rows, error } = await supabase
    .from("contacts")
    .update({ party_defaults: next })
    .eq("id", contactId)
    .select("id");
  if (error) return { error: error.message, savedAt: null };
  if (!rows || rows.length === 0) {
    return { error: "Nothing was saved — you may not edit this contact.", savedAt: null };
  }

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "contact",
    entityId: contactId,
    eventType: "updated",
    payload: JSON.parse(JSON.stringify({ section: "party_defaults", changed })),
  });

  revalidatePath(`/contacts/${contactId}`);
  return { error: null, savedAt: Date.now() };
}
