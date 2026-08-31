-- 0078 — the dormant portal roles get a tripwire, and the one time-based
-- duty without a sweep gets its nudge (audit 2026-08-29: SEC-07, SEC-08).
--
-- 1. SEC-07 — `user_role` has carried owner_portal / developer_portal /
--    partner_portal since 0001, with ZERO scoping: every staff read policy is
--    an org-membership scan, so a portal-role profile seeded out-of-band
--    (dashboard, script, service role) would read the entire org's CRM at
--    staff level. 0043 recorded the deferral ("considered, not overlooked:
--    when those roles are built, contacts and buyer_requirements must be
--    revisited TOGETHER"); this adds the MECHANICAL guard the note lacked —
--    a CHECK, not a trigger, because the existing profiles trigger
--    deliberately exempts null-uid paths (migrations/seeds) and therefore
--    cannot catch exactly the seeded-profile threat this names. A CHECK binds
--    every path, service_role included (0072's lesson).
--
--    SUNSET OBLIGATION: the portal-phase migration that builds real portal
--    RLS must DROP `profiles_role_staff_only` in the same file — otherwise
--    the portal build hits an invisible wall. Record it there, not here.
--
-- 2. SEC-08 — `retention_until` was computed, stored, indexed (0017 even
--    predicted this sweep in its index comment) … and then waited for an
--    admin to remember /settings/retention. Every other time-based duty has
--    a sweep; the AML retention duty — where HOLDING the records past the
--    window is itself the breach — had none. T-retention-expiry settles the
--    boundary: "Surfaced, never automatic. A nightly NUDGE would be a
--    reasonable follow-up — an automatic purge would not." This is that
--    nudge: a TWELFTH task kind and two arms in the existing 03:15 sweep
--    (the 0075 precedent — not a ninth cron job). The sweep mints the task
--    and NOTHING else; purgeExpiredRetention stays the only destroyer, and
--    destruction stays a human act attributed to an actor.
--
--    Assignee is the oldest active ADMIN only — destruction is admin-only,
--    so the agent/creator fallback arms would assign an unactionable task.
--    Idempotence is keyed to the CYCLE (due date = the contact's current
--    retention_until): a purge nulls the marker and closes the task; a
--    re-dated duty re-arms — the 0006-bug rule.
--
-- The full 0075 sweep body is restated with the two arms added — dropping
-- any existing arm would silently delete behaviour. Additive: hosted BEFORE
-- the merge.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

-- ---------- 1. the portal tripwire (SEC-07) ---------------------------------

do $$
declare
  n int;
begin
  select count(*) into n from public.profiles
   where role in ('owner_portal', 'developer_portal', 'partner_portal');
  if n > 0 then
    raise exception '0078 aborted: % portal-role profile(s) already exist — the deferral premise is false, investigate before guarding', n;
  end if;
end $$;

-- Re-run guard added 2026-09-01 (post-audit review): drop-if-exists before
-- each add, the 0045/0049/0054 idiom. INERT on first run; makes a replay
-- (restore-path db push against an already-migrated DB) a no-op instead of
-- a 42710 abort. The assertion block below re-proves the constraint exists.
alter table public.profiles
  drop constraint if exists profiles_role_staff_only;
alter table public.profiles
  add constraint profiles_role_staff_only
  check (role in ('admin', 'agent', 'listing_manager'));

comment on constraint profiles_role_staff_only on public.profiles is
  'SEC-07 tripwire: the portal enum values are UNBUILT (0043''s deferral) and '
  'every staff read policy is an org-membership scan — a portal profile would '
  'read the org at staff level. The portal-phase migration must DROP this in '
  'the same file that introduces real portal RLS.';

-- ---------- 2. the kind (SEC-08) --------------------------------------------

insert into public.task_kinds (kind, description, added_in) values
  ('retention_expired', 'The five-year AML retention on an erased contact''s records has run out', '0078')
on conflict (kind) do nothing;

-- ---------- 3. the sweep, arms 1-5 + 2b/4b verbatim from 0075, + 2c/4c ------

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

  -- 2b) no-show rebooking nudges (0075, audit WF-7). Due the Cyprus day after
  --     the missed slot; a viewing marked no_show weeks late mints a task that
  --     is already overdue, which is honest (same doctrine as arm 2). Not
  --     minted when a rebooking already exists — the nag would open pre-closed.
  with due as (
    select v.id, v.org_id, v.agent_id, v.created_by, v.property_id, v.contact_id,
           p.reference,
           (v.scheduled_at at time zone 'Asia/Nicosia')::date + 1 as nag_date
      from viewings v
      join properties p on p.id = v.property_id
     where v.status = 'no_show'
       and (p_org is null or v.org_id = p_org)
       and not exists (
         select 1 from viewings v2
          where v2.org_id = v.org_id
            and v2.contact_id = v.contact_id
            and v2.property_id = v.property_id
            and v2.id <> v.id
            and v2.scheduled_at > v.scheduled_at
            and v2.status <> 'cancelled')
  ),
  created as (
    insert into tasks (org_id, title, due_at, assignee_id, viewing_id, property_id, kind)
    select d.org_id,
           'Rebook after no-show: ' || d.reference,
           (d.nag_date::timestamp + interval '23 hours 59 minutes') at time zone 'Asia/Nicosia',
           coalesce(
             (select pr.id from profiles pr where pr.id = d.agent_id and pr.is_active),
             (select pr.id from profiles pr where pr.id = d.created_by and pr.is_active),
             (select pr.id from profiles pr
               where pr.org_id = d.org_id and pr.role = 'admin' and pr.is_active
               order by pr.created_at limit 1)),
           d.id,
           d.property_id,
           'viewing_no_show'
      from due d
      -- one-shot key (viewing_id, kind), the 0053 rationale: no_show is
      -- terminal, there is no second cycle to arm
     where not exists (
       select 1 from tasks t where t.viewing_id = d.id and t.kind = 'viewing_no_show')
    returning org_id, viewing_id, id, assignee_id
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'viewing', viewing_id, 'followup_task_created',
         jsonb_build_object('kind', 'viewing_no_show', 'task_id', id,
                            'assignee_id', assignee_id)
  from created;

  -- 2c) retention-expired nudges (0078, audit SEC-08). Admin-assigned only —
  --     destruction is admin-only, an agent cannot act on this. Due date IS
  --     the expiry date (already overdue on mint, which is honest: the duty
  --     lapsed the day the window closed). Keyed to the CYCLE: a purge nulls
  --     retention_until and the supersede below closes the task; a re-dated
  --     duty re-arms. Mints nothing for years — the earliest real expiry is
  --     2031 — and that is the point: it fires when memory has long failed.
  with due as (
    select c.id, c.org_id, c.display_name, c.retention_until
      from contacts c
     where c.erased_at is not null
       and c.retention_until is not null
       and c.retention_until <= (now() at time zone 'Asia/Nicosia')::date
       and (p_org is null or c.org_id = p_org)
  ),
  created as (
    insert into tasks (org_id, title, due_at, assignee_id, contact_id, kind)
    select d.org_id,
           'AML retention expired — review for destruction: ' || d.display_name,
           (d.retention_until::timestamp + interval '23 hours 59 minutes') at time zone 'Asia/Nicosia',
           (select pr.id from profiles pr
             where pr.org_id = d.org_id and pr.role = 'admin' and pr.is_active
             order by pr.created_at limit 1),
           d.id,
           'retention_expired'
      from due d
     where not exists (
       select 1 from tasks t
        where t.contact_id = d.id
          and t.kind = 'retention_expired'
          and (t.due_at at time zone 'Asia/Nicosia')::date = d.retention_until)
    returning org_id, contact_id, id, assignee_id
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'contact', contact_id, 'followup_task_created',
         jsonb_build_object('kind', 'retention_expired', 'task_id', id,
                            'assignee_id', assignee_id)
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

  -- 4b) self-heal the no-show invariant (0075): a LATER non-cancelled viewing
  --     for the same contact+property means the rebooking happened — close the
  --     nag. The reason states exactly what the predicate proved, nothing more.
  with superseded as (
    update tasks t
       set is_done = true, done_at = now()
      from viewings v
     where t.viewing_id = v.id
       and t.kind = 'viewing_no_show'
       and not t.is_done
       and (p_org is null or t.org_id = p_org)
       and exists (
         select 1 from viewings v2
          where v2.org_id = v.org_id
            and v2.contact_id = v.contact_id
            and v2.property_id = v.property_id
            and v2.id <> v.id
            and v2.scheduled_at > v.scheduled_at
            and v2.status <> 'cancelled')
    returning t.org_id, t.id, t.viewing_id
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'task', id, 'superseded',
         jsonb_build_object('kind', 'viewing_no_show', 'viewing_id', viewing_id,
                            'reason', 'viewing_rebooked')
  from superseded;

  -- 4c) self-heal the retention invariant (0078): a purge nulls the marker
  --     (purgeExpiredRetention clears retention_until), and a corrected duty
  --     moves it — either way the open nag no longer describes the row. The
  --     reason names only what the predicate proved.
  with superseded as (
    update tasks t
       set is_done = true, done_at = now()
      from contacts c
     where t.contact_id = c.id
       and t.kind = 'retention_expired'
       and not t.is_done
       and (p_org is null or t.org_id = p_org)
       and (c.retention_until is null
            or (t.due_at at time zone 'Asia/Nicosia')::date <> c.retention_until)
    returning t.org_id, t.id, t.contact_id
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'task', id, 'superseded',
         jsonb_build_object('kind', 'retention_expired', 'contact_id', contact_id,
                            'reason', 'retention_purged_or_changed')
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

-- ---------- assertions ------------------------------------------------------

do $$
declare
  n int;
begin
  -- the tripwire is in and VALIDATED
  if not exists (
    select 1 from pg_constraint
     where conname = 'profiles_role_staff_only' and convalidated
  ) then
    raise exception '0078 aborted: profiles_role_staff_only missing or not validated';
  end if;

  -- prove the refusal on a live row where one exists (rolled-back
  -- subtransaction; a fresh database has no profiles yet — the 0050 lesson:
  -- SKIP with a NOTICE, and RLS test 53 covers it unconditionally)
  if exists (select 1 from public.profiles) then
    begin
      update public.profiles set role = 'owner_portal'
       where id = (select id from public.profiles limit 1);
      raise exception '0078 aborted: a portal role was ACCEPTED — the tripwire does not fire';
    exception when check_violation then
      null; -- expected: the refusal IS the pass
    end;
  else
    raise notice '0078: no profiles yet — portal probe SKIPPED (RLS test 53 covers it)';
  end if;

  -- twelve kinds, nothing lost
  select count(*) into n from public.task_kinds;
  if n <> 12 then
    raise exception '0078 aborted: expected 12 task kinds, found %', n;
  end if;
  if not exists (select 1 from public.task_kinds where kind = 'retention_expired') then
    raise exception '0078 aborted: retention_expired kind missing';
  end if;

  -- the sweep still carries EVERY arm — a restatement that dropped one would
  -- silently delete behaviour (checked against the compiled source)
  select count(*) into n from pg_proc p
   where p.proname = 'create_followup_nudges'
     and position('deal_no_contact'    in p.prosrc) > 0
     and position('viewing_feedback'   in p.prosrc) > 0
     and position('viewing_no_show'    in p.prosrc) > 0
     and position('retention_expired'  in p.prosrc) > 0
     and position('assignee_deactivated' in p.prosrc) > 0;
  if n <> 1 then
    raise exception '0078 aborted: create_followup_nudges is missing an arm';
  end if;

  -- still scheduled, still locked down
  select count(*) into n from cron.job where jobname = 'followup-nudges';
  if n <> 1 then
    raise exception '0078 aborted: followup-nudges is no longer scheduled';
  end if;
  if has_function_privilege('anon', 'public.create_followup_nudges(uuid)', 'execute')
  or has_function_privilege('authenticated', 'public.create_followup_nudges(uuid)', 'execute') then
    raise exception '0078 aborted: create_followup_nudges is callable over PostgREST';
  end if;

  raise notice '0078: portal tripwire live (refusal proven where probable), retention_expired kind live (12 kinds), sweep gains arms 2c + 4c, still scheduled, execute locked down';
end $$;
