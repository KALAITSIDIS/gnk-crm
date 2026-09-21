-- =============================================================================
-- 0102 — the desk-alert outbox after review: the provider's key window,
--        the legacy closure inside the claim, a way to hand back an
--        unattempted claim, and the lifetime of a rotated key
--
-- 0101 built the outbox on one promise: every automatic retry presents the
-- SAME provider idempotency key, so a retry after a LOST ANSWER — the
-- provider accepted the message and the response never arrived — is answered
-- with the first message rather than a second one. Resend keeps a key for
-- 24 hours (docs re-read 2026-09-21) and says nothing about what happens
-- after. The review found the promise unguarded:
--
-- A. `claim_notification_jobs` handed out any due row whatever its age. The
--    backoff schedule fits in ~2h07m, but a schedule only says when a retry
--    is DUE; the sweep that runs it is a daily Vercel cron until pg_net is
--    approved, and can be down. A row first attempted 25 hours earlier still
--    reached the sender, under a key nobody remembered — a second e-mail
--    where the whole design exists to prevent one. Reproduced on the local
--    stack before this file (supabase/tests/enquiry-alert-outbox-window.test.ts).
--
--    NOW: `notification_key_window()` is the ONE definition of how long a key
--    may be trusted — 20 hours, the provider's 24 minus a margin for clock
--    skew and for the provider counting from ITS receipt, not our claim. The
--    claim refuses any row whose FIRST attempt is older than that and closes
--    it for a human instead: `failed`, category `timeout`, result
--    `key_window_expired`, one event. A row that has NEVER been attempted is
--    eligible however old it is — the clock is the first attempt, not the
--    creation (`first_attempted_at`, set at the first claim, is what counts,
--    so a claim that died before sending counts as an attempt: conservative
--    on purpose). The worker also checks the same window before it sends,
--    and refuses to schedule a retry the window could not hold; the SQL is
--    the backstop that makes the worker's arithmetic unable to matter.
--
-- D. The rollout guard — a lead the pre-0101 route already alerted, whose
--    timeline says `enquiry_alert: sent` — was a separate read in the worker,
--    and a read that FAILED let the send proceed. It is now part of the
--    claim, in the claim's own transaction: such a row is closed as accepted
--    / `legacy_sender` (no attempt spent, one event) and is never handed out.
--    There is no longer a lookup that can fail independently of the claim.
--
-- B. A sweep is one function invocation with a time budget. When the budget
--    cannot fit another 8-second provider call, the worker must hand a job
--    back UNATTEMPTED — and 0101 counted the attempt at the claim, so a slow
--    batch would have spent attempts on messages nobody tried to send.
--    `complete_notification_job` gains the outcome `released`: back to
--    pending, due now, the attempt given back, and the first-attempt clock
--    cleared when the claim was the only attempt there ever was.
--
-- Rotation. `request_enquiry_alert_retry` (the explicit human resend) already
-- rotated the key after a conflict or after 24 hours, but left
-- `first_attempted_at` where it was — so the NEW key would have looked expired
-- at once under the rule above. A rotated key is a key that has never been
-- attempted: its clock is cleared with it. Rotation stays a human decision —
-- the worker never rotates to escape an ambiguous outcome or a conflict.
--
-- SIGNATURES. `claim_notification_jobs` gains a fifth argument with a default
-- (`p_key_window interval default notification_key_window()`), which needs a
-- drop-and-create; the deployed worker's four named arguments still resolve
-- (0098's lesson: a defaulted parameter is safe in this deploy order).
-- `complete_notification_job` and `request_enquiry_alert_retry` keep their
-- signatures (`create or replace`, ACL preserved, restated anyway). The
-- door is untouched.
--
-- Pins that move with this file: the migrations count in
-- scripts/backup/verify-restore.sql; the grants table gains no row
-- (`notification_key_window` is SECURITY INVOKER and returns a constant).
-- The cron count stays TEN. The TS side pins the window in
-- lib/services/enquiry-alert-jobs.ts against this file's literal.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The one definition of the window
-- ---------------------------------------------------------------------------
create or replace function public.notification_key_window()
returns interval
language sql immutable parallel safe as $fn$
  select interval '20 hours'
$fn$;

comment on function public.notification_key_window() is
  'How long a provider idempotency key may be trusted (0102): Resend keeps a '
  'key 24 hours; 20 leaves a margin for clock skew and for the provider''s own '
  'clock. Past this, a job whose first attempt is older is closed for review '
  '(key_window_expired) rather than retried under a key the provider may have '
  'forgotten. lib/services/enquiry-alert-jobs.ts carries the same number.';

-- ---------------------------------------------------------------------------
-- 2. The claim: legacy closure, window closure, then the claim itself
-- ---------------------------------------------------------------------------
drop function if exists public.claim_notification_jobs(text, int, int, uuid);

create function public.claim_notification_jobs(
  p_worker        text,
  p_limit         int      default 5,
  p_lease_seconds int      default 90,
  p_lead_id       uuid     default null,
  p_key_window    interval default public.notification_key_window()
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
  -- A window past the provider's retention is a mistake, not a setting.
  if v_window <= interval '0' or v_window > interval '24 hours' then
    raise exception 'claim_notification_jobs: p_key_window must be within the provider''s 24 hours';
  end if;

  -- 0) THE LEGACY CLOSURE (0102, finding D), in this transaction: a lead the
  --    pre-0101 route already alerted has `enquiry_alert: sent` on its
  --    timeline. Such a row is closed as accepted — nothing to send — and
  --    can never be handed out, whatever happens to any later read.
  with told as (
    update notification_jobs j
       set state         = 'accepted',
           last_category = null,
           last_result   = 'legacy_sender',
           accepted_at   = now(),
           finished_at   = now(),
           claimed_by    = null,
           claimed_until = null
     where ((j.state = 'pending')
            or (j.state = 'sending' and j.claimed_until < now()))
       and (p_lead_id is null or j.lead_id = p_lead_id)
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

  -- 1) An interrupted worker whose job has no attempts left: terminal with an
  --    event, not a row that stays "sending" forever and shows as nothing.
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
     returning j.*
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select d.org_id, null, 'lead', d.lead_id, 'enquiry_alert',
         jsonb_build_object('outcome', 'failed', 'provider', d.provider, 'job_id', d.id,
                            'attempt', d.attempts, 'category', 'timeout',
                            'result', 'lease_expired', 'exhausted', true)
    from dead d;

  -- 2) THE KEY WINDOW (0102, finding A): a row first attempted longer ago
  --    than the provider remembers its key is not retried — the retry could
  --    be a second e-mail. Closed for a human: the inbox offers Retry alert,
  --    which is the explicit decision and rotates the key.
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
     returning j.*
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select s.org_id, null, 'lead', s.lead_id, 'enquiry_alert',
         jsonb_build_object('outcome', 'failed', 'provider', s.provider, 'job_id', s.id,
                            'attempt', s.attempts, 'category', 'timeout',
                            'result', 'key_window_expired', 'exhausted', false)
    from stale s;

  -- 3) The claim. `for update skip locked`: a row another worker holds is
  --    stepped over, never waited on and never handed out twice. The attempt
  --    is counted HERE so a worker that dies mid-send still spends one; a
  --    worker that runs out of budget hands it back with `released`.
  return query
  with due as (
    select j.id
      from notification_jobs j
     where ((j.state = 'pending' and j.next_attempt_at <= now())
            or (j.state = 'sending' and j.claimed_until < now()))
       and j.attempts < j.max_attempts
       -- never attempted, or attempted inside the window the provider still honours
       and (j.first_attempted_at is null or j.first_attempted_at >= now() - v_window)
       and (p_lead_id is null or j.lead_id = p_lead_id)
     order by j.next_attempt_at
     limit p_limit
     for update skip locked
  )
  update notification_jobs j
     set state              = 'sending',
         claimed_by         = p_worker,
         claimed_until      = now() + v_lease,
         attempts           = j.attempts + 1,
         first_attempted_at = coalesce(j.first_attempted_at, now()),
         last_attempted_at  = now()
    from due
   where j.id = due.id
  returning j.*;
end $fn$;

comment on function public.claim_notification_jobs(text, int, int, uuid, interval) is
  'Claims up to p_limit due notification jobs for p_worker under a lease of '
  'p_lease_seconds (0101, reviewed 0102): pending rows whose next_attempt_at '
  'has passed and sending rows whose lease lapsed, attempts < max_attempts, '
  'never attempted OR first attempted inside p_key_window (default '
  'notification_key_window(), 20 h) — for update skip locked. Counts the '
  'attempt at the claim. Before claiming it closes, with an event: rows whose '
  'lead already carries enquiry_alert: sent (accepted / legacy_sender), lapsed '
  'leases with no attempts left (failed / lease_expired), and rows first '
  'attempted outside the window (failed / key_window_expired). p_lead_id '
  'narrows to one lead. service_role-only.';

-- ---------------------------------------------------------------------------
-- 3. Completion gains `released`: an unattempted claim handed back
-- ---------------------------------------------------------------------------
create or replace function public.complete_notification_job(
  p_job_id              uuid,
  p_worker              text,
  p_outcome             text,
  p_category            text default null,
  p_result              text default null,
  p_provider_message_id text default null,
  p_retry_in_seconds    int  default null
)
returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  v_job     notification_jobs;
  v_state   text;
  v_result  text := left(coalesce(p_result, p_outcome), 80);
begin
  if p_outcome is null or p_outcome not in ('accepted', 'retry', 'failed', 'cancelled', 'released') then
    raise exception 'complete_notification_job: unknown outcome %', coalesce(p_outcome, '<null>');
  end if;
  if p_category is not null and p_category not in ('transient', 'permanent', 'timeout', 'conflict') then
    raise exception 'complete_notification_job: unknown category %', p_category;
  end if;

  select * into v_job from notification_jobs where id = p_job_id for update;
  -- Not found, not in flight, or held by someone else: nothing changes and
  -- the caller is told so. A worker whose lease lapsed and whose job was
  -- re-claimed lands here — its outcome belongs to nobody now.
  if not found or v_job.state <> 'sending' or v_job.claimed_by is distinct from p_worker then
    return false;
  end if;

  -- 0102 (finding B): the worker ran out of budget before trying this one.
  -- Back to pending, due now, the claim's attempt given back — and when that
  -- claim was the only attempt there ever was, the key window has not
  -- started: nothing was presented to the provider.
  if p_outcome = 'released' then
    update notification_jobs
       set state              = 'pending',
           next_attempt_at    = now(),
           attempts           = greatest(v_job.attempts - 1, 0),
           first_attempted_at = case when v_job.attempts - 1 <= 0 then null else first_attempted_at end,
           claimed_by         = null,
           claimed_until      = null
     where id = p_job_id;
    return true;
  end if;

  if p_outcome = 'retry' and v_job.attempts < v_job.max_attempts then
    update notification_jobs
       set state           = 'pending',
           next_attempt_at = now() + make_interval(secs => greatest(coalesce(p_retry_in_seconds, 60), 1)),
           last_category   = p_category,
           last_result     = v_result,
           claimed_by      = null,
           claimed_until   = null
     where id = p_job_id;
    return true;
  end if;

  v_state := case p_outcome when 'accepted' then 'accepted'
                            when 'cancelled' then 'cancelled'
                            else 'failed' end;

  update notification_jobs
     set state               = v_state,
         last_category       = case when p_outcome = 'accepted' then null else p_category end,
         last_result         = v_result,
         provider_message_id = case when p_outcome = 'accepted'
                                    then left(p_provider_message_id, 120) else provider_message_id end,
         accepted_at         = case when p_outcome = 'accepted' then now() else accepted_at end,
         finished_at         = now(),
         claimed_by          = null,
         claimed_until       = null
   where id = p_job_id;

  -- The terminal outcome on the lead's timeline. Ids and words only.
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  values (
    v_job.org_id, null, 'lead', v_job.lead_id, 'enquiry_alert',
    jsonb_build_object(
      'outcome', v_state,
      'provider', v_job.provider,
      'job_id', v_job.id,
      'attempt', v_job.attempts,
      'category', case when p_outcome = 'accepted' then null else p_category end,
      'result', v_result,
      'provider_message_id', case when p_outcome = 'accepted' then left(p_provider_message_id, 120) end,
      'exhausted', p_outcome = 'retry'
    )
  );
  return true;
end $fn$;

comment on function public.complete_notification_job(uuid, text, text, text, text, text, int) is
  'Ends a claim (0101, reviewed 0102), only for the worker that holds it. '
  'accepted: the provider accepted the message (its id is kept; delivery is '
  'not confirmed). retry: back to pending after p_retry_in_seconds, or terminal '
  'failed when the attempt was the last allowed. failed / cancelled: terminal '
  'now. released: the worker ran out of budget before trying — back to pending '
  'at once with the attempt given back (and the first-attempt clock cleared '
  'when nothing was ever tried); no event. Terminal outcomes write the lead''s '
  'enquiry_alert event. Returns false when the row is not in flight under '
  'p_worker. service_role-only.';

-- ---------------------------------------------------------------------------
-- 4. The staff retry: a rotated key starts a fresh lifetime
-- ---------------------------------------------------------------------------
create or replace function public.request_enquiry_alert_retry(p_lead_id uuid)
returns setof public.notification_jobs
language plpgsql security definer set search_path = public as $fn$
declare
  v_uid    uuid := auth.uid();
  v_org    uuid;
  v_lead   leads;
  v_job    notification_jobs;
  v_rotate boolean;
  v_serial int;
begin
  if v_uid is null then raise exception 'Not authenticated.'; end if;
  -- The same gate require_aal2 puts on every table: a definer function must
  -- apply it by hand.
  if not (select mfa_satisfied()) then raise exception 'Second factor required.'; end if;
  v_org := (select current_org_id());
  if v_org is null then raise exception 'Not authenticated.'; end if;

  -- Another org's lead reads "not found" — the same words as no lead at all.
  select * into v_lead from leads where id = p_lead_id and org_id = v_org;
  if not found then raise exception 'Lead not found.'; end if;

  -- Doc 04's lead rule: admin, the assigned agent, or anyone while unassigned.
  if (select current_role_gnk()) <> 'admin'
     and v_lead.assigned_agent_id is not null
     and v_lead.assigned_agent_id <> v_uid then
    raise exception 'Lead is assigned to another agent.';
  end if;

  if v_lead.message = '[erased at the contact''s request]' then
    raise exception 'This enquiry has been redacted — there is nothing left to send.';
  end if;

  select * into v_job
    from notification_jobs
   where lead_id = p_lead_id and kind = 'enquiry_desk_alert'
   for update;
  if not found then raise exception 'No desk alert is recorded for this lead.'; end if;

  if v_job.state = 'sending' and v_job.claimed_until > now() then
    raise exception 'The alert is being sent right now — try again in a minute.';
  end if;
  if v_job.state = 'accepted' then
    raise exception 'The desk was already alerted for this enquiry.';
  end if;

  -- The provider remembers a key for 24 hours and refuses it with another
  -- payload. Inside the window, and with no conflict, the SAME key is reused
  -- on purpose: a retry after an ambiguous timeout must not be a second
  -- e-mail. Otherwise a fresh serial — a fresh key — and, because that key
  -- has never been presented to anyone, a fresh lifetime (0102). This is the
  -- ONE place a key rotates, and a person asked for it.
  v_rotate := v_job.last_category = 'conflict'
           or (v_job.first_attempted_at is not null
               and v_job.first_attempted_at < now() - public.notification_key_window());
  v_serial := v_job.key_serial + case when v_rotate then 1 else 0 end;

  update notification_jobs
     set state              = 'pending',
         attempts           = 0,
         next_attempt_at    = now(),
         claimed_by         = null,
         claimed_until      = null,
         key_serial         = v_serial,
         first_attempted_at = case when v_rotate then null else first_attempted_at end,
         last_category      = null,
         last_result        = null,
         finished_at        = null
   where id = v_job.id;

  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  values (
    v_job.org_id, v_uid, 'lead', v_job.lead_id, 'enquiry_alert',
    jsonb_build_object(
      'outcome', 'retry_requested',
      'provider', v_job.provider,
      'job_id', v_job.id,
      'key_serial', v_serial,
      'key_rotated', v_rotate,
      'previous_state', v_job.state,
      'previous_result', v_job.last_result
    )
  );

  return query select * from notification_jobs where id = v_job.id;
end $fn$;

comment on function public.request_enquiry_alert_retry(uuid) is
  'A staff member asks for the desk alert of a website lead to be sent again '
  '(0101, reviewed 0102): a signed-in, aal2-satisfied member of the lead''s own '
  'org, admin or the assigned agent or anyone while unassigned; refused while '
  'a worker holds a live claim, for an accepted alert, and for a redacted lead. '
  'Resets the job to pending with a fresh attempt budget; rotates the provider '
  'key only when the old one is unsafe (a conflict, or a first attempt older '
  'than notification_key_window()) and then clears the first-attempt clock — a '
  'new key has never been presented. Signs an event with the caller and '
  'key_rotated. Returns the job. The route''s after() then sends at once.';

-- ---------------------------------------------------------------------------
-- 5. Grants — the drop above took claim's ACL with it; the others are restated
-- ---------------------------------------------------------------------------
revoke execute on function public.claim_notification_jobs(text, int, int, uuid, interval) from public, anon, authenticated;
grant  execute on function public.claim_notification_jobs(text, int, int, uuid, interval) to service_role;
revoke execute on function public.complete_notification_job(uuid, text, text, text, text, text, int) from public, anon, authenticated;
grant  execute on function public.complete_notification_job(uuid, text, text, text, text, text, int) to service_role;
revoke execute on function public.request_enquiry_alert_retry(uuid) from public, anon;
grant  execute on function public.request_enquiry_alert_retry(uuid) to authenticated, service_role;
-- a constant, readable by anyone who can already read the table's status
revoke execute on function public.notification_key_window() from public, anon;
grant  execute on function public.notification_key_window() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Apply-time assertions (the 0084 idiom: self-test leads, then removed;
--    their events stay). The retry function needs a session and is proven
--    by the vitest suite instead.
-- ---------------------------------------------------------------------------
do $$
declare
  v_org     uuid;
  v_slug    text;
  v_stale   uuid;
  v_old     uuid;
  v_legacy  uuid;
  v_rel     uuid;
  v_job     public.notification_jobs;
  v_claimed public.notification_jobs;
  n         int;
begin
  if public.notification_key_window() >= interval '24 hours' then
    raise exception '0102 aborted: the key window must be shorter than the provider''s 24 hours';
  end if;

  select id, slug into v_org, v_slug from organizations order by created_at limit 1;
  if v_org is null then
    raise notice '0102: no organization to self-test against — grants and shape checked only';
  else
    -- (a) first attempted 25 hours ago: not claimed, closed for review, one event
    select s.lead_id into v_stale
      from submit_public_enquiry(v_slug, '0102 selftest stale', 'selftest-0102-stale@example.invalid',
                                 null, '0102 self-test stale', null, 'selftest-0102-stale', null) s;
    update notification_jobs set attempts = 1, first_attempted_at = now() - interval '25 hours'
     where lead_id = v_stale;
    select count(*) into n from claim_notification_jobs('selftest-0102', 1, 60, v_stale);
    if n <> 0 then raise exception '0102 aborted: a job outside the key window was claimed'; end if;
    select * into v_job from notification_jobs where lead_id = v_stale;
    if v_job.state <> 'failed' or v_job.last_result <> 'key_window_expired' or v_job.attempts <> 1 then
      raise exception '0102 aborted: the stale job was not closed for review';
    end if;
    select count(*) into n from events
     where entity_type = 'lead' and entity_id = v_stale and event_type = 'enquiry_alert'
       and payload ->> 'result' = 'key_window_expired';
    if n <> 1 then raise exception '0102 aborted: the window closure wrote no event'; end if;

    -- (b) never attempted, however old: still claimed
    select s.lead_id into v_old
      from submit_public_enquiry(v_slug, '0102 selftest old', 'selftest-0102-old@example.invalid',
                                 null, '0102 self-test old', null, 'selftest-0102-old', null) s;
    update notification_jobs set created_at = now() - interval '30 days', next_attempt_at = now() - interval '30 days'
     where lead_id = v_old;
    select * into v_claimed from claim_notification_jobs('selftest-0102', 1, 60, v_old);
    if not found or v_claimed.attempts <> 1 then
      raise exception '0102 aborted: a never-attempted job was refused for its age';
    end if;

    -- (c) the legacy closure: a lead already told by the old route is never handed out
    select s.lead_id into v_legacy
      from submit_public_enquiry(v_slug, '0102 selftest legacy', 'selftest-0102-legacy@example.invalid',
                                 null, '0102 self-test legacy', null, 'selftest-0102-legacy', null) s;
    insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
    values (v_org, null, 'lead', v_legacy, 'enquiry_alert', '{"outcome":"sent","provider":"resend"}'::jsonb);
    select count(*) into n from claim_notification_jobs('selftest-0102', 1, 60, v_legacy);
    if n <> 0 then raise exception '0102 aborted: a legacy-sent lead was handed to the worker'; end if;
    select * into v_job from notification_jobs where lead_id = v_legacy;
    if v_job.state <> 'accepted' or v_job.last_result <> 'legacy_sender' or v_job.attempts <> 0 then
      raise exception '0102 aborted: the legacy closure did not land on the row';
    end if;

    -- (d) released: the attempt is given back and the clock cleared
    select s.lead_id into v_rel
      from submit_public_enquiry(v_slug, '0102 selftest release', 'selftest-0102-release@example.invalid',
                                 null, '0102 self-test release', null, 'selftest-0102-release', null) s;
    select * into v_claimed from claim_notification_jobs('selftest-0102', 1, 60, v_rel);
    if not complete_notification_job(v_claimed.id, 'selftest-0102', 'released', null, null, null, null) then
      raise exception '0102 aborted: the holder could not release its claim';
    end if;
    select * into v_job from notification_jobs where lead_id = v_rel;
    if v_job.state <> 'pending' or v_job.attempts <> 0 or v_job.first_attempted_at is not null then
      raise exception '0102 aborted: a released claim did not give its attempt back';
    end if;
    select count(*) into n from events
     where entity_type = 'lead' and entity_id = v_rel and event_type = 'enquiry_alert';
    if n <> 0 then raise exception '0102 aborted: a release wrote an event'; end if;

    -- clean the self-test up: tasks, then leads (jobs cascade); the events stay
    delete from tasks where lead_id in
      (select id from leads where org_id = v_org and idempotency_key like 'selftest-0102-%');
    delete from leads where org_id = v_org and idempotency_key like 'selftest-0102-%';
  end if;

  -- the door is untouched: one overload, eight arguments, same return
  if not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname = 'public' and p.proname = 'submit_public_enquiry'
                    and p.pronargs = 8
                    and pg_get_function_result(p.oid) = 'TABLE(lead_id uuid, lead_org_id uuid, replayed boolean)') then
    raise exception '0102 aborted: the door changed — it must not';
  end if;
  -- exactly one claim overload, the five-argument one
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'claim_notification_jobs';
  if n <> 1 then raise exception '0102 aborted: expected one claim_notification_jobs, found %', n; end if;
  if not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname = 'public' and p.proname = 'claim_notification_jobs' and p.pronargs = 5) then
    raise exception '0102 aborted: claim_notification_jobs did not gain p_key_window';
  end if;

  -- grants
  if has_function_privilege('anon', 'public.claim_notification_jobs(text,int,int,uuid,interval)', 'execute')
     or has_function_privilege('authenticated', 'public.claim_notification_jobs(text,int,int,uuid,interval)', 'execute')
     or not has_function_privilege('service_role', 'public.claim_notification_jobs(text,int,int,uuid,interval)', 'execute') then
    raise exception '0102 aborted: claim_notification_jobs grants are wrong';
  end if;
  if has_function_privilege('anon', 'public.complete_notification_job(uuid,text,text,text,text,text,int)', 'execute')
     or not has_function_privilege('service_role', 'public.complete_notification_job(uuid,text,text,text,text,text,int)', 'execute') then
    raise exception '0102 aborted: complete_notification_job grants are wrong';
  end if;
  if has_function_privilege('anon', 'public.request_enquiry_alert_retry(uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.request_enquiry_alert_retry(uuid)', 'execute') then
    raise exception '0102 aborted: request_enquiry_alert_retry grants are wrong';
  end if;
  if has_function_privilege('anon', 'public.notification_key_window()', 'execute') then
    raise exception '0102 aborted: notification_key_window is anon-callable';
  end if;

  select count(*) into n from rls_aal2_coverage();
  if n <> 0 then raise exception '0102 aborted: % table(s) lack require_aal2', n; end if;
  select count(*) into n from cron.job;
  if n <> 10 then raise exception '0102 aborted: expected ten cron jobs, found %', n; end if;

  raise notice '0102: key window 20h enforced at the claim (key_window_expired for review), legacy closure inside the claim, released outcome, rotated keys start a fresh lifetime.';
end $$;
