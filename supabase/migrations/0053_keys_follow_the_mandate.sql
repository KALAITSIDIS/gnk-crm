-- 0053 — when a mandate ends, chase the keys back.
--
-- Both halves have existed since 0001 and nothing connects them: `property_keys`
-- tracks who physically holds a key, `mandates` tracks whether the agency still
-- represents the property, and a mandate can end with three of the owner's keys
-- in an agent's glovebox without anything anywhere saying so.
--
-- ============================================================================
-- THIS MIGRATION FIXES A LATENT BUG IT WOULD OTHERWISE HAVE TRIPPED OVER, and
-- that is the most important thing in this file.
--
-- `tasks.mandate_id` has only ever carried ONE kind, `mandate_renewal`, and two
-- places quietly assume it always will:
--
--   1. `expire_mandates()` step 3 completes EVERY open task with a matching
--      mandate_id whose mandate is not active. No `kind` filter.
--   2. `supersedeRenewalTasks()` in lib/actions/mandates.ts does the same over
--      PostgREST — `.eq("mandate_id", …).eq("is_done", false)`, no kind.
--
-- A `key_recall` task hangs off the mandate that ended, so it is by definition
-- attached to a NOT-ACTIVE mandate. Both of those would have completed it
-- within seconds of it being raised — the cron on its next run, the action
-- immediately — and the feature would have looked like it was working (the task
-- appears, an event is written) while never leaving anyone anything to do.
--
-- Both are narrowed to `kind = 'mandate_renewal'` here and in the TypeScript,
-- and the assertion block below PROVES the key_recall task survives a full
-- `expire_mandates()` run rather than trusting that it does.
-- ============================================================================
--
-- WHAT COUNTS AS "STILL HELD": `in_office` and `checked_out`.
--   * `checked_out` — an agent personally has it. The sharp end.
--   * `in_office`   — the agency has it, filed, for a property it no longer
--                     represents. Less dramatic, same duty: give it back.
--   * `with_owner`  — already where it belongs. Nothing to chase; this is the
--                     state that CLOSES the task.
--   * `lost`        — nothing to recall. It is already recorded as lost, which
--                     is its own (worse) problem, and raising a "return it"
--                     task for a key nobody can find is noise.
--
-- ONE-SHOT, NOT A BOUNDARY CYCLE, which makes this the odd one out among the
-- sweeps. 0012/0020/0047/0051 all key idempotence to a moving boundary because
-- their condition can recur. A mandate ends ONCE — `expired` and `terminated`
-- are both terminal in MANDATE_TRANSITIONS, with no path back to active — so
-- the key is simply (mandate_id, kind) and there is no second cycle to arm.
--
-- FIRST-RUN BEHAVIOUR, stated because it is the one surprising thing: the
-- predicate is "ended mandate + keys still held + no task yet", not "ended
-- tonight". So the first run also picks up mandates that ended BEFORE this
-- migration and still have keys out. That is deliberate — those keys really are
-- still held, and a list of them is exactly what a desk wants — but on a large
-- database it is a one-time batch rather than a trickle. MEASURED before
-- shipping: on production that count is 0, and locally 0.
--
-- The due date is `current_date + 7`. That is a GRACE PERIOD on a task that has
-- already fired, not a firing threshold, which is why it is not in 0052's
-- `nudge_thresholds` — nothing here decides WHETHER to raise anything, only how
-- long the desk gives itself once it has. An owner can be abroad; a task that
-- goes overdue the same evening it appears is noise, not urgency.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

-- ---------- the kind --------------------------------------------------------

-- 0049's payoff again: a one-line INSERT, which cannot silently drop the eight
-- kinds already there the way a rewritten CHECK can.
insert into public.task_kinds (kind, description, added_in) values
  ('key_recall', 'A mandate ended while the agency still holds keys to the property', '0053')
on conflict (kind) do nothing;

-- ---------- the raiser ------------------------------------------------------

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
           ((current_date + 7)::timestamp + interval '23 hours 59 minutes')
             at time zone 'Asia/Nicosia',
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

-- Locked down at write time (T-C4). The app reaches this through the SERVICE
-- ROLE from an already-admin-gated server action (lib/supabase/admin.ts), not
-- as the signed-in user — granting `authenticated` would let any signed-in user
-- pass any mandate id to a SECURITY DEFINER function that writes tasks.
revoke execute on function public.raise_key_recall_tasks(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.raise_key_recall_tasks(uuid, uuid) to service_role;

-- ---------- expire_mandates: the two kind filters, plus the new call ---------

create or replace function public.expire_mandates()
returns void
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
          -- 0053: `tasks.mandate_id` is no longer single-kind. Without this a
          -- key_recall task dated on the expiry day would block the renewal
          -- reminder for that cycle.
          and t.kind = 'mandate_renewal'
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
       -- 0053: THE BUG THIS MIGRATION EXISTS AROUND. Without this filter, every
       -- key_recall task is completed on the next run — they hang off mandates
       -- that are BY DEFINITION no longer active, so `m.status <> 'active'`
       -- matches every one of them.
       and t.kind = 'mandate_renewal'
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

  -- 4) 0053: chase keys on mandates that have ended. Runs LAST, after the flip
  --    in step 1, so a mandate that expired overnight is already `expired` and
  --    is picked up in the same pass rather than waiting a further night.
  select raise_key_recall_tasks();
$$;

do $$
declare
  n_kinds    int;
  probe_org  uuid;
  probe_prop uuid;
  probe_mand uuid;
  probe_key  uuid;
  raised     int;
  again      int;
  open_after int;
  open_heal  int;
begin
  select count(*) into n_kinds from public.task_kinds;
  if n_kinds <> 9 then
    raise exception '0053 aborted: expected 9 task kinds, found %', n_kinds;
  end if;
  if not exists (select 1 from public.task_kinds where kind = 'key_recall') then
    raise exception '0053 aborted: key_recall was not added';
  end if;

  -- T-C4, asserted rather than trusted
  if has_function_privilege('anon', 'public.raise_key_recall_tasks(uuid, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.raise_key_recall_tasks(uuid, uuid)', 'execute') then
    raise exception '0053 aborted: raise_key_recall_tasks is callable over PostgREST';
  end if;
  if not has_function_privilege('service_role', 'public.raise_key_recall_tasks(uuid, uuid)', 'execute') then
    raise exception '0053 aborted: service_role lost EXECUTE (the app and the RLS suite call it)';
  end if;

  -- create or replace preserves the ACL, but 0021 and T-C4 both exist because
  -- that was assumed once too often
  if has_function_privilege('anon', 'public.expire_mandates()', 'execute') then
    raise exception '0053 aborted: expire_mandates became callable by anon';
  end if;

  -- ---- the probe, in a SUBTRANSACTION that is rolled back ------------------
  -- The raiser writes to `events`, which is APPEND-ONLY AND HASH-CHAINED, so
  -- deleting the probe's rows afterwards would either break
  -- verify_events_chain() or work only by the accident of them being last.
  -- Specific errcode, not `when others`: a genuine failure must still
  -- propagate rather than be reported as a pass.
  select id into probe_org from organizations order by created_at limit 1;
  if probe_org is not null then
    begin
      insert into properties (org_id, reference, kind, property_type, status, title)
      values (probe_org, '0053-PROBE', 'standalone', 'apartment', 'available',
              '{"en":"0053 probe"}')
      returning id into probe_prop;

      insert into mandates (org_id, property_id, status, type, start_date, expiry_date)
      values (probe_org, probe_prop, 'terminated', 'open'::mandate_type,
              current_date - 200, current_date - 10)
      returning id into probe_mand;

      insert into property_keys (org_id, property_id, key_code, status)
      values (probe_org, probe_prop, '0053-K1', 'checked_out')
      returning id into probe_key;

      -- raises exactly one
      select raise_key_recall_tasks(probe_mand) into raised;
      if raised <> 1 then
        raise exception '0053 aborted: expected 1 recall task, got %', raised;
      end if;

      -- idempotent
      select raise_key_recall_tasks(probe_mand) into again;
      if again <> 0 then
        raise exception '0053 aborted: a second call raised % more', again;
      end if;

      -- THE ASSERTION THIS MIGRATION EXISTS FOR: a full expire_mandates() run
      -- must NOT complete the recall task. Before the kind filters above, step
      -- 3 matched it on mandate_id alone and closed it every night.
      perform expire_mandates();
      select count(*) into open_after from tasks
       where mandate_id = probe_mand and kind = 'key_recall' and not is_done;
      if open_after <> 1 then
        raise exception
          '0053 aborted: expire_mandates() closed the key_recall task — the kind filter is not working';
      end if;

      -- self-heal: the key goes to the owner, the task closes
      update property_keys set status = 'with_owner' where id = probe_key;
      perform raise_key_recall_tasks(probe_mand);
      select count(*) into open_heal from tasks
       where mandate_id = probe_mand and kind = 'key_recall' and not is_done;
      if open_heal <> 0 then
        raise exception '0053 aborted: returning the last key did not close the task';
      end if;

      raise exception using errcode = 'GNK53', message = '0053 probe rollback';
    exception when sqlstate 'GNK53' then
      null; -- expected — the rollback IS the point
    end;

    raise notice '0053: kind added (9 total), execute locked down, recall PROVEN to raise once, survive expire_mandates(), and self-heal (probe rolled back)';
  else
    raise notice '0053: kind added (9 total), execute locked down; behaviour probe SKIPPED (no organizations on this database) — RLS test 37 covers it';
  end if;
end $$;
