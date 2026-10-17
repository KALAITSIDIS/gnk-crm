import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The way back from 0148 — its documented ROLLBACK, run as ONE transaction
 * (one execute_sql call, or a forward migration file): the
 * property_media_paths_own_property CHECK goes; nothing else 0148 did needs
 * undoing (it changed no column, policy, trigger, function or row). Under
 * 0148's own lock discipline: a bounded wait, the table locked up front
 * inside a DO block (the CLI refuses a top-level LOCK). `if exists`, so the
 * text is a no-op on a database still at 0147.
 *
 * Used by media-path-bound.test.ts to replay 0148 over the state before it,
 * to plant the rows its preflight must refuse (a row written before 0148),
 * and to prove the rollback — always inside a rolled-back transaction, or
 * restored in a `finally`. Not a test file: it registers no tests. Never
 * pointed at hosted.
 */

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

export const MIGRATION_0148 = "0148_media_paths_own_property.sql";
export const readMigration0148 = () =>
  readFileSync(join(MIGRATIONS, MIGRATION_0148), "utf-8").replace(/\r\n/g, "\n");

export const CHECK_0148 = "property_media_paths_own_property";

export const REVERT_0148_SQL = `
set local lock_timeout = '5s';
do $$
begin
  lock table public.property_media in access exclusive mode;
end $$;
alter table public.property_media drop constraint if exists property_media_paths_own_property;
`;
