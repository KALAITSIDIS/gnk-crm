import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The way back from 0144 — its documented ROLLBACK, run as ONE transaction
 * (one execute_sql call, or a forward migration file): the three finite-amount
 * CHECKs go; nothing else 0144 did needs undoing (it changed no column, policy,
 * trigger, function or row). Under 0144's own lock discipline: a bounded wait,
 * deals then offers locked up front in one statement (inside a DO block — the
 * CLI refuses a top-level LOCK), the parent's CHECKs dropped first.
 *
 * Used by money-amounts-finite.test.ts to replay 0144 over the state before
 * it, to plant rows its preflight must refuse, and to prove the rollback
 * leaves the 0143 checks in place — always inside a rolled-back transaction.
 * Not a test file: it registers no tests. Never pointed at hosted.
 */

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

export const MIGRATION_0144 = "0144_finite_money_amounts.sql";
export const readMigration0144 = () =>
  readFileSync(join(MIGRATIONS, MIGRATION_0144), "utf-8").replace(/\r\n/g, "\n");

export const FINITE_CHECKS_0144 = [
  "offers_amount_finite",
  "deals_expected_value_finite",
  "deals_final_value_finite",
] as const;

export const REVERT_0144_SQL = `
set local lock_timeout = '5s';
do $$
begin
  lock table public.deals, public.offers in access exclusive mode;
end $$;
alter table public.deals
  drop constraint deals_expected_value_finite,
  drop constraint deals_final_value_finite;
alter table public.offers drop constraint offers_amount_finite;
`;
