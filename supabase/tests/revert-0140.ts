import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The way back from 0140 to 0093's dashboard function — 0140's documented
 * ROLLBACK: admin_dashboard_stats() recreated with 0093's exact text, sliced
 * from 0093's own file so it cannot drift from what 0093 applied (hosted's
 * body hashed identical to it on 2026-10-04). CREATE OR REPLACE keeps the
 * grants, as 0140 itself does.
 *
 * Used by dashboard-won-value.test.ts to replay 0140 over 0093's body and to
 * prove the rollback brings the estimate back — always inside a rolled-back
 * transaction. Not a test file: it registers no tests. Never pointed at hosted.
 */

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const read = (file: string) => readFileSync(join(MIGRATIONS, file), "utf-8").replace(/\r\n/g, "\n");

export const MIGRATION_0140 = "0140_dashboard_won_final_value.sql";
export const readMigration0140 = () => read(MIGRATION_0140);

/** md5 of 0093's prosrc (CR-stripped) — the preflight's guard, and what the rollback restores. */
export const BODY_0093_MD5 = "23f87cba94b4a79357cb5888bab2203a";

/** The function's full signature. */
export const SIG_0140 = "public.admin_dashboard_stats(timestamp with time zone,timestamp with time zone,timestamp with time zone)";

function slice0093(): string {
  const s = read("0093_dashboard_counts_live_listings.sql");
  const start = s.indexOf("CREATE OR REPLACE FUNCTION public.admin_dashboard_stats(");
  const endMark = "$function$;";
  const end = s.indexOf(endMark, start);
  if (start < 0 || end < 0) throw new Error("revert-0140: 0093's admin_dashboard_stats text was not found");
  return s.slice(start, end + endMark.length);
}

export const REVERT_0140_SQL = slice0093();
