-- 0046 — let `tasks.kind` carry the new-listing alert.
--
-- The mirror of 0045. `raiseNewListingAlert` writes kind 'new_listing_match'
-- when a property's status ENTERS a matchable state — first publication, a
-- withdrawn listing put back on, or a fallen-through sale returning to
-- `available`.
--
-- The constraint is worth keeping rather than dropping: it is what turned a
-- typo'd `kind` into a loud failure instead of an orphan row no sweep would
-- ever match. 0045 exists because it did exactly that, correctly.
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
      -- 0046: a property came onto the market and matches saved searches
      'new_listing_match'::text
    ])
  );

do $$
declare
  def text;
  -- NOT named `kind`: a PL/pgSQL variable of that name shadows tasks.kind and
  -- makes the EXISTS below ambiguous. The first version did exactly that, the
  -- block aborted, and the constraint went in UNVERIFIED — which is the failure
  -- mode an assertion block exists to prevent, so it is named here.
  k   text;
begin
  select pg_get_constraintdef(oid) into def
    from pg_constraint
   where conrelid = 'public.tasks'::regclass and conname = 'tasks_kind_chk';
  if def is null then
    raise exception '0046 aborted: tasks_kind_chk is missing';
  end if;

  -- EVERY kind that came before must survive the rewrite, not just the new one.
  -- A rewritten CHECK is exactly where a live value gets dropped silently, and
  -- each of these has a sweep or an action filtering on it.
  foreach k in array array['mandate_renewal','deal_no_contact','viewing_feedback',
                           'price_drop_match','new_listing_match']
  loop
    if def not like '%' || k || '%' then
      raise exception '0046 aborted: tasks_kind_chk does not admit %', k;
    end if;
  end loop;

  -- and nothing already written can have been orphaned by the new definition
  if exists (
    select 1 from tasks t
     where t.kind is not null
       and t.kind <> all (array['mandate_renewal','deal_no_contact','viewing_feedback',
                                'price_drop_match','new_listing_match']::text[])
  ) then
    raise exception '0046 aborted: existing tasks hold a kind the new CHECK rejects';
  end if;

  raise notice '0046: tasks_kind_chk admits 5 kinds, no orphaned rows';
end $$;
