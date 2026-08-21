-- 0034 — give every property that has a mandate the owner that mandate names.
--
-- BACKLOG audit finding 2. `properties.owner_contact_id` has existed since 0001
-- and only the CSV importer ever wrote it, so the app's only notion of an owner
-- lived on `mandates.owner_contact_id`. The Parties panel now writes the
-- property column directly; this migration makes the rows that pre-date it
-- agree, so "who owns this" has ONE answer rather than two half-answers.
--
-- Direction matters: mandate -> property, never the reverse. The mandate is the
-- signed instrument and the stronger claim; the property column is a
-- denormalised convenience for search and display.
--
-- ONLY ACTIVE MANDATES, and only where the property has no owner yet. An
-- expired or terminated mandate names who the owner WAS, which is not a fact
-- worth copying forward, and a hand-set owner beats an inferred one.
--
-- DISTINCT ON picks the newest active mandate per property. Nothing currently
-- stops two active mandates on one property (audit finding 7 — a partial unique
-- index is the fix and is not this migration's job), so the choice has to be
-- deterministic rather than left to the planner.
--
-- EVENTS ARE WRITTEN, one per property changed, with actor_id NULL = system.
-- The guardrail in CLAUDE.md is that every property update writes an event, and
-- a migration is not an exemption: without this, an owner would appear on a
-- record with nothing in its timeline explaining where it came from.
--
-- NO EXPLICIT begin/commit. The Supabase CLI wraps each migration file in one
-- transaction; opening another here would nest, and the `commit` would end the
-- CLI's transaction early — leaving the ledger insert outside it (HANDOFF §3).
-- One data-modifying CTE gives the same atomicity without the nesting.

with picked as (
  select distinct on (m.property_id)
         m.property_id,
         m.owner_contact_id,
         m.id as mandate_id
    from public.mandates m
    join public.properties p on p.id = m.property_id
   where m.status = 'active'
     and m.owner_contact_id is not null
     and p.owner_contact_id is null
   order by m.property_id, m.created_at desc, m.id desc
),
updated as (
  update public.properties p
     set owner_contact_id = k.owner_contact_id
    from picked k
   where p.id = k.property_id
  returning p.id, p.org_id, p.reference, p.owner_contact_id
)
insert into public.events (org_id, actor_id, entity_type, entity_id, event_type, payload)
select u.org_id,
       null,
       'property',
       u.id,
       'updated',
       jsonb_build_object(
         'section', 'parties',
         'source',  'migration_0034_backfill',
         'changed', jsonb_build_object(
           'owner_contact_id', jsonb_build_object('from', null, 'to', u.owner_contact_id)
         ),
         'from_mandate', k.mandate_id,
         'reference',    u.reference
       )
  from updated u
  join picked k on k.property_id = u.id;

do $$
declare
  leftover  int;
  disagrees int;
begin
  -- Every property with an active, owner-bearing mandate must now name an owner.
  select count(*) into leftover
    from public.properties p
   where p.owner_contact_id is null
     and exists (
       select 1 from public.mandates m
        where m.property_id = p.id
          and m.status = 'active'
          and m.owner_contact_id is not null
     );
  if leftover <> 0 then
    raise exception '0034 aborted: % property(ies) still have no owner despite an active mandate', leftover;
  end if;

  -- A property whose owner disagrees with its own active mandate is not an
  -- error — a hand-set owner deliberately wins — but it is worth saying out
  -- loud, because the other explanation is a backfill copied the wrong way.
  select count(*) into disagrees
    from public.properties p
    join public.mandates m on m.property_id = p.id
   where m.status = 'active'
     and m.owner_contact_id is not null
     and p.owner_contact_id is not null
     and p.owner_contact_id <> m.owner_contact_id;
  if disagrees <> 0 then
    raise notice '0034: % property(ies) name a different owner than their active mandate — left alone, a hand-set owner wins', disagrees;
  end if;

  raise notice '0034 ok: owners backfilled from active mandates, events written';
end $$;
