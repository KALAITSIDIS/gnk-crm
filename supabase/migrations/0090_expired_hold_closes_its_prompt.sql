-- 0090 — the sweep that expires a hold also closes the prompt about it.
--
-- THE DEFECT 0089 SHIPPED. `reservation_still_live` asks the desk to settle a
-- hold still live on a property whose deal was won. `completeLiveHoldChecks`
-- closes it when a PERSON settles the hold through `transitionReservation` —
-- but the other way a hold leaves the live set is `expire_reservations()` at
-- 03:45, which is SQL and knows nothing about the prompt. So:
--
--   1. the task sat open and red forever, asking for an action an expired hold
--      no longer has a transition for, with no remedy but ticking it off by
--      hand — which is precisely "a prompt that survives being obeyed teaches
--      the desk to ignore prompts", the failure the kind was written to avoid;
--   2. worse, `raiseLiveHoldCheck`'s duplicate guard refuses to raise while any
--      open prompt of that kind exists on the property, so one stale row
--      permanently suppressed EVERY future live-hold prompt on that property.
--
-- (2) is the reason this is a migration and not a backlog note: the guard is
-- correct, and the only way it stops being a trap is if the sweep closes what
-- it invalidates.
--
-- WHY HERE AND NOT IN warn_expiring_reservations. That function already carries
-- the sibling self-heal for `reservation_expiring` (0047) and runs at 03:50, so
-- the leg could have gone there — five minutes later, and correct only for as
-- long as the two cron entries keep that order. Closing it inside the statement
-- that causes the staleness needs no ordering assumption and leaves no window.
--
-- 0089's own assertion still holds: this adds no reference to `properties`. The
-- 2026-08-26 independence of holds from listing status is untouched — the leg
-- reads `tasks` and the rows this very statement just expired, nothing else.
--
-- The supersede is EVENTED with a null actor, like every other sweep arm, and
-- the reason names what actually happened: the hold lapsed before anyone
-- settled it. That distinction is what makes the ignored case countable later,
-- rather than reading as though the ask was answered.

create or replace function public.expire_reservations() returns void
language sql security definer set search_path = public as $$
  with expired as (
    update reservations
       set status = 'expired',
           released_at = now(),
           release_reason = coalesce(release_reason, 'expired automatically'),
           updated_at = now()
     where status in ('held', 'confirmed')
       and expires_at < now()
    returning id, org_id, property_id, contact_id, expires_at
  ),
  -- unchanged: the expiry's own event, exactly as 0044 wrote it
  expiry_events as (
    insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
    select org_id, null, 'property', property_id, 'reservation_expired',
           jsonb_build_object('reservation_id', id,
                              'contact_id', contact_id,
                              'expired_at', expires_at)
      from expired
    returning 1
  ),
  -- 0090: the prompt about a hold that has now lapsed is COMPLETED, never
  -- deleted, so history keeps its shape (0047's idiom).
  superseded as (
    update tasks t
       set is_done = true, done_at = now()
      from expired e
     where t.reservation_id = e.id
       and t.kind = 'reservation_still_live'
       and not t.is_done
    returning t.org_id, t.id, t.reservation_id
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'task', id, 'superseded',
         jsonb_build_object(
           'kind', 'reservation_still_live',
           'reservation_id', reservation_id,
           'reason', 'the hold lapsed before anyone settled it')
    from superseded;
$$;

comment on function public.expire_reservations() is
  'Nightly: expires holds past their date, events each expiry on the property, '
  'and completes any reservation_still_live prompt about a hold it just '
  'expired (0090 — otherwise the prompt outlives its ask AND its duplicate '
  'guard suppresses every later one on that property). Idempotent by '
  'construction: the update selects only live rows, so a second run in a night '
  'matches nothing.';

-- ---------------------------------------------------------------------------
-- Prove it.
-- ---------------------------------------------------------------------------
do $$
declare
  n int;
  src text;
begin
  src := pg_get_functiondef('public.expire_reservations()'::regprocedure);

  -- the new leg is present
  if position('reservation_still_live' in src) = 0 then
    raise exception '0090: the supersede leg is missing from expire_reservations()';
  end if;

  -- and the old behaviour survived the rewrite
  if position('reservation_expired' in src) = 0
     or position('expired automatically' in src) = 0 then
    raise exception '0090: the rewrite lost the expiry event or its release_reason';
  end if;

  -- 0089's independence assertion still holds — this function must never learn
  -- about properties.status (the coupling DECLINED 2026-08-26)
  if src ~* '\mproperties\M' then
    raise exception '0090: expire_reservations() now references properties — the declined coupling';
  end if;

  -- the kind it closes must actually exist, or the leg is dead code
  select count(*) into n from public.task_kinds where kind = 'reservation_still_live';
  if n <> 1 then
    raise exception '0090: reservation_still_live is not registered — 0089 is not applied';
  end if;
end $$;
