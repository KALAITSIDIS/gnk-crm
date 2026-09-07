import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Whether the filed viewing confirmation still describes the viewing.
 *
 * A confirmation is generated FROM a viewing's `scheduled_at` and then filed as
 * a document. Nothing in `rescheduleViewing` touches that document — correctly:
 * the PDF is a record of what was sent, its digest is chained into the event
 * log (`tests/e2e/viewing-confirmation.spec.ts` pins that), and rewriting a
 * record of the past is exactly what this app refuses to do everywhere else.
 *
 * But the Download control offered it as the current document, so after a
 * reschedule an agent could forward a client a PDF naming the old time. Keeping
 * the record and presenting it as current are two different things, and only
 * the second is wrong.
 *
 * So: the document stays, and the UI is told it is out of date.
 *
 * THE RESCHEDULE IS READ AS THE SYSTEM, NOT AS THE CALLER. `events_select`
 * (0063) admits an admin, or the actor who wrote the row — nothing else. So an
 * admin rescheduling an agent's viewing writes an event that agent cannot see,
 * and asking on their client would answer "never rescheduled": the warning
 * would vanish for precisely the person about to send the sheet. Whether a
 * viewing has moved is a fact about the VIEWING, not about who is looking.
 *
 * `org_id` is therefore filtered explicitly, taken from the document row — the
 * admin client has no RLS to scope it.
 *
 * STALENESS IS MEASURED BY TIMESTAMPS, NOT BY PARSING THE TITLE. The title
 * carries a formatted, localised datetime meant for a human; comparing
 * `documents.created_at` against the newest `rescheduled` event's `created_at`
 * asks the same question without depending on a display format. It errs toward
 * warning — a reschedule that landed on the same time would still flag — which
 * is the safe direction for something about to be sent to a client.
 */

type Client = SupabaseClient<Database>;

export interface ConfirmationFreshness {
  /** is any confirmation on file at all */
  hasDocument: boolean;
  /** filed BEFORE the viewing was last rescheduled */
  stale: boolean;
  /** the filed document's own title, verbatim — it names the time it was issued for */
  filedTitle: string | null;
}

export const NO_CONFIRMATION: ConfirmationFreshness = {
  hasDocument: false,
  stale: false,
  filedTitle: null,
};

/**
 * Pure half, so the comparison can be tested without a database.
 *
 * A missing reschedule means nothing has moved since the document was filed. A
 * missing document means there is nothing to be stale.
 */
export function isStale(documentAt: string | null, lastRescheduledAt: string | null): boolean {
  if (!documentAt || !lastRescheduledAt) return false;
  return new Date(lastRescheduledAt).getTime() > new Date(documentAt).getTime();
}

export async function confirmationFreshness(
  supabase: Client,
  viewingId: string,
): Promise<ConfirmationFreshness> {
  const { data: doc } = await supabase
    .from("documents")
    .select("created_at, title, org_id")
    .eq("entity_type", "viewing")
    .eq("entity_id", viewingId)
    .eq("doc_type", "viewing_confirmation")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!doc) return NO_CONFIRMATION;

  // `occurred_at`, not `created_at`: the events table has no created_at (0001).
  // It is also the column both event indexes are built on.
  const { data: moved } = await createAdminClient()
    .from("events")
    .select("occurred_at")
    .eq("org_id", doc.org_id)
    .eq("entity_type", "viewing")
    .eq("entity_id", viewingId)
    .eq("event_type", "rescheduled")
    .order("occurred_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    hasDocument: true,
    stale: isStale(doc.created_at, moved?.occurred_at ?? null),
    filedTitle: doc.title ?? null,
  };
}
