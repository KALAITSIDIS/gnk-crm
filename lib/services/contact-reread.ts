import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

/** What a form answers when it posted a contact the caller cannot see. */
export const CONTACT_UNAVAILABLE = "That contact is no longer available to you.";

/**
 * Re-read, under RLS, the contact ids a form posted before a write links them
 * (T-contact-links-org-isolation).
 *
 * `contacts_select` is organisation-wide for every role, so "visible" here
 * means exactly "a contact of the caller's own organisation" — what migration
 * 0139's composite keys enforce on leads, deals, offers, share_links, mandates
 * and properties. Before 0139 those links are single-column and accept another
 * organisation's contact id; after it they refuse one with 23503 and the
 * driver's message. This read turns both into a sentence and stops the write
 * before anything lands. It is the MESSAGE, not the boundary: the key is the
 * boundary (createReservation's re-reads, 0126 / 0129, are the same idiom).
 *
 * Pass only ids the write would newly link — an id the row already carries is
 * already its own, and reading it again would only add a way to refuse a save
 * that changed nothing. Empty ids are skipped.
 *
 * True when every id is visible.
 */
export async function contactsVisible(
  supabase: SupabaseClient<Database>,
  ids: readonly (string | null | undefined)[],
): Promise<boolean> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (wanted.length === 0) return true;
  const reads = await Promise.all(
    wanted.map((id) => supabase.from("contacts").select("id").eq("id", id).maybeSingle()),
  );
  return reads.every((r) => Boolean(r.data));
}
