import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Which of these leads still hold notes that are not redacted
 * (T-redact-lead-notes).
 *
 * `redactLead` rewrites the message, then blanks the notes — two writes. A
 * redaction interrupted between them leaves a lead whose message shows the
 * marker while its notes keep the desk's words, and the Redact button keyed on
 * the message alone would never be offered again. The leads page asks this
 * for its redacted, unlinked rows and offers "Finish redaction" for them.
 *
 * ONE read through the caller's RLS for the whole page, never a query per row,
 * and none at all when the page holds no such lead.
 */
export async function loadLeadsWithUnredactedNotes(
  supabase: SupabaseClient<Database>,
  leadIds: string[],
): Promise<Set<string>> {
  if (leadIds.length === 0) return new Set();
  const { data, error } = await supabase
    .from("interaction_notes")
    .select("entity_id")
    .eq("entity_type", "lead")
    .in("entity_id", leadIds)
    .is("redacted_at", null);
  // A failed read offers nothing extra: the button it would add is the
  // finishing step of an Article 17 request, never a reason to break the page.
  if (error) return new Set();
  return new Set((data ?? []).map((n) => n.entity_id as string));
}
