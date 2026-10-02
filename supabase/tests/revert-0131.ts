import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The way back from 0131 to 0130's catalogue — 0131's documented ROLLBACK,
 * built from the APPLIED migration files themselves rather than retyped, so it
 * cannot drift from what 0131 replaced:
 *
 *   - the deals_stage_changed_event trigger and its function dropped;
 *   - move_deal_to_stage as 0067 wrote it (its event INSERT back) + its grants;
 *   - trg_deals_closed_guard as 0118 wrote it + its revoke;
 *   - events_insert's check as 0128 wrote it.
 *
 * All of it in ONE transaction, as the 0131 header says: the trigger without
 * 0067's INSERT writes one event per move, both together write two, 0067's
 * INSERT under 0131's policy refuses every move.
 *
 * Used by stage-movement-authentic.test.ts to replay 0131 over 0130 (its
 * preflight and postflight) and to prove the rollback restores 0130's
 * behaviour — always inside a rolled-back transaction. Not a test file: it
 * registers no tests. Never pointed at hosted.
 */

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const read = (file: string) => readFileSync(join(MIGRATIONS, file), "utf-8").replace(/\r\n/g, "\n");

/** The text from `start` up to and including the first `end` after it. */
function section(file: string, start: string, end: string): string {
  const text = read(file);
  const from = text.indexOf(start);
  if (from < 0) throw new Error(`revert-0131: ${file} has no "${start}"`);
  const to = text.indexOf(end, from);
  if (to < 0) throw new Error(`revert-0131: ${file} has no "${end}" after "${start}"`);
  return text.slice(from, to + end.length);
}

export const MIGRATION_0131 = "0131_authentic_stage_movement.sql";
export const readMigration0131 = () => read(MIGRATION_0131);

/** 0067's move_deal_to_stage and its grants. */
export const RPC_0067 = section(
  "0067_stage_change_ids.sql",
  "create or replace function public.move_deal_to_stage(p_deal_id uuid, p_stage_id uuid)",
  "grant  execute on function public.move_deal_to_stage(uuid, uuid) to authenticated, service_role;",
);

/** 0118's deals_closed_guard body and its revoke (the trigger itself is unchanged by 0131). */
export const GUARD_0118 = section(
  "0118_deal_close_only_through_close_deal.sql",
  "create or replace function public.trg_deals_closed_guard()",
  "revoke execute on function public.trg_deals_closed_guard() from public, anon, authenticated, service_role;",
);

/** 0128's events_insert check. */
export const POLICY_0128 = section("0128_session_written_events.sql", "alter policy events_insert on public.events", "\n  );");

export const REVERT_0131_SQL = [
  "drop trigger if exists deals_stage_changed_event on public.deals;",
  "drop function if exists public.trg_deals_stage_changed_event();",
  RPC_0067,
  GUARD_0118,
  POLICY_0128,
].join("\n\n");

/**
 * The preflight's code hash: md5 of the body with CRs, `--` comments and runs
 * of whitespace normalised — the expression 0131 evaluates in SQL.
 */
export const CODE_MD5_SQL =
  "md5(btrim(regexp_replace(regexp_replace(replace(p.prosrc, E'\\r', ''), '--[^\\n]*', '', 'g'), '\\s+', ' ', 'g')))";
