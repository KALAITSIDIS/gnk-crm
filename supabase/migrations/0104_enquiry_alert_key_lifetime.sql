-- =============================================================================
-- 0104 — the provider key's lifetime is independent of the retry budget
--
-- THE REGRESSION (audit 2026-09-21, reproduced on the local stack with the
-- 0102 functions before this file was written — supabase/tests/
-- enquiry-alert-key-lifetime.test.ts, and a rolled-back SQL script that
-- walked the exact sequence). 0102 made two promises that met in ONE column:
--
--   * `request_enquiry_alert_retry` gives a job a fresh attempt budget
--     (`attempts = 0`) but keeps the provider key AND its clock
--     (`first_attempted_at`) while the key is still safe to reuse — a retry
--     after a lost answer must be the same message, not a second one.
--   * `released` (a worker out of budget hands an UNATTEMPTED claim back)
--     gives the claim's attempt back and clears the clock "when that claim
--     was the only attempt there ever was" — judged by `attempts - 1 <= 0`.
--
-- Put together: attempted once → staff retry (attempts 0, clock kept) →
-- claim (attempts 1) → release (attempts 0; `attempts - 1 <= 0`, so the clock
-- is CLEARED). The row now says the key was never presented. Twenty-five
-- hours later the claim hands it out again under the SAME key_serial — the
-- provider forgot the key at 24 h, so if the first attempt had been accepted
-- with its answer lost, this is the second e-mail the window exists to
-- prevent. The budget was reset; the key's lifetime must not have been.
-- The 0102 self-test proved release-of-a-first-claim and the window each on
-- their own; nothing proved the combination.
--
-- THE FIX. One new fact the retry cannot reset: `key_attempts`, the number
-- of claims handed out under the CURRENT key_serial that were not released.
--   * the claim increments it (with attempts);
--   * `released` decrements it and clears `first_attempted_at` ONLY when it
--     returns to zero — nothing was ever presented under this key;
--   * the staff retry leaves it alone unless the key rotates, and then sets
--     it to 0 with the clock (a new key has never been presented);
--   * nothing else touches it. The worker still never rotates.
-- `attempts` keeps its meaning (the resettable budget the schedule and
-- max_attempts read); `first_attempted_at` keeps its meaning (when the
-- current key was first handed out) and is now only ever cleared for a key
-- that was never presented. The worker's window arithmetic reads the same
-- column and is unchanged.
--
-- Backfill: rows that carry a clock get key_attempts = greatest(attempts, 1)
-- — the best fact available for a row whose budget may already have been
-- reset. Hosted holds no rows today.
--
-- Signatures unchanged (`create or replace`, ACLs restated). The door is
-- untouched. Pins that move: the migrations count in
-- scripts/backup/verify-restore.sql; database.types.ts gains the column.
-- =============================================================================

alter table public.notification_jobs
  add column if not exists key_attempts int not null default 0 check (key_attempts >= 0);

comment on column public.notification_jobs.key_attempts is
  'Claims handed out under the CURRENT key_serial that were not released '
  '(0104). Unlike attempts it is never reset by the staff retry — only a '
  'rotation zeroes it — so a released claim clears first_attempted_at only '
  'when nothing was ever presented under this key.';

update public.notification_jobs
   set key_attempts = greatest(attempts, 1)
 where key_attempts = 0
   and first_attempted_at is not null;

-- The invariant the regression broke, made unwritable: a running key clock
-- means at least one presentation under the current key. Every writer below
-- keeps it; a fixture or a future edit that clears one without the other is
-- refused by the database rather than discovered 25 hours later.
alter table public.notification_jobs
  drop constraint if exists notification_jobs_key_clock_check;
alter table public.notification_jobs
  add constraint notification_jobs_key_clock_check
  check (first_attempted_at is null or key_attempts >= 1);

-- ---------------------------------------------------------------------------
-- 1. The claim counts the presentation against the key
-- ---------------------------------------------------------------------------
create or replace function public.claim_notification_jobs(
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
  if v_window <= interval '0' or v_window > interval '24 hours' then
    raise exception 'claim_notification_jobs: p_key_window must be within the provider''s 24 hours';
  end if;

  -- 0) the legacy closure (0102, finding D)
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
     returning j.*
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select d.org_id, null, 'lead', d.lead_id, 'enquiry_alert',
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
     returning j.*
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select s.org_id, null, 'lead', s.lead_id, 'enquiry_alert',
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

comment on function public.claim_notification_jobs(text, int, int, uuid, interval) is
  'Claims up to p_limit due notification jobs for p_worker under a lease of '
  'p_lease_seconds (0101, reviewed 0102, key lifetime 0104): pending rows whose '
  'next_attempt_at has passed and sending rows whose lease lapsed, attempts < '
  'max_attempts, never attempted OR first attempted inside p_key_window '
  '(default notification_key_window(), 20 h) — for update skip locked. Counts '
  'the attempt and the presentation (key_attempts) at the claim. Before '
  'claiming it closes, with an event: rows whose lead already carries '
  'enquiry_alert: sent (accepted / legacy_sender), lapsed leases with no '
  'attempts left (failed / lease_expired), and rows first attempted outside the '
  'window (failed / key_window_expired). p_lead_id narrows to one lead. '
  'service_role-only.';

-- ---------------------------------------------------------------------------
-- 2. Completion: `released` gives back the presentation, and clears the
--    clock only when nothing was ever presented under this key
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
  if not found or v_job.state <> 'sending' or v_job.claimed_by is distinct from p_worker then
    return false;
  end if;

  -- 0102 (finding B) / 0104: the worker ran out of budget before trying this
  -- one. Back to pending, due now, the claim's attempt AND presentation given
  -- back — and the key's clock cleared only when this claim was the only
  -- presentation there ever was under this key. A reset budget (the staff
  -- retry) does not make an earlier presentation un-happen.
  if p_outcome = 'released' then
    update notification_jobs
       set state              = 'pending',
           next_attempt_at    = now(),
           attempts           = greatest(v_job.attempts - 1, 0),
           key_attempts       = greatest(v_job.key_attempts - 1, 0),
           first_attempted_at = case when v_job.key_attempts - 1 <= 0 then null else first_attempted_at end,
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
  'Ends a claim (0101, reviewed 0102, key lifetime 0104), only for the worker '
  'that holds it. accepted: the provider accepted the message (its id is kept; '
  'delivery is not confirmed). retry: back to pending after p_retry_in_seconds, '
  'or terminal failed when the attempt was the last allowed. failed / '
  'cancelled: terminal now. released: the worker ran out of budget before '
  'trying — back to pending at once with the attempt and the presentation '
  '(key_attempts) given back, and the first-attempt clock cleared only when '
  'nothing was ever presented under the current key; no event. Terminal '
  'outcomes write the lead''s enquiry_alert event. Returns false when the row '
  'is not in flight under p_worker. service_role-only.';

-- ---------------------------------------------------------------------------
-- 3. The staff retry resets the budget, never the key's history
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
  if not (select mfa_satisfied()) then raise exception 'Second factor required.'; end if;
  v_org := (select current_org_id());
  if v_org is null then raise exception 'Not authenticated.'; end if;

  select * into v_lead from leads where id = p_lead_id and org_id = v_org;
  if not found then raise exception 'Lead not found.'; end if;

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

  -- Inside the window and without a conflict the SAME key is reused on
  -- purpose. Otherwise a fresh serial — a fresh key — with a fresh lifetime
  -- AND a fresh presentation count (0104): nothing has been presented under
  -- it. A reused key keeps both: the budget below is the only thing reset.
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
         key_attempts       = case when v_rotate then 0 else key_attempts end,
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
  '(0101, reviewed 0102, key lifetime 0104): a signed-in, aal2-satisfied member '
  'of the lead''s own org, admin or the assigned agent or anyone while '
  'unassigned; refused while a worker holds a live claim, for an accepted alert, '
  'and for a redacted lead. Resets the job to pending with a fresh attempt '
  'budget; rotates the provider key only when the old one is unsafe (a conflict, '
  'or a first attempt older than notification_key_window()) and then clears the '
  'first-attempt clock and the presentation count — a new key has never been '
  'presented. A reused key keeps both. Signs an event with the caller and '
  'key_rotated. Returns the job. The route''s after() then sends at once.';

-- ---------------------------------------------------------------------------
-- 4. Grants restated (create or replace keeps them; restated on purpose)
-- ---------------------------------------------------------------------------
revoke execute on function public.claim_notification_jobs(text, int, int, uuid, interval) from public, anon, authenticated;
grant  execute on function public.claim_notification_jobs(text, int, int, uuid, interval) to service_role;
revoke execute on function public.complete_notification_job(uuid, text, text, text, text, text, int) from public, anon, authenticated;
grant  execute on function public.complete_notification_job(uuid, text, text, text, text, text, int) to service_role;
revoke execute on function public.request_enquiry_alert_retry(uuid) from public, anon;
grant  execute on function public.request_enquiry_alert_retry(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Apply-time assertions (0084 idiom). The staff retry needs a session and
--    is proven by supabase/tests/enquiry-alert-key-lifetime.test.ts; here the
--    row is set the way that function leaves it and the rest is exercised.
-- ---------------------------------------------------------------------------
do $$
declare
  v_org     uuid;
  v_slug    text;
  v_lead    uuid;
  v_first   uuid;
  v_job     public.notification_jobs;
  v_claimed public.notification_jobs;
  n         int;
begin
  select id, slug into v_org, v_slug from organizations order by created_at limit 1;
  if v_org is null then
    raise notice '0104: no organization to self-test against — shape and grants checked only';
  else
    -- (a) attempted once under key 1 two hours ago, then the staff retry's
    --     reset (attempts 0, clock and key kept, key_attempts 1)
    select s.lead_id into v_lead
      from submit_public_enquiry(v_slug, '0104 selftest lifetime', 'selftest-0104-lifetime@example.invalid',
                                 null, '0104 self-test lifetime', null, 'selftest-0104-lifetime', null) s;
    update notification_jobs
       set state = 'pending', attempts = 0, key_attempts = 1, key_serial = 1,
           first_attempted_at = now() - interval '2 hours', last_attempted_at = now() - interval '2 hours',
           next_attempt_at = now()
     where lead_id = v_lead;
    select * into v_claimed from claim_notification_jobs('selftest-0104', 1, 60, v_lead);
    if not found or v_claimed.attempts <> 1 or v_claimed.key_attempts <> 2 or v_claimed.first_attempted_at is null then
      raise exception '0104 aborted: the claim did not count the presentation against the key';
    end if;
    if not complete_notification_job(v_claimed.id, 'selftest-0104', 'released', null, null, null, null) then
      raise exception '0104 aborted: the holder could not release its claim';
    end if;
    select * into v_job from notification_jobs where lead_id = v_lead;
    if v_job.state <> 'pending' or v_job.attempts <> 0 or v_job.key_attempts <> 1 or v_job.first_attempted_at is null then
      raise exception '0104 aborted: a release after a reset budget erased the key''s clock (the audit''s regression)';
    end if;
    -- "25 hours later" — the same key must not be handed out again
    update notification_jobs set first_attempted_at = now() - interval '25 hours' where lead_id = v_lead;
    select count(*) into n from claim_notification_jobs('selftest-0104', 1, 60, v_lead);
    if n <> 0 then raise exception '0104 aborted: a forgotten key was presented again'; end if;
    select * into v_job from notification_jobs where lead_id = v_lead;
    if v_job.state <> 'failed' or v_job.last_result <> 'key_window_expired' or v_job.key_serial <> 1 then
      raise exception '0104 aborted: the stale job was not closed for review';
    end if;

    -- (b) a genuinely first claim, released: nothing was presented, the clock clears
    select s.lead_id into v_first
      from submit_public_enquiry(v_slug, '0104 selftest first', 'selftest-0104-first@example.invalid',
                                 null, '0104 self-test first', null, 'selftest-0104-first', null) s;
    select * into v_claimed from claim_notification_jobs('selftest-0104', 1, 60, v_first);
    if v_claimed.key_attempts <> 1 then raise exception '0104 aborted: first claim did not count'; end if;
    perform complete_notification_job(v_claimed.id, 'selftest-0104', 'released', null, null, null, null);
    select * into v_job from notification_jobs where lead_id = v_first;
    if v_job.key_attempts <> 0 or v_job.first_attempted_at is not null or v_job.attempts <> 0 then
      raise exception '0104 aborted: a never-presented key kept a clock';
    end if;

    delete from tasks where lead_id in
      (select id from leads where org_id = v_org and idempotency_key like 'selftest-0104-%');
    delete from leads where org_id = v_org and idempotency_key like 'selftest-0104-%';
  end if;

  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'notification_jobs' and column_name = 'key_attempts') then
    raise exception '0104 aborted: key_attempts is missing';
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.notification_jobs'::regclass
                    and conname = 'notification_jobs_key_clock_check') then
    raise exception '0104 aborted: the key-clock invariant is not enforced';
  end if;
  if exists (select 1 from notification_jobs where first_attempted_at is not null and key_attempts < 1) then
    raise exception '0104 aborted: a row carries a key clock with no presentation';
  end if;
  if has_function_privilege('anon', 'public.claim_notification_jobs(text,int,int,uuid,interval)', 'execute')
     or has_function_privilege('authenticated', 'public.claim_notification_jobs(text,int,int,uuid,interval)', 'execute')
     or not has_function_privilege('service_role', 'public.claim_notification_jobs(text,int,int,uuid,interval)', 'execute')
     or has_function_privilege('anon', 'public.complete_notification_job(uuid,text,text,text,text,text,int)', 'execute')
     or has_function_privilege('anon', 'public.request_enquiry_alert_retry(uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.request_enquiry_alert_retry(uuid)', 'execute') then
    raise exception '0104 aborted: grants are wrong';
  end if;
  -- the door is untouched
  if not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname = 'public' and p.proname = 'submit_public_enquiry' and p.pronargs = 8
                    and pg_get_function_result(p.oid) = 'TABLE(lead_id uuid, lead_org_id uuid, replayed boolean)') then
    raise exception '0104 aborted: the door changed — it must not';
  end if;

  raise notice '0104: key_attempts counts presentations under the current key; a released claim clears the clock only when nothing was ever presented.';
end $$;
