-- 0089 — a won deal's live hold gets a prompt, the way its stale listing already does.
--
-- THE PROBLEM. markDealWon does not touch the property's reservation, and
-- nothing else does either. A hold that is still 'held' or 'confirmed' when the
-- sale closes simply runs to its expiry, at which point `expire_reservations()`
-- (0044) writes `release_reason = coalesce(release_reason, 'expired automatically')`
-- and events it as `reservation_expired`. That is a false line in the property's
-- history: the hold did not lapse, the sale completed. The buyer's own hold is
-- recorded as having quietly run out on the property they bought.
--
-- WHY A PROMPT AND NOT AN AUTOMATIC RELEASE. Converting or releasing the hold
-- from markDealWon is the coupling DECLINED on 2026-08-26 (DECISIONS: "`properties.status`
-- is not to be coupled to holds, now or later. Do not build the trigger"), and
-- the reason recorded there applies unchanged: the desk's manual action and an
-- automatic one are both legitimate and neither can know about the other. The
-- same decision set the precedent for exactly this shape — "the Won side got a
-- task that ASKS" (`listing_status_check`, 0076). This is that task for the
-- sibling case, and the THIRTEENTH kind (0076 made eleven, 0078 twelve).
--
-- WHAT IS DELIBERATELY NOT CHANGED. `expire_reservations()` still does not
-- reference `properties` in any way. Teaching the sweep to check whether the
-- property was sold would build the declined coupling inside the one function
-- the 2026-08-26 entry cites as proof of independence. The prompt exists so a
-- person settles the hold before the sweep ever reaches it; if nobody does, the
-- sweep's wording stays as it is and the open task is the record of the ask.
--
-- Additive only: one row in the `task_kinds` reference table. No column, no
-- policy, no function. Safe to apply before the code that writes the kind —
-- an unused kind is inert, whereas code writing an unregistered kind is what
-- 0076's own note describes as failing silently.

insert into public.task_kinds (kind, description, added_in) values
  ('reservation_still_live',
   'A deal was won but the property still carries a live reservation (held/confirmed)',
   '0089')
on conflict (kind) do nothing;

-- ---------------------------------------------------------------------------
-- Prove it, in the migration, the way 0076 and 0088 do.
-- ---------------------------------------------------------------------------
do $$
declare
  n int;
begin
  select count(*) into n from public.task_kinds where kind = 'reservation_still_live';
  if n <> 1 then
    raise exception '0089: the reservation_still_live kind was not registered (found %)', n;
  end if;

  -- The total, the way every kind migration before this one asserts it
  -- (0049 = 7, 0051 = 8, 0053 = 9, 0075 = 10, 0076 = 11, 0078 = 12). A count
  -- that has drifted means a kind arrived or vanished without a migration
  -- saying so, and `supabase/tests/rls.test.ts` test 33 pins the same list by
  -- EQUALITY — the two must be changed together or CI says so.
  select count(*) into n from public.task_kinds;
  if n <> 13 then
    raise exception '0089 aborted: expected 13 task kinds, found %', n;
  end if;

  -- The prompt links the reservation it is about, so the desk can open it from
  -- the task. 0047 added the column; assert it is still there rather than
  -- discovering it at the first insert.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'tasks' and column_name = 'reservation_id'
  ) then
    raise exception '0089: tasks.reservation_id is missing — 0047 is not applied';
  end if;

  -- And the thing this whole migration exists because of: the sweep must still
  -- be independent of properties. If a later change couples them, the reason
  -- for choosing a prompt over a release has gone, and this should be revisited
  -- rather than silently kept.
  if position('properties' in pg_get_functiondef('public.expire_reservations()'::regprocedure)) > 0 then
    raise exception '0089: expire_reservations() now references properties — the 2026-08-26 independence this prompt assumes is gone';
  end if;
end $$;
