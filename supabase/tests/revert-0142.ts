import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The way back from 0142 — its documented ROLLBACK, run as ONE transaction and
 * only once the application no longer calls apply_unit_type: the function and
 * the operation record go; nothing else 0142 did needs undoing (it changed no
 * policy, trigger or existing row).
 *
 * Used by unit-type-apply.test.ts to replay 0142 over the state before it and
 * to prove the rollback leaves the pre-0142 path working — always inside a
 * rolled-back transaction. Not a test file: it registers no tests. Never
 * pointed at hosted.
 */

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

export const MIGRATION_0142 = "0142_atomic_unit_type_apply.sql";
export const readMigration0142 = () =>
  readFileSync(join(MIGRATIONS, MIGRATION_0142), "utf-8").replace(/\r\n/g, "\n");

export const REVERT_0142_SQL = `
drop function public.apply_unit_type(uuid, uuid, uuid, text);
drop table public.unit_type_applications;
`;
