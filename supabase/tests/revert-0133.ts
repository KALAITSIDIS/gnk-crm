import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The way back from 0133 to 0132's catalogue — 0133's documented ROLLBACK:
 * the 11 `<table>_id_without_history` triggers dropped, then their function.
 * 0133 replaced nothing, so nothing is restored; every drop is `if exists`, so
 * the text is a no-op on a database still at 0132 and an earlier migration's
 * replay test may run it unconditionally (0131's does: its preflight requires
 * deals to carry exactly the triggers it was written against). Inside a
 * transaction: it uses `set local`.
 *
 * Like 0132's rollback it takes every lock at once, NOWAIT, retrying for about
 * 5 s, so it never waits while holding a lock (DROP TRIGGER takes ACCESS
 * EXCLUSIVE, and no drop order avoids every cycle with a session).
 *
 * Used by insert-id-history.test.ts to replay 0133 over 0132 and to prove the
 * rollback restores 0132's behaviour — always inside a rolled-back
 * transaction. Not a test file: it registers no tests. Never pointed at hosted.
 */

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

export const MIGRATION_0133 = "0133_insert_id_without_history.sql";
export const readMigration0133 = () => readFileSync(join(MIGRATIONS, MIGRATION_0133), "utf-8").replace(/\r\n/g, "\n");

/**
 * Each table whose row id is a history subject — the `entity_type` its
 * events (and, where the CHECKs allow, its interaction notes and documents)
 * carry — in 0133's lock order, parents first. profiles' history is also every
 * event it is the ACTOR of.
 */
export const HISTORY_SUBJECTS: ReadonlyArray<readonly [table: string, entityType: string]> = [
  ["profiles", "user"],
  ["contacts", "contact"],
  ["properties", "property"],
  ["property_keys", "key"],
  ["mandates", "mandate"],
  ["leads", "lead"],
  ["deals", "deal"],
  ["viewings", "viewing"],
  ["offers", "offer"],
  ["share_links", "share_link"],
  ["tasks", "task"],
];

export const REVERT_0133_SQL = [
  "set local lock_timeout = '5s';",
  `do $$
declare
  v_try int := 0;
begin
  loop
    begin
      lock table ${HISTORY_SUBJECTS.map(([t]) => `public.${t}`).join(", ")} in access exclusive mode nowait;
      exit;
    exception when lock_not_available then
      v_try := v_try + 1;
      if v_try >= 100 then
        raise exception '0133 rollback: the 11 tables were never free at once (~5 s) — nothing was changed, apply it again';
      end if;
      perform pg_sleep(0.05);
    end;
  end loop;
end $$;`,
  ...[...HISTORY_SUBJECTS].reverse().map(([table]) => `drop trigger if exists ${table}_id_without_history on public.${table};`),
  "drop function if exists public.trg_insert_id_without_history();",
].join("\n");
