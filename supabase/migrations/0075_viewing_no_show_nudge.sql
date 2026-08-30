-- 0075 — a no-show finally generates a follow-up (audit 2026-08-29, WF-7).
--
-- The buyer most in need of a rebooking call was the one buyer who generated
-- NOTHING: the feedback nudge keys on `completed` (0020, kept by 0052), and
-- `no_show` appeared in exactly one place in all of supabase/ — the enum. A
-- viewing marked no_show vanished from every follow-up surface.
--
-- Two new arms inside the EXISTING 03:15 `followup-nudges` sweep — deliberately
-- NOT a new cron job (0074 just gave the 8 jobs a witness; a 9th would ripple
-- through cron_health's count assertion, RLS test 50 and the restore pack for
-- no operational gain):
--
--   mint      no_show viewing, no rebooking yet → one `viewing_no_show` task,
--             due the Cyprus day after the missed slot. One-shot key
--             (viewing_id, kind), the 0053 rationale: no_show is terminal in
--             VIEWING_STATUS_ACTIONS, there is no second cycle to arm.
--   supersede a LATER non-cancelled viewing for the same contact+property
--             closes the open task — the call happened, or was never needed.
--             Reason `viewing_rebooked`: states only what the predicate
--             actually proved (the 0052 lesson — an append-only log can never
--             take a false reason back).
--
-- The rebooking condition lives on a DIFFERENT row (an INSERT), so the 0020
-- edit-time trigger cannot catch it; sweep-only means the task clears the next
-- night, not instantly — 0020's stated "nightly safety net" design.
--
-- "Next day" is a due-date grace, not a firing threshold, so it does NOT join
-- 0052's nudge_thresholds (0053:55-59 sets that precedent).
--
-- The full 0052 body is restated below with the two arms added — dropping any
-- existing arm would silently delete behaviour, so every arm is carried over
-- verbatim and the assertion block re-proves the lockdown.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

-- ---------- the kind --------------------------------------------------------

-- 0049's payoff: a one-line INSERT cannot silently drop the nine kinds already
-- there the way a rewritten CHECK can.
insert into public.task_kinds (kind, description, added_in) values
  ('viewing_no_show', 'A viewing was marked no-show and the buyer has not been rebooked', '0075')
on conflict (kind) do nothing;

-- ---------- the sweep, arms 1-5 verbatim from 0052 + the two new arms --------

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
  -- the tenth kind is in and nothing already there was lost
  select count(*) into n from public.task_kinds;
  if n <> 10 then
    raise exception '0075 aborted: expected 10 task kinds, found %', n;
  end if;
  if not exists (select 1 from public.task_kinds where kind = 'viewing_no_show') then
    raise exception '0075 aborted: viewing_no_show kind missing';
  end if;

  -- the sweep is still scheduled — a drop-and-recreate would have unscheduled it
  select count(*) into n from cron.job where jobname = 'followup-nudges';
  if n <> 1 then
    raise exception '0075 aborted: followup-nudges is no longer scheduled';
  end if;

  -- create or replace PRESERVES the ACL, but 0021 and T-C4 both exist because
  -- that was assumed once too often
  if has_function_privilege('anon', 'public.create_followup_nudges(uuid)', 'execute')
  or has_function_privilege('authenticated', 'public.create_followup_nudges(uuid)', 'execute') then
    raise exception '0075 aborted: create_followup_nudges is callable over PostgREST';
  end if;

  raise notice '0075: viewing_no_show kind live (10 kinds), sweep gains mint 2b + supersede 4b, still scheduled, execute locked down';
end $$;
