-- 0030 — evaluate the RLS helpers once per statement, not once per row.
--
-- current_org_id() and current_role_gnk() are `stable security definer` SQL
-- functions. `security definer` blocks inlining, so every reference is a real
-- call, and a bare call in a policy predicate is evaluated PER ROW.
--
-- COUNTED 2026-08-11, not inferred: a probe table with a stable security definer
-- function of the same shape, raising a NOTICE per call, was scanned 20 rows.
--   org_id = probe_fn()           -> 21 calls
--   org_id = (select probe_fn())  ->  1 call
-- Plan shape does NOT settle this on its own: the same function appears as an
-- `Index Cond` (once, as a scan key) in some plans and a `Filter` in others.
--
-- SCOPE: the 7 paginated list tables only — the screens that render hundreds of
-- rows, where a per-row call multiplies. 62 other permissive policies stay bare
-- deliberately (36 on config/staff-bounded tables, 26 on tables read a few rows
-- at a time). The 29 require_aal2 policies already wrap their predicate (0029).
--
-- NOTHING HERE CHANGES WHAT A POLICY MEANS. It is an evaluation-strategy change.
-- If behaviour changes, this migration has a bug — which is what the check at the
-- bottom exists to catch.
--
-- These statements were GENERATED from pg_policies, not hand-transcribed, so
-- they cannot differ from what was deployed by a typo.

create temp table _before as
  select tablename, policyname, qual, with_check
    from pg_policies
   where schemaname = 'public' and permissive = 'PERMISSIVE'
     and tablename in ('contacts','deals','events','leads','properties','tasks','viewings');

drop policy contacts_insert on public.contacts;
create policy contacts_insert on public.contacts
  for insert to public
  with check (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = ANY (ARRAY['admin'::user_role, 'agent'::user_role, 'listing_manager'::user_role]))));

drop policy contacts_select on public.contacts;
create policy contacts_select on public.contacts
  for select to public
  using ((org_id = (select current_org_id())));

drop policy contacts_update_admin on public.contacts;
create policy contacts_update_admin on public.contacts
  for update to public
  using (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = 'admin'::user_role)))
  with check ((org_id = (select current_org_id())));

drop policy contacts_update_agent on public.contacts;
create policy contacts_update_agent on public.contacts
  for update to public
  using (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = 'agent'::user_role) AND ((assigned_agent_id = auth.uid()) OR (created_by = auth.uid()))))
  with check ((org_id = (select current_org_id())));

drop policy deals_insert on public.deals;
create policy deals_insert on public.deals
  for insert to public
  with check (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = ANY (ARRAY['admin'::user_role, 'agent'::user_role]))));

drop policy deals_select on public.deals;
create policy deals_select on public.deals
  for select to public
  using (((org_id = (select current_org_id())) AND (((select current_role_gnk()) = ANY (ARRAY['admin'::user_role, 'listing_manager'::user_role])) OR (agent_id = auth.uid()) OR (created_by = auth.uid()))));

drop policy deals_update_admin on public.deals;
create policy deals_update_admin on public.deals
  for update to public
  using (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = 'admin'::user_role)))
  with check (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = 'admin'::user_role)));

drop policy deals_update_agent on public.deals;
create policy deals_update_agent on public.deals
  for update to public
  using (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = 'agent'::user_role) AND ((agent_id = auth.uid()) OR (created_by = auth.uid()))))
  with check (((org_id = (select current_org_id())) AND ((agent_id = auth.uid()) OR (created_by = auth.uid()))));

drop policy events_insert on public.events;
create policy events_insert on public.events
  for insert to public
  with check ((org_id = (select current_org_id())));

drop policy events_select on public.events;
create policy events_select on public.events
  for select to public
  using (((org_id = (select current_org_id())) AND (((select current_role_gnk()) = 'admin'::user_role) OR (actor_id = auth.uid()))));

drop policy leads_insert on public.leads;
create policy leads_insert on public.leads
  for insert to public
  with check (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = ANY (ARRAY['admin'::user_role, 'agent'::user_role, 'listing_manager'::user_role]))));

drop policy leads_select on public.leads;
create policy leads_select on public.leads
  for select to public
  using ((org_id = (select current_org_id())));

drop policy leads_update_admin on public.leads;
create policy leads_update_admin on public.leads
  for update to public
  using (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = 'admin'::user_role)))
  with check (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = 'admin'::user_role)));

drop policy leads_update_agent on public.leads;
create policy leads_update_agent on public.leads
  for update to public
  using (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = 'agent'::user_role) AND ((assigned_agent_id = auth.uid()) OR (assigned_agent_id IS NULL))))
  with check (((org_id = (select current_org_id())) AND ((assigned_agent_id = auth.uid()) OR (assigned_agent_id IS NULL))));

drop policy properties_insert on public.properties;
create policy properties_insert on public.properties
  for insert to public
  with check (((org_id = (select current_org_id())) AND (((select current_role_gnk()) = ANY (ARRAY['admin'::user_role, 'listing_manager'::user_role])) OR (((select current_role_gnk()) = 'agent'::user_role) AND (assigned_agent_id = auth.uid())))));

drop policy properties_select on public.properties;
create policy properties_select on public.properties
  for select to public
  using ((org_id = (select current_org_id())));

drop policy properties_update on public.properties;
create policy properties_update on public.properties
  for update to public
  using (((org_id = (select current_org_id())) AND (((select current_role_gnk()) = ANY (ARRAY['admin'::user_role, 'listing_manager'::user_role])) OR (((select current_role_gnk()) = 'agent'::user_role) AND (assigned_agent_id = auth.uid())))))
  with check ((org_id = (select current_org_id())));

drop policy tasks_delete on public.tasks;
create policy tasks_delete on public.tasks
  for delete to public
  using (((org_id = (select current_org_id())) AND (((select current_role_gnk()) = 'admin'::user_role) OR (created_by = auth.uid()))));

drop policy tasks_insert on public.tasks;
create policy tasks_insert on public.tasks
  for insert to public
  with check (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = ANY (ARRAY['admin'::user_role, 'agent'::user_role, 'listing_manager'::user_role]))));

drop policy tasks_select on public.tasks;
create policy tasks_select on public.tasks
  for select to public
  using (((org_id = (select current_org_id())) AND (((select current_role_gnk()) = 'admin'::user_role) OR (assignee_id = auth.uid()) OR (created_by = auth.uid()))));

drop policy tasks_update on public.tasks;
create policy tasks_update on public.tasks
  for update to public
  using (((org_id = (select current_org_id())) AND (((select current_role_gnk()) = 'admin'::user_role) OR (assignee_id = auth.uid()))))
  with check ((org_id = (select current_org_id())));

drop policy viewings_insert on public.viewings;
create policy viewings_insert on public.viewings
  for insert to public
  with check (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = ANY (ARRAY['admin'::user_role, 'agent'::user_role]))));

drop policy viewings_select on public.viewings;
create policy viewings_select on public.viewings
  for select to public
  using ((org_id = (select current_org_id())));

drop policy viewings_update on public.viewings;
create policy viewings_update on public.viewings
  for update to public
  using (((org_id = (select current_org_id())) AND (((select current_role_gnk()) = 'admin'::user_role) OR (((select current_role_gnk()) = 'agent'::user_role) AND (agent_id = auth.uid())))))
  with check ((org_id = (select current_org_id())));

-- Self-check. Normalising the wrapper away must reproduce the ORIGINAL text
-- exactly. A migration is one transaction, so a mismatch aborts everything and
-- nothing half-lands.
do $$
declare
  bad int;
  detail text;
begin
  select count(*), string_agg(p.tablename || '.' || p.policyname, ', ')
    into bad, detail
    from pg_policies p
    join _before b
      on b.tablename = p.tablename and b.policyname = p.policyname
   where p.schemaname = 'public'
     and (
       replace(replace(coalesce(p.qual, ''),
         '( SELECT current_org_id() AS current_org_id)',     'current_org_id()'),
         '( SELECT current_role_gnk() AS current_role_gnk)', 'current_role_gnk()')
       is distinct from coalesce(b.qual, '')
       or
       replace(replace(coalesce(p.with_check, ''),
         '( SELECT current_org_id() AS current_org_id)',     'current_org_id()'),
         '( SELECT current_role_gnk() AS current_role_gnk)', 'current_role_gnk()')
       is distinct from coalesce(b.with_check, '')
     );

  if bad > 0 then
    raise exception '0030 changed % predicate(s), aborting: %', bad, detail;
  end if;

  -- A check that never matches would pass vacuously. Prove it saw the rewrite.
  select count(*) into bad
    from pg_policies
   where schemaname = 'public' and permissive = 'PERMISSIVE'
     and tablename in ('contacts','deals','events','leads','properties','tasks','viewings')
     and coalesce(qual,'') || coalesce(with_check,'') like '%( SELECT current_org_id()%';

  if bad <> 24 then
    raise exception '0030 expected 24 hoisted policies, found % — the rewrite did not apply', bad;
  end if;
end $$;
