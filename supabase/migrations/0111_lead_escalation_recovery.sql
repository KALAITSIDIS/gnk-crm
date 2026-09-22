-- =============================================================================
-- 0111 — an admin recovers a stopped lead escalation, by the job's id
--
-- THE GAP (audit 2026-09-22, fifth brief, verified against 7f12eaa). The
-- desk alert (0101) has had a staff retry since it existed —
-- `request_enquiry_alert_retry(p_lead_id)`, hard-wired to
-- kind = 'enquiry_desk_alert'. The escalation (0107) runs on the same outbox
-- and the worker deliberately closes several of its outcomes "for a
-- decision" (a provider conflict, a key past its window, a retry the window
-- cannot hold, a policy switched off at send time, nobody eligible) — and
-- nobody could take that decision: the inbox showed only the desk alert's
-- row and no function admitted an escalation. A second gap sat beside it:
-- the staff retry's accelerator claims "any due job of this lead, limit 1",
-- and since 0107 a lead can carry BOTH kinds, so the desk-alert retry could
-- claim and send the escalation instead.
--
-- WHAT THIS FILE DOES.
--   1. `claim_notification_jobs` gains `p_job_id uuid default null`: the
--      closures and the claim itself narrow to that one row when given. The
--      five-argument function is DROPPED first — a second defaulted overload
--      would make the deployed worker's four-named-argument call ambiguous
--      to PostgREST (the 0110 lesson) — and the six-argument one created in
--      the same transaction. A caller that omits p_job_id resolves as before,
--      so the hosted apply is not deploy-coupled.
--   2. `request_lead_escalation_recovery(p_job_id, p_action, p_reason)`:
--      the escalation's recovery, every rule in SQL — ADMIN only (the desk
--      alert's assignee rule is deliberately not extended: an escalation is
--      about the assignee), aal2, the caller's own organisation, this kind
--      only, the lead still open / unanswered / not redacted, the policy ON,
--      at least one configured recipient eligible NOW (active admin/agent of
--      the org, with an address, not the assignee), no live lease, not
--      accepted, not merely queued, and — the point of the two actions —
--        * `retry`  reuses the provider key and is admitted only while the
--                   key is safe to present again: no conflict, not
--                   key_window_expired / retry_beyond_window, first attempt
--                   inside notification_key_window();
--        * `resend` rotates the key (a NEW logical send, a reason required)
--                   and is admitted only when `retry` is NOT.
--      One row never admits both; the function refuses the wrong one with a
--      sentence, so a page can only ever offer the one the database would
--      accept, and nothing here — or anywhere — rotates a key on its own.
--      A cancellation is recoverable only when the POLICY was the cause
--      (escalation_disabled, no_recipient); one made because the lead was no
--      longer eligible is final. The row is locked `for update`, so of two
--      simultaneous requests the second re-reads a row already pending and
--      is refused. The event: `lead_escalation` / `recovery_requested` with
--      the admin as actor, the action, the previous state, category and
--      result, key_serial and key_rotated, and the reason (≤ 200 chars) —
--      ids and words, never a person. It goes through trg_events_hash, so
--      its id is drawn under the organisation's chain lock (0109).
--
-- NOT DONE HERE: no "send it now" for a queued row (the worker owns it), no
-- change to the desk alert's retry, no state reset beyond the transition
-- above, no cron, no table.
--
-- Pins that move with this file: the migrations count in
-- scripts/backup/verify-restore.sql (111) and one row in its grants table;
-- database.types.ts regenerated. The cron count stays TWELVE.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The claim, addressable by job id
-- ---------------------------------------------------------------------------
drop function if exists public.claim_notification_jobs(text, int, int, uuid, interval);

create function public.claim_notification_jobs(
  p_worker        text,
  p_limit         int      default 5,
  p_lease_seconds int      default 90,
  p_lead_id       uuid     default null,
  p_key_window    interval default public.notification_key_window(),
  p_job_id        uuid     default null
)
returns setof public.notification_jobs
language plpgsql security definer set search_path = public as $fn$
declare
  v_lease  interval := make_interval(secs => greatest(coalesce(p_lease_seconds, 90), 1));
  v_window interval := coalesce(p_key_window, public.notification_key_window());
begin
  if p_worker is null or btrim(p_worker) = '' then
    raise exception 'claim_notification_jobs: p_worker is required';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'claim_notification_jobs: p_limit must be between 1 and 100';
  end if;
  if v_window <= interval '0' or v_window > interval '24 hours' then
    raise exception 'claim_notification_jobs: p_key_window must be within the provider''s 24 hours';
  end if;

  -- 0) the legacy closure (0102, finding D) — DESK ALERTS ONLY (0107): an
  --    escalation row on a lead the pre-outbox route once alerted is not
  --    already sent
  with told as (
    update notification_jobs j
       set state         = 'accepted',
           last_category = null,
           last_result   = 'legacy_sender',
           accepted_at   = now(),
           finished_at   = now(),
           claimed_by    = null,
           claimed_until = null
     where j.kind = 'enquiry_desk_alert'
       and ((j.state = 'pending')
            or (j.state = 'sending' and j.claimed_until < now()))
       and (p_lead_id is null or j.lead_id = p_lead_id)
       and (p_job_id is null or j.id = p_job_id)
       and exists (select 1 from events e
                    where e.org_id = j.org_id
                      and e.entity_type = 'lead'
                      and e.entity_id = j.lead_id
                      and e.event_type = 'enquiry_alert'
                      and e.payload ->> 'outcome' = 'sent')
     returning j.*
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select t.org_id, null, 'lead', t.lead_id, 'enquiry_alert',
         jsonb_build_object('outcome', 'accepted', 'provider', t.provider, 'job_id', t.id,
                            'attempt', t.attempts, 'category', null, 'result', 'legacy_sender',
                            'provider_message_id', null, 'exhausted', false)
    from told t;

  -- 1) a lapsed lease with no attempts left
  with dead as (
    update notification_jobs j
       set state         = 'failed',
           last_category = 'timeout',
           last_result   = 'lease_expired',
           claimed_by    = null,
           claimed_until = null,
           finished_at   = now()
     where j.state = 'sending'
       and j.claimed_until < now()
       and j.attempts >= j.max_attempts
       and (p_lead_id is null or j.lead_id = p_lead_id)
       and (p_job_id is null or j.id = p_job_id)
     returning j.*
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select d.org_id, null, 'lead', d.lead_id,
         case d.kind when 'lead_escalation' then 'lead_escalation' else 'enquiry_alert' end,
         jsonb_build_object('outcome', 'failed', 'provider', d.provider, 'job_id', d.id,
                            'attempt', d.attempts, 'category', 'timeout',
                            'result', 'lease_expired', 'exhausted', true)
    from dead d;

  -- 2) the key window (0102, finding A): first presented longer ago than
  --    the provider remembers — closed for a human, never retried
  with stale as (
    update notification_jobs j
       set state         = 'failed',
           last_category = 'timeout',
           last_result   = 'key_window_expired',
           claimed_by    = null,
           claimed_until = null,
           finished_at   = now()
     where ((j.state = 'pending')
            or (j.state = 'sending' and j.claimed_until < now()))
       and j.first_attempted_at is not null
       and j.first_attempted_at < now() - v_window
       and (p_lead_id is null or j.lead_id = p_lead_id)
       and (p_job_id is null or j.id = p_job_id)
     returning j.*
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select s.org_id, null, 'lead', s.lead_id,
         case s.kind when 'lead_escalation' then 'lead_escalation' else 'enquiry_alert' end,
         jsonb_build_object('outcome', 'failed', 'provider', s.provider, 'job_id', s.id,
                            'attempt', s.attempts, 'category', 'timeout',
                            'result', 'key_window_expired', 'exhausted', false)
    from stale s;

  -- 3) the claim. The attempt AND the presentation are counted here: a
  --    worker that dies mid-send has spent both; one that runs out of budget
  --    gives both back with `released`.
  return query
  with due as (
    select j.id
      from notification_jobs j
     where ((j.state = 'pending' and j.next_attempt_at <= now())
            or (j.state = 'sending' and j.claimed_until < now()))
       and j.attempts < j.max_attempts
       and (j.first_attempted_at is null or j.first_attempted_at >= now() - v_window)
       and (p_lead_id is null or j.lead_id = p_lead_id)
       and (p_job_id is null or j.id = p_job_id)
     order by j.next_attempt_at
     limit p_limit
     for update skip locked
  )
  update notification_jobs j
     set state              = 'sending',
         claimed_by         = p_worker,
         claimed_until      = now() + v_lease,
         attempts           = j.attempts + 1,
         key_attempts       = j.key_attempts + 1,
         first_attempted_at = coalesce(j.first_attempted_at, now()),
         last_attempted_at  = now()
    from due
   where j.id = due.id
  returning j.*;
end $fn$;

comment on function public.claim_notification_jobs(text, int, int, uuid, interval, uuid) is
  'Claims up to p_limit due notification jobs for p_worker under a lease of '
  'p_lease_seconds (0101, reviewed 0102, key lifetime 0104, second kind 0107, '
  'exact job 0111): pending rows whose next_attempt_at has passed and sending '
  'rows whose lease lapsed, attempts < max_attempts, never attempted OR first '
  'attempted inside p_key_window (default notification_key_window(), 20 h) — '
  'for update skip locked. Counts the attempt and the presentation '
  '(key_attempts) at the claim. Before claiming it closes, with an event of '
  'the kind''s own type: desk-alert rows whose lead already carries '
  'enquiry_alert: sent (accepted / legacy_sender), lapsed leases with no '
  'attempts left (failed / lease_expired), and rows first attempted outside '
  'the window (failed / key_window_expired). p_lead_id narrows to one lead; '
  'p_job_id to one row — a staff action that was given a job id claims that '
  'job and no other, so a lead carrying both kinds never has the wrong one '
  'sent. service_role-only.';

-- ---------------------------------------------------------------------------
-- 2. The recovery
-- ---------------------------------------------------------------------------
create or replace function public.request_lead_escalation_recovery(
  p_job_id uuid,
  p_action text,
  p_reason text default null
)
returns setof public.notification_jobs
language plpgsql security definer set search_path = public as $fn$
declare
  v_uid      uuid := auth.uid();
  v_org      uuid;
  v_job      notification_jobs;
  v_lead     leads;
  v_cfg      jsonb;
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_key_safe boolean;
  v_serial   int;
  n          int;
begin
  -- who
  if v_uid is null then raise exception 'Not authenticated.'; end if;
  if not (select mfa_satisfied()) then raise exception 'Second factor required.'; end if;
  v_org := (select current_org_id());
  if v_org is null then raise exception 'Not authenticated.'; end if;
  if (select current_role_gnk()) <> 'admin' then raise exception 'Admins only.'; end if;
  if p_action is null or p_action not in ('retry', 'resend') then
    raise exception 'Unknown action "%" — retry or resend.', coalesce(p_action, '');
  end if;

  -- which row: the caller's own organisation, locked. A second request for
  -- the same row waits here and then reads the row as this one leaves it.
  select * into v_job from notification_jobs where id = p_job_id and org_id = v_org for update;
  if not found then raise exception 'Notification not found.'; end if;
  if v_job.kind <> 'lead_escalation' then
    raise exception 'Only a lead escalation can be recovered here — use Retry alert for the desk alert.';
  end if;

  -- the lead, now: still something to escalate
  select * into v_lead from leads where id = v_job.lead_id and org_id = v_org;
  if not found then raise exception 'Lead not found.'; end if;
  if v_lead.message = '[erased at the contact''s request]' then
    raise exception 'This enquiry has been redacted — there is nothing left to send.';
  end if;
  if v_lead.first_response_at is not null then
    raise exception 'The enquiry has been answered — no escalation is needed.';
  end if;
  if v_lead.status not in ('new', 'contacted', 'qualified') then
    raise exception 'The lead is closed — an escalation is only for an open enquiry.';
  end if;

  -- the policy, now: on, and somebody eligible to receive it (the worker
  -- applies the same rule again at send time — lib/services/lead-escalation.ts)
  v_cfg := public.lead_escalation_config();
  if not coalesce((v_cfg ->> 'enabled')::boolean, false) then
    raise exception 'Lead escalation is switched off — switch it on under Settings → Lead escalation first.';
  end if;
  select count(*) into n
    from profiles p
   where p.org_id = v_org
     and p.is_active
     and p.role in ('admin', 'agent')
     and coalesce(btrim(p.email), '') <> ''
     and (v_lead.assigned_agent_id is null or p.id <> v_lead.assigned_agent_id)
     and p.id in (select (e #>> '{}')::uuid from jsonb_array_elements(v_cfg -> 'recipients') e);
  if n = 0 then
    raise exception 'Nobody eligible would receive this escalation — check the recipients under Settings → Lead escalation.';
  end if;

  -- the row's state: only a stopped row may be recovered
  if v_job.state = 'accepted' then
    raise exception 'The escalation was already accepted by the provider.';
  end if;
  if v_job.state = 'sending' and v_job.claimed_until > now() then
    raise exception 'The escalation is being sent right now — try again in a minute.';
  end if;
  if v_job.state = 'pending' then
    if v_job.attempts > 0 then
      raise exception 'A retry is already scheduled — the sweep will send it.';
    end if;
    raise exception 'The escalation is queued — the sweep will send it.';
  end if;
  if v_job.state = 'cancelled'
     and coalesce(v_job.last_result, '') not in ('escalation_disabled', 'no_recipient') then
    raise exception 'This escalation was cancelled because the enquiry was no longer eligible (%) and cannot be recovered.',
      coalesce(v_job.last_result, 'unknown');
  end if;
  -- here: failed, sending under a lapsed lease, or cancelled by the policy

  -- the key: may the same one be presented again? Inside the window and
  -- without a conflict the provider deduplicates a repeat — a retry cannot
  -- send a second copy. Otherwise an earlier attempt may have been accepted
  -- with its answer lost, and only a person may decide to send again.
  v_key_safe := coalesce(v_job.last_category, '') <> 'conflict'
    and coalesce(v_job.last_result, '') not in ('key_window_expired', 'retry_beyond_window')
    and (v_job.first_attempted_at is null
         or v_job.first_attempted_at >= now() - public.notification_key_window());
  if p_action = 'retry' and not v_key_safe then
    raise exception 'The provider may already hold this e-mail under its key — an earlier attempt could have been sent. Review and resend under a new key instead.';
  end if;
  if p_action = 'resend' and v_key_safe then
    raise exception 'The same key is still safe to reuse — use Retry, which cannot send a second copy.';
  end if;
  if p_action = 'resend' and v_reason is null then
    raise exception 'A reason is required to resend under a new key.';
  end if;
  v_reason := left(v_reason, 200);
  v_serial := v_job.key_serial + case when p_action = 'resend' then 1 else 0 end;

  -- the transition: pending, due now, a fresh budget; the key and its
  -- history kept on retry, fresh on resend (0104: a new key has never been
  -- presented, so its clock and its presentation count start empty)
  update notification_jobs
     set state              = 'pending',
         attempts           = 0,
         next_attempt_at    = now(),
         claimed_by         = null,
         claimed_until      = null,
         key_serial         = v_serial,
         key_attempts       = case when p_action = 'resend' then 0 else key_attempts end,
         first_attempted_at = case when p_action = 'resend' then null else first_attempted_at end,
         last_category      = null,
         last_result        = null,
         finished_at        = null
   where id = v_job.id;

  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  values (
    v_job.org_id, v_uid, 'lead', v_job.lead_id, 'lead_escalation',
    jsonb_build_object(
      'outcome', 'recovery_requested',
      'action', p_action,
      'provider', v_job.provider,
      'job_id', v_job.id,
      'key_serial', v_serial,
      'key_rotated', p_action = 'resend',
      'previous_state', v_job.state,
      'previous_category', v_job.last_category,
      'previous_result', v_job.last_result,
      'reason', v_reason
    )
  );

  return query select * from notification_jobs where id = v_job.id;
end $fn$;

comment on function public.request_lead_escalation_recovery(uuid, text, text) is
  'An admin recovers a stopped lead escalation by its job id (0111): '
  'aal2-satisfied admin of the row''s own organisation; kind lead_escalation '
  'only; the lead still open, unanswered and not redacted; the policy on and '
  'at least one configured recipient eligible now; refused for a live lease, '
  'an accepted row, a queued or scheduled row, and a cancellation made '
  'because the lead was no longer eligible. retry: the same provider key, '
  'admitted only while it is safe to present again (no conflict, not '
  'key_window_expired / retry_beyond_window, first attempt inside '
  'notification_key_window()). resend: a new key (a reason required), '
  'admitted only when retry is not. Resets the row to pending with a fresh '
  'budget and writes lead_escalation / recovery_requested with the admin as '
  'actor. Returns the row. The action''s after() then claims THIS job.';

-- ---------------------------------------------------------------------------
-- 3. Grants — the 0044 lesson, every function since
-- ---------------------------------------------------------------------------
revoke execute on function public.claim_notification_jobs(text, int, int, uuid, interval, uuid) from public, anon, authenticated;
grant  execute on function public.claim_notification_jobs(text, int, int, uuid, interval, uuid) to service_role;
revoke execute on function public.request_lead_escalation_recovery(uuid, text, text) from public, anon;
grant  execute on function public.request_lead_escalation_recovery(uuid, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Apply-time assertions. The recovery needs a session and is proven by
--    supabase/tests/lead-escalation-recovery.test.ts; here its shape, its
--    grants and its first refusal are checked, and the exact-job claim is
--    exercised in a SUBTRANSACTION that is rolled back (0061's idiom), so
--    nothing is left on the first organisation — on hosted, the live one.
-- ---------------------------------------------------------------------------
do $$
declare
  v_org    uuid;
  v_slug   text;
  v_lead   uuid;
  v_desk   public.notification_jobs;
  v_esc    public.notification_jobs;
  v_got    public.notification_jobs;
  n        int;
  probed   text := 'skipped (no organizations)';
begin
  -- exactly one claim function, carrying p_job_id: a caller that omits it
  -- must resolve without ambiguity
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'claim_notification_jobs';
  if n <> 1 then
    raise exception '0111 aborted: expected one claim_notification_jobs, found % — a named-argument call would be ambiguous', n;
  end if;
  if pg_get_function_arguments('public.claim_notification_jobs'::regproc) not like '%p_job_id uuid DEFAULT NULL%' then
    raise exception '0111 aborted: claim_notification_jobs does not carry p_job_id';
  end if;

  if has_function_privilege('anon', 'public.claim_notification_jobs(text,int,int,uuid,interval,uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.claim_notification_jobs(text,int,int,uuid,interval,uuid)', 'execute')
     or not has_function_privilege('service_role', 'public.claim_notification_jobs(text,int,int,uuid,interval,uuid)', 'execute') then
    raise exception '0111 aborted: claim grants are wrong';
  end if;
  if has_function_privilege('anon', 'public.request_lead_escalation_recovery(uuid,text,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.request_lead_escalation_recovery(uuid,text,text)', 'execute')
     or not has_function_privilege('service_role', 'public.request_lead_escalation_recovery(uuid,text,text)', 'execute') then
    raise exception '0111 aborted: recovery grants are wrong';
  end if;

  -- without a session the recovery refuses before it reads anything
  begin
    perform public.request_lead_escalation_recovery(gen_random_uuid(), 'retry', null);
    raise exception '0111 aborted: the recovery ran without a session';
  exception
    when raise_exception then
      if sqlerrm <> 'Not authenticated.' then raise; end if;
  end;

  select id, slug into v_org, v_slug from organizations order by created_at limit 1;
  if v_org is not null then
    begin
      select s.lead_id into v_lead
        from submit_public_enquiry(v_slug, '0111 selftest both kinds', 'selftest-0111-both@example.invalid',
                                   null, '0111 self-test both kinds', null, 'selftest-0111-both', null) s;
      if v_lead is null then raise exception '0111 aborted: the door refused the self-test enquiry'; end if;
      select * into v_desk from notification_jobs where lead_id = v_lead and kind = 'enquiry_desk_alert';
      insert into notification_jobs (org_id, lead_id, kind) values (v_org, v_lead, 'lead_escalation') returning * into v_esc;

      -- both rows are due now; by job id exactly the escalation is handed out
      select * into v_got from claim_notification_jobs('selftest-0111', 5, 60, null, null, v_esc.id);
      if not found or v_got.id <> v_esc.id or v_got.kind <> 'lead_escalation' then
        raise exception '0111 aborted: a claim by job id did not hand out that job';
      end if;
      select count(*) into n from notification_jobs where lead_id = v_lead and kind = 'enquiry_desk_alert'
         and state = 'pending' and attempts = 0 and key_attempts = 0 and claimed_by is null;
      if n <> 1 then raise exception '0111 aborted: the desk alert was touched by a claim for the escalation'; end if;

      -- lead AND job id must agree: the desk row named with another lead's id yields nothing
      select count(*) into n from claim_notification_jobs('selftest-0111-b', 5, 60, gen_random_uuid(), null, v_desk.id);
      if n <> 0 then raise exception '0111 aborted: a claim with a mismatched lead and job id handed out a row'; end if;
      -- and a caller that names neither still receives the due rows as before
      select count(*) into n from claim_notification_jobs('selftest-0111-c', 5, 60, v_lead);
      if n <> 1 then raise exception '0111 aborted: expected the one remaining due row for the lead, found %', n; end if;

      probed := 'PASSED — a claim by job id hands out that row alone; lead and job id must agree; a caller without it is unchanged';

      -- unwind everything: the lead, its rows, its events
      raise exception using errcode = 'YY111', message = 'rollback the 0111 probe';
    exception
      when sqlstate 'YY111' then null;   -- specific: a real failure still propagates
    end;
    if exists (select 1 from leads where id = v_lead) then
      raise exception '0111 aborted: the probe did not unwind';
    end if;
  end if;

  raise notice '0111 ok: exact-job claim and admin recovery of a lead escalation — probe %', probed;
end $$;
