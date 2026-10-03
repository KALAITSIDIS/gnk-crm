import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The way back from 0136 to 0114's public enquiry door — 0136's documented
 * ROLLBACK: submit_public_enquiry() recreated with 0114's exact text, comment
 * and grants, sliced from 0114's own file so it cannot drift from what 0114
 * applied (hosted's body hashed identical to that file's on 2026-10-03).
 *
 * Used by routing-own-org.test.ts to replay 0136 over 0114's body and to prove
 * the rollback restores the cross-organisation counts — always inside a
 * rolled-back transaction. Not a test file: it registers no tests. Never
 * pointed at hosted.
 */

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const read = (file: string) => readFileSync(join(MIGRATIONS, file), "utf-8").replace(/\r\n/g, "\n");

export const MIGRATION_0136 = "0136_routing_counts_own_org.sql";
export const readMigration0136 = () => read(MIGRATION_0136);

/** md5 of 0114's prosrc — the preflight's guard, and what the rollback must restore. */
export const BODY_0114_MD5 = "65da4d2d2efb3762dbca32277971a0a6";
export const SIG_0136 = "public.submit_public_enquiry(text, text, text, text, text, text, text, jsonb)";

function slice0114(): string {
  const s = read("0114_enquiry_identity_single_line.sql");
  const start = s.indexOf("create or replace function public.submit_public_enquiry(");
  const endMark = `grant  execute on function ${SIG_0136}\n  to service_role;`;
  const end = s.indexOf(endMark, start);
  if (start < 0 || end < 0) throw new Error("revert-0136: 0114's submit_public_enquiry text was not found");
  return s.slice(start, end + endMark.length);
}

export const REVERT_0136_SQL = slice0114();
