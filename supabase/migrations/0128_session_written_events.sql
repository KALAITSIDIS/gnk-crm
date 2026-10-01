-- =============================================================================
-- 0128 — what a user session may write into the append-only chain: never a
--        deal's terminal event, and never an occurred_at of its choosing
--
-- THE GAP (BACKLOG "A user session can hand-write a deal's terminal events",
-- "A crafted event's `occurred_at` is bounded only in the renderer";
-- reproduced 2026-10-01 against 85639ad on the local stack at 0127 through
-- PostgREST with aal2 sessions of a throwaway organisation, pinned RED first by
-- supabase/tests/session-written-events.test.ts — 5 of its 10 tests failed at
-- 0127's policy, each for the reason it names; the 5 that passed are the paths
-- this file must keep: a deal's `updated` and a lead's `lost` on a session,
-- close_deal's own terminal event, a session event left to the default
-- occurred_at, the service role's explicit occurred_at — and the chain
-- verifying):
--
--   * events_insert (0071) checks only `org_id = current_org_id()` and
--     `actor_id = auth.uid()`. The session that may close a deal could also
--     POST `won` / `lost` / `won_override` events for it — or for any deal of
--     its organisation — without closing it, and the chain keeps them for
--     good. Only close_deal, a definer, writes them (0117 / 0118); 0118 made
--     the DEAL unreachable, not the event. Measured: an admin's and the deal
--     agent's direct `won`, `lost` and `won_override` were all accepted.
--   * The same policy let a session set `occurred_at`. A far-future value
--     (measured: year 200000 stored as sent) sorts first in the admin feed for
--     good, skews `occurred_at_inversion`, and lands in the DEFAULT partition;
--     a past value back-dates a record that is meant to be contemporaneous.
--
-- THE FIX
--   A. events_insert gains `not (entity_type = 'deal' and event_type in
--      ('won','lost','won_override'))`, keeping its hoisted `(select …)` form
--      (rls_hoisted_policy_count pins it, 0030). Checked first: no app path,
--      invoker function or test writes those three on a session —
--      add_deal_stage / reorder_stage log `stages_updated`, move_deal_to_stage
--      `stage_changed`, the notes trigger `conversation_logged`; a LEAD's
--      `lost` is entity_type 'lead' and is untouched. close_deal is a definer
--      and RLS does not apply to it.
--   B. events_insert also gains `occurred_at = now()`: a session's event
--      occurs at its own insert. The column defaults to now(), and no session
--      writer sets it (logEvent, and the four invoker functions that insert
--      events — add_deal_stage, move_deal_to_stage, reorder_stage, the notes
--      trigger — name every column but occurred_at), so every write today
--      passes; a value a session SUPPLIES is refused (42501). RLS binds only
--      sessions: definers, the service role (imports, backfills) and a
--      restore keep what they give.
--      NOT a BEFORE trigger that stamps now(): events is partitioned BY
--      occurred_at, the row is routed to its partition BEFORE the partition's
--      BEFORE trigger runs, and a trigger that moves it to another partition
--      fails 0A000 ("moving row to another partition during a BEFORE FOR EACH
--      ROW trigger is not supported") — measured on the first version of this
--      file. NOT a table CHECK: it would bind imports and a restore too, and
--      a CHECK must not depend on now().
--
-- NOT CHANGED: what any session may READ; every other event type; the chain
-- trigger (events_hash / trg_events_hash) and its lock; the partitions; no
-- trigger and no function is added.
--
-- LOCKS. ALTER POLICY takes an ACCESS EXCLUSIVE lock on events; every event
-- write waits behind it.
-- lock_timeout (5 s) bounds each wait; a collision is a clean 55P03 rollback —
-- then apply again, and do NOT write the ledger row. ONE transaction.
--
-- ROLLBACK, a forward migration: restore events_insert's 0071 check (the
-- preflight below quotes it); in the same change delete
-- supabase/tests/session-written-events.test.ts and verify-restore.sql's 0128
-- row. No data moves.
-- =============================================================================

set local lock_timeout = '5s';

do $$
begin
  if current_setting('lock_timeout') <> '5s' then
    raise exception '0128 aborted: this file must run as ONE transaction (SET LOCAL lock_timeout did not take effect) — nothing was changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Preflight: the policy this file rewrites must be 0071's.
-- ---------------------------------------------------------------------------
do $$
declare
  v_check text;
begin
  select pg_get_expr(p.polwithcheck, p.polrelid) into v_check
    from pg_policy p
   where p.polrelid = 'public.events'::regclass and p.polname = 'events_insert' and p.polcmd = 'a';
  if v_check is distinct from
     '((org_id = ( SELECT current_org_id() AS current_org_id)) AND (actor_id = ( SELECT auth.uid() AS uid)))' then
    raise exception '0128 aborted: events_insert''s check is not 0071''s (%) — nothing was changed', coalesce(v_check, 'missing');
  end if;
  raise notice '0128: preflight passed — events_insert is 0071''s';
end $$;

-- ---------------------------------------------------------------------------
-- A. a deal's terminal events come only from close_deal
-- ---------------------------------------------------------------------------
alter policy events_insert on public.events
  with check (
    -- 0071's two clauses, written as 0071 wrote them so the hoisted form
    -- renders identically (rls_hoisted_policy_count)
    org_id = (select current_org_id())
    and actor_id = (select auth.uid())
    -- 0128: won / lost / won_override are close_deal's, a definer; a session
    -- may not write them for any deal
    and not (entity_type = 'deal' and event_type in ('won', 'lost', 'won_override'))
    -- 0128: a session's event occurs at its own insert (the column's default)
    and occurred_at = now()
  );

-- ---------------------------------------------------------------------------
-- Postflight
-- ---------------------------------------------------------------------------
do $$
declare
  v_check text;
begin
  select pg_get_expr(p.polwithcheck, p.polrelid) into v_check
    from pg_policy p where p.polrelid = 'public.events'::regclass and p.polname = 'events_insert';
  if v_check !~ 'won_override' or v_check !~ 'occurred_at = now\(\)'
     or v_check !~ 'SELECT current_org_id\(\) AS current_org_id' or v_check !~ 'SELECT auth\.uid\(\) AS uid' then
    raise exception '0128 postflight: events_insert is not the 0128 check: %', v_check;
  end if;
  raise notice '0128: postflight passed';
end $$;
