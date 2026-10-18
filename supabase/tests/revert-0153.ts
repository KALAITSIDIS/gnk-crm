import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The way back from 0153 — its documented ROLLBACK, run as ONE transaction
 * (one execute_sql call, or a forward migration file) AFTER the application
 * release that reads the function has been rolled back: the function goes.
 * Nothing else moves — 0153 read and wrote no data, and admin_dashboard_stats
 * (whose property_statuses the previous dashboard reads) was never touched.
 * Under 0153's own bounded wait.
 *
 * Used by dashboard-inventory.test.ts to replay 0153 over the state before
 * it, to plant what its preflight must refuse, and to prove the rollback —
 * always inside a rolled-back transaction. Not a test file: it registers no
 * tests. Never pointed at hosted.
 */

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

export const MIGRATION_0153 = "0153_property_inventory_counts.sql";
export const readMigration0153 = () =>
  readFileSync(join(MIGRATIONS, MIGRATION_0153), "utf-8").replace(/\r\n/g, "\n");

/** md5(replace(prosrc, chr(13), '')) of the function's body, as 0153's preflight and postflight pin it. */
export const BODY_MD5_0153 = "08fd3810d66ff221198a022f9bf58c5c";

export const SIGNATURE_0153 = "public.property_inventory_counts()";

export const REVERT_0153_SQL = `
set local lock_timeout = '5s';
drop function public.property_inventory_counts();
`;
