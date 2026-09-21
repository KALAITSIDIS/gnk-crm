-- =============================================================================
-- 0107 — an unanswered website enquiry is escalated by e-mail to a colleague
--        (audit 2026-09-22, finding 3 — the second half of the 2026-09-15
--        audit's trigger T1; BACKLOG "Lead SLA e-mail escalation")
--
-- WHAT EXISTED. 0098's `lead-sla` sweep mints one `lead_unanswered` TASK per
-- website lead still open with no first response after an hour, on the
-- assignee's list — and nothing leaves the building: the e-mail half waited
-- on pg_net, which 0103 has since installed for the desk-alert sweep. The
-- desk alert (0101) tells the desk an enquiry ARRIVED; nothing tells anyone
-- that it is still WAITING.
--
-- WHAT THIS ADDS, AND HOW LITTLE. The outbox already has everything an
-- escalation needs — a row per lead per kind, an atomic leased claim, a
-- bounded retry schedule under one provider idempotency key with its 20-hour
-- window, terminal events, cancellation on redaction, a two-minute delivery
-- sweep with its outcome record on the dashboard. So the escalation is a
-- SECOND KIND on the same table, `lead_escalation`, and:
--
--   1. `cyprus_config.lead_escalation` holds the policy — enabled, the wait,
--      the recipients (profile ids), working hours and the timezone — SEEDED
--      OFF with placeholder values. The 2026-09-15 audit PROPOSED fifteen
--      minutes and "the other principal"; neither is an approved decision, so
--      nothing here sends until an admin turns it on (Settings → Lead
--      escalation, or the raw editor). `lead_escalation_config()` is the one
--      validated reader (0052's nudge_threshold idiom): every malformed key
--      falls back to its default, an unknown timezone to Asia/Nicosia, and
--      malformed working hours to "around the clock" — and
--      lib/services/lead-escalation.ts mirrors it rule for rule so the
--      settings page shows what the sweep will do.
--
--   2. `lead_escalation_due_at(received, cfg)` says WHEN a lead's wait is up:
--      the wait counted in WORKING TIME, in the configured zone, in wall-clock
--      arithmetic — so "fifteen minutes after 09:00" is 09:15 local on either
--      side of a daylight-saving switch, an enquiry at 22:00 Friday is due at
--      09:15 Monday, and one at 17:50 carries its last five minutes to the
--      next opening. Working hours null = the wait is flat clock time.
--
--   3. `raise_lead_escalations()` MINTS, every five minutes (`lead-escalation`,
--      the twelfth cron job): one `lead_escalation` job per website lead that
--      is open, unanswered, not redacted, received within `max_age_hours`
--      (48: turning the feature on must not e-mail about every stale enquiry
--      of the quarter — those have their tasks), whose due time has passed,
--      and has no such job yet. The unique (lead_id, kind) index makes a
--      second job impossible by any path, two concurrent sweeps included; a
--      `lead_escalation: scheduled` event marks the moment. Nothing is minted
--      while the policy is off, and a lead answered or closed before its due
--      time never gets a row at all — the sweep's WHERE is the eligibility
--      rule, so answered-in-time leaves no noise behind.
--
--   4. The WORKER (lib/services/enquiry-alert-worker.ts) sends it: it re-reads
--      the policy (a kill switch at send time), re-reads the lead (still
--      open, still unanswered, not redacted), resolves the recipients AT
--      THAT MOMENT — active admins/agents of the lead's own organisation among
--      the configured ids, never the lead's assignee (they have the desk
--      alert and the task; the escalation is for somebody else) — and cancels
--      with a word (`escalation_disabled`, `lead_answered`, `lead_closed`,
--      `lead_redacted`, `no_recipient`) when any of that no longer holds.
--      Provider outcomes are classified exactly as the desk alert's.
--
--   5. The outbox's own functions learn the second kind: the claim's legacy
--      closure (0102 D — "the pre-outbox route already told the desk") is
--      restricted to desk alerts, because an escalation row on a lead with an
--      old `enquiry_alert: sent` event is NOT already sent; and every event
--      the claim, the completion and the redaction trigger write carries the
--      kind's own event type, `lead_escalation`, so a lead's timeline reads
--      truthfully. Signatures are unchanged: nothing here is deploy-coupled.
--
-- TOLERANCE, STATED: minted within five minutes of the due time, sent by the
-- next two-minute sweep (or by nothing, if the provider is unarmed — the row
-- waits, visibly overdue on the cron-health card). "Fifteen minutes" means
-- fifteen to about twenty-two. Not a promise of a minute.
--
-- NO DIGEST. The brief's daily digest has no approved recipients, content or
-- hour, and this table wants a lead per row; a digest is a different shape
-- and stays on the BACKLOG as a decision.
--
-- Pins that move with this file: EXPECTED_CRON_JOBS 11 → 12
-- (lib/services/cron-health.ts), RLS test 50 (twelve, `lead-escalation`
-- among the names), scripts/backup/verify-restore.sql (migrations 107, the
-- cron list + `exactly 12`, three grants rows), docs/10's cron table and env
-- section, HANDOFF §0's Cron row.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. A second kind on the outbox
-- ---------------------------------------------------------------------------
alter table public.notification_jobs drop constraint if exists notification_jobs_kind_check;
alter table public.notification_jobs
  add constraint notification_jobs_kind_check
  check (kind in ('enquiry_desk_alert', 'lead_escalation'));

comment on column public.notification_jobs.kind is
  'enquiry_desk_alert (0101): the desk is told an enquiry arrived. '
  'lead_escalation (0107): a colleague is told it is still unanswered. One row '
  'per lead per kind; the provider key is prefixed by the kind.';

-- ---------------------------------------------------------------------------
-- 2. The policy row — OFF until an admin decides
-- ---------------------------------------------------------------------------
-- `on conflict do nothing`: re-running must never clobber a value the desk has
-- since chosen. The values are PLACEHOLDERS for the shape: the 2026-09-15
-- audit proposed fifteen minutes; the hours are the desk hours the website
-- and the acknowledgement e-mail already state (gnk-web lib/site.ts,
-- lib/services/enquiry-ack.ts); recipients are for the admin to pick.
insert into public.cyprus_config (key, value, description) values (
  'lead_escalation',
  jsonb_build_object(
    'enabled',        false,
    'after_minutes',  15,
    'max_age_hours',  48,
    'recipients',     '[]'::jsonb,
    'working_hours',  jsonb_build_object('days', '[1,2,3,4,5]'::jsonb, 'start', '09:00', 'end', '18:00'),
    'timezone',       'Asia/Nicosia'
  ),
  'Escalate a website enquiry still unanswered after after_minutes of working time to the listed colleagues by e-mail (never to its assignee). OFF until enabled on Settings → Lead escalation. Checked every five minutes, sent by the two-minute alert sweep: expect the wait plus up to seven minutes. days are ISO (1 = Monday … 7 = Sunday); working_hours null = around the clock; max_age_hours bounds how old an enquiry may be when it becomes due.'
) on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 3. The one validated reader of that row (0052's idiom)
-- ---------------------------------------------------------------------------
-- Every failure mode lands on the default: a missing row, a key absent or of
-- the wrong type, a wait outside 1..1440 minutes, an age outside 1..720
-- hours, an id that is not a uuid, a timezone Postgres does not know,
-- working hours that are not a day list with start < end. The settings
-- page's reader (lib/services/lead-escalation.ts) applies the SAME table;
-- supabase/tests/lead-escalation.test.ts and lead-escalation.test.ts pin
-- the two against each other. p_raw lets a caller validate a value that is
-- not the row (the settings page's preview, the tests).
create or replace function public.lead_escalation_config(p_raw jsonb default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare
  v            jsonb := coalesce(p_raw, (select c.value from cyprus_config c where c.key = 'lead_escalation'), '{}'::jsonb);
  v_enabled    boolean := false;
  v_minutes    int := 15;
  v_max_age    int := 48;
  v_recipients jsonb := '[]'::jsonb;
  v_hours      jsonb := null;
  v_tz         text := 'Asia/Nicosia';
  v_days       jsonb;
  v_start      text;
  v_end        text;
begin
  if v is null or jsonb_typeof(v) <> 'object' then v := '{}'::jsonb; end if;

  if jsonb_typeof(v -> 'enabled') = 'boolean' then v_enabled := (v ->> 'enabled')::boolean; end if;

  if (v ->> 'after_minutes') ~ '^[0-9]{1,5}$' and (v ->> 'after_minutes')::int between 1 and 1440 then
    v_minutes := (v ->> 'after_minutes')::int;
  end if;
  if (v ->> 'max_age_hours') ~ '^[0-9]{1,5}$' and (v ->> 'max_age_hours')::int between 1 and 720 then
    v_max_age := (v ->> 'max_age_hours')::int;
  end if;

  if jsonb_typeof(v -> 'recipients') = 'array' then
    select coalesce(jsonb_agg(distinct e), '[]'::jsonb) into v_recipients
      from jsonb_array_elements(v -> 'recipients') e
     where jsonb_typeof(e) = 'string'
       and (e #>> '{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  end if;

  if jsonb_typeof(v -> 'timezone') = 'string' then
    begin
      perform now() at time zone (v ->> 'timezone');
      v_tz := v ->> 'timezone';
    exception when others then
      v_tz := 'Asia/Nicosia';
    end;
  end if;

  -- working hours: an ISO day list (1..7), start and end as HH:MM, start < end;
  -- anything else is "around the clock" (null), which the settings page shows
  if jsonb_typeof(v -> 'working_hours') = 'object' then
    v_days  := v #> '{working_hours,days}';
    v_start := v #>> '{working_hours,start}';
    v_end   := v #>> '{working_hours,end}';
    if jsonb_typeof(v_days) = 'array'
       and v_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       and v_end   ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       and v_start::time < v_end::time then
      select coalesce(jsonb_agg(d order by d), '[]'::jsonb) into v_days
        from (select distinct (e #>> '{}')::int as d
                from jsonb_array_elements(v_days) e
               where jsonb_typeof(e) = 'number' and (e #>> '{}') ~ '^[1-7]$') s;
      if jsonb_array_length(v_days) > 0 then
        v_hours := jsonb_build_object('days', v_days, 'start', v_start, 'end', v_end);
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'enabled',       v_enabled,
    'after_minutes', v_minutes,
    'max_age_hours', v_max_age,
    'recipients',    v_recipients,
    'working_hours', v_hours,
    'timezone',      v_tz
  );
end $fn$;

comment on function public.lead_escalation_config(jsonb) is
  'The validated lead_escalation policy (0107): the cyprus_config row (or p_raw) '
  'with every malformed key replaced by its default — enabled false, '
  'after_minutes 15 (1..1440), max_age_hours 48 (1..720), recipients [] (uuids '
  'only), working_hours null unless a valid ISO day list with HH:MM start < end, '
  'timezone Asia/Nicosia unless Postgres knows the given one. '
  'lib/services/lead-escalation.ts mirrors this rule for rule. service_role-only.';

-- ---------------------------------------------------------------------------
-- 4. When a lead's wait is up: working-time arithmetic in the configured zone
-- ---------------------------------------------------------------------------
create or replace function public.lead_escalation_due_at(p_received timestamptz, p_cfg jsonb default null)
returns timestamptz
language plpgsql stable security definer set search_path = public as $fn$
declare
  cfg         jsonb := public.lead_escalation_config(p_cfg);
  v_tz        text := cfg ->> 'timezone';
  v_hours     jsonb := cfg -> 'working_hours';
  v_remaining interval := make_interval(mins => (cfg ->> 'after_minutes')::int);
  v_local     timestamp;
  v_day       date;
  v_open      timestamp;
  v_close     timestamp;
  v_start     time;
  v_end       time;
  i           int := 0;
begin
  if p_received is null then return null; end if;
  -- around the clock: the wait is flat
  if v_hours is null or jsonb_typeof(v_hours) <> 'object' then
    return p_received + v_remaining;
  end if;

  v_start := (v_hours ->> 'start')::time;
  v_end   := (v_hours ->> 'end')::time;
  -- wall clock in the desk's zone; the arithmetic below is in wall-clock
  -- time on purpose, and the answer goes back through the zone at the end,
  -- so a daylight-saving switch between arrival and due time changes the
  -- UTC instant and never the local one
  v_local := p_received at time zone v_tz;

  loop
    i := i + 1;
    if i > 60 then
      -- no working day in two months of looking (an empty week): flat clock time
      return p_received + make_interval(mins => (cfg ->> 'after_minutes')::int);
    end if;
    v_day   := v_local::date;
    v_open  := v_day + v_start;
    v_close := v_day + v_end;
    if (v_hours -> 'days') @> to_jsonb(extract(isodow from v_day)::int) and v_local < v_close then
      if v_local < v_open then v_local := v_open; end if;
      if v_local + v_remaining <= v_close then
        return (v_local + v_remaining) at time zone v_tz;
      end if;
      -- the rest of the wait carries to the next working day
      v_remaining := v_remaining - (v_close - v_local);
    end if;
    v_local := (v_day + 1)::timestamp;
  end loop;
end $fn$;

comment on function public.lead_escalation_due_at(timestamptz, jsonb) is
  'When an enquiry received at p_received is due for escalation (0107) under '
  'the policy (the row, or p_cfg): after_minutes of WORKING time in the '
  'configured zone — arriving outside the hours, the wait starts at the next '
  'opening; a wait that crosses closing carries its remainder to the next '
  'opening; wall-clock arithmetic, so daylight saving moves the instant and '
  'not the local time. working_hours null: flat clock time. service_role-only.';

-- ---------------------------------------------------------------------------
-- 5. The sweep that mints
-- ---------------------------------------------------------------------------
create or replace function public.raise_lead_escalations(p_org uuid default null)
returns int
language plpgsql security definer set search_path = public as $fn$
declare
  cfg     jsonb := public.lead_escalation_config();
  v_count int := 0;
begin
  if not (cfg ->> 'enabled')::boolean then return 0; end if;

  with due as (
    -- the eligibility rule, in one place: a website lead, open, unanswered,
    -- not redacted, young enough, past its due time, not yet escalated
    select l.id, l.org_id, l.received_at
      from leads l
     where l.source = 'website'
       and l.status in ('new', 'contacted', 'qualified')
       and l.first_response_at is null
       and l.message is distinct from '[erased at the contact''s request]'
       and l.received_at > now() - make_interval(hours => (cfg ->> 'max_age_hours')::int)
       and (p_org is null or l.org_id = p_org)
       and not exists (select 1 from notification_jobs j
                        where j.lead_id = l.id and j.kind = 'lead_escalation')
       and public.lead_escalation_due_at(l.received_at, cfg) <= now()
  ),
  minted as (
    -- two sweeps at once: the second loses the unique index, inserts nothing,
    -- and logs nothing — `returning` names only the rows this call wrote
    insert into notification_jobs (org_id, lead_id, kind)
    select d.org_id, d.id, 'lead_escalation' from due d
    on conflict (lead_id, kind) do nothing
    returning org_id, lead_id, id
  ),
  logged as (
    -- Guardrail 1: ids and numbers only, never the person
    insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
    select m.org_id, null, 'lead', m.lead_id, 'lead_escalation',
           jsonb_build_object('outcome', 'scheduled', 'job_id', m.id,
                              'after_minutes', (cfg ->> 'after_minutes')::int,
                              'working_hours', jsonb_typeof(cfg -> 'working_hours') = 'object',
                              'timezone', cfg ->> 'timezone')
      from minted m
    returning 1
  )
  select count(*) into v_count from logged;

  return v_count;
end $fn$;

comment on function public.raise_lead_escalations(uuid) is
  'Every five minutes (0107): one lead_escalation notification job per website '
  'lead still open, unanswered, not redacted, received within max_age_hours, '
  'whose working-time wait (lead_escalation_due_at) has passed and that has no '
  'such job yet — with a lead_escalation: scheduled event. Nothing while the '
  'policy is off. The unique (lead_id, kind) index makes a second job '
  'impossible; concurrent sweeps mint one. The worker re-checks eligibility '
  'and resolves recipients at send time. Returns the number minted. p_org is '
  'for the tests; cron calls it for every org. service_role-only.';

-- ---------------------------------------------------------------------------
-- 6. The outbox learns the second kind: the legacy closure is desk-alert-only,
--    and every event names the kind's own type
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
  'p_lease_seconds (0101, reviewed 0102, key lifetime 0104, second kind 0107): '
  'pending rows whose next_attempt_at has passed and sending rows whose lease '
  'lapsed, attempts < max_attempts, never attempted OR first attempted inside '
  'p_key_window (default notification_key_window(), 20 h) — for update skip '
  'locked. Counts the attempt and the presentation (key_attempts) at the '
  'claim. Before claiming it closes, with an event of the kind''s own type: '
  'desk-alert rows whose lead already carries enquiry_alert: sent (accepted / '
  'legacy_sender), lapsed leases with no attempts left (failed / '
  'lease_expired), and rows first attempted outside the window (failed / '
  'key_window_expired). p_lead_id narrows to one lead. service_role-only.';

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

  -- the terminal outcome on the lead's timeline, under the kind's own type (0107)
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  values (
    v_job.org_id, null, 'lead', v_job.lead_id,
    case v_job.kind when 'lead_escalation' then 'lead_escalation' else 'enquiry_alert' end,
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
  'Ends a claim (0101, reviewed 0102, key lifetime 0104, second kind 0107), '
  'only for the worker that holds it. accepted: the provider accepted the '
  'message (its id is kept; delivery is not confirmed). retry: back to pending '
  'after p_retry_in_seconds, or terminal failed when the attempt was the last '
  'allowed. failed / cancelled: terminal now. released: the worker ran out of '
  'budget before trying — back to pending at once with the attempt and the '
  'presentation (key_attempts) given back, and the first-attempt clock cleared '
  'only when nothing was ever presented under the current key; no event. '
  'Terminal outcomes write the lead''s event under the kind''s own type '
  '(enquiry_alert / lead_escalation). Returns false when the row is not in '
  'flight under p_worker. service_role-only.';

create or replace function public.cancel_lead_notification_jobs()
returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  with cancelled as (
    update notification_jobs j
       set state         = 'cancelled',
           last_category = null,
           last_result   = 'lead_redacted',
           claimed_by    = null,
           claimed_until = null,
           finished_at   = now()
     where j.lead_id = new.id
       and j.state = 'pending'
     returning j.*
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select c.org_id, null, 'lead', c.lead_id,
         case c.kind when 'lead_escalation' then 'lead_escalation' else 'enquiry_alert' end,
         jsonb_build_object('outcome', 'cancelled', 'provider', c.provider, 'job_id', c.id,
                            'attempt', c.attempts, 'result', 'lead_redacted')
    from cancelled c;
  return null;
end $fn$;

-- ---------------------------------------------------------------------------
-- 7. Grants — the 0044 lesson, every function since
-- ---------------------------------------------------------------------------
revoke execute on function public.lead_escalation_config(jsonb) from public, anon, authenticated;
grant  execute on function public.lead_escalation_config(jsonb) to service_role;
revoke execute on function public.lead_escalation_due_at(timestamptz, jsonb) from public, anon, authenticated;
grant  execute on function public.lead_escalation_due_at(timestamptz, jsonb) to service_role;
revoke execute on function public.raise_lead_escalations(uuid) from public, anon, authenticated;
grant  execute on function public.raise_lead_escalations(uuid) to service_role;
-- restated for the three redefined above: create or replace keeps the ACL,
-- and a reader of this file should not have to trust that
revoke execute on function public.claim_notification_jobs(text, int, int, uuid, interval) from public, anon, authenticated;
grant  execute on function public.claim_notification_jobs(text, int, int, uuid, interval) to service_role;
revoke execute on function public.complete_notification_job(uuid, text, text, text, text, text, int) from public, anon, authenticated;
grant  execute on function public.complete_notification_job(uuid, text, text, text, text, text, int) to service_role;
revoke execute on function public.cancel_lead_notification_jobs() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. The twelfth job. Five minutes: the wait is measured in minutes, and a
--    ten-minute grid would turn "fifteen" into "fifteen to twenty-seven".
--    (name and schedule on the cron.schedule line itself: tests/unit/
--    cron-jobs-pinned.test.ts scans migrations for `cron.schedule('<name>'`)
-- ---------------------------------------------------------------------------
select cron.schedule('lead-escalation', '*/5 * * * *', $$select raise_lead_escalations()$$);

-- ---------------------------------------------------------------------------
-- 9. Apply-time assertions. What this migration claims, proven here
--    (the 0084 idiom: self-test leads, then removed; their events stay).
--    The policy row is restored to EXACTLY what it was before, whatever the
--    self-test had to set it to.
-- ---------------------------------------------------------------------------
do $$
declare
  v_org      uuid;
  v_slug     text;
  v_before   jsonb;
  v_on       jsonb;
  v_cfg      jsonb;
  v_lead     uuid;
  v_answered uuid;
  v_closed   uuid;
  v_job      public.notification_jobs;
  v_claimed  public.notification_jobs;
  n          int;
  hours      jsonb := jsonb_build_object('days', '[1,2,3,4,5]'::jsonb, 'start', '09:00', 'end', '18:00');
  test_cfg   jsonb := jsonb_build_object('enabled', true, 'after_minutes', 15, 'working_hours', hours, 'timezone', 'Asia/Nicosia');
begin
  -- (a) the reader: defaults for nonsense, and the seeded row is OFF
  v_cfg := lead_escalation_config('{"enabled":"yes","after_minutes":0,"max_age_hours":-1,"recipients":["nope",7],"working_hours":{"days":[8],"start":"25:00","end":"18:00"},"timezone":"Mars/Olympus"}'::jsonb);
  if (v_cfg ->> 'enabled')::boolean or (v_cfg ->> 'after_minutes')::int <> 15 or (v_cfg ->> 'max_age_hours')::int <> 48
     or v_cfg -> 'recipients' <> '[]'::jsonb or v_cfg -> 'working_hours' <> 'null'::jsonb or v_cfg ->> 'timezone' <> 'Asia/Nicosia' then
    raise exception '0107 aborted: the reader did not fall back to defaults for a malformed policy: %', v_cfg;
  end if;
  v_cfg := lead_escalation_config('{"enabled":true,"after_minutes":30,"recipients":["11111111-1111-1111-1111-111111111111","11111111-1111-1111-1111-111111111111"],"working_hours":{"days":[5,1,1],"start":"08:30","end":"17:00"},"timezone":"Europe/Athens"}'::jsonb);
  if not (v_cfg ->> 'enabled')::boolean or (v_cfg ->> 'after_minutes')::int <> 30
     or jsonb_array_length(v_cfg -> 'recipients') <> 1 or v_cfg #> '{working_hours,days}' <> '[1,5]'::jsonb
     or v_cfg ->> 'timezone' <> 'Europe/Athens' then
    raise exception '0107 aborted: the reader did not keep a valid policy: %', v_cfg;
  end if;
  if (lead_escalation_config() ->> 'enabled')::boolean then
    raise exception '0107 aborted: the policy must be seeded OFF';
  end if;

  -- (b) the clock, in Cyprus wall time, across both daylight-saving switches
  -- inside the hours: 10:00 → 10:15 local (07:15Z in summer time)
  if lead_escalation_due_at('2026-09-22 07:00:00+00', test_cfg) <> '2026-09-22 07:15:00+00' then
    raise exception '0107 aborted: a working-hours enquiry is due after the wait';
  end if;
  -- Friday 18:30 local (winter, UTC+2) → Monday 09:15 local, which is SUMMER time after the 29 March switch: 06:15Z
  if lead_escalation_due_at('2026-03-27 16:30:00+00', test_cfg) <> '2026-03-30 06:15:00+00' then
    raise exception '0107 aborted: spring switch — expected Monday 06:15Z, got %', lead_escalation_due_at('2026-03-27 16:30:00+00', test_cfg);
  end if;
  -- Saturday 22:00 local (summer, UTC+3) → Monday 09:15 local, WINTER time after the 25 October switch: 07:15Z
  if lead_escalation_due_at('2026-10-24 19:00:00+00', test_cfg) <> '2026-10-26 07:15:00+00' then
    raise exception '0107 aborted: autumn switch — expected Monday 07:15Z, got %', lead_escalation_due_at('2026-10-24 19:00:00+00', test_cfg);
  end if;
  -- 17:50 local (summer): ten minutes fit before 18:00, five carry to 09:05 tomorrow (06:05Z)
  if lead_escalation_due_at('2026-09-22 14:50:00+00', test_cfg) <> '2026-09-23 06:05:00+00' then
    raise exception '0107 aborted: the remainder of a wait did not carry to the next opening';
  end if;
  -- before opening: the wait starts at 09:00
  if lead_escalation_due_at('2026-09-22 04:00:00+00', test_cfg) <> '2026-09-22 06:15:00+00' then
    raise exception '0107 aborted: an early enquiry is not due at opening + wait';
  end if;
  -- around the clock: flat
  if lead_escalation_due_at('2026-09-26 19:00:00+00', test_cfg || '{"working_hours":null}'::jsonb) <> '2026-09-26 19:15:00+00' then
    raise exception '0107 aborted: with no hours the wait must be flat clock time';
  end if;

  -- (c) the sweep, on a self-test org, with the policy temporarily ON
  select id, slug into v_org, v_slug from organizations order by created_at limit 1;
  if v_org is null then
    raise notice '0107: no organization to self-test the sweep against — reader, clock, grants and schedule checked only';
  else
    select value into v_before from cyprus_config where key = 'lead_escalation';
    v_on := v_before || jsonb_build_object('enabled', true, 'after_minutes', 15, 'max_age_hours', 48, 'working_hours', null);

    select s.lead_id into v_lead
      from submit_public_enquiry(v_slug, '0107 selftest waiting', 'selftest-0107-waiting@example.invalid',
                                 null, '0107 self-test waiting', null, 'selftest-0107-waiting', null) s;
    select s.lead_id into v_answered
      from submit_public_enquiry(v_slug, '0107 selftest answered', 'selftest-0107-answered@example.invalid',
                                 null, '0107 self-test answered', null, 'selftest-0107-answered', null) s;
    select s.lead_id into v_closed
      from submit_public_enquiry(v_slug, '0107 selftest closed', 'selftest-0107-closed@example.invalid',
                                 null, '0107 self-test closed', null, 'selftest-0107-closed', null) s;
    update leads set received_at = now() - interval '20 minutes' where id in (v_lead, v_answered, v_closed);
    update leads set first_response_at = now() where id = v_answered;
    update leads set status = 'lost', lost_reason = '0107 self-test' where id = v_closed;

    -- OFF: nothing minted, however overdue
    if raise_lead_escalations(v_org) <> 0 then raise exception '0107 aborted: the sweep minted while the policy is off'; end if;

    update cyprus_config set value = v_on where key = 'lead_escalation';
    -- ON: exactly the waiting lead, once
    if raise_lead_escalations(v_org) <> 1 then raise exception '0107 aborted: expected exactly one escalation minted'; end if;
    if raise_lead_escalations(v_org) <> 0 then raise exception '0107 aborted: the sweep minted a second escalation for the same lead'; end if;
    select count(*) into n from notification_jobs where kind = 'lead_escalation' and lead_id in (v_lead, v_answered, v_closed);
    if n <> 1 then raise exception '0107 aborted: expected one lead_escalation job, found %', n; end if;
    if exists (select 1 from notification_jobs where kind = 'lead_escalation' and lead_id in (v_answered, v_closed)) then
      raise exception '0107 aborted: an answered or closed lead was escalated';
    end if;
    select count(*) into n from events
     where entity_type = 'lead' and entity_id = v_lead and event_type = 'lead_escalation' and payload ->> 'outcome' = 'scheduled';
    if n <> 1 then raise exception '0107 aborted: the scheduled event is missing'; end if;
    -- the unique index is the guarantee, by any path
    begin
      insert into notification_jobs (org_id, lead_id, kind) values (v_org, v_lead, 'lead_escalation');
      raise exception '0107 aborted: a second lead_escalation row was accepted';
    exception when unique_violation then null;
    end;
    -- a third kind is refused
    begin
      insert into notification_jobs (org_id, lead_id, kind) values (v_org, v_lead, 'something_else');
      raise exception '0107 aborted: an unknown kind was accepted';
    exception when check_violation then null;
    end;

    -- (d) the legacy closure must NOT touch it: give the lead an old-style
    --     "sent" event, claim, and expect the escalation row handed out
    insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
    values (v_org, null, 'lead', v_lead, 'enquiry_alert', jsonb_build_object('outcome', 'sent', 'selftest', '0107'));
    -- the desk-alert row IS closed by it (0102 D unchanged)
    perform claim_notification_jobs('selftest-0107', 5, 60, v_lead);
    select * into v_job from notification_jobs where lead_id = v_lead and kind = 'enquiry_desk_alert';
    if v_job.state <> 'accepted' or v_job.last_result <> 'legacy_sender' then
      raise exception '0107 aborted: the desk-alert legacy closure regressed';
    end if;
    select * into v_claimed from notification_jobs where lead_id = v_lead and kind = 'lead_escalation';
    if v_claimed.state <> 'sending' or v_claimed.claimed_by <> 'selftest-0107' then
      raise exception '0107 aborted: the escalation row was not claimed (state %, result %)', v_claimed.state, v_claimed.last_result;
    end if;
    -- (e) completion writes the kind's own event type
    if not complete_notification_job(v_claimed.id, 'selftest-0107', 'cancelled', null, 'lead_answered', null, null) then
      raise exception '0107 aborted: the holder could not complete its claim';
    end if;
    select count(*) into n from events
     where entity_type = 'lead' and entity_id = v_lead and event_type = 'lead_escalation'
       and payload ->> 'outcome' = 'cancelled' and payload ->> 'result' = 'lead_answered';
    if n <> 1 then raise exception '0107 aborted: the completion event is not under lead_escalation'; end if;
    if exists (select 1 from events where entity_id = v_lead and event_type = 'enquiry_alert' and payload ->> 'result' = 'lead_answered') then
      raise exception '0107 aborted: an escalation outcome was filed as a desk alert';
    end if;
    if exists (select 1 from events where entity_id in (v_lead, v_answered, v_closed) and payload::text ilike '%selftest-0107-%@%') then
      raise exception '0107 aborted: an event payload carries an address — it can never be erased';
    end if;

    -- restore the policy EXACTLY, then clean up: tasks, then leads (jobs cascade; events stay)
    update cyprus_config set value = v_before where key = 'lead_escalation';
    if (select value from cyprus_config where key = 'lead_escalation') <> v_before then
      raise exception '0107 aborted: the policy row was not restored';
    end if;
    delete from tasks where lead_id in (select id from leads where org_id = v_org and idempotency_key like 'selftest-0107-%');
    delete from leads where org_id = v_org and idempotency_key like 'selftest-0107-%';
  end if;

  -- grants: the three new functions service_role-only; the redefined ones unchanged
  if has_function_privilege('anon', 'public.lead_escalation_config(jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.lead_escalation_config(jsonb)', 'execute')
     or not has_function_privilege('service_role', 'public.lead_escalation_config(jsonb)', 'execute')
     or has_function_privilege('anon', 'public.lead_escalation_due_at(timestamptz,jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.lead_escalation_due_at(timestamptz,jsonb)', 'execute')
     or not has_function_privilege('service_role', 'public.lead_escalation_due_at(timestamptz,jsonb)', 'execute')
     or has_function_privilege('anon', 'public.raise_lead_escalations(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.raise_lead_escalations(uuid)', 'execute')
     or not has_function_privilege('service_role', 'public.raise_lead_escalations(uuid)', 'execute')
     or has_function_privilege('anon', 'public.claim_notification_jobs(text,int,int,uuid,interval)', 'execute')
     or has_function_privilege('authenticated', 'public.complete_notification_job(uuid,text,text,text,text,text,int)', 'execute')
     or not has_function_privilege('service_role', 'public.claim_notification_jobs(text,int,int,uuid,interval)', 'execute') then
    raise exception '0107 aborted: grants are wrong';
  end if;
  if has_function_privilege('service_role', 'public.cancel_lead_notification_jobs()', 'execute') then
    raise exception '0107 aborted: a trigger body is callable over PostgREST';
  end if;

  -- the door is untouched (0104's check, kept)
  if not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname = 'public' and p.proname = 'submit_public_enquiry' and p.pronargs = 8
                    and pg_get_function_result(p.oid) = 'TABLE(lead_id uuid, lead_org_id uuid, replayed boolean)') then
    raise exception '0107 aborted: the door changed — it must not';
  end if;

  if not exists (select 1 from cron.job where jobname = 'lead-escalation' and schedule = '*/5 * * * *') then
    raise exception '0107 aborted: lead-escalation is not scheduled every five minutes';
  end if;
  select count(*) into n from cron.job;
  if n <> 12 then raise exception '0107 aborted: expected 12 cron jobs, found %', n; end if;

  -- no new table: the aal2 invariant stands, and says so
  select count(*) into n from rls_aal2_coverage();
  if n <> 0 then raise exception '0107 aborted: % table(s) lack require_aal2', n; end if;

  raise notice '0107: lead_escalation on the outbox (seeded OFF), lead_escalation_config / _due_at (working time, Asia/Nicosia), raise_lead_escalations every five minutes (lead-escalation, the twelfth job), kind-aware outbox events.';
end $$;
