import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The way back from 0150 — its documented ROLLBACK, run as ONE transaction
 * (one execute_sql call, or a forward migration file). Valid only while 0151
 * has NOT been applied: 0097's readers must still exist for the application
 * to call (revert 0151 first, with revert-0151.ts).
 *
 * The four functions, the two tables and the four columns go, the composite
 * key 0150 added goes, and portal_connections gets 0095's table-level INSERT
 * and UPDATE grants back. Pull history and export dates are lost (telemetry,
 * not records); no row the desk wrote moves, and no feed URL changes — 0150
 * never touched the token column.
 *
 * Used by portal-feed-integrity.test.ts inside rolled-back transactions. Not a
 * test file: it registers no tests. Never pointed at hosted.
 */

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

export const MIGRATION_0150 = "0150_portal_feed_integrity.sql";
export const readMigration0150 = () =>
  readFileSync(join(MIGRATIONS, MIGRATION_0150), "utf-8").replace(/\r\n/g, "\n");

export const REVERT_0150_SQL = `
set local lock_timeout = '5s';
do $$
begin
  if to_regprocedure('public.portal_connection_by_token(text, text)') is null then
    raise exception 'revert-0150: 0151 is applied (0097''s readers are gone) — revert 0151 first';
  end if;
end $$;
drop function if exists public.portal_feed_connection(text, text);
drop function if exists public.portal_feed_supplement(text);
drop function if exists public.record_portal_pull(text, text, text, integer, integer, integer, text, jsonb);
drop function if exists public.sync_portal_export(text, jsonb);
drop table if exists public.portal_export_state;
drop table if exists public.portal_pull_log;
alter table public.portal_connections drop constraint if exists portal_connections_org_id_id_key;
alter table public.portal_connections
  drop column if exists last_pull_outcome,
  drop column if exists last_success_at,
  drop column if exists last_error_at,
  drop column if exists last_error_reason;
revoke insert (id, org_id, portal, enabled, settings, feed_token_sha256, updated_by)
  on table public.portal_connections from authenticated;
revoke update (id, enabled, settings, feed_token_sha256, updated_by)
  on table public.portal_connections from authenticated;
grant insert, update on table public.portal_connections to authenticated;
comment on column public.portal_connections.last_pulled_at is null;
comment on column public.portal_connections.last_pull_count is null;
`;
