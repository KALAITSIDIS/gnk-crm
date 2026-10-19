import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { fetchAll } from "@/lib/supabase/fetch-all";
import { unwrapRows } from "@/lib/supabase/unwrap";
import { isGuid } from "@/lib/validators/ids";

/**
 * EVERY lead, deal and viewing of a contact, as ids — what the contact page's
 * combined history and its summary strip are read for (A06).
 *
 * NOT the page's display lists. The Deals and Viewings tabs show the newest 50,
 * and until the A06 review their ids were also what the history was asked
 * about — so a contact's 51st-newest deal added nothing to "Last logged
 * contact" or the feed, and the strip could say "None logged yet" the day after
 * a call was logged on it. That bites first on a developer or a seller, who is
 * `seller_contact_id` on every unit deal. A "none" must be true of every record
 * the person has, so these reads are uncapped: paged (fetchAll — PostgREST cuts
 * a read at 1,000 rows silently), and the readers send the ids on in slices
 * under the gateway's 414 (entity-timeline.ts IDS_PER_READ).
 *
 * Read on the CALLER's client, so every id is one RLS let them see — the
 * contract the system-side readers rely on (entity-timeline.ts): leads and
 * viewings are org-readable, deals are what `deals_select` admits. A failed
 * page throws (fetchAll; unwrapRows routes PGRST303 to the session-clock page):
 * a history read over a partial id list would be a "none" standing in for data
 * that was not read.
 */
export interface ContactHistoryIds {
  leadIds: string[];
  dealIds: string[];
  viewingIds: string[];
}

type IdPage = { data: { id: string }[] | null; error: PostgrestError | null; status?: number };

/**
 * One paged id read; unwrapRows inside, so a hollow answer or a clock rejection
 * is never "the end". Shared with lib/queries/record-viewing-ids.ts, which reads
 * a property's or a deal's viewings for their Activity feeds the same way.
 */
export async function allIds(label: string, page: (from: number, to: number) => PromiseLike<IdPage>): Promise<string[]> {
  const rows = await fetchAll(async (from, to) => ({ data: unwrapRows(await page(from, to), label), error: null }), label);
  // The pages are separate snapshots: a row inserted between two of them
  // shifts the next page, which repeats an id already read. Each counts once.
  return [...new Set(rows.map((r) => r.id))];
}

export async function readContactHistoryIds(
  supabase: SupabaseClient<Database>,
  contactId: string,
): Promise<ContactHistoryIds> {
  // interpolated into a PostgREST `.or()` filter below: only an id gets there
  if (!isGuid(contactId)) throw new Error("contact history: not a contact id");
  const [leadIds, dealIds, viewingIds] = await Promise.all([
    allIds("contact lead ids", (from, to) =>
      supabase.from("leads").select("id").eq("contact_id", contactId).order("id").range(from, to),
    ),
    allIds("contact deal ids", (from, to) =>
      supabase
        .from("deals")
        .select("id")
        .or(`buyer_contact_id.eq.${contactId},seller_contact_id.eq.${contactId}`)
        .order("id")
        .range(from, to),
    ),
    allIds("contact viewing ids", (from, to) =>
      supabase.from("viewings").select("id").eq("contact_id", contactId).order("id").range(from, to),
    ),
  ]);
  return { leadIds, dealIds, viewingIds };
}
