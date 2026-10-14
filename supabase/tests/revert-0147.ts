import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The way back from 0147 to 0146's catalogue — 0147's documented ROLLBACK:
 * the 51 policies it hoisted written bare again, 0030's
 * rls_bare_helper_calls() body and comment, and 0100's comments on
 * rls_bare_auth_calls() / rls_hoisted_policy_count().
 *
 * Nothing here is typed by hand: the 51 ALTERs are 0147's own statements
 * with the `(select …)` wrapper removed (none of the 51 carried a wrapped
 * call before 0147 — measured — so the removal restores each text exactly:
 * the replay in rls-hoist.test.ts proves it by passing 0147's preflight, which
 * pins every predicate's md5), and the guard body and comments are sliced
 * from 0030's and 0100's files. CREATE OR REPLACE keeps the guard's ACL.
 *
 * ALTER POLICY takes ACCESS EXCLUSIVE, so the text takes 0147's 19 locks
 * first, in 0147's order. ONE transaction (it uses `set local`).
 *
 * Used by rls-hoist.test.ts to replay 0147 over 0146 and to prove the rollback
 * — always inside a rolled-back transaction. Not a test file: it registers no
 * tests. Never pointed at hosted.
 */

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const read = (file: string) => readFileSync(join(MIGRATIONS, file), "utf-8").replace(/\r\n/g, "\n");

export const MIGRATION_0147 = "0147_hoist_remaining_rls_helpers.sql";
export const readMigration0147 = () => read(MIGRATION_0147);

/** md5 of rls_bare_helper_calls()'s prosrc — 0030's (0147's preflight pin) and 0147's (its self-check pin). */
export const GUARD_0030_MD5 = "90aac6a256ba53f176f169e0d6dd14ee";
export const GUARD_0147_MD5 = "bbf45e18e481985b9d6491045388da68";
/** md5 of the three guards' comments before 0147 (local and hosted read them equal on 2026-10-14). */
export const COMMENTS_0146_MD5 = {
  rls_bare_auth_calls: "1949e03e670ace32f7f30285e70d9ff4",
  rls_bare_helper_calls: "ff4445693835baa0ae2e915c994068c4",
  rls_hoisted_policy_count: "350654610b8882b3749b37de399d2105",
} as const;

/** The 51 ALTER POLICY statements of 0147, as the file carries them. */
export function alters0147(): string[] {
  const s = readMigration0147();
  const from = s.indexOf("\nalter policy ");
  const to = s.indexOf("-- ---------------------------------------------------------------------------\n-- The guard looks at the whole schema now");
  if (from < 0 || to < 0 || to < from) throw new Error("revert-0147: 0147's ALTER block was not found");
  const stmts = s
    .slice(from, to)
    .split(/\n(?=alter policy )/)
    .map((x) => x.trim())
    .filter((x) => x.startsWith("alter policy "));
  if (stmts.length !== 51) throw new Error(`revert-0147: expected 51 ALTERs, found ${stmts.length}`);
  return stmts;
}

/** `alter policy <name> on public.<table>` → [table, name]. */
export const policyOf = (stmt: string): [string, string] => {
  const m = /^alter policy (\S+) on public\.(\S+)/.exec(stmt);
  if (!m) throw new Error(`revert-0147: not an ALTER POLICY: ${stmt.slice(0, 60)}`);
  return [m[2]!, m[1]!];
};

/** 0147's lock statement, as the file carries it (the rollback takes the same locks in the same order). */
export function locks0147(): string {
  const m = /lock table public\.[^;]*in access exclusive mode;/.exec(readMigration0147());
  if (!m) throw new Error("revert-0147: 0147's lock statement was not found");
  return m[0];
}

function slice(file: string, start: string, end: string): string {
  const s = read(file);
  const a = s.indexOf(start);
  const b = s.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`revert-0147: ${start} not found in ${file}`);
  return s.slice(a, b + end.length);
}

export const REVERT_0147_SQL = () =>
  [
    "set local lock_timeout = '5s';",
    `set local search_path = "$user", public, extensions;`,
    locks0147(),
    ...alters0147().map((stmt) => stmt.replace(/\(select current_org_id\(\)\)/g, "current_org_id()").replace(/\(select current_role_gnk\(\)\)/g, "current_role_gnk()")),
    // 0030's guard and its comment
    slice("0030_hoist_rls_helpers.sql", "create or replace function public.rls_bare_helper_calls()", "$$;"),
    slice("0030_hoist_rls_helpers.sql", "comment on function public.rls_bare_helper_calls() is", "';\n"),
    // 0100's two comments
    slice("0100_advisor_lints.sql", "comment on function public.rls_bare_auth_calls() is", "';\n"),
    slice("0100_advisor_lints.sql", "comment on function public.rls_hoisted_policy_count() is", "';\n"),
  ].join("\n\n");
