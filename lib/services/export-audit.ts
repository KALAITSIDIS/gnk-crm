import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import { logEvent } from "./events";

/**
 * Audit trail for bulk CSV exports (DECISIONS T-csv-export). A list export moves
 * a lot of PII in one action, so it is recorded on the append-only event log the
 * same way mutations are. The event is org-level (entity_type "export",
 * entity_id null), one `exported` type for every list, distinguished by
 * `payload.list`. Filters are kept in the payload for the audit record; the
 * one-line timeline (describeEvent) shows only the list and row count.
 *
 * Written BEFORE the CSV is returned to the caller: if the audit insert fails,
 * the export fails too — no PII leaves without a record of who took it.
 */
export interface ListExportAudit {
  orgId: string;
  actorId: string;
  /** list slug, e.g. "contacts" — stays as stored, like stage names */
  list: string;
  /** rows written to the CSV */
  count: number;
  /** the request's filter params, for the audit record (not the timeline line) */
  filters?: Record<string, string>;
}

export async function logListExport(
  supabase: SupabaseClient<Database>,
  audit: ListExportAudit,
): Promise<void> {
  const payload: Json = {
    list: audit.list,
    count: audit.count,
    ...(audit.filters && Object.keys(audit.filters).length > 0
      ? { filters: audit.filters }
      : {}),
  };
  await logEvent(supabase, {
    orgId: audit.orgId,
    actorId: audit.actorId,
    entityType: "export",
    entityId: null,
    eventType: "exported",
    payload,
  });
}
