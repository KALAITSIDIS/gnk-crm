import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The way back from 0137 to 0041's public share page — 0137's documented
 * ROLLBACK: resolve_share_link() recreated with 0041's exact text and grants,
 * sliced from 0041's own file so it cannot drift from what 0041 applied
 * (hosted's body hashed identical to that file's on 2026-10-03).
 *
 * Used by share-link-opened-own-org.test.ts to replay 0137 over 0041's body
 * and to prove the rollback restores the unbounded throttle — always inside a
 * rolled-back transaction. Not a test file: it registers no tests. Never
 * pointed at hosted.
 */

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const read = (file: string) => readFileSync(join(MIGRATIONS, file), "utf-8").replace(/\r\n/g, "\n");

export const MIGRATION_0137 = "0137_share_link_opened_own_org.sql";
export const readMigration0137 = () => read(MIGRATION_0137);

/** md5 of 0041's prosrc — the preflight's guard, and what the rollback must restore. */
export const BODY_0041_MD5 = "529134eb853faf9aa3b0c9a63257a35e";
export const SIG_0137 = "public.resolve_share_link(text)";

/** 0041's exposure guard: no column of these names may appear in the function's source (0041's header). */
export const FORBIDDEN_0041 = [
  "owner_net_price",
  "min_acceptable_price",
  "internal_notes",
  "amenities_notes",
  "title_deed_status",
  "postal_code",
  "owner_contact_id",
  "developer_contact_id",
  "commission",
] as const;

function slice0041(): string {
  const s = read("0041_availability_share_links.sql");
  const start = s.indexOf("create or replace function resolve_share_link(");
  const endMark = "grant  execute on function resolve_share_link(text) to anon, authenticated, service_role;";
  const end = s.indexOf(endMark, start);
  if (start < 0 || end < 0) throw new Error("revert-0137: 0041's resolve_share_link text was not found");
  return s.slice(start, end + endMark.length);
}

export const REVERT_0137_SQL = slice0041();
