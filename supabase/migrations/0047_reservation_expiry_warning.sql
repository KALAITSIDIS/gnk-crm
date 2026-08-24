-- 0047 — warn before a reservation lapses, instead of only after.
--
-- 0044 expires a hold at 03:45 and writes an event. Nobody is told BEFOREHAND,
-- so the first anyone learns of a lapse is that the property is free again —
-- which is exactly the wrong moment, because a hold usually lapses for a
-- fixable reason (the deposit did not arrive, the lawyer needed another week).
--
-- A SQL sweep, unlike the match alerts. Those live in TypeScript because they
-- call `matching.ts`; this one is pure time arithmetic, so it belongs with
-- expire_mandates (0001), create_followup_nudges (0020) and expire_reservations
-- (0044) as a pg_cron job. Ordering matters and is deliberate: expiry runs at
-- 03:45 and this at 03:50, so a hold that lapsed overnight is already `expired`
-- by the time this runs and its stale warning is superseded in the same pass.
--
-- IDEMPOTENCE KEYED TO A CYCLE, not to "does any task exist" — 0006's bug,
-- which 0012 and 0020 both had to fix. The cycle here is the reservation's
-- CURRENT expiry: the task's due date is the Cyprus end-of-day of `expires_at`,
-- so extending a hold moves the boundary, supersedes the old warning and arms a
-- new one. That falls out of the key rather than needing its own branch.
--
-- INVARIANT
--   an OPEN reservation_expiring task exists iff its reservation is LIVE, its
--   expiry is within WARN_DAYS, and its due date equals that reservation's
--   current expiry date.
--
-- THE KEY IGNORES `is_done`, DELIBERATELY, and it is worth stating why because
-- it looks like an oversight. Filtering the existence check to OPEN tasks would
-- re-mint a warning the night after an agent completed one, with the boundary
-- unchanged — 0006's one-shot bug in its other direction, spam instead of
-- silence. The cost is one narrow case: extend a hold and then move it BACK to
-- the exact same date, and no fresh warning is raised, because one for that
-- date already exists. Measured, not assumed — a probe walked create →
-- idempotent → extend-out → re-arm-on-a-new-date → release and every step
-- behaved. Extending to any DIFFERENT date re-arms correctly, which is the
-- case that actually happens.
--
-- Threshold hardcoded at 2 days, like 0020's 14: a second, separately-editable
-- copy could disagree silently about what "about to lapse" means. Changing it
-- is one `create or replace function`.
--
-- Timezone note: 0018's "do not re-derive Cyprus time in SQL" rule is about
-- CALLERS, which pass window bounds as parameters. Cron has no caller, so the
-- end-of-day expression is copied verbatim from 0012/0020 rather than
-- reinvented.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

-- ---------- schema ----------------------------------------------------------

-- Completes the family: tasks already carries deal_id, mandate_id, viewing_id,
-- property_id and contact_id. property_id alone would ALMOST work here, because
-- 0044's partial unique index guarantees one live hold per property — but it
-- would break the moment a property has a second hold in its history, and it
-- would make the supersede join reason about the wrong thing.
alter table public.tasks add column if not exists reservation_id uuid
  references public.reservations(id) on delete cascade;

create index if not exists tasks_reservation_idx
  on public.tasks(reservation_id) where reservation_id is not null;

alter table public.tasks drop constraint if exists tasks_kind_chk;

alter table public.tasks add constraint tasks_kind_chk
  check (
    kind is null
    or kind = any (array[
      'mandate_renewal'::text,
      'deal_no_contact'::text,
      'viewing_feedback'::text,
      'price_drop_match'::text,
      'new_listing_match'::text,
      -- 0047: a live hold lapses within 2 days
      'reservation_expiring'::text
    ])
  );

-- ---------- the sweep -------------------------------------------------------

create or replace function public.warn_expiring_reservations(p_org uuid default null)
returns void
language sql security definer set search_path = public as $$
  -- 1) mint a warning for every live hold lapsing within 2 days
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
       and r.expires_at <= now() + interval '2 days'
       and (p_org is null or r.org_id = p_org)
  ),
  created as (
    insert into tasks (org_id, title, due_at, assignee_id, property_id,
                       contact_id, reservation_id, kind)
    select d.org_id,
           'Reservation on ' || d.reference || ' lapses ' || to_char(d.expiry_date, 'DD Mon'),
           (d.expiry_date::timestamp + interval '23 hours 59 minutes') at time zone 'Asia/Nicosia',
           -- three-arm fallback, per 0012/0020: a NULL assignee is invisible on
           -- every surface, because /tasks and the agent dashboard both filter
           -- on assignee_id = me.
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
          -- keyed to THIS expiry, not to "any warning for this hold": extending
          -- the hold moves the boundary, which is a new cycle
          and (t.due_at at time zone 'Asia/Nicosia')::date = d.expiry_date
     )
    returning org_id, id, reservation_id, property_id, assignee_id
  ),
  logged as (
    insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
    select org_id, null, 'property', property_id, 'reservation_expiring_soon',
           jsonb_build_object('task_id', id, 'reservation_id', reservation_id,
                              'assignee_id', assignee_id, 'days', 2)
      from created
    returning 1
  ),
  -- 2) self-heal: a warning whose condition stopped holding is COMPLETED, never
  --    deleted, so history keeps its shape and "Recently done" stays honest.
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

-- 03:50, after expire-reservations at 03:45 — a hold that lapsed overnight is
-- already `expired` by then, so its stale warning is superseded in this pass
-- rather than surviving until tomorrow.
select cron.schedule('warn-expiring-reservations', '50 3 * * *',
                     $$select warn_expiring_reservations()$$);

-- LOCK DOWN EXECUTE. A newly created function carries a PUBLIC `=X` grant, so
-- without this it is callable over PostgREST by `anon`. T-C4 shipped exactly
-- that hole on `expire_reservations` and the security advisor caught it; this
-- migration does not repeat it. `public` must be named explicitly because
-- naming roles cannot remove a PUBLIC grant, and doing so also strips
-- service_role's implicit grant (0010's lesson), hence the re-grant — the RLS
-- suite calls this function.
revoke execute on function public.warn_expiring_reservations(uuid) from public, anon, authenticated;
grant  execute on function public.warn_expiring_reservations(uuid) to service_role;

do $$
declare
  def text;
  k   text;
begin
  select pg_get_constraintdef(oid) into def
    from pg_constraint
   where conrelid = 'public.tasks'::regclass and conname = 'tasks_kind_chk';
  if def is null then
    raise exception '0047 aborted: tasks_kind_chk is missing';
  end if;

  -- EVERY kind must survive the rewrite, not just the new one. A rewritten
  -- CHECK is where a live value gets dropped silently.
  foreach k in array array['mandate_renewal','deal_no_contact','viewing_feedback',
                           'price_drop_match','new_listing_match','reservation_expiring']
  loop
    if def not like '%' || k || '%' then
      raise exception '0047 aborted: tasks_kind_chk does not admit %', k;
    end if;
  end loop;

  if exists (
    select 1 from tasks t
     where t.kind is not null
       and t.kind <> all (array['mandate_renewal','deal_no_contact','viewing_feedback',
                                'price_drop_match','new_listing_match',
                                'reservation_expiring']::text[])
  ) then
    raise exception '0047 aborted: existing tasks hold a kind the new CHECK rejects';
  end if;

  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='tasks'
                    and column_name='reservation_id') then
    raise exception '0047 aborted: tasks.reservation_id is missing';
  end if;

  if not exists (select 1 from cron.job where jobname = 'warn-expiring-reservations') then
    raise exception '0047 aborted: warn-expiring-reservations was not scheduled';
  end if;

  -- The T-C4 check, asserted rather than trusted: a revoke that silently no-ops
  -- is a failure this repo has hit before (st_estimatedextent).
  if has_function_privilege('anon', 'public.warn_expiring_reservations(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.warn_expiring_reservations(uuid)', 'execute') then
    raise exception '0047 aborted: warn_expiring_reservations is callable over PostgREST';
  end if;
  if not has_function_privilege('service_role', 'public.warn_expiring_reservations(uuid)', 'execute') then
    raise exception '0047 aborted: service_role lost EXECUTE (the RLS suite calls it)';
  end if;

  raise notice '0047: warning sweep scheduled, 6 kinds admitted, execute locked down';
end $$;
