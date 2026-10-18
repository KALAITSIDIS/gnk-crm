-- =============================================================================
-- 0151 — portal feed integrity, CONTRACT half (portal integrations audit
-- 2026-10-18; DECISIONS T-portal-feed-integrity).
--
-- WHAT IT DOES. Drops 0097's three anon-callable functions:
--   portal_connection_by_token(p_portal, p_token_sha256)
--   portal_supplement(p_token_sha256)
--   note_portal_pull(p_token_sha256, p_ua, p_count)
-- Each compared its argument straight to portal_connections.feed_token_sha256,
-- so the stored digest — in every export, dump, offsite archive and member's
-- read since 0097 — opened the feed over PostgREST, and the third let any
-- token or digest holder write the pull telemetry. 0150 added their
-- replacements, which hash the URL's token themselves (readers) or are
-- service_role only (writes). After this file no function accepts the
-- stored value as a credential, and no existing feed URL changes: the column
-- still holds sha256(token) and the new readers hash the token they are given.
--
-- DEPLOY ORDER: CONTRACT — DESTRUCTIVE AFTER DEPLOY (HANDOFF's inverted
-- order). Apply to hosted only AFTER the application that calls 0150's
-- functions is deployed and its deployment SHA confirmed. Against an older
-- application every pull would answer 404 (PGRST202 on the lookup — fails
-- CLOSED: a portal keeps its listings stale, it does not remove them) and
-- every pull note would be lost. ROLLBACK FLOOR: no application older than
-- this branch's merge runs against a database at 0151.
--
-- ROLLBACK: a forward migration recreating the three functions with 0097's
-- bodies and grants (supabase/tests/revert-0151.ts holds the text). It
-- re-opens the defect; it exists only so an application rollback past the
-- floor has a database to run against.
--
-- Pins that move with this file: scripts/backup/verify-restore.sql (the
-- migrations count; the three anon rows go, and the pack's anon paragraph
-- states the rows by form: six (true, true, true, true), the two 0150
-- readers (true, true, false, true));
-- supabase/tests/aal1-definer-boundary.test.ts (three exemptions removed).
-- NO EXPLICIT begin/commit (HANDOFF §3). The file's LAST result is a summary.
-- =============================================================================

set local lock_timeout = '5s';

do $$
begin
  if current_setting('lock_timeout') <> '5s' then
    raise exception '0151 aborted: this file must run as ONE transaction (SET LOCAL lock_timeout did not take effect) — nothing was changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 0. Preflight — 0150's replacements are in place, so the drop strands nothing
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.portal_feed_connection(text, text)') is null
     or to_regprocedure('public.portal_feed_supplement(text)') is null
     or to_regprocedure('public.record_portal_pull(text, text, text, integer, integer, integer, text, jsonb)') is null
     or to_regprocedure('public.sync_portal_export(text, jsonb)') is null then
    raise exception '0151 aborted: 0150''s functions are not all there — apply 0150 first; nothing was changed';
  end if;
  if not has_function_privilege('anon', 'public.portal_feed_connection(text, text)', 'execute')
     or not has_function_privilege('anon', 'public.portal_feed_supplement(text)', 'execute') then
    raise exception '0151 aborted: anon cannot call 0150''s feed readers — dropping the old ones would 404 every pull; nothing was changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. The three digest-taking functions go
-- ---------------------------------------------------------------------------
drop function if exists public.portal_connection_by_token(text, text);
drop function if exists public.portal_supplement(text);
drop function if exists public.note_portal_pull(text, text, integer);

-- ---------------------------------------------------------------------------
-- 2. Postflight — no anon-callable function reads the token column without
--    hashing what it was given
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
begin
  if to_regprocedure('public.portal_connection_by_token(text, text)') is not null
     or to_regprocedure('public.portal_supplement(text)') is not null
     or to_regprocedure('public.note_portal_pull(text, text, integer)') is not null then
    raise exception '0151 postflight: a digest-taking portal function survived';
  end if;
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and has_function_privilege('anon', p.oid, 'execute')
     and position('feed_token_sha256' in p.prosrc) > 0
     and position('pg_catalog.sha256(convert_to(' in p.prosrc) = 0;
  if v_bad is not null then
    raise exception '0151 postflight: anon may call % , which reads feed_token_sha256 without hashing its argument', v_bad;
  end if;
end $$;

select 'portal digest readers dropped (contract)' as migration_0151,
       (select count(*) from pg_proc p
         where p.pronamespace = 'public'::regnamespace
           and p.proname in ('portal_feed_connection', 'portal_feed_supplement', 'record_portal_pull', 'sync_portal_export')) as replacements;
