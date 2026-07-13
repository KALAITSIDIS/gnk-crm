-- T4.5: mandate renewal tasks. expire_mandates() (cron: daily 03:00, see 0001)
-- now also creates ONE renewal task per active mandate entering its reminder
-- window. tasks.mandate_id links task -> mandate and makes the insert
-- idempotent across nightly runs. Doc 03 updated in the same commit.

alter table tasks add column mandate_id uuid references mandates(id);
create index tasks_mandate_idx on tasks(mandate_id) where mandate_id is not null;

create or replace function expire_mandates() returns void
language sql security definer set search_path = public as $$
  -- renewal reminders: active mandates within expiry - renewal_reminder_days,
  -- assigned to the property's agent (fallback: whoever created the mandate)
  with created as (
    insert into tasks (org_id, title, due_at, assignee_id, property_id, mandate_id)
    select m.org_id,
           'Mandate renewal: ' || p.reference || ' expires ' || to_char(m.expiry_date, 'DD Mon YYYY'),
           m.expiry_date::timestamptz,
           coalesce(p.assigned_agent_id, m.created_by),
           m.property_id,
           m.id
    from mandates m
    join properties p on p.id = m.property_id
    where m.status = 'active'
      and m.expiry_date is not null
      and current_date >= m.expiry_date - m.renewal_reminder_days
      and not exists (select 1 from tasks t where t.mandate_id = m.id)
    returning org_id, mandate_id, assignee_id
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'mandate', mandate_id, 'renewal_task_created',
         jsonb_build_object('assignee_id', assignee_id)
  from created;

  -- expiry flip, each with its system event (actor null = system/cron)
  with flipped as (
    update mandates set status = 'expired'
    where status = 'active' and expiry_date is not null and expiry_date < current_date
    returning org_id, id, expiry_date
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'mandate', id, 'status_changed',
         jsonb_build_object('from', 'active', 'to', 'expired', 'expiry_date', expiry_date)
  from flipped;
$$;
