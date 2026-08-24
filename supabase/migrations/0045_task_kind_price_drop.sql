-- 0045 — let `tasks.kind` carry the price-drop alert.
--
-- `tasks_kind_chk` (0020) allows exactly three values: mandate_renewal,
-- deal_no_contact, viewing_feedback. The price-drop alert needs a fourth.
--
-- THIS MIGRATION EXISTS BECAUSE A CLAIM WAS WRONG. The feature was written on
-- the belief that it needed no migration — `tasks` already had `kind`,
-- `property_id` and `assignee_id`, so the row looked writable. It was not: the
-- CHECK rejected the insert, the service discarded the returned error, and the
-- whole feature silently did nothing on a save that otherwise succeeded. Found
-- end to end, not by a test, and the error-swallowing was fixed in the same
-- change.
--
-- The constraint is worth keeping rather than dropping. It is what turned a
-- typo'd `kind` into a loud failure instead of an orphan row that no sweep
-- would ever match — every consumer of `kind` filters on an exact string.
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
      -- 0045: a price drop brought a property inside somebody's budget
      'price_drop_match'::text
    ])
  );

do $$
declare
  def text;
begin
  select pg_get_constraintdef(oid) into def
    from pg_constraint
   where conrelid = 'public.tasks'::regclass and conname = 'tasks_kind_chk';

  if def is null then
    raise exception '0045 aborted: tasks_kind_chk is missing';
  end if;

  -- The new value must be admitted...
  if def not like '%price_drop_match%' then
    raise exception '0045 aborted: tasks_kind_chk does not admit price_drop_match';
  end if;

  -- ...and the three that existed before must NOT have been dropped on the way.
  -- A rewritten CHECK is exactly where an existing value gets lost silently,
  -- and every one of these has a live sweep filtering on it.
  if def not like '%mandate_renewal%'
     or def not like '%deal_no_contact%'
     or def not like '%viewing_feedback%' then
    raise exception '0045 aborted: tasks_kind_chk lost a kind that 0012/0020 depend on';
  end if;
end $$;
