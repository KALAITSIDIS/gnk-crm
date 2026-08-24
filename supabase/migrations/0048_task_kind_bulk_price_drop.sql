-- 0048 — let `tasks.kind` carry the bulk-reprice alert.
--
-- `applyPriceUplift` moves every priced unit in a block at once. The
-- single-property alert (0045) is the wrong shape for it: calling it per unit
-- would issue four queries per unit — 240 for a 60-unit block, on an action a
-- desk runs while watching — and would raise five separate tasks for what is
-- one phone call. The bulk path fetches once, aggregates in memory, and raises
-- ONE task against the PROJECT.
--
-- THE FOURTH WIDENING OF THIS CHECK IN FOUR MIGRATIONS (0045, 0046, 0047, and
-- now this). That is a pattern, not a coincidence: every new system-task rule
-- needs a DDL change purely to add a string. A `task_kinds` lookup table with
-- an FK would give the same protection — and the protection is real, 0045
-- exists because this CHECK rejected a typo'd kind loudly — while making a new
-- rule a data insert. Recorded in BACKLOG rather than done here, because
-- refactoring a working security control is not what this change is for.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

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
      'reservation_expiring'::text,
      -- 0048: a block reprice brought buyers into range across several units
      'bulk_price_drop_match'::text
    ])
  );

do $$
declare
  def text;
  k   text;
  all_kinds text[] := array['mandate_renewal','deal_no_contact','viewing_feedback',
                            'price_drop_match','new_listing_match','reservation_expiring',
                            'bulk_price_drop_match'];
begin
  select pg_get_constraintdef(oid) into def
    from pg_constraint
   where conrelid = 'public.tasks'::regclass and conname = 'tasks_kind_chk';
  if def is null then
    raise exception '0048 aborted: tasks_kind_chk is missing';
  end if;

  -- EVERY kind must survive the rewrite, not just the new one. A rewritten
  -- CHECK is where a live value gets dropped silently, and each of these has a
  -- sweep or an action filtering on it.
  foreach k in array all_kinds
  loop
    if def not like '%' || k || '%' then
      raise exception '0048 aborted: tasks_kind_chk does not admit %', k;
    end if;
  end loop;

  if exists (
    select 1 from tasks t
     where t.kind is not null and t.kind <> all (all_kinds)
  ) then
    raise exception '0048 aborted: existing tasks hold a kind the new CHECK rejects';
  end if;

  raise notice '0048: tasks_kind_chk admits 7 kinds, no orphaned rows';
end $$;
