import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The way back from 0143 — its documented ROLLBACK, run as ONE transaction and
 * only once the application no longer calls set_unit_status: the function
 * goes; nothing else 0143 did needs undoing (it created no table and changed
 * no policy, trigger or existing row).
 *
 * Used by unit-status-actions.test.ts to replay 0143 over the state before it
 * and to prove the rollback leaves the pre-0143 path working — always inside a
 * rolled-back transaction. Not a test file: it registers no tests. Never
 * pointed at hosted.
 */

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

export const MIGRATION_0143 = "0143_atomic_unit_status.sql";
export const readMigration0143 = () =>
  readFileSync(join(MIGRATIONS, MIGRATION_0143), "utf-8").replace(/\r\n/g, "\n");

export const REVERT_0143_SQL = `
drop function public.set_unit_status(uuid, text, text, uuid);
`;
