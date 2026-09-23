import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import {
  SUGGESTION_HISTORY_LIMIT,
  SUGGESTION_LOOKUP_LIMIT,
  buildSuggestions,
  enquiryMatchKeys,
  type CandidateRow,
  type EnquiryMatchKeys,
  type SuggestionSet,
} from "@/lib/services/enquiry-contact-match";

/**
 * "Possible existing contact" for the unlinked website enquiries on ONE inbox
 * page (T-enquiry-contact-suggestions) — a read, never a write.
 *
 * ONE QUERY FOR THE PAGE, not one per row: every enquiry's e-mail and phone go
 * into a single `contacts` select, and each candidate brings its most recent
 * linked enquiries with it as an embedded, per-contact bounded list (newest
 * first, one more than is shown, so "older ones exist" is known without a
 * count). No query at all when nothing on the page can be matched.
 *
 * THROUGH THE CALLER'S CLIENT, so the database decides what this person may
 * see: `contacts_select` / `leads_select` / `properties_select` are org-wide
 * and `require_aal2` sits in front of all of them — a session without its
 * second factor reads nothing at all. What RLS does NOT hide is filtered here:
 * archived contacts (archive is the contacts "delete", and a merged duplicate
 * is archived) and erased ones — erasure keeps the name, e-mail and phone on
 * the row, and an erased contact can be active — unarchived before
 * unarchiveContact refused it (T-refuse-unarchive-erased), or by a write
 * outside the app, which the database does not forbid — so `erased_at` is
 * tested on its own.
 *
 * A FAILED LOOKUP IS NEVER "NO MATCH". An error, or more candidate rows than
 * the page bound, makes every row that needed the lookup say "unavailable".
 */
export type EnquirySuggestionState =
  | { status: "unreadable" }
  | { status: "no_identifiers" }
  | { status: "unavailable" }
  | { status: "no_match"; keys: EnquiryMatchKeys }
  | ({ status: "matches"; keys: EnquiryMatchKeys } & SuggestionSet);

export interface SuggestionLead {
  id: string;
  message: string | null;
}

const quoted = (values: string[]) => values.map((v) => `"${v}"`).join(",");

export async function loadEnquiryContactSuggestions(
  supabase: SupabaseClient<Database>,
  leads: readonly SuggestionLead[],
): Promise<Map<string, EnquirySuggestionState>> {
  const states = new Map<string, EnquirySuggestionState>();
  const keyed: { id: string; keys: EnquiryMatchKeys }[] = [];
  const emails = new Set<string>();
  const phones = new Set<string>();

  for (const lead of leads) {
    const read = enquiryMatchKeys(lead.message);
    if (read.kind !== "keys") {
      states.set(lead.id, { status: read.kind });
      continue;
    }
    keyed.push({ id: lead.id, keys: read.keys });
    if (read.keys.email) emails.add(read.keys.email);
    if (read.keys.phoneE164) phones.add(read.keys.phoneE164);
  }
  if (keyed.length === 0) return states;

  // Every value is a normalised e-mail (no quotes, commas, parentheses,
  // backslashes or whitespace, at most 254 characters — normalizeEmailForMatch
  // refuses the rest) or `+` and digits, so double-quoting is enough for
  // PostgREST's filter grammar and nothing can close the quote. The values
  // travel in the URL: instrumentation.ts strips outgoing queries from every
  // Sentry span and breadcrumb (scrub-event.ts), and nothing here logs them.
  const filters: string[] = [];
  if (emails.size > 0) filters.push(`email.in.(${quoted([...emails])})`);
  if (phones.size > 0) {
    filters.push(`phone_e164.in.(${quoted([...phones])})`);
    filters.push(`additional_phones.ov.{${quoted([...phones])}}`);
  }

  const lookup = () =>
    supabase
      .from("contacts")
      .select(
        `id, display_name, email, phone_e164, additional_phones,
         leads!leads_contact_id_fkey(id, received_at, status, assigned_agent_id, properties(id, reference))`,
      )
      .eq("is_archived", false)
      .is("erased_at", null)
      .or(filters.join(","))
      .order("received_at", { referencedTable: "leads", ascending: false })
      .order("id", { referencedTable: "leads", ascending: false })
      .limit(SUGGESTION_HISTORY_LIMIT + 1, { referencedTable: "leads" })
      .order("id")
      .limit(SUGGESTION_LOOKUP_LIMIT + 1);

  // postgrest-js resolves even a network failure as { data: null, error };
  // the catch is for anything else, so the inbox itself never fails over this
  let result: Awaited<ReturnType<typeof lookup>> | null = null;
  try {
    result = await lookup();
  } catch {
    result = null;
  }
  const data = result?.data ?? null;
  const error = result ? result.error : { code: "thrown" };

  if (error || !data || data.length > SUGGESTION_LOOKUP_LIMIT) {
    // the code only: a filter echoed back in a message would carry the addresses
    if (error) console.error(`[enquiry-suggestions] contact lookup failed (${error.code ?? "unknown"})`);
    else if (data && data.length > SUGGESTION_LOOKUP_LIMIT) {
      console.error(`[enquiry-suggestions] more than ${SUGGESTION_LOOKUP_LIMIT} candidate contacts on one page`);
    }
    for (const { id } of keyed) states.set(id, { status: "unavailable" });
    return states;
  }

  const rows: CandidateRow[] = data.map((c) => ({
    id: c.id,
    display_name: c.display_name,
    email: c.email,
    phone_e164: c.phone_e164,
    additional_phones: c.additional_phones,
    history: (c.leads ?? []).map((l) => ({
      id: l.id,
      received_at: l.received_at,
      status: l.status,
      assigned_agent_id: l.assigned_agent_id,
      property: l.properties ? { id: l.properties.id, reference: l.properties.reference } : null,
    })),
  }));

  for (const { id, keys } of keyed) {
    const set = buildSuggestions(keys, rows);
    states.set(id, set.candidates.length > 0 ? { status: "matches", keys, ...set } : { status: "no_match", keys });
  }
  return states;
}
