-- 0025 — measure deal silence by CONTACT, not by keystrokes.
--
-- B7's deal_no_contact nudge keyed off deals.last_activity_at, which
-- lib/actions/deals.ts stamps on every field change. Renaming a deal therefore
-- read as "I spoke to the buyer": trg_supersede_deal_nudges closed the open
-- chase-up on the spot and recorded reason 'deal_contacted_or_closed' — an
-- assertion about the world nobody had made, attributed via auth.uid() to
-- whoever happened to be editing. The nightly job then declined to re-mint it,
-- because the 14-day boundary had moved too. A deal could be edited weekly and
-- never once chased. Pinned by RLS test 27.
--
-- Contact is a claim someone makes. It gets its own column.
--
--   last_contact_at   set only by logDealContact
--   last_activity_at  unchanged — still the health-score activity signal
--                     (doc 02 §C5), still bumped by any edit
--
-- Backfilled from last_activity_at so existing deals keep the boundary they
-- have today, rather than a fleet of nudges appearing the morning this ships.
--
-- Deals with no contact ever logged fall back to created_at, so a deal nobody
-- touches is still chased 14 days after it was opened. That fallback is inlined
-- rather than wrapped in a helper: a new public function would be
-- anon-executable by default (HANDOFF §4.3) and this is one coalesce.

alter table deals add column if not exists last_contact_at timestamptz;

update deals set last_contact_at = last_activity_at where last_contact_at is null;

comment on column deals.last_contact_at is
  'When someone last recorded contact with the buyer (logDealContact). Drives the deal_no_contact nudge. NOT bumped by edits — that is last_activity_at.';

-- ---------- the nightly job: 0024's, with two predicates changed -------------
-- Byte-identical to 0024 apart from the boundary in step 1 and the supersede
-- predicate in step 3, both of which now read contact rather than activity, and
-- step 3's reason string, which no longer claims two things at once.

create or replace function create_followup_nudges(p_org uuid default null) returns void
language sql security definer set search_path = public as $$
  -- 1) no-contact nudges: open deals with no logged contact for 14 days, one
  --    task per silent period, due Cyprus end-of-day of the boundary crossed
  with stale as (
    select d.id, d.org_id, d.title, d.agent_id, d.created_by,
           (coalesce(d.last_contact_at, d.created_at) at time zone 'Asia/Nicosia')::date + 14 as boundary
      from deals d
     where d.status = 'open'
       and (p_org is null or d.org_id = p_org)
  ),
  created as (
    insert into tasks (org_id, title, due_at, assignee_id, deal_id, kind)
    select s.org_id,
           'No contact in 14 days: ' || s.title,
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
                            'assignee_id', assignee_id, 'days', 14)
  from created;

  -- 2) viewing-feedback nudges. The due date is a deterministic function of the
  --    viewing, NOT of when this ran: a catch-up run after cron downtime stamps
  --    the date the nudge should have carried and the task appears already
  --    overdue, which is honest.
  with due as (
    select v.id, v.org_id, v.agent_id, v.created_by, v.property_id, p.reference,
           ((v.scheduled_at + interval '48 hours') at time zone 'Asia/Nicosia')::date as nag_date
      from viewings v
      join properties p on p.id = v.property_id
     where v.status = 'completed'
       and v.feedback is null
       and now() >= v.scheduled_at + interval '48 hours'
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
     where not exists (
       select 1 from tasks t where t.viewing_id = d.id and t.kind = 'viewing_feedback')
    returning org_id, viewing_id, id, assignee_id
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'viewing', viewing_id, 'followup_task_created',
         jsonb_build_object('kind', 'viewing_feedback', 'task_id', id,
                            'assignee_id', assignee_id, 'hours', 48)
  from created;

  -- 3) self-heal the deal invariant. The trigger does this at edit time with
  --    actor attribution; this is the nightly safety net (and the only path
  --    that catches a deal whose boundary moved by a clock change).
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
               <> (coalesce(d.last_contact_at, d.created_at) at time zone 'Asia/Nicosia')::date + 14)
    returning t.org_id, t.id, t.deal_id, d.status
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'task', id, 'superseded',
         jsonb_build_object('kind', 'deal_no_contact', 'deal_id', deal_id,
                            'reason', case when status <> 'open'
                                           then 'deal_closed' else 'deal_contacted' end)
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

revoke execute on function public.create_followup_nudges(uuid) from public, anon, authenticated;
grant execute on function public.create_followup_nudges(uuid) to service_role;

-- ---------- the edit-time trigger, same two changes -------------------------
create or replace function trg_supersede_deal_nudges() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  with superseded as (
    update tasks t
       set is_done = true, done_at = now()
     where t.deal_id = new.id
       and t.kind = 'deal_no_contact'
       and not t.is_done
       and (new.status <> 'open'
            or (t.due_at at time zone 'Asia/Nicosia')::date
               <> (coalesce(new.last_contact_at, new.created_at) at time zone 'Asia/Nicosia')::date + 14)
    returning t.org_id, t.id
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, auth.uid(), 'task', id, 'superseded',
         jsonb_build_object('kind', 'deal_no_contact', 'deal_id', new.id,
                            'reason', case when new.status <> 'open'
                                           then 'deal_closed' else 'deal_contacted' end)
  from superseded;
  return null;
end $$;

revoke execute on function public.trg_supersede_deal_nudges() from public, anon, authenticated;

-- The trigger's WHEN clause has to move with the predicate, and this is the part
-- that is easy to miss: 0020 fired on `last_activity_at or status`, so after the
-- function started reading last_contact_at the trigger would never have fired
-- for the one event that should close a nudge. The function would have been
-- correct and the feature still broken. Caught by RLS test 27's second half.
--
-- Now fires on exactly the two things that can change the outcome. Dropped
-- rather than replaced: CREATE OR REPLACE TRIGGER exists in PG14+, but a DROP
-- makes the column-list change explicit in the diff rather than silent.
drop trigger if exists deals_supersede_nudges on deals;
create trigger deals_supersede_nudges after update on deals
for each row
when (old.last_contact_at is distinct from new.last_contact_at
      or old.status is distinct from new.status)
execute function trg_supersede_deal_nudges();
