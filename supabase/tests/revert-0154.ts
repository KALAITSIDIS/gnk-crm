import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The way back from 0154 — its documented ROLLBACK, run as ONE transaction
 * (one execute_sql call, or a forward migration file): report_source_roi gets
 * 0076's body and comment back, report_stage_conversion 0130's (CREATE OR
 * REPLACE keeps both functions' grants). No row moves either way. Under 0154's
 * own lock discipline: a bounded wait; CREATE OR REPLACE FUNCTION takes no
 * table lock, so there is nothing to lock up front.
 *
 * The two restatements are taken VERBATIM from 0076 (section 5) and 0130 (the
 * reader and its comment) rather than retyped, so they are byte-for-byte the
 * text whose digests 0154's preflight accepts as "before" — asserted by
 * report-definitions.test.ts, which uses this file to replay 0154 over the
 * state before it, to plant what its preflight must refuse, and to prove the
 * rollback, always inside a rolled-back transaction. Not a test file: it
 * registers no tests. Never pointed at hosted.
 */

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const read = (file: string) => readFileSync(join(MIGRATIONS, file), "utf-8").replace(/\r\n/g, "\n");

export const MIGRATION_0154 = "0154_report_definitions.sql";
export const readMigration0154 = () => read(MIGRATION_0154);

/** md5(replace(prosrc, chr(13), '')) of each body, as 0154's preflight and postflight pin them. */
export const BODY_MD5_0154 = {
  report_source_roi: { before: "5cebcb28051927a5def7908631fbc8e7", after: "a2d98fbb96ce5ff94805c193dee3d331" },
  report_stage_conversion: { before: "f5d44b9a7e9f420cb459cce9ff18b4a7", after: "68246923289bff0870562f640a5ffa08" },
} as const;

/** The text between `start` (included) and `end` (excluded) of a migration file; throws when either is missing. */
function section(file: string, start: string, end: string): string {
  const sql = read(file);
  const from = sql.indexOf(start);
  const to = from < 0 ? -1 : sql.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`revert-0154: ${file} no longer holds the section starting "${start}"`);
  return sql.slice(from, to);
}

/** 0076 section 5: report_source_roi and its comment. */
export const SOURCE_ROI_0076 = section(
  "0076_final_value_and_report_honesty.sql",
  "create or replace function public.report_source_roi(",
  "-- ---------- 6. report_stage_conversion",
);

/** 0130: report_stage_conversion and its comment (the postflight that follows is 0130's own). */
export const STAGE_CONVERSION_0130 = section(
  "0130_stage_conversion_malformed_ids.sql",
  "create or replace function public.report_stage_conversion(",
  "-- ---------------------------------------------------------------------------\n-- Postflight",
);

export const REVERT_0154_SQL = `
set local lock_timeout = '5s';

${SOURCE_ROI_0076}
${STAGE_CONVERSION_0130}
`;
