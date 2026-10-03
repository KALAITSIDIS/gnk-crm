import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The way back from 0135 to 0094's sweep — 0135's documented ROLLBACK:
 * redact_stale_enquiries() recreated with 0094's exact text and comment,
 * sliced from 0094's own file so it cannot drift from what 0094 applied
 * (hosted's body hashed identical to that file's on 2026-10-03). CREATE OR
 * REPLACE keeps the grants and the cron job, as 0135 itself does.
 *
 * Used by redact-notes-own-org.test.ts to replay 0135 over 0094's body and to
 * prove the rollback restores the cross-organisation blanking — always inside
 * a rolled-back transaction. Not a test file: it registers no tests. Never
 * pointed at hosted.
 */

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const read = (file: string) => readFileSync(join(MIGRATIONS, file), "utf-8").replace(/\r\n/g, "\n");

export const MIGRATION_0135 = "0135_redact_notes_own_org.sql";
export const readMigration0135 = () => read(MIGRATION_0135);

/** md5 of 0094's prosrc — the preflight's guard, and what the rollback must restore. */
export const BODY_0094_MD5 = "044c146a25329a36fb7b89049e2b3ab3";

function slice0094(): string {
  const s = read("0094_interaction_notes.sql");
  const start = s.indexOf("create or replace function public.redact_stale_enquiries");
  const endMark = "Idempotent: an already-redacted row is skipped.';";
  const end = s.indexOf(endMark, start);
  if (start < 0 || end < 0) throw new Error("revert-0135: 0094's redact_stale_enquiries text was not found");
  return s.slice(start, end + endMark.length);
}

export const REVERT_0135_SQL = slice0094();
