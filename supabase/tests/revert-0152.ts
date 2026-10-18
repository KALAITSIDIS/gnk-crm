import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The way back from 0152 — its documented ROLLBACK, run as ONE transaction
 * (one execute_sql call, or a forward migration file): the trigger
 * properties_storage_from_features and its body go, and the column's
 * "derived" comment is cleared. The backfilled has_storage values stay —
 * they are valid at 0151, where the column was free, and which rows were NULL
 * before 0152 is not kept. Under 0152's lock discipline, one step stronger:
 * DROP TRIGGER takes ACCESS EXCLUSIVE, so that is taken up front inside a DO
 * block (the CLI refuses a top-level LOCK), with the same bounded wait.
 * `if exists`, so the text is a no-op on a database still at 0151.
 *
 * Used by storage-room-one-value.test.ts to replay 0152 over the state before
 * it, to plant the rows its preflight must refuse (a row written before 0152
 * whose two values disagree), and to prove the rollback — always inside a
 * rolled-back transaction. Not a test file: it registers no tests. Never
 * pointed at hosted.
 */

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

export const MIGRATION_0152 = "0152_storage_room_one_value.sql";
export const readMigration0152 = () =>
  readFileSync(join(MIGRATIONS, MIGRATION_0152), "utf-8").replace(/\r\n/g, "\n");

export const TRIGGER_0152 = "properties_storage_from_features";
export const FUNCTION_0152 = "public.trg_property_storage_from_features()";

export const REVERT_0152_SQL = `
set local lock_timeout = '5s';
do $$
begin
  lock table public.properties in access exclusive mode;
end $$;
drop trigger if exists properties_storage_from_features on public.properties;
drop function if exists public.trg_property_storage_from_features();
comment on column public.properties.has_storage is null;
`;
