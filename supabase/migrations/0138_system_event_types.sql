-- =============================================================================
-- 0138 — a session cannot write the records only the system writes:
--        `enquiry_alert`, `lead_escalation` and `opened`
--
-- THE GAP (BACKLOG "A session may write ANY event type…", the machine-reader
-- addendum T-routing-own-org's and T-share-link-opened-own-org's reviews
-- added; re-verified 2026-10-03 on the local stack at 0137 by
-- supabase/tests/system-event-types.test.ts, pinned RED first — DECISIONS
-- T-system-event-types has the count):
--
--   * `events_insert` (latest 0134) lets an aal2 session write any event
--     type in its own organisation but the five 0128 / 0131 / 0134 reserve.
--     Three more are written ONLY by the system (definers and the service
--     role — the app writes none of them through a session: every literal and
--     every computed `eventType` in lib/ and app/ was read 2026-10-03), and
--     machines read them as the system's word:
--       - `enquiry_alert` — claim_notification_jobs (0111) closes a pending
--         desk alert as already sent when it finds an `enquiry_alert` event
--         with `outcome = 'sent'` for the lead: any member could write one,
--         and the desk was never told of a website enquiry;
--       - `lead_escalation` — the escalation's own record (0107 / 0111):
--         a forged line reads as an escalation that happened;
--       - `opened` — resolve_share_link's once-a-day evidence line (0137
--         stopped a session's line suppressing the system's, but a session's
--         `opened` still renders as "Proposal link opened — N properties",
--         like a buyer's view, with a payload of its choosing).
--
-- THE FIX: `events_insert` gains `event_type not in ('enquiry_alert',
-- 'lead_escalation', 'opened')` under ANY entity_type, as 0134 did for
-- erased / retention_purged; 0128's, 0131's and 0134's clauses are kept
-- verbatim, each its own clause (their restore-pack rows read them). RLS binds
-- sessions only: the definers that write these lines (the claim / finish
-- functions, the escalation sweep, resolve_share_link) and the service role
-- (the alert worker, the tests' fixtures) are unchanged.
--
-- WHY NOT a reader-side fix (`actor_id is null` in each reader): every new
-- reader would have to remember it; the policy closes the write once (0128 /
-- 0131 / 0134's precedent). `assigned` is NOT reserved: the app writes it
-- through the session (reassignLead, the task assignee) — a member steering
-- the round-robin with one stays on BACKLOG.
--
-- CONTRACT. No function changes; types identical; no release-compat entry.
-- The deployed app writes none of the three through a session, so this is
-- NOT deploy-coupled: hosted 0138 first, then merge.
--
-- LOCKS: ALTER POLICY takes ACCESS EXCLUSIVE on events for the milliseconds
-- to commit — reads of events wait too; the diagnostic and the boundary are
-- read under it (exact). lock_timeout 5 s; a 55P03 keeps nothing — apply
-- again, no ledger row. ONE transaction (checked below). Apply in the usual
-- window (outside 02:55–04:05 UTC, away from 06:00, not on a minute the
-- enquiry-alert cron runs — every even minute).
--
-- PREFLIGHT refuses, changing nothing, unless events_insert's check is
-- exactly 0134's (read under the fixed search_path).
--
-- EXISTING ROWS — READ-ONLY DIAGNOSTIC, NO REPAIR (the file's last row):
--   session_written_system_events  events of the three types with an actor
--                                  (the system writes them with none) — lines
--                                  a session forged before 0138;
--   boundary                       the largest event id when sessions lost the
--                                  right to write them.
-- RESOLUTION: an operator decision per counted row, recorded in DECISIONS.
--
-- NOT CHANGED: who may read events; every other event type; the definers;
-- the service role; existing events (nothing is written, modified or moved).
--
-- ROLLBACK, a forward migration in one transaction: restore 0134's
-- events_insert (supabase/tests/revert-0138.ts slices that statement from
-- 0134's file, and the test file replays it). In the same change: delete the
-- test file and helper; remove the restore pack's 0138 row and move its
-- migrations pin FORWARD; restore the BACKLOG text. No data moves.
--
-- Pins that move with this file: scripts/backup/verify-restore.sql (the
-- migrations count, the 0138 SECURITY row).
-- =============================================================================

set local lock_timeout = '5s';
-- pg_get_expr's output depends on the session's search_path: read the policy
-- under the FIXED path local and hosted both use (0127 / 0134's idiom)
set local search_path = "$user", public, extensions;

do $$
begin
  if current_setting('lock_timeout') <> '5s' then
    raise exception '0138 aborted: this file must run as ONE transaction (SET LOCAL lock_timeout did not take effect) — nothing was changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Preflight: events_insert is exactly 0134's
-- ---------------------------------------------------------------------------
do $$
declare
  v_check text;
begin
  select pg_get_expr(p.polwithcheck, p.polrelid) into v_check
    from pg_policy p
   where p.polrelid = 'public.events'::regclass and p.polname = 'events_insert' and p.polcmd = 'a';
  if v_check is distinct from
     '((org_id = ( SELECT current_org_id() AS current_org_id)) AND (actor_id = ( SELECT auth.uid() AS uid)) AND (NOT ((entity_type = ''deal''::text) AND (event_type = ANY (ARRAY[''won''::text, ''lost''::text, ''won_override''::text])))) AND (event_type <> ''stage_changed''::text) AND (event_type <> ALL (ARRAY[''erased''::text, ''retention_purged''::text])) AND (occurred_at = now()))' then
    raise exception '0138 aborted: events_insert''s check is not 0134''s (%) — nothing was changed', coalesce(v_check, 'missing');
  end if;
  -- the hoisted-policy count the postflight must find unchanged (0030)
  perform set_config('gnk.m0138_hoisted', public.rls_hoisted_policy_count()::text, true);
  raise notice '0138: preflight passed — events_insert is 0134''s';
end $$;

-- ---------------------------------------------------------------------------
-- A session may not write the system's `enquiry_alert`, `lead_escalation`
-- or `opened` lines
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
    -- 0131: stage_changed is the deals_stage_changed_event trigger's, a
    -- definer; a session may not write it at all (its own clause: 0131's
    -- restore-pack row reads it)
    and event_type <> 'stage_changed'
    -- 0134: erased / retention_purged are the erasure's and the purge's,
    -- written as the system; a session may not write them under any
    -- entity_type — the erasure reads its own as "already complete"
    and event_type not in ('erased', 'retention_purged')
    -- 0138: enquiry_alert / lead_escalation / opened are the alert worker's,
    -- the escalation sweep's and the public share page's, written as the
    -- system; machines read them as the system's word
    and event_type not in ('enquiry_alert', 'lead_escalation', 'opened')
    -- 0128: a session's event occurs at its own insert (the column's default)
    and occurred_at = now()
  );

-- ---------------------------------------------------------------------------
-- Postflight, the diagnostic and the boundary (events' lock is held: exact)
-- ---------------------------------------------------------------------------
do $$
declare
  v_check text;
  v_max   bigint;
  v_forged bigint;
begin
  select pg_get_expr(p.polwithcheck, p.polrelid) into v_check
    from pg_policy p where p.polrelid = 'public.events'::regclass and p.polname = 'events_insert';
  if v_check is distinct from
     '((org_id = ( SELECT current_org_id() AS current_org_id)) AND (actor_id = ( SELECT auth.uid() AS uid)) AND (NOT ((entity_type = ''deal''::text) AND (event_type = ANY (ARRAY[''won''::text, ''lost''::text, ''won_override''::text])))) AND (event_type <> ''stage_changed''::text) AND (event_type <> ALL (ARRAY[''erased''::text, ''retention_purged''::text])) AND (event_type <> ALL (ARRAY[''enquiry_alert''::text, ''lead_escalation''::text, ''opened''::text])) AND (occurred_at = now()))' then
    raise exception '0138 postflight: events_insert is not the 0138 check: %', v_check;
  end if;
  if public.rls_hoisted_policy_count()::text is distinct from current_setting('gnk.m0138_hoisted', true) then
    raise exception '0138 postflight: rls_hoisted_policy_count moved (% → %)',
      current_setting('gnk.m0138_hoisted', true), public.rls_hoisted_policy_count();
  end if;
  if exists (select 1 from public.rls_bare_helper_calls() where policyname = 'events_insert')
     or exists (select 1 from public.rls_bare_auth_calls() where policyname = 'events_insert') then
    raise exception '0138 postflight: events_insert calls a helper or auth function bare';
  end if;

  select coalesce(max(e.id), 0) into v_max from public.events e;
  select count(*) into v_forged from public.events e
   where e.event_type in ('enquiry_alert', 'lead_escalation', 'opened') and e.actor_id is not null;
  perform set_config('gnk.m0138_existing',
    format('session_written_system_events=%s boundary=%s', v_forged, v_max), true);
  raise notice '0138: postflight passed — events_insert refuses a session''s enquiry_alert / lead_escalation / opened';
end $$;

-- EXISTING ROWS (header) — read-only, nothing repaired; the file's LAST result
select current_setting('gnk.m0138_existing', true) as existing_rows;
