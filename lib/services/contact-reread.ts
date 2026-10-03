import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/** What a form answers when it posted a contact the caller cannot see. */
export const CONTACT_UNAVAILABLE = "That contact is no longer available to you.";
/** What it answers when the re-read itself failed — the contact may well be fine. */
export const CONTACT_CHECK_FAILED = "Could not check that contact just now — please try again.";

/**
 * Re-read, under RLS, the contact ids a form posted before a write links them
 * (T-contact-links-org-isolation).
 *
 * `contacts_select` is organisation-wide for every role, so "visible" here
 * means exactly "a contact of the caller's own organisation" — what migration
 * 0139's composite keys enforce on leads, deals, offers, share_links, mandates
 * and properties. Before 0139 those links were single-column and accepted
 * another organisation's contact id; since it they refuse one with 23503 and
 * the driver's message. This read turns both into a sentence and stops the write
 * before anything lands. It is the MESSAGE, not the boundary: the key is the
 * boundary (createReservation's re-reads, 0126 / 0129, are the same idiom).
 *
 * Pass only ids the write would newly link — an id the row already carries is
 * already its own, and reading it again would only add a way to refuse a save
 * that changed nothing. Empty ids are skipped, repeats read once.
 *
 * Null when every id is visible; otherwise the sentence to return.
 * postgrest-js answers a network or server failure as `{ data: null, error }`
 * — it does not throw — so a failed read is told apart from an empty one: a
 * contact that may be fine is never reported as gone.
 */
export async function contactLinkError(
  supabase: SupabaseClient<Database>,
  ids: readonly (string | null | undefined)[],
): Promise<string | null> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (wanted.length === 0) return null;
  const reads = await Promise.all(
    wanted.map((id) => supabase.from("contacts").select("id").eq("id", id).maybeSingle()),
  );
  if (reads.some((r) => r.error)) return CONTACT_CHECK_FAILED;
  return reads.every((r) => Boolean(r.data)) ? null : CONTACT_UNAVAILABLE;
}
