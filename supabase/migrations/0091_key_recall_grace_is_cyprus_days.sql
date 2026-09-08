-- 0091 — the key-recall grace period is seven CYPRUS days, not seven UTC ones.
--
-- 0053 builds the due date as
--     ((current_date + 7)::timestamp + interval '23 hours 59 minutes')
--       at time zone 'Asia/Nicosia'
-- which converts the wall clock correctly but anchors on `current_date`. The
-- database session runs in UTC, so `current_date` is the UTC day, and Cyprus is
-- UTC+2/+3 — between local midnight and 02:00/03:00 the UTC day is still
-- YESTERDAY and the task is stamped six days and a bit of grace instead of seven.
--
-- WHY THIS ONE AND NOT THE OTHER `current_date` SITES. Every other one (0006,
-- 0012, 0020, 0024, 0025, 0052, 0075, 0078) lives in a function only cron calls,
-- scheduled 03:00–03:55 UTC = 05:xx/06:xx Cyprus, where the two calendars always
-- agree. `raise_key_recall_tasks` is the exception: lib/actions/mandates.ts
-- invokes it over RPC the moment a person expires or terminates a mandate, so it
-- runs at whatever time that person happens to be working — including the small
-- hours this migration is about. Same defect the TypeScript raisers had
-- (cyprusEndOfToday, 2026-09-07); this is its last home.
--
-- 0053's own header calls the seven days a deliberate grace period — "an owner
-- can be abroad; a task that goes overdue the same evening it appears is noise,
-- not urgency" — so a day short is a day of the thing the number exists to buy.
--
-- The rest of the function is 0053's byte for byte: same candidates CTE, same
-- three-arm assignee fallback, same (mandate_id, kind) idempotence key, same
-- keys-returned self-heal. Only the due-date anchor moves.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

create or replace function public.raise_key_recall_tasks(
  p_mandate uuid default null,
  p_actor   uuid default null
)
returns int
language sql security definer set search_path = public as $$
  with candidates as (
    select m.id as mandate_id, m.org_id, m.property_id, m.created_by, m.status,
           p.reference, p.assigned_agent_id,
           (select count(*) from property_keys k
             where k.property_id = m.property_id
               and k.status in ('in_office', 'checked_out')) as held
      from mandates m
      join properties p on p.id = m.property_id
     -- both terminal, and there is no transition back to active, which is why
     -- (mandate_id, kind) is a sufficient key
     where m.status in ('expired', 'terminated')
       and (p_mandate is null or m.id = p_mandate)
  ),
  created as (
    insert into tasks (org_id, title, due_at, assignee_id, property_id, mandate_id, kind)
    select c.org_id,
           'Return keys: ' || c.reference || ' — ' || c.held
             || case when c.held = 1 then ' key' else ' keys' end
             || ' still held (mandate ' || c.status || ')',
           -- grace, not urgency theatre: see the header
           -- 0091: anchored on the CYPRUS day, not current_date
           ((((now() at time zone 'Asia/Nicosia')::date + 7)::timestamp
             + interval '23 hours 59 minutes')
             at time zone 'Asia/Nicosia'),
           -- three-arm fallback, per 0012/0020/0047/0051: a NULL assignee is
           -- invisible on every surface, because /tasks and the agent dashboard
           -- both filter on assignee_id = me.
           coalesce(
             (select pr.id from profiles pr
               where pr.id = c.assigned_agent_id and pr.is_active),
             (select pr.id from profiles pr
               where pr.id = c.created_by and pr.is_active),
             (select pr.id from profiles pr
               where pr.org_id = c.org_id and pr.role = 'admin' and pr.is_active
               order by pr.created_at limit 1)),
           c.property_id,
           c.mandate_id,
           'key_recall'
      from candidates c
     where c.held > 0
       and not exists (
         select 1 from tasks t
          where t.mandate_id = c.mandate_id
            and t.kind = 'key_recall')
    returning org_id, id, mandate_id, property_id, assignee_id
  ),
  logged as (
    insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
    select c.org_id, p_actor, 'mandate', c.mandate_id, 'key_recall_task_created',
           jsonb_build_object('task_id', c.id,
                              'assignee_id', c.assignee_id,
                              'property_id', c.property_id,
                              'keys', d.held)
      from created c join candidates d on d.mandate_id = c.mandate_id
    returning 1
  ),
  -- self-heal: once nothing is held any more the task is COMPLETED, never
  -- deleted, so history keeps its shape. Handing the last key to the owner is
  -- the ordinary way this closes; marking it lost also closes it, because there
  -- is then nothing left to recall — the loss is its own record.
  superseded as (
    update tasks t
       set is_done = true, done_at = now()
      from mandates m
     where t.mandate_id = m.id
       and t.kind = 'key_recall'
       and not t.is_done
       and (p_mandate is null or m.id = p_mandate)
       and not exists (
         select 1 from property_keys k
          where k.property_id = m.property_id
            and k.status in ('in_office', 'checked_out'))
    returning t.org_id, t.id, t.mandate_id
  ),
  healed as (
    insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
    select org_id, p_actor, 'task', id, 'superseded',
           jsonb_build_object('kind', 'key_recall', 'mandate_id', mandate_id,
                              'reason', 'keys_returned')
      from superseded
    returning 1
  )
  select count(*)::int from created;
$$;

comment on function public.raise_key_recall_tasks(uuid, uuid) is
  'Raises key_recall tasks for ended mandates whose keys are still held, and '
  'completes the task once nothing is held. Due date is seven CYPRUS days out '
  '(0091 — current_date is the UTC day, and this function is called '
  'synchronously from a user action, so the two can disagree).';

-- ---------------------------------------------------------------------------
-- Prove it.
-- ---------------------------------------------------------------------------
do $$
declare
  src text;
  cy_due date;
  utc_due date;
begin
  src := pg_get_functiondef('public.raise_key_recall_tasks(uuid, uuid)'::regprocedure);

  -- the anchor moved
  if position('current_date + 7' in src) > 0 then
    raise exception '0091: raise_key_recall_tasks still anchors the due date on current_date';
  end if;
  if position('now() at time zone ''Asia/Nicosia'')::date + 7' in src) = 0 then
    raise exception '0091: the Cyprus-anchored due date is missing';
  end if;

  -- and nothing else did: the parts 0053 argued for must all still be there
  if position('key_recall' in src) = 0
     or position('keys_returned' in src) = 0
     or position('23 hours 59 minutes' in src) = 0
     or position('in_office' in src) = 0 then
    raise exception '0091: the rewrite lost part of 0053 (kind, self-heal, end-of-day, or the held-key test)';
  end if;

  -- the two calendars really do differ in the window this is about: at 00:30
  -- Cyprus the UTC day is still yesterday, so the old expression is a day short
  select ((timestamptz '2026-07-15 21:30:00+00' at time zone 'Asia/Nicosia')::date + 7)
    into cy_due;
  select ((timestamptz '2026-07-15 21:30:00+00' at time zone 'UTC')::date + 7)
    into utc_due;
  if cy_due <= utc_due then
    raise exception '0091: the premise does not hold — Cyprus due % is not after UTC due %',
      cy_due, utc_due;
  end if;
end $$;
