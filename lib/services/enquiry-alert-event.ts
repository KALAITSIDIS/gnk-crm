import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { logEvent } from "@/lib/services/events";

/**
 * The desk alert's outcome, on the lead's timeline (integrations audit
 * 2026-09-15, INT-01).
 *
 * Until 0096 the enquiry route discarded the word `sendEnquiryAlert` returned,
 * so a failed or skipped alert left a lead in the inbox with nothing anywhere
 * saying nobody had been told — the one failure the alert exists to prevent,
 * wearing no symptom at all. Now every website lead carries an `enquiry_alert`
 * event: `sent`, `skipped` (the provider is not configured) or `failed`.
 *
 * OUTCOME AND PROVIDER ONLY. An event cannot be redacted, so no address, no
 * name and no message may enter it (SEC-03); the lead id is the whole link.
 *
 * NEVER THROWS. This runs in `after()`, once the visitor has their 202 and
 * the enquiry is committed; a record that cannot be written is a console line,
 * never a reason to lose the enquiry.
 */
export type EnquiryAlertOutcome = "sent" | "skipped" | "failed";

export async function recordEnquiryAlert(
  supabase: SupabaseClient<Database>,
  a: { orgId: string; leadId: string; outcome: EnquiryAlertOutcome },
): Promise<void> {
  try {
    await logEvent(supabase, {
      orgId: a.orgId,
      actorId: null,
      entityType: "lead",
      entityId: a.leadId,
      eventType: "enquiry_alert",
      payload: { outcome: a.outcome, provider: "resend" },
    });
  } catch (err) {
    console.error(
      "[enquiry-alert] could not record the outcome on the lead:",
      err instanceof Error ? err.message : String(err),
    );
  }
}
