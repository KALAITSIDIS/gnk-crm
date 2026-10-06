import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The way back from 0141 — its documented ROLLBACK, run as ONE transaction and
 * only once the application no longer calls record_price_list_version: the
 * function, the unique index, the pairing check and the two columns go;
 * nothing else 0141 did needs undoing (it changed no policy, trigger or row).
 *
 * Used by price-list-version.test.ts to replay 0141 over the state before it
 * and to prove the rollback leaves the deployed-before-0141 path working —
 * always inside a rolled-back transaction. Not a test file: it registers no
 * tests. Never pointed at hosted.
 */

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

export const MIGRATION_0141 = "0141_atomic_price_list_version.sql";
export const readMigration0141 = () =>
  readFileSync(join(MIGRATIONS, MIGRATION_0141), "utf-8").replace(/\r\n/g, "\n");

export const REVERT_0141_SQL = `
drop function public.record_price_list_version(uuid, uuid, text, text, numeric, text, jsonb);
drop index public.price_lists_org_operation_key;
alter table public.price_lists drop constraint price_lists_operation_pair;
alter table public.price_lists drop column operation, drop column operation_id;
`;
