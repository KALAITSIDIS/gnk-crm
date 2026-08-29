-- 0071 — an event names its author, enforced at the database (audit
-- 2026-08-29, SEC-01).
--
-- The INSERT policy on `events` checked only org membership, so any
-- authenticated aal2 session could append rows with an ARBITRARY actor_id —
-- another user's, or null, which renders as "system". The hash chain proves
-- nothing was EDITED after the fact; it says nothing about whether a row was
-- written by the person it names. In a commission or GDPR dispute, opposing
-- counsel could argue any staff member could have written any log line —
-- and the log's evidentiary weight is the product's stated USP (doc 01
-- §11.2). With two admin users today the insider pool is tiny; the policy is
-- for the desk this system is built to become.
--
-- ============================================================================
-- COMPATIBILITY WAS MEASURED, NOT ASSUMED. Every writer class was enumerated
-- (2026-08-29) before tightening:
--
--   app layer      lib/services/events.ts logEvent — every call site passes
--                  the caller's own profile.id (= auth.uid()); the optional
--                  actorId defaulting to null was a footgun this policy now
--                  turns into a loud insert error instead of a silent
--                  "system" row.
--   invoker RPCs   move_deal_to_stage (0067), add_deal_stage / reorder_stage
--                  (0014) — all write auth.uid().
--   invoker trigs  trg_price_history (0005), trg_supersede_deal_nudges /
--                  _viewing_nudges (0025) — all write auth.uid().
--   definer RPCs   record_key_movement (0013), resolve_share_link
--                  (0023/0041) — run as owner, RLS bypassed; unaffected.
--   sweeps/crons   expire_mandates, create_followup_nudges,
--                  warn_expiring_reservations, remind_due_installments,
--                  expire_reservations, raise_key_recall_tasks — write
--                  actor null but EXECUTE is revoked from `authenticated`
--                  (0007/0020/0025 et al.) and they run as postgres under
--                  pg_cron or service_role, which bypass RLS; unaffected.
--
-- So: no authenticated path exists that legitimately writes an actor other
-- than its own uid, and system (null-actor) rows remain possible exactly for
-- the roles that should write them. RLS test 47 pins all three directions.
-- ============================================================================
--
-- NOT A HAZARDOUS DEPLOY. Policy only — additive restriction, no schema
-- change, live code already complies. Standard additive order: hosted first,
-- then merge.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

drop policy events_insert on public.events;

create policy events_insert on public.events for insert
  with check ((org_id = (select current_org_id()))
              and (actor_id = (select auth.uid())));

do $$
declare
  chk text;
  n   int;
begin
  select with_check into chk
    from pg_policies
   where schemaname = 'public' and tablename = 'events'
     and policyname = 'events_insert';

  if chk is null then
    raise exception '0071 aborted: events_insert policy is missing';
  end if;
  if chk !~ 'actor_id' or chk !~ 'auth\.uid' then
    raise exception '0071 aborted: events_insert does not bind actor_id to auth.uid(): %', chk;
  end if;
  if chk !~ 'current_org_id' then
    raise exception '0071 aborted: the org check was lost in the rewrite: %', chk;
  end if;

  -- the policy set on events must be exactly what 0063 left plus this rewrite:
  -- events_select, events_insert, require_aal2 — a dropped-and-not-recreated
  -- policy here would fail open or closed silently.
  select count(*) into n
    from pg_policies where schemaname = 'public' and tablename = 'events';
  if n <> 3 then
    raise exception '0071 aborted: expected 3 policies on events, found %', n;
  end if;

  raise notice '0071: events_insert now requires actor_id = auth.uid() (3 policies on events, org check intact)';
end $$;
