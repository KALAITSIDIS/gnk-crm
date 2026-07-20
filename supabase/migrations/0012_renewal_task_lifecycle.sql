-- 0012: renewal task lifecycle (tasks audit 2026-07-20). Three defects in the
-- T4.5 renewal pipeline, all in expire_mandates():
--
--   1. ONE-SHOT reminders. The idempotence guard was `not exists (ANY task for
--      the mandate)` — completed tasks count too, and renewing a mandate is an
--      in-place expiry_date update (saveMandate), so after the first reminder
--      no later expiry cycle could ever create another. The guard is now keyed
--      per expiry CYCLE: a reminder exists for THIS expiry iff a task's due
--      date falls on it (Cyprus calendar date — robust across the due-time
--      format change in #2).
--   2. Midnight-UTC due dates. due_at was `expiry_date::timestamptz` (00:00
--      UTC), so renewal tasks read "overdue" for the whole of their final day,
--      while quick-added tasks store Cyprus 23:59 end-of-day (DECISIONS T5.5).
--      Renewal tasks now store the same EOD stamp.
--   3. Orphan tasks. assignee = coalesce(property agent, mandate creator), but
--      imported mandates carry no created_by and imported/admin-created
--      properties no assigned_agent_id → NULL assignee, which no surface shows
--      (/tasks and the agent dashboard both filter assignee_id = me). Third
--      fallback = the org's oldest active admin.
--
-- New invariant, enforced nightly and at edit time (mandates.ts, same commit):
-- an OPEN renewal task exists iff its mandate is ACTIVE with a MATCHING expiry.
-- Tasks that stop matching are completed ("superseded") with a system event —
-- never deleted, so history keeps its shape. Backfills below repair rows
-- created under the old rules. Doc 03 updated in the same commit.

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
    insert into tasks (org_id, title, due_at, assignee_id, property_id, mandate_id)
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
           m.id
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

-- ---------- backfills (one-time repairs of rows created under the old rules) --

-- a) supersede stale open renewal tasks (mandate renewed since, cleared its
--    expiry, or left active) — rows from before the app-side supersede existed
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
       jsonb_build_object('mandate_id', mandate_id, 'reason', 'backfill_0012_stale')
from superseded;

-- b) surviving open renewal tasks still stamped midnight-UTC → Cyprus EOD of
--    the same calendar day (fixes the all-day-overdue display; date unchanged)
update tasks
   set due_at = ((due_at at time zone 'UTC')::date::timestamp + interval '23 hours 59 minutes') at time zone 'Asia/Nicosia'
 where mandate_id is not null
   and not is_done
   and due_at = ((due_at at time zone 'UTC')::date::timestamp at time zone 'UTC');

-- c) orphan (NULL-assignee) open renewal tasks → the org's oldest active admin
with reassigned as (
  update tasks t
     set assignee_id = (
       select pr.id from profiles pr
        where pr.org_id = t.org_id and pr.role = 'admin' and pr.is_active
        order by pr.created_at limit 1)
   where t.mandate_id is not null
     and t.assignee_id is null
     and not t.is_done
  returning t.org_id, t.id, t.assignee_id, t.mandate_id
)
insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
select org_id, null, 'task', id, 'reassigned',
       jsonb_build_object('mandate_id', mandate_id, 'assignee_id', assignee_id,
                          'reason', 'backfill_0012_orphan')
from reassigned
where assignee_id is not null;
