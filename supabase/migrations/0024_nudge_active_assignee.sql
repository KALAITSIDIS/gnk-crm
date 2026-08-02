-- 0024: system-generated tasks must never land on a deactivated profile.
--
-- 0012 established that a NULL assignee is invisible — /tasks and the agent
-- dashboard both filter `assignee_id = me` — and answered it with a three-arm
-- fallback: entity agent → creator → the org's oldest ACTIVE admin. Only the
-- third arm ever checked `is_active`, so the guard stopped exactly where the
-- fallback started.
--
-- A deactivated assignee is strictly worse than a NULL one. The task is equally
-- invisible (0014: is_active = false kills RLS access, so the person cannot even
-- sign in to see it), but the row no longer LOOKS unassigned, so no
-- "unassigned/orphan tasks" surface can find it either. It is lost in a way the
-- 0012 bug at least advertised.
--
-- All three system task kinds share the defect, because all three share the
-- fallback shape:
--   deal_no_contact  (0020) — arms `deals.agent_id`, `deals.created_by`
--   viewing_feedback (0020) — arms `viewings.agent_id`, `viewings.created_by`
--   mandate_renewal  (0012, re-stated in 0020) — arms
--                              `properties.assigned_agent_id`, `mandates.created_by`
--
-- Each raw arm becomes "that profile, IF it is active", so a deactivated agent
-- falls through to the creator and then to the active-admin arm that was always
-- correct. The predicate is inlined rather than extracted into a helper
-- function on purpose: a new `security definer` function in `public` is
-- anon-executable by default (0007, and the 0021 regression that followed
-- 0020), and this needs no new grant surface.
--
-- Fixing the fallback is necessary but NOT sufficient, for two reasons:
--   1. Tasks minted before today are already stranded, and the cycle guards
--      ("a nudge exists for THIS boundary") deliberately refuse to mint a
--      replacement — so nothing would ever repair them.
--   2. Deactivation happens AFTER assignment far more often than before it. A
--      user deactivated tomorrow strands every open task they hold, and a
--      one-time backfill cannot see that.
-- So the re-home is stated as an invariant and self-healed nightly, which is
-- 0020's own design rule ("stated invariants, self-healed by cron"), and run
-- once inline at the bottom of this migration so the database is correct now
-- rather than at 03:15.
--
-- NEW INVARIANT
--   an OPEN system-generated task (`kind is not null`) is never assigned to a
--   profile with is_active = false, provided its org has an active admin.
--
-- No DDL: three function bodies and one backfill. `create or replace function`
-- preserves the existing ACL, so 0007's lockdown and 0022's deliberate removal
-- of the `service_role` grant on expire_mandates both survive untouched — this
-- migration adds no GRANT of its own, and must not.

-- ---------- 0020's job, with the fallback guarded ---------------------------
-- Byte-identical to 0020 apart from the two `coalesce` blocks and the new
-- step 5. Every threshold, cycle guard and supersede predicate is unchanged.

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
             (select pr.id from profiles pr where pr.id = s.agent_id and pr.is_active),
             (select pr.id from profiles pr where pr.id = s.created_by and pr.is_active),
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

  -- 5) self-heal the assignee invariant (0024). Deliberately covers EVERY
  --    system kind, mandate_renewal included: this job runs at 03:15, fifteen
  --    minutes after expire_mandates, so one place owns the invariant for all
  --    three rather than each cron re-implementing it.
  --
  --    Re-homed to the active-admin arm rather than re-derived per kind: the
  --    per-kind arms are exactly what went stale (the agent left), and the
  --    admin arm is the one the fallback already treats as the backstop.
  --    Guarded on an active admin EXISTING so a degenerate org is left alone
  --    rather than having its assignee nulled — NULL is invisible too, and
  --    silently making it worse is not a repair.
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

-- ---------- 0012's job, with the same fallback guarded ----------------------
-- Byte-identical to the 0020 re-statement apart from the `coalesce` block.
-- expire_mandates() takes no p_org and holds no service_role grant (0022), so
-- it is unreachable from the RLS suite by design; the shared invariant is
-- covered by step 5 above and by RLS test 26.

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
  --    org's oldest active admin — never NULL, and never a deactivated profile)
  with created as (
    insert into tasks (org_id, title, due_at, assignee_id, property_id, mandate_id, kind)
    select m.org_id,
           'Mandate renewal: ' || p.reference || ' expires ' || to_char(m.expiry_date, 'DD Mon YYYY'),
           (m.expiry_date::timestamp + interval '23 hours 59 minutes') at time zone 'Asia/Nicosia',
           coalesce(
             (select pr.id from profiles pr where pr.id = p.assigned_agent_id and pr.is_active),
             (select pr.id from profiles pr where pr.id = m.created_by and pr.is_active),
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

-- ---------- backfill: repair the rows already stranded ----------------------
-- The same statement step 5 runs nightly, executed once now across every org so
-- the invariant holds from this migration rather than from the next 03:15.

with rehomed as (
  update tasks t
     set assignee_id = (
       select pr.id from profiles pr
        where pr.org_id = t.org_id and pr.role = 'admin' and pr.is_active
        order by pr.created_at limit 1)
   where t.kind is not null
     and not t.is_done
     and exists (
       select 1 from profiles pr where pr.id = t.assignee_id and not pr.is_active)
     and exists (
       select 1 from profiles pr
        where pr.org_id = t.org_id and pr.role = 'admin' and pr.is_active)
  returning t.org_id, t.id, t.assignee_id, t.kind
)
insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
select org_id, null, 'task', id, 'reassigned',
       jsonb_build_object('kind', kind, 'assignee_id', assignee_id,
                          'reason', 'backfill_0024_inactive_assignee')
from rehomed;
