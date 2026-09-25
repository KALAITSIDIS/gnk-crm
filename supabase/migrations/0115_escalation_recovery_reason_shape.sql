-- =============================================================================
-- 0115 — an escalation recovery's event carries no typed reason (SEC-03)
--
-- THE LEAK (BACKLOG, found by T-reservation-release-reason-shape's scouts;
-- verified against f075f9b). `request_lead_escalation_recovery` (0111, the
-- latest body — 0112 did not re-create it) wrote the admin-typed resend
-- reason, up to 200 characters, into the `lead_escalation` /
-- `recovery_requested` event as `'reason', v_reason`. The events table is
-- append-only and hash-chained: nothing written there can be erased or
-- corrected, and a reason for resending an unanswered enquiry's escalation is
-- exactly where somebody writes "rang Mrs X on 99…". No timeline line printed
-- it (there is no `lead_escalation` entry in EVENT_LINES) — the dialog's
-- promise "kept on the lead's timeline" was never kept — so the chain was its
-- ONLY home, and the TypeScript payload scan cannot see SQL.
--
-- WHAT THIS FILE DOES. Re-creates the function from 0111's text with exactly
-- three removals (a `diff` against 0111's body shows only them):
--   * the `'reason'` key of the event — every other key stays: the admin as
--     actor, `action`, `provider`, `job_id`, `key_serial`, `key_rotated`,
--     `previous_state` / `_category` / `_result`. Those ARE the audit fact:
--     who decided, when, which recovery, and why the worker had stopped;
--   * the refusal "A reason is required to resend under a new key." — the
--     text is no longer kept anywhere, and a required field that nothing
--     keeps would tell the admin a falsehood. The friction that matters stays
--     in the page: Review & resend is a dialog that states the duplicate risk
--     and needs an explicit confirmation, and the DATABASE still admits
--     `resend` only when `retry` is unsafe;
--   * the `v_reason` variable and its 200-character cut.
-- `p_reason` STAYS in the signature, accepted and ignored: dropping it would
-- change the arity, and the deployed code (which sends it on a resend) would
-- fail CLOSED until the new code deployed. With it kept, this file is not
-- deploy-coupled in either order, and a later migration may drop it once no
-- deployed caller sends it. The return shape is untouched.
--
-- NOT DONE HERE: existing `recovery_requested` events keep their reason — the
-- chain cannot be edited (a decision for the operator, as for every SEC-03
-- follow-up). No new column: the reason is not moved to the job row, because
-- nothing reads it and a new home would need its own erasure rule.
--
-- Pins that move with this file: the migrations count in
-- scripts/backup/verify-restore.sql (115). Grants are unchanged and
-- re-stated. database.types.ts is unchanged (same arguments).
-- =============================================================================

create or replace function public.request_lead_escalation_recovery(
  p_job_id uuid,
  p_action text,
  p_reason text default null   -- accepted and IGNORED since 0115: never stored
)
returns setof public.notification_jobs
language plpgsql security definer set search_path = public as $fn$
declare
  v_uid      uuid := auth.uid();
  v_org      uuid;
  v_job      notification_jobs;
  v_lead     leads;
  v_cfg      jsonb;
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
      'previous_result', v_job.last_result
    )
  );

  return query select * from notification_jobs where id = v_job.id;
end $fn$;

comment on function public.request_lead_escalation_recovery(uuid, text, text) is
  'An admin recovers a stopped lead escalation by its job id (0111; 0115 '
  'dropped the typed reason): aal2-satisfied admin of the row''s own '
  'organisation; kind lead_escalation only; the lead still open, unanswered '
  'and not redacted; the policy on and at least one configured recipient '
  'eligible now; refused for a live lease, an accepted row, a queued or '
  'scheduled row, and a cancellation made because the lead was no longer '
  'eligible. retry: the same provider key, admitted only while it is safe to '
  'present again (no conflict, not key_window_expired / retry_beyond_window, '
  'first attempt inside notification_key_window()). resend: a new key, '
  'admitted only when retry is not. p_reason is accepted and ignored — no '
  'typed text reaches the chain. Resets the row to pending with a fresh '
  'budget and writes lead_escalation / recovery_requested with the admin as '
  'actor. Returns the row. The action''s after() then claims THIS job.';

-- grants: unchanged by create or replace, re-stated (the 0044 lesson)
revoke execute on function public.request_lead_escalation_recovery(uuid, text, text) from public, anon;
grant  execute on function public.request_lead_escalation_recovery(uuid, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Apply-time assertions. The behaviour needs a session and is proven by
-- supabase/tests/lead-escalation-recovery.test.ts; here the shape.
-- ---------------------------------------------------------------------------
do $$
declare
  n   int;
  src text;
begin
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'request_lead_escalation_recovery';
  if n <> 1 then raise exception '0115 aborted: expected one request_lead_escalation_recovery, found %', n; end if;

  select p.prosrc into src from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'request_lead_escalation_recovery'
     and p.prosecdef and 'search_path=public' = any (p.proconfig)
     and pg_get_function_identity_arguments(p.oid) = 'p_job_id uuid, p_action text, p_reason text';
  if src is null then
    raise exception '0115 aborted: the recovery lost its signature, SECURITY DEFINER or search_path';
  end if;
  if src ~* 'v_reason|''reason''|p_reason' then
    raise exception '0115 aborted: the recovery still reads or writes a reason';
  end if;
  if src !~ '''recovery_requested''' or src !~ '''previous_result''' or src !~ '''key_rotated''' then
    raise exception '0115 aborted: the recovery event lost an audit fact';
  end if;

  if has_function_privilege('anon', 'public.request_lead_escalation_recovery(uuid,text,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.request_lead_escalation_recovery(uuid,text,text)', 'execute')
     or not has_function_privilege('service_role', 'public.request_lead_escalation_recovery(uuid,text,text)', 'execute') then
    raise exception '0115 aborted: recovery grants are wrong';
  end if;

  -- without a session it still refuses before it reads anything
  begin
    perform public.request_lead_escalation_recovery(gen_random_uuid(), 'resend', 'x');
    raise exception '0115 aborted: the recovery ran without a session';
  exception
    when raise_exception then
      if sqlerrm <> 'Not authenticated.' then raise; end if;
  end;

  raise notice '0115: request_lead_escalation_recovery writes no reason; signature, grants and first refusal unchanged';
end $$;
