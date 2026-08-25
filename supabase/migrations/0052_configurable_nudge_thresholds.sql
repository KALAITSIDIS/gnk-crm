-- 0052 — one operator-visible home for the four hardcoded sweep thresholds.
--
-- 14 days (deal no-contact), 48 hours (viewing feedback), 2 days (reservation
-- expiry, 0047) and 7 days (instalment due, 0051) are each hardcoded in a
-- different migration, and each carries a comment saying a second editable copy
-- would disagree silently about what the number means. That argument is sound
-- and it is why they were hardcoded. It stops holding at four: the desk cannot
-- tune any of them without a migration, which means in practice they are not
-- tuned at all, and nobody outside this repo can even see what they are.
--
-- NOT a fifth threshold: `mandate_renewal` was ALREADY configurable — 0012
-- reads `mandates.renewal_reminder_days` per row, prefilled from
-- `cyprus_config.default_mandate_terms`. That is also the PRECEDENT this
-- follows: a value with a default in `cyprus_config`, read live, never copied.
--
-- ============================================================================
-- THE HEALTH SCORE DELIBERATELY DOES NOT FOLLOW. Operator decision, 2026-08-25.
--
-- `computeHealth` scores activity on a fixed cliff — full points within 7 days,
-- half within 14, zero after (doc 02 §C5) — and 14 is the same number the
-- no-contact nudge used. They are no longer tied. Setting the nudge to 21 days
-- means the score calls a deal stale a week before anyone is told about it.
--
-- That divergence is ACCEPTED, and the settings page says so in as many words,
-- because the alternative is worse: `deals.health_score` and its factor
-- snapshot are STORED and recomputed only in-action (DECISIONS T3.3), so a
-- score that tracked this setting would either be wrong on every existing deal
-- until something happened to touch it, or would need a mass recompute fired
-- from a settings save — a rewrite of every deal's score that, by T3.3's own
-- rule, writes no event and so would be invisible in every deal's timeline.
--
-- The health score is a QUALITY MODEL. This is a WORKFLOW SETTING. Keeping them
-- separate and saying so is honest; wiring them together quietly is not.
-- ============================================================================
--
-- THE CRON MUST SURVIVE A MISSING OR CORRUPT VALUE. `cyprus_config` is editable
-- as RAW JSON on /settings/cyprus-config, so "someone pastes a string into
-- deal_no_contact_days" is a reachable state, not a hypothetical — and it must
-- not be able to break four nightly sweeps. `nudge_threshold()` therefore
-- falls back to the hardcoded default when the row is missing, the key is
-- absent, the value is non-numeric, or the number is outside a sane range. The
-- callers keep passing their original constant as that fallback, so deleting
-- the config row restores exactly today's behaviour.
--
-- WHAT CHANGING A THRESHOLD DOES TO TASKS ALREADY OPEN, stated because it is
-- surprising and it is correct:
--   * deal no-contact — the boundary IS a function of the threshold, so the
--     existing self-heal supersedes every open nudge and re-mints it on the new
--     schedule that same night. Desirable, and it falls out of the key rather
--     than needing new code.
--   * viewing feedback — the guard is "any task for this viewing" (one feedback
--     lifecycle, 0020), so existing nudges stay put and only new ones use the
--     new window.
--   * reservation expiry / instalment due — the task's due date is the hold's
--     expiry or the line's due date, NOT a function of the threshold. Changing
--     the window changes only WHICH rows are picked up. Nothing re-keys.
--
-- AND THE BUG THAT FALLS OUT OF THE FIRST CASE, fixed here rather than shipped:
-- superseding a no-contact nudge previously logged `reason: deal_contacted`
-- whenever the boundary moved. After this migration the boundary can also move
-- because an ADMIN CHANGED THE SETTING, and writing "the deal was contacted"
-- into an append-only log when nobody contacted anybody is a false statement
-- that can never be corrected. The two cases ARE distinguishable — a real
-- contact stamps `last_contact_at` AFTER the task was created — so the sweep
-- now says which one happened.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

-- ---------- the setting ------------------------------------------------------

-- `on conflict do nothing`: re-running must never clobber a value the desk has
-- since tuned. The description is what the generic config editor renders.
insert into public.cyprus_config (key, value, description) values (
  'nudge_thresholds',
  jsonb_build_object(
    'deal_no_contact_days',    14,
    'viewing_feedback_hours',  48,
    'reservation_expiry_days',  2,
    'installment_due_days',     7
  ),
  'When the nightly sweeps raise chase-up tasks. Editable on Settings → Nudges. Does NOT change how deal health is scored — see 0052.'
) on conflict (key) do nothing;

-- ---------- the reader -------------------------------------------------------

create or replace function public.nudge_threshold(p_key text, p_fallback numeric)
returns numeric
language sql stable security definer set search_path = public as $$
  -- Every failure mode lands on p_fallback, which is the caller's original
  -- hardcoded constant:
  --   * no `nudge_thresholds` row      -> subquery yields NULL
  --   * key absent from the JSON       -> `->>` yields NULL
  --   * value is not a plain number    -> the regex refuses it, NULL
  --   * value <= 0 or absurdly large   -> the range check refuses it, NULL
  -- The regex matters more than it looks: a bare `::numeric` on operator-typed
  -- JSON would RAISE, and a raise inside a cron sweep is an outage of that
  -- sweep, not a bad number.
  select coalesce(
    (select case
              when (c.value ->> p_key) ~ '^[0-9]+(\.[0-9]+)?$'
               and (c.value ->> p_key)::numeric > 0
               and (c.value ->> p_key)::numeric <= 3650
              then (c.value ->> p_key)::numeric
            end
       from cyprus_config c
      where c.key = 'nudge_thresholds'),
    p_fallback);
$$;

-- Locked down at write time (T-C4). The APP does not need this — it reads the
-- `cyprus_config` row directly, which every signed-in user may already select —
-- so nothing is lost by refusing it over PostgREST. `public` must be named
-- explicitly because naming roles cannot remove a PUBLIC grant, and doing so
-- also strips service_role (0010), hence the re-grant.
revoke execute on function public.nudge_threshold(text, numeric) from public, anon, authenticated;
grant  execute on function public.nudge_threshold(text, numeric) to service_role;

-- ---------- sweep 1: follow-up nudges (0020 · 0021 · 0024 · 0025) ------------

create or replace function public.create_followup_nudges(p_org uuid default null)
returns void
language sql security definer set search_path = public as $$
  -- 1) no-contact nudges: open deals with no logged contact for N days, one
  --    task per silent period, due Cyprus end-of-day of the boundary crossed
  with stale as (
    select d.id, d.org_id, d.title, d.agent_id, d.created_by,
           (coalesce(d.last_contact_at, d.created_at) at time zone 'Asia/Nicosia')::date
             + (nudge_threshold('deal_no_contact_days', 14))::int as boundary
      from deals d
     where d.status = 'open'
       and (p_org is null or d.org_id = p_org)
  ),
  created as (
    insert into tasks (org_id, title, due_at, assignee_id, deal_id, kind)
    -- the title states the CURRENT threshold; a task minted under the old one
    -- keeps the old wording, which is right — it is what was true when it was
    -- raised, and the supersede below closes it anyway
    select s.org_id,
           'No contact in ' || (nudge_threshold('deal_no_contact_days', 14))::int
             || ' days: ' || s.title,
           (s.boundary::timestamp + interval '23 hours 59 minutes') at time zone 'Asia/Nicosia',
           coalesce(
             (select pr.id from profiles pr where pr.id = s.agent_id and pr.is_active),
             (select pr.id from profiles pr where pr.id = s.created_by and pr.is_active),
             (select pr.id from profiles pr
               where pr.org_id = s.org_id and pr.role = 'admin' and pr.is_active
               order by pr.created_at limit 1)),
           s.id,
           'deal_no_contact'
      from stale s
     where current_date >= s.boundary
       -- keyed to THIS boundary, not to "any nudge for this deal": logging
       -- contact moves last_contact_at, which moves the boundary, so a later
       -- silence is a new cycle and mints a new task
       and not exists (
         select 1 from tasks t
          where t.deal_id = s.id
            and t.kind = 'deal_no_contact'
            and (t.due_at at time zone 'Asia/Nicosia')::date = s.boundary)
    returning org_id, deal_id, id, assignee_id
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'deal', deal_id, 'followup_task_created',
         jsonb_build_object('kind', 'deal_no_contact', 'task_id', id,
                            'assignee_id', assignee_id,
                            'days', (nudge_threshold('deal_no_contact_days', 14))::int)
  from created;

  -- 2) viewing-feedback nudges. The due date is a deterministic function of the
  --    viewing, NOT of when this ran: a catch-up run after cron downtime stamps
  --    the date the nudge should have carried and the task appears already
  --    overdue, which is honest.
  with due as (
    select v.id, v.org_id, v.agent_id, v.created_by, v.property_id, p.reference,
           ((v.scheduled_at + make_interval(hours => (nudge_threshold('viewing_feedback_hours', 48))::int))
              at time zone 'Asia/Nicosia')::date as nag_date
      from viewings v
      join properties p on p.id = v.property_id
     where v.status = 'completed'
       and v.feedback is null
       and now() >= v.scheduled_at
                    + make_interval(hours => (nudge_threshold('viewing_feedback_hours', 48))::int)
       and (p_org is null or v.org_id = p_org)
  ),
  created as (
    insert into tasks (org_id, title, due_at, assignee_id, viewing_id, property_id, kind)
    select d.org_id,
           'Log viewing feedback: ' || d.reference,
           (d.nag_date::timestamp + interval '23 hours 59 minutes') at time zone 'Asia/Nicosia',
           coalesce(
             (select pr.id from profiles pr where pr.id = d.agent_id and pr.is_active),
             (select pr.id from profiles pr where pr.id = d.created_by and pr.is_active),
             (select pr.id from profiles pr
               where pr.org_id = d.org_id and pr.role = 'admin' and pr.is_active
               order by pr.created_at limit 1)),
           d.id,
           d.property_id,
           'viewing_feedback'
      from due d
      -- "any task for this viewing" is the RIGHT guard here and is NOT the 0006
      -- bug: a viewing has ONE feedback lifecycle, and saveViewingFeedback can
      -- only ever set feedback, never clear it, so there is no second cycle.
      -- It also means changing the window leaves existing nudges alone.
     where not exists (
       select 1 from tasks t where t.viewing_id = d.id and t.kind = 'viewing_feedback')
    returning org_id, viewing_id, id, assignee_id
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'viewing', viewing_id, 'followup_task_created',
         jsonb_build_object('kind', 'viewing_feedback', 'task_id', id,
                            'assignee_id', assignee_id,
                            'hours', (nudge_threshold('viewing_feedback_hours', 48))::int)
  from created;

  -- 3) self-heal the deal invariant. The trigger does this at edit time with
  --    actor attribution; this is the nightly safety net (and the only path
  --    that catches a deal whose boundary moved by a clock change — or, since
  --    0052, by an admin changing the threshold).
  with superseded as (
    update tasks t
       set is_done = true, done_at = now()
      from deals d
     where t.deal_id = d.id
       and t.kind = 'deal_no_contact'
       and not t.is_done
       and (p_org is null or t.org_id = p_org)
       and (d.status <> 'open'
            or (t.due_at at time zone 'Asia/Nicosia')::date
               <> (coalesce(d.last_contact_at, d.created_at) at time zone 'Asia/Nicosia')::date
                  + (nudge_threshold('deal_no_contact_days', 14))::int)
    returning t.org_id, t.id, t.deal_id, d.status, d.last_contact_at, t.created_at
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'task', id, 'superseded',
         jsonb_build_object('kind', 'deal_no_contact', 'deal_id', deal_id,
                            -- SAY WHICH ONE HAPPENED. Before 0052 a moved
                            -- boundary could only mean contact was logged, so
                            -- 'deal_contacted' was safe to assert. Now it can
                            -- also mean the admin changed the setting, and a
                            -- false statement in an append-only log can never
                            -- be taken back. A real contact stamps
                            -- last_contact_at AFTER the task was minted, which
                            -- is what tells the two apart.
                            'reason', case
                              when status <> 'open' then 'deal_closed'
                              when last_contact_at is not null
                               and last_contact_at > created_at then 'deal_contacted'
                              else 'threshold_changed'
                            end)
  from superseded;

  -- 4) self-heal the viewing invariant
  with superseded as (
    update tasks t
       set is_done = true, done_at = now()
      from viewings v
     where t.viewing_id = v.id
       and t.kind = 'viewing_feedback'
       and not t.is_done
       and (p_org is null or t.org_id = p_org)
       and (v.feedback is not null or v.status <> 'completed')
    returning t.org_id, t.id, t.viewing_id
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'task', id, 'superseded',
         jsonb_build_object('kind', 'viewing_feedback', 'viewing_id', viewing_id,
                            'reason', 'feedback_logged_or_viewing_reopened')
  from superseded;

  -- 5) self-heal the assignee invariant (0024). Deliberately covers EVERY
  --    system kind, mandate_renewal included: this job runs at 03:15, fifteen
  --    minutes after expire_mandates, so one place owns the invariant for all
  --    three rather than each cron re-implementing it.
  with rehomed as (
    update tasks t
       set assignee_id = (
         select pr.id from profiles pr
          where pr.org_id = t.org_id and pr.role = 'admin' and pr.is_active
          order by pr.created_at limit 1)
     where t.kind is not null
       and not t.is_done
       and (p_org is null or t.org_id = p_org)
       and exists (
         select 1 from profiles pr
          where pr.id = t.assignee_id and not pr.is_active)
       and exists (
         select 1 from profiles pr
          where pr.org_id = t.org_id and pr.role = 'admin' and pr.is_active)
    returning t.org_id, t.id, t.assignee_id, t.kind
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'task', id, 'reassigned',
         jsonb_build_object('kind', kind, 'assignee_id', assignee_id,
                            'reason', 'assignee_deactivated')
  from rehomed;
$$;

-- ---------- sweep 2: reservation expiry warning (0047) -----------------------

create or replace function public.warn_expiring_reservations(p_org uuid default null)
returns void
language sql security definer set search_path = public as $$
  with due_soon as (
    select r.id, r.org_id, r.property_id, r.contact_id, r.created_by,
           r.expires_at,
           (r.expires_at at time zone 'Asia/Nicosia')::date as expiry_date,
           p.reference,
           p.assigned_agent_id
      from reservations r
      join properties p on p.id = r.property_id
     where r.status in ('held', 'confirmed')
       and r.expires_at > now()
       and r.expires_at <= now()
                           + make_interval(days => (nudge_threshold('reservation_expiry_days', 2))::int)
       and (p_org is null or r.org_id = p_org)
  ),
  created as (
    insert into tasks (org_id, title, due_at, assignee_id, property_id,
                       contact_id, reservation_id, kind)
    select d.org_id,
           'Reservation on ' || d.reference || ' lapses ' || to_char(d.expiry_date, 'DD Mon'),
           (d.expiry_date::timestamp + interval '23 hours 59 minutes') at time zone 'Asia/Nicosia',
           coalesce(
             d.created_by,
             d.assigned_agent_id,
             (select pr.id from profiles pr
               where pr.org_id = d.org_id and pr.role = 'admin' and pr.is_active
               order by pr.created_at limit 1)),
           d.property_id,
           d.contact_id,
           d.id,
           'reservation_expiring'
      from due_soon d
     where not exists (
       select 1 from tasks t
        where t.reservation_id = d.id
          and t.kind = 'reservation_expiring'
          -- keyed to THIS expiry, which is NOT a function of the threshold:
          -- widening the window changes which holds are picked up, never the
          -- key, so nothing re-mints
          and (t.due_at at time zone 'Asia/Nicosia')::date = d.expiry_date
     )
    returning org_id, id, reservation_id, property_id, assignee_id
  ),
  logged as (
    insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
    select org_id, null, 'property', property_id, 'reservation_expiring_soon',
           jsonb_build_object('task_id', id, 'reservation_id', reservation_id,
                              'assignee_id', assignee_id,
                              'days', (nudge_threshold('reservation_expiry_days', 2))::int)
      from created
    returning 1
  ),
  superseded as (
    update tasks t
       set is_done = true, done_at = now()
      from reservations r
     where t.reservation_id = r.id
       and t.kind = 'reservation_expiring'
       and not t.is_done
       and (p_org is null or t.org_id = p_org)
       and (r.status not in ('held', 'confirmed')
            or (t.due_at at time zone 'Asia/Nicosia')::date
               <> (r.expires_at at time zone 'Asia/Nicosia')::date)
    returning t.org_id, t.id, t.reservation_id, r.status
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'task', id, 'superseded',
         jsonb_build_object('kind', 'reservation_expiring',
                            'reservation_id', reservation_id,
                            'reason', case
                              when status in ('held', 'confirmed') then 'reservation_extended'
                              else 'reservation_no_longer_live'
                            end)
    from superseded;
$$;

-- ---------- sweep 3: instalment reminders (0051) -----------------------------

create or replace function public.remind_due_installments(p_org uuid default null)
returns void
language sql security definer set search_path = public as $$
  with due_soon as (
    select i.id, i.org_id, i.reservation_id, i.label, i.amount, i.due_date,
           i.due_date - (now() at time zone 'Asia/Nicosia')::date as days_out,
           r.property_id, r.contact_id, r.created_by,
           p.reference,
           p.assigned_agent_id
      from reservation_installments i
      join reservations r on r.id = i.reservation_id
      join properties    p on p.id = r.property_id
     where i.paid_at is null
       and i.due_date is not null
       -- CHASEABLE, not LIVE (0051): `converted` is the state a buyer spends
       -- most of a payment plan in, and dropping it here would stop chasing
       -- money the moment a sale is signed. RLS test 35 pins this.
       and r.status in ('held', 'confirmed', 'converted')
       and i.due_date <= (now() at time zone 'Asia/Nicosia')::date
                         + (nudge_threshold('installment_due_days', 7))::int
       and (p_org is null or i.org_id = p_org)
  ),
  created as (
    insert into tasks (org_id, title, due_at, assignee_id, property_id,
                       contact_id, reservation_id, installment_id, kind)
    select d.org_id,
           'Instalment "' || d.label || '" on ' || d.reference
             || ' due ' || to_char(d.due_date, 'DD Mon'),
           (d.due_date::timestamp + interval '23 hours 59 minutes') at time zone 'Asia/Nicosia',
           coalesce(
             d.created_by,
             d.assigned_agent_id,
             (select pr.id from profiles pr
               where pr.org_id = d.org_id and pr.role = 'admin' and pr.is_active
               order by pr.created_at limit 1)),
           d.property_id,
           d.contact_id,
           d.reservation_id,
           d.id,
           'installment_due'
      from due_soon d
     where not exists (
       select 1 from tasks t
        where t.installment_id = d.id
          and t.kind = 'installment_due'
          -- keyed to the LINE's due date, not to the threshold: widening the
          -- window changes which lines are picked up, never the key
          and (t.due_at at time zone 'Asia/Nicosia')::date = d.due_date
     )
    returning org_id, id, installment_id, reservation_id, property_id, assignee_id
  ),
  logged as (
    insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
    select c.org_id, null, 'property', c.property_id, 'installment_due_soon',
           jsonb_build_object('task_id', c.id,
                              'installment_id', c.installment_id,
                              'reservation_id', c.reservation_id,
                              'assignee_id', c.assignee_id,
                              'label', d.label,
                              'amount', d.amount,
                              'due_date', d.due_date,
                              'days', d.days_out)
      from created c join due_soon d on d.id = c.installment_id
    returning 1
  ),
  superseded as (
    update tasks t
       set is_done = true, done_at = now()
      from reservation_installments i
      join reservations r on r.id = i.reservation_id
     where t.installment_id = i.id
       and t.kind = 'installment_due'
       and not t.is_done
       and (p_org is null or t.org_id = p_org)
       and (i.paid_at is not null
            or i.due_date is null
            or r.status not in ('held', 'confirmed', 'converted')
            or (t.due_at at time zone 'Asia/Nicosia')::date <> i.due_date)
    returning t.org_id, t.id, t.installment_id, i.paid_at, i.label, r.status
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'task', id, 'superseded',
         jsonb_build_object('kind', 'installment_due',
                            'installment_id', installment_id,
                            'label', label,
                            'reason', case
                              when paid_at is not null then 'installment_paid'
                              when status not in ('held', 'confirmed', 'converted')
                                then 'reservation_no_longer_live'
                              else 'installment_rescheduled'
                            end)
    from superseded;
$$;

do $$
declare
  seeded    jsonb;
  v         numeric;
  n_cron    int;
begin
  select value into seeded from cyprus_config where key = 'nudge_thresholds';
  if seeded is null then
    raise exception '0052 aborted: the nudge_thresholds row was not created';
  end if;

  -- the four keys must be present and must read back as today's constants, or
  -- this migration has quietly changed behaviour instead of exposing it
  if nudge_threshold('deal_no_contact_days',   -1) <> 14 then
    raise exception '0052 aborted: deal_no_contact_days did not read back as 14';
  end if;
  if nudge_threshold('viewing_feedback_hours', -1) <> 48 then
    raise exception '0052 aborted: viewing_feedback_hours did not read back as 48';
  end if;
  if nudge_threshold('reservation_expiry_days', -1) <> 2 then
    raise exception '0052 aborted: reservation_expiry_days did not read back as 2';
  end if;
  if nudge_threshold('installment_due_days',   -1) <> 7 then
    raise exception '0052 aborted: installment_due_days did not read back as 7';
  end if;

  -- an absent key falls back rather than returning NULL, which would make every
  -- comparison in every sweep NULL and silently stop all four
  if nudge_threshold('no_such_key_at_all', 99) <> 99 then
    raise exception '0052 aborted: an absent key did not fall back';
  end if;

  -- THE FAILURE MODE THAT MATTERS. /settings/cyprus-config edits this row as
  -- RAW JSON, so garbage is reachable, and a bare cast would RAISE inside a
  -- cron sweep. Prove each bad shape lands on the fallback instead — in a
  -- SUBTRANSACTION that is rolled back, so the seeded row is left untouched.
  -- Specific errcode, not `when others`: a real failure must still propagate.
  begin
    update cyprus_config
       set value = jsonb_build_object(
             'deal_no_contact_days',    'fourteen',   -- not a number
             'viewing_feedback_hours',  0,            -- would nudge instantly
             'reservation_expiry_days', -3,           -- negative
             'installment_due_days',    999999)       -- absurd
     where key = 'nudge_thresholds';

    if nudge_threshold('deal_no_contact_days',    14) <> 14
    or nudge_threshold('viewing_feedback_hours',  48) <> 48
    or nudge_threshold('reservation_expiry_days',  2) <> 2
    or nudge_threshold('installment_due_days',     7) <> 7 then
      raise exception '0052 aborted: a corrupt value did NOT fall back to the default';
    end if;

    raise exception using errcode = 'GNK52', message = '0052 probe rollback';
  exception when sqlstate 'GNK52' then
    null; -- expected — the rollback IS the point
  end;

  -- the seeded row survived the probe
  if nudge_threshold('deal_no_contact_days', -1) <> 14 then
    raise exception '0052 aborted: the probe did not roll back cleanly';
  end if;

  -- all four sweeps must still be scheduled; a `create or replace` that dropped
  -- and recreated one would have unscheduled it
  select count(*) into n_cron from cron.job
   where jobname in ('followup-nudges', 'warn-expiring-reservations', 'remind-due-installments');
  if n_cron <> 3 then
    raise exception '0052 aborted: expected 3 rewritten sweeps still scheduled, found %', n_cron;
  end if;

  -- create or replace PRESERVES the ACL, but 0021 and T-C4 both exist because
  -- that was assumed once too often
  if has_function_privilege('anon', 'public.create_followup_nudges(uuid)', 'execute')
  or has_function_privilege('anon', 'public.warn_expiring_reservations(uuid)', 'execute')
  or has_function_privilege('anon', 'public.remind_due_installments(uuid)', 'execute')
  or has_function_privilege('anon', 'public.nudge_threshold(text, numeric)', 'execute')
  or has_function_privilege('authenticated', 'public.nudge_threshold(text, numeric)', 'execute') then
    raise exception '0052 aborted: a sweep or the reader is callable over PostgREST';
  end if;
  if not has_function_privilege('service_role', 'public.nudge_threshold(text, numeric)', 'execute') then
    raise exception '0052 aborted: service_role lost EXECUTE on nudge_threshold';
  end if;

  raise notice '0052: 4 thresholds seeded at their current values, corrupt input falls back (proven, rolled back), 3 sweeps rewritten and still scheduled, execute locked down';
end $$;
