import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The way back from 0134 to 0132's catalogue — 0134's documented ROLLBACK:
 * events_insert's check as 0131 wrote it, then the `contacts_retain_erasure`
 * and `documents_kept_for_retention` triggers and their functions dropped.
 * Built from the APPLIED migration file rather than retyped, so it cannot
 * drift from what 0134 replaced; every drop is `if exists`, so the text is a
 * no-op on a database still at 0132 / 0133.
 *
 * ALTER POLICY and DROP TRIGGER each take ACCESS EXCLUSIVE, which waits for
 * readers too. So the text takes all three locks at once, NOWAIT, retrying for
 * about 5 s (0132's idiom): it never waits while holding a lock, so it cannot
 * deadlock with a session, and sessions wait only for the milliseconds the
 * statements take. ONE transaction (it uses `set local`).
 *
 * Used by erasure-lifecycle.test.ts to replay 0134 over 0132 (its preflight
 * and postflight) and to prove the rollback restores 0132's behaviour —
 * always inside a rolled-back transaction. Not a test file: it registers no
 * tests. Never pointed at hosted.
 */

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const read = (file: string) => readFileSync(join(MIGRATIONS, file), "utf-8").replace(/\r\n/g, "\n");

/** The text from `start` up to and including the first `end` after it. */
function section(file: string, start: string, end: string): string {
  const text = read(file);
  const from = text.indexOf(start);
  if (from < 0) throw new Error(`revert-0134: ${file} has no "${start}"`);
  const to = text.indexOf(end, from);
  if (to < 0) throw new Error(`revert-0134: ${file} has no "${end}" after "${start}"`);
  return text.slice(from, to + end.length);
}

export const MIGRATION_0134 = "0134_erasure_lifecycle_guard.sql";
export const readMigration0134 = () => read(MIGRATION_0134);

/** 0131's events_insert check — the one 0134's preflight requires. */
export const POLICY_0131 = section("0131_authentic_stage_movement.sql", "alter policy events_insert on public.events", "\n  );");

export const REVERT_0134_SQL = [
  "set local lock_timeout = '5s';",
  `do $$
declare
  v_try int := 0;
begin
  loop
    begin
      lock table public.contacts, public.documents, public.events in access exclusive mode nowait;
      exit;
    exception when lock_not_available then
      v_try := v_try + 1;
      if v_try >= 100 then
        raise exception '0134 rollback: contacts, documents and events were never free at once (~5 s) — nothing was changed, apply it again';
      end if;
      perform pg_sleep(0.05);
    end;
  end loop;
end $$;`,
  POLICY_0131,
  "drop trigger if exists contacts_retain_erasure on public.contacts;",
  "drop function if exists public.trg_contacts_erasure_lifecycle();",
  "drop trigger if exists documents_kept_for_retention on public.documents;",
  "drop function if exists public.trg_documents_kept_for_retention();",
].join("\n\n");

/** events_insert's check as 0131 left it, rendered (search_path "$user", public, extensions). */
export const CHECK_0131 =
  "((org_id = ( SELECT current_org_id() AS current_org_id)) AND (actor_id = ( SELECT auth.uid() AS uid)) AND (NOT ((entity_type = 'deal'::text) AND (event_type = ANY (ARRAY['won'::text, 'lost'::text, 'won_override'::text])))) AND (event_type <> 'stage_changed'::text) AND (occurred_at = now()))";

/** …and as 0134 leaves it. */
export const CHECK_0134 =
  "((org_id = ( SELECT current_org_id() AS current_org_id)) AND (actor_id = ( SELECT auth.uid() AS uid)) AND (NOT ((entity_type = 'deal'::text) AND (event_type = ANY (ARRAY['won'::text, 'lost'::text, 'won_override'::text])))) AND (event_type <> 'stage_changed'::text) AND (event_type <> ALL (ARRAY['erased'::text, 'retention_purged'::text])) AND (occurred_at = now()))";
