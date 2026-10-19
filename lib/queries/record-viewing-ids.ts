import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { allIds } from "@/lib/queries/contact-history";
import { isGuid } from "@/lib/validators/ids";

/**
 * EVERY viewing of a property or a deal, as ids — what the property's and the
 * deal's combined Activity feed reads the viewings' events for (A06 step 5).
 *
 * NOT the pages' display lists. The property page shows the next ten scheduled
 * viewings and the deal page its ten newest; a viewing's history (booked,
 * rescheduled, completed, its slip signed) belongs on the feed whether or not
 * the viewing is still in either list, so this read is uncapped: paged
 * (fetchAll — PostgREST cuts a read at 1,000 rows silently), ordered by id so
 * a page is a page, and the reader sends the ids on in slices under the
 * gateway's 414 (entity-timeline.ts IDS_PER_READ).
 *
 * Read on the CALLER's client, so every id is one RLS let them see — the
 * contract `readEntityTimelines` relies on: it reads the events as the system.
 * `viewings_select` is org-wide, and a signed slip's names are withheld from
 * non-admins by the reader (redactSlipSigners), not by this list. A failed
 * page throws (fetchAll; unwrapRows routes PGRST303 to the session-clock
 * page), as the contact page's history ids do: a feed read over a partial id
 * list would be a shorter history standing in for one that was not read.
 */
export async function readRecordViewingIds(
  supabase: SupabaseClient<Database>,
  record: { column: "property_id" | "deal_id"; id: string },
): Promise<string[]> {
  // a malformed id would cost a 22P02 on every page; the pages 404 before this
  if (!isGuid(record.id)) throw new Error("viewing ids: not a record id");
  const label = record.column === "property_id" ? "property viewing ids" : "deal viewing ids";
  return allIds(label, (from, to) =>
    supabase.from("viewings").select("id").eq(record.column, record.id).order("id").range(from, to),
  );
}
