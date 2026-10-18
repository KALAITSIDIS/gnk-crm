import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { requirementFromMeta, type EnquiryMeta } from "@/lib/services/enquiry-meta";
import { logEvent } from "@/lib/services/events";
import { eventNotice } from "@/lib/services/one-time-secrets";
import { certainlyRolledBack } from "@/lib/services/rpc-outcome";

/**
 * A website buyer's brief, saved as the contact's search (0098 LR-01; A04).
 *
 * Extracted from `createContactFromEnquiry`, which seeded a search only while
 * it was creating a NEW contact — so a brief whose person already existed
 * (linked through "Review and link" or Link contact) was dropped on the floor.
 * Both the create path and `saveSearchFromEnquiry` now run this one body: the
 * same seed (`requirementFromMeta`), the same insert, the same
 * `requirement_added` line on the CONTACT, with `via` and the lead it came from.
 *
 * NEVER A THROW AFTER THE INSERT. Its outcome is classified, never guessed:
 *   - `refused`     — the insert certainly did not commit (`certainlyRolledBack`,
 *                     T-refusal-allowlist), or nothing was attempted;
 *   - `unconfirmed` — it may have: a code that can follow a commit, no code, a
 *                     hollow answer. The desk is told to look before adding it
 *                     again, because a second search for the same brief shows
 *                     every match twice (BACKLOG, duplicated saved searches);
 *   - `saved`       — the row exists; a timeline line that could not be written
 *                     comes back as `notice` (NOT_RECORDED / NOT_CONFIRMED), and
 *                     the search stays (T-log-event-hollow).
 *
 * The event payload is a literal of ids and shape (audit SEC-03): the label is
 * the seed's fixed "From website enquiry", never the visitor's words, and the
 * brief itself stays on the lead. event-payload-privacy.test.ts scans this file.
 */

type Client = SupabaseClient<Database>;

export type SeedOutcome =
  | { kind: "no_brief" }
  | { kind: "saved"; requirementId: string; notice: string | null }
  | { kind: "refused"; reason: string }
  | { kind: "unconfirmed" };

export async function seedRequirementFromBrief(
  supabase: Client,
  actor: { id: string; orgId: string },
  contactId: string,
  meta: EnquiryMeta,
  leadId: string,
): Promise<SeedOutcome> {
  const { data: areaRows, error: areaErr } = await supabase.from("areas").select("id, district_id, name");
  // The area lookup turns the brief's "Kato Paphos" into the area and its
  // district. Without it the search would be saved with no location at all —
  // "anywhere" — which is not what the buyer said: refuse, nothing written.
  if (areaErr || !Array.isArray(areaRows)) return { kind: "refused", reason: "the areas could not be read" };
  const areas = areaRows.map((a) => ({
    id: a.id,
    district_id: a.district_id,
    name_en: ((a.name as { en?: string } | null)?.en ?? "").trim(),
  }));
  const seed = requirementFromMeta(meta, areas);
  if (!seed) return { kind: "no_brief" };

  const { data: requirement, error: reqErr } = await supabase
    .from("buyer_requirements")
    .insert({
      org_id: actor.orgId,
      contact_id: contactId,
      ...seed,
      property_types: seed.property_types as Database["public"]["Enums"]["property_type"][],
      created_by: actor.id,
    })
    .select("id")
    .single();
  if (reqErr) {
    return certainlyRolledBack(reqErr.code) ? { kind: "refused", reason: reqErr.message } : { kind: "unconfirmed" };
  }
  if (!requirement?.id) return { kind: "unconfirmed" };

  let notice: string | null = null;
  try {
    await logEvent(supabase, {
      orgId: actor.orgId,
      actorId: actor.id,
      entityType: "contact",
      entityId: contactId,
      eventType: "requirement_added",
      payload: { requirement_id: requirement.id, label: seed.label, via: "website_enquiry", lead_id: leadId },
    });
  } catch (err) {
    // no message: an event error could echo the payload's ids into a log line
    console.error("[requirement-from-brief] saved search kept, its requirement_added line not written");
    notice = eventNotice(err);
  }
  return { kind: "saved", requirementId: requirement.id, notice };
}

/** The create-contact path's caveat for a search that was not saved (its contact and link were). */
export function seedNote(outcome: SeedOutcome): string | null {
  switch (outcome.kind) {
    case "no_brief":
      return null;
    case "saved":
      return outcome.notice;
    case "refused":
      return `The saved search could not be created (${outcome.reason}) — add it on the contact.`;
    case "unconfirmed":
      return "The saved search could not be confirmed — open the contact's Preferences tab before adding it again.";
  }
}
