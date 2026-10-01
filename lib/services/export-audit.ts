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
  /**
   * The filters that shaped the export, as `auditFilters` vets them — never
   * the request's raw search params (T-export-filter-shape).
   */
  filters?: AuditedFilters;
}

/** A filter as the chain may hold it: a vetted value, or only THAT it was used. */
export type AuditedFilters = Record<string, string | number | boolean>;

/**
 * Value checks for `auditFilters`, keyed by the list's own filter names (a
 * typo is a type error, not a silently downgraded filter): a filter whose
 * value passes is recorded as-is.
 */
export type FilterVetting<T> = Partial<Record<keyof T & string, (value: unknown) => boolean>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const vet = {
  oneOf:
    (values: readonly string[]) =>
    (v: unknown) =>
      typeof v === "string" && values.includes(v),
  uuid: (v: unknown) => typeof v === "string" && UUID.test(v),
  number: (v: unknown) => typeof v === "number" && Number.isFinite(v),
  flag: (v: unknown) => v === true,
};

/**
 * The shape of an export's filters for the audit record (T-export-filter-shape).
 *
 * The event is hash-chained and erasure cannot reach it, so it may hold only
 * what identifies no one: a value that passes its vetting (a vocabulary
 * member, an id, a number, a flag) is kept; any other value that was set is
 * recorded as `true` — the filter was USED, never what was typed into it. The
 * search box is the case this exists for: it matches a contact's name, phone
 * and e-mail and a key's holder, so `q` has no vetting and is always `true`.
 *
 * `parsed` is the list's PARSED filter object, never the request's search
 * params: a parameter the list does not read has no business in the record.
 * An unset filter (undefined, null, "", false) is left out.
 */
export function auditFilters<T extends object>(parsed: T, vetting: FilterVetting<T>): AuditedFilters {
  const out: AuditedFilters = {};
  const checks = vetting as Record<string, ((value: unknown) => boolean) | undefined>;
  for (const [key, value] of Object.entries(parsed) as [string, unknown][]) {
    if (value === undefined || value === null || value === "" || value === false) continue;
    const check = checks[key];
    const keep =
      check !== undefined &&
      check(value) &&
      (typeof value === "string" || typeof value === "number" || typeof value === "boolean");
    out[key] = keep ? (value as string | number | boolean) : true;
  }
  return out;
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
