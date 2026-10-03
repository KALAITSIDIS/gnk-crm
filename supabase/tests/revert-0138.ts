import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The way back from 0138 to 0134's events_insert — 0138's documented
 * ROLLBACK: 0134's `alter policy events_insert …` statement, sliced from
 * 0134's own file so it cannot drift from what 0134 applied.
 *
 * Used by system-event-types.test.ts to replay 0138 over 0134's policy and to
 * prove the rollback lets a session write the three types again — always
 * inside a rolled-back transaction. Not a test file: it registers no tests.
 * Never pointed at hosted.
 */

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const read = (file: string) => readFileSync(join(MIGRATIONS, file), "utf-8").replace(/\r\n/g, "\n");

export const MIGRATION_0138 = "0138_system_event_types.sql";
export const readMigration0138 = () => read(MIGRATION_0138);

/** events_insert's check after 0138, as pg_get_expr renders it under the fixed search_path. */
export const CHECK_0138 =
  "((org_id = ( SELECT current_org_id() AS current_org_id)) AND (actor_id = ( SELECT auth.uid() AS uid)) AND (NOT ((entity_type = 'deal'::text) AND (event_type = ANY (ARRAY['won'::text, 'lost'::text, 'won_override'::text])))) AND (event_type <> 'stage_changed'::text) AND (event_type <> ALL (ARRAY['erased'::text, 'retention_purged'::text])) AND (event_type <> ALL (ARRAY['enquiry_alert'::text, 'lead_escalation'::text, 'opened'::text])) AND (occurred_at = now()))";

function policy0134(): string {
  const s = read("0134_erasure_lifecycle_guard.sql");
  const start = s.indexOf("alter policy events_insert on public.events");
  const end = s.indexOf("\n  );", start);
  if (start < 0 || end < 0) throw new Error("revert-0138: 0134's events_insert statement was not found");
  return s.slice(start, end + "\n  );".length);
}

export const REVERT_0138_SQL = policy0134();
