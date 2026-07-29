-- 0020: automated follow-up nudges (IMPROVEMENTS B7). Two cron-driven rules,
-- materialised as real `tasks` rows and modelled on 0012's renewal lifecycle:
--
--   deal_no_contact  — an OPEN deal with no activity for 14 days
--   viewing_feedback — a COMPLETED viewing still missing feedback 48 hours
--                      after it was scheduled
--
-- The roadmap's third rule ("mandate expiring in 30 days") ALREADY EXISTS via
-- expire_mandates() and is not rebuilt here.
--
-- Everything 0012 learned the hard way is carried across:
--   1. Idempotence keyed to a CYCLE, never to "does any task exist" — that
--      second form is the 0006 bug that made reminders one-shot forever. The
--      deal cycle is the staleness BOUNDARY (last activity, Cyprus date, + 14).
--      The viewing rule genuinely has no cycle; see the comment on its guard.
--   2. Cyprus end-of-day due stamps, not midnight UTC, or a task reads
--      "overdue" for the whole of its final day.
--   3. A three-arm assignee fallback (agent → creator → oldest active org
--      admin). A NULL assignee is invisible on every surface: /tasks and the
--      agent dashboard both filter assignee_id = me.
--   4. Stated invariants, self-healed by cron. Tasks that stop matching are
--      COMPLETED ("superseded") with an actor-null system event — never
--      deleted, so history keeps its shape and "Recently done" stays honest.
--
-- INVARIANTS
--   an OPEN deal_no_contact task exists iff its deal is OPEN and its due date
--     equals that deal's current staleness boundary;
--   an OPEN viewing_feedback task exists iff its viewing is COMPLETED and its
--     feedback is still null.
--
-- Thresholds are deliberately hardcoded. 14 days is the health score's own
-- activity cliff (doc 02 §C5: ≤7d full credit, ≤14d half, beyond that zero), so
-- a second, separately-editable copy could disagree with it silently about what
-- "stale" means. Changing either is one `create or replace function`.
--
-- Timezone note: lib/utils/tz.ts owns Cyprus wall-clock logic and 0018 says not
-- to re-derive it in SQL. That rule is about CALLERS — 0018 takes its window
-- bounds as parameters because a caller exists. Cron has no caller, so the EOD
-- expression below is copied verbatim from 0012 rather than reinvented.

-- ---------- schema ----------------------------------------------------------

-- `kind` is the single discriminator for system-generated tasks, and
-- `kind is null` means "a human made this". 0012 had no marker of its own and
-- used `mandate_id is not null` as a proxy, which is already read in two places
-- (the /tasks "auto" badge, the CSV "Auto" column) and would otherwise have to
-- grow an `or kind is not null` in both, forever.
alter table tasks add column if not exists kind text;
alter table tasks add column if not exists viewing_id uuid references viewings(id);

update tasks set kind = 'mandate_renewal' where mandate_id is not null and kind is null;

-- A CHECK, not free text like events.entity_type: this is a closed set the
-- schema owns, and a typo in the cron would otherwise mint tasks that no
-- surface recognises as nudges. Dropped first so the migration re-runs cleanly.
alter table tasks drop constraint if exists tasks_kind_chk;
alter table tasks add constraint tasks_kind_chk
  check (kind is null or kind in ('mandate_renewal','deal_no_contact','viewing_feedback'));

create index if not exists tasks_nudge_deal_idx
  on tasks(deal_id, due_at) where kind = 'deal_no_contact';
create index if not exists tasks_nudge_viewing_idx
  on tasks(viewing_id) where kind = 'viewing_feedback';

-- ---------- the nightly job -------------------------------------------------

-- p_org exists for testability: cron calls this with no arguments (all orgs),
-- while the RLS suite passes its own fixture org, because RLS test 23 pins that
-- the suite never writes into the seeded org the dev app uses.
create or replace function create_followup_nudges(p_org uuid default null) returns void
language sql security definer set search_path = public as $$
  -- 1) no-contact nudges: open deals silent for 14 days, one task per silent
  --    period, due Cyprus end-of-day of the boundary they crossed
  with stale as (
    select d.id, d.org_id, d.title, d.agent_id, d.created_by,
           (d.last_activity_at at time zone 'Asia/Nicosia')::date + 14 as boundary
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
             s.agent_id,
             s.created_by,
             (select pr.id from profiles pr
               where pr.org_id = s.org_id and pr.role = 'admin' and pr.is_active
               order by pr.created_at limit 1)),
           s.id,
           'deal_no_contact'
      from stale s
     where current_date >= s.boundary
       -- keyed to THIS boundary, not to "any nudge for this deal": contact
       -- moves last_activity_at, which moves the boundary, so a later silence
       -- is a new cycle and mints a new task
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
             d.agent_id,
             d.created_by,
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

  -- 3) self-heal the deal invariant. The triggers below do this at edit time
  --    with actor attribution; this is the nightly safety net (and the only
  --    path that catches a deal whose boundary moved by a clock change).
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
               <> (d.last_activity_at at time zone 'Asia/Nicosia')::date + 14)
    returning t.org_id, t.id, t.deal_id
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'task', id, 'superseded',
         jsonb_build_object('kind', 'deal_no_contact', 'deal_id', deal_id,
                            'reason', 'deal_contacted_or_closed')
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
$$;

-- The job walks every open deal in every org, so no app role may call it. The
-- explicit service_role grant is NOT optional: a function's service_role EXECUTE
-- rides on the PUBLIC default grant, so the revoke kills it — exactly the
-- collateral 0010 fixed for 0007 and 0019 fixed for 0016.
revoke execute on function create_followup_nudges(uuid) from public, anon, authenticated;
grant execute on function create_followup_nudges(uuid) to service_role;

-- 03:15, between expire-mandates (03:00) and verify-events-chain (03:30), so
-- the night's nudge events are covered by the same run's chain check (0016).
select cron.unschedule('followup-nudges')
 where exists (select 1 from cron.job where jobname = 'followup-nudges');
select cron.schedule('followup-nudges', '15 3 * * *', $$select create_followup_nudges()$$);

-- ---------- edit-time supersede, with actor attribution ---------------------

-- 0012 supersedes at edit time from the app (saveMandate / setMandateStatus) so
-- the task list is honest immediately rather than the next morning. The app-side
-- equivalent here would be seven call sites plus move_deal_to_stage (0011),
-- which is SQL-side and unreachable from TypeScript — so this is trigger-level,
-- exactly like trg_price_history (0005), which writes its event with
-- actor_id = auth.uid() for the same stated reason (direct DB edits and imports
-- are covered too, not just app saves). profiles.id references auth.users(id),
-- so auth.uid() IS the profile id. Under cron/service_role it is null = system.

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
               <> (new.last_activity_at at time zone 'Asia/Nicosia')::date + 14)
    returning t.org_id, t.id
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, auth.uid(), 'task', id, 'superseded',
         jsonb_build_object('kind', 'deal_no_contact', 'deal_id', new.id,
                            'reason', 'deal_contacted_or_closed')
  from superseded;
  return null;
end $$;

create or replace function trg_supersede_viewing_nudges() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  with superseded as (
    update tasks t
       set is_done = true, done_at = now()
     where t.viewing_id = new.id
       and t.kind = 'viewing_feedback'
       and not t.is_done
       and (new.feedback is not null or new.status <> 'completed')
    returning t.org_id, t.id
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, auth.uid(), 'task', id, 'superseded',
         jsonb_build_object('kind', 'viewing_feedback', 'viewing_id', new.id,
                            'reason', 'feedback_logged_or_viewing_reopened')
  from superseded;
  return null;
end $$;

-- The WHEN clauses keep these off the health-score recompute write, which
-- updates health/health_score and touches neither column.
drop trigger if exists deals_supersede_nudges on deals;
create trigger deals_supersede_nudges after update on deals
for each row
when (old.last_activity_at is distinct from new.last_activity_at
      or old.status is distinct from new.status)
execute function trg_supersede_deal_nudges();

drop trigger if exists viewings_supersede_nudges on viewings;
create trigger viewings_supersede_nudges after update on viewings
for each row
when (old.feedback is distinct from new.feedback
      or old.status is distinct from new.status)
execute function trg_supersede_viewing_nudges();

-- ---------- 0012's function, re-stated to stamp `kind` ----------------------
-- Byte-identical to 0012 apart from the INSERT column list: `kind` is added so
-- that "system-generated task" has ONE meaning across all three nudge types.
-- The idempotence guard and every other predicate are unchanged.

create or replace function expire_mandates() returns void
language sql security definer set search_path = public as $$
  -- 1) expiry flip first (so freshly-expired mandates can't mint a reminder
  --    in the same run), each with its system event (actor null = system/cron)
  with flipped as (
    update mandates set status = 'expired'
    where status = 'active' and expiry_date is not null and expiry_date < current_date
    returning org_id, id, expiry_date
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'mandate', id, 'status_changed',
         jsonb_build_object('from', 'active', 'to', 'expired', 'expiry_date', expiry_date)
  from flipped;

  -- 2) renewal reminders: active mandates within expiry - renewal_reminder_days,
  --    one task per expiry cycle, due Cyprus end-of-day of the expiry date,
  --    assigned to the property's agent (fallbacks: mandate creator, then the
  --    org's oldest active admin — never NULL for an org with an admin)
  with created as (
    insert into tasks (org_id, title, due_at, assignee_id, property_id, mandate_id, kind)
    select m.org_id,
           'Mandate renewal: ' || p.reference || ' expires ' || to_char(m.expiry_date, 'DD Mon YYYY'),
           (m.expiry_date::timestamp + interval '23 hours 59 minutes') at time zone 'Asia/Nicosia',
           coalesce(
             p.assigned_agent_id,
             m.created_by,
             (select pr.id from profiles pr
               where pr.org_id = m.org_id and pr.role = 'admin' and pr.is_active
               order by pr.created_at limit 1)),
           m.property_id,
           m.id,
           'mandate_renewal'
    from mandates m
    join properties p on p.id = m.property_id
    where m.status = 'active'
      and m.expiry_date is not null
      and current_date >= m.expiry_date - m.renewal_reminder_days
      and not exists (
        select 1 from tasks t
        where t.mandate_id = m.id
          and (t.due_at at time zone 'Asia/Nicosia')::date = m.expiry_date)
    returning org_id, mandate_id, assignee_id
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'mandate', mandate_id, 'renewal_task_created',
         jsonb_build_object('assignee_id', assignee_id)
  from created;

  -- 3) self-heal: complete open renewal tasks whose mandate is no longer
  --    active or whose expiry moved (saveMandate does this at edit time with
  --    actor attribution; this is the nightly safety net)
  with superseded as (
    update tasks t
       set is_done = true, done_at = now()
      from mandates m
     where t.mandate_id = m.id
       and not t.is_done
       and (m.status <> 'active'
            or m.expiry_date is null
            or (t.due_at at time zone 'Asia/Nicosia')::date <> m.expiry_date)
    returning t.org_id, t.id, t.mandate_id
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'task', id, 'superseded',
         jsonb_build_object('mandate_id', mandate_id, 'reason', 'mandate_renewed_or_inactive')
  from superseded;
$$;
