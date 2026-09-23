import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { LEAD_MESSAGE_REDACTED } from "@/lib/services/erasure";
import { LEAD_OPEN_STATUSES } from "@/lib/validators/contacts";

/**
 * The one write that links a contact to a lead, and what its answer means
 * (T-enquiry-contact-suggestions).
 *
 * THE WRITE IS CONDITIONAL: `contact_id is null`, the lead still open, and its
 * message not redacted. A colleague who linked a contact, converted the lead
 * or closed it after this person's screen was drawn wins at the database, and
 * nothing of theirs is overwritten; an enquiry an admin redacted meanwhile is
 * not re-attached to a named person. Postgres re-checks the WHERE against the
 * row it locks, so two clicks racing each other cannot both land.
 *
 * A ZERO-ROW ANSWER IS AMBIGUOUS, and the ambiguity decides whether an event
 * may be written. RLS refuses an UPDATE by matching zero rows with no error
 * (supabase/tests/listing-manager-silent-writes.test.ts), exactly like a lost
 * race — so the row is read again (the `stampLandedElsewhere` idiom in
 * lib/actions/leads.ts):
 *   - it now holds THIS contact  → already linked: the winner (a colleague, or
 *     this person's own first click) wrote the one event there is to write
 *   - it holds another contact   → linked elsewhere: refuse, change nothing
 *   - it is no longer open       → converted or closed meanwhile
 *   - its message was redacted   → redacted meanwhile
 *   - still unlinked and open    → the row policy refused this person
 *
 * Takes the caller's client so the DB suite can race two real sessions
 * through it; the action owns the checks before it and the event after it.
 * Only `contact_id` is written: status, assignment, the response clock, the
 * brief and the lead's notification rows are left as they are.
 */
export type LeadLinkOutcome =
  | "linked"
  | "already_linked"
  | "linked_elsewhere"
  | "closed"
  | "redacted"
  | "refused"
  | "error";

export async function linkUnlinkedLead(
  supabase: SupabaseClient<Database>,
  leadId: string,
  contactId: string,
): Promise<LeadLinkOutcome> {
  const { data, error } = await supabase
    .from("leads")
    .update({ contact_id: contactId })
    .eq("id", leadId)
    .is("contact_id", null)
    .in("status", [...LEAD_OPEN_STATUSES])
    // `neq` alone would drop a lead whose message is null
    .or(`message.is.null,message.neq."${LEAD_MESSAGE_REDACTED}"`)
    .select("id");
  if (error) return "error";
  if (data && data.length > 0) return "linked";

  const { data: now, error: readErr } = await supabase
    .from("leads")
    .select("contact_id, status, message")
    .eq("id", leadId)
    .maybeSingle();
  if (readErr) return "error";
  if (!now) return "refused";
  if (now.contact_id === contactId) return "already_linked";
  if (now.contact_id) return "linked_elsewhere";
  if (!(LEAD_OPEN_STATUSES as readonly string[]).includes(now.status)) return "closed";
  if (now.message === LEAD_MESSAGE_REDACTED) return "redacted";
  return "refused";
}

/**
 * Who may link a contact to a lead — `leads_update` (doc 04) in the app's
 * words: an admin, or an agent on their own or an unassigned lead. A listing
 * manager reads every lead and may write none, so no link control is offered
 * to one (the row policy would refuse the write with zero rows).
 */
export function mayLinkLeadContact(
  profile: { id: string; role: string },
  assignedAgentId: string | null,
): boolean {
  if (profile.role === "admin") return true;
  return profile.role === "agent" && (!assignedAgentId || assignedAgentId === profile.id);
}
