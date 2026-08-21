-- 0036 — a mandate can be renewed, and only one can be active at a time.
--
-- BACKLOG audit findings 6 and 7, which are the same problem seen from two
-- sides: nothing in the schema knows that one mandate replaces another, so
-- nothing stops two from being live at once.
--
-- FINDING 6 — `renewed_from_id`. MANDATE_TRANSITIONS is a dead end at `expired`
-- and `terminated`, so renewing meant a blank dialog and retyping the owner,
-- type, commission, reminder and notes, and the new row carried no link to the
-- one it replaced. For a business whose commission evidence is a hash chain, an
-- unlinked mandate history is a real loss: "were we on an exclusive in March"
-- becomes an exercise in reading dates and guessing.
--
-- FINDING 7 — one active mandate per property, as a UNIQUE INDEX rather than a
-- convention. `saveMandate` inserted with no pre-check and every reader takes
-- the first active row it finds, so two exclusives with different commission
-- rates could coexist and the UI would show one of them arbitrarily. This is
-- the number the business gets paid on; it deserves a database guarantee.
--
-- The index is PARTIAL — `where status = 'active'` — so the history is
-- unaffected. A property may carry any number of draft, expired or terminated
-- mandates, which is exactly what a renewal chain looks like.
--
-- ORDER MATTERS HERE. The check runs BEFORE the index is created, so a
-- pre-existing violation produces a sentence naming the property rather than a
-- bare 23505 from the index build.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

do $$
declare
  conflicted int;
  example text;
begin
  select count(*) into conflicted
    from (
      select property_id from public.mandates
       where status = 'active'
       group by property_id having count(*) > 1
    ) dupes;

  if conflicted <> 0 then
    select p.reference into example
      from public.mandates m
      join public.properties p on p.id = m.property_id
     where m.status = 'active'
     group by p.reference having count(*) > 1
     limit 1;
    raise exception
      '0036 aborted: % property(ies) already have more than one ACTIVE mandate (e.g. %). Terminate the duplicates first — this migration will not choose which one is real.',
      conflicted, example;
  end if;
end $$;

alter table public.mandates
  add column if not exists renewed_from_id uuid references public.mandates(id);

comment on column public.mandates.renewed_from_id is
  'The mandate this one replaces. Set by the Renew action, which copies the '
  'terms forward and shifts the dates by the same duration. See 0036.';

-- A renewal chain is walked backwards from the newest mandate, so the index is
-- on the pointer rather than the target.
create index if not exists mandates_renewed_from_idx
  on public.mandates(renewed_from_id)
  where renewed_from_id is not null;

-- `mandates_safe` lists its columns explicitly (0002), so a new column on the
-- base table is invisible through it — and every read path in the app goes
-- through the view, because listing managers have no base-table access and
-- commission is masked there. Appended LAST, which is the only position
-- `create or replace view` accepts for a new column.
--
-- The masking and the row rules below are copied verbatim from 0002. Nothing
-- about who sees what changes here; only `renewed_from_id` is added. The view
-- carries no reloptions (checked before replacing), so replacing it does not
-- alter its SECURITY DEFINER posture, and `create or replace` keeps its grants.
create or replace view public.mandates_safe as
  select id, org_id, property_id, owner_contact_id, type, status,
         start_date, expiry_date, renewal_reminder_days, notes,
         signed_document_id, created_by, created_at, updated_at,
         case when current_role_gnk() = 'admin'
                or exists (select 1 from properties p
                           where p.id = mandates.property_id
                             and p.assigned_agent_id = auth.uid())
              then commission_pct end as commission_pct,
         case when current_role_gnk() = 'admin'
                or exists (select 1 from properties p
                           where p.id = mandates.property_id
                             and p.assigned_agent_id = auth.uid())
              then commission_notes end as commission_notes,
         renewed_from_id
  from mandates
  where org_id = current_org_id()
    and (current_role_gnk() in ('admin','listing_manager')
         or (current_role_gnk() = 'agent'
             and (created_by = auth.uid()
                  or exists (select 1 from properties p
                             where p.id = mandates.property_id
                               and p.assigned_agent_id = auth.uid()))));

-- One live mandate per property. Partial, so history is untouched.
create unique index if not exists mandates_one_active_per_property
  on public.mandates(property_id)
  where status = 'active';

do $$
declare
  idx int;
begin
  select count(*) into idx
    from pg_indexes
   where schemaname = 'public'
     and indexname in ('mandates_one_active_per_property', 'mandates_renewed_from_idx');
  if idx <> 2 then
    raise exception '0036 aborted: expected 2 new indexes, found %', idx;
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'mandates'
       and column_name = 'renewed_from_id'
  ) then
    raise exception '0036 aborted: renewed_from_id was not added';
  end if;

  -- the app reads mandates ONLY through the view, so a column the view does not
  -- expose does not exist as far as any screen is concerned
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'mandates_safe'
       and column_name = 'renewed_from_id'
  ) then
    raise exception '0036 aborted: mandates_safe does not expose renewed_from_id';
  end if;

  -- replacing a view can silently drop its grants; listing managers read
  -- through it and would lose mandates entirely
  if not has_table_privilege('authenticated', 'public.mandates_safe', 'select') then
    raise exception '0036 aborted: authenticated lost SELECT on mandates_safe';
  end if;

  raise notice '0036 ok: renewal link added, one-active-mandate-per-property enforced';
end $$;
