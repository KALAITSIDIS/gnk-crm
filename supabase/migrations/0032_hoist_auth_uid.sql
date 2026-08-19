-- 0032 - finish 0030: hoist auth.uid() in the policies 0030 already optimised.
--
-- 0030 wrapped current_org_id()/current_role_gnk() as (select ...) so they are
-- evaluated once per STATEMENT rather than once per row. It did not touch
-- auth.uid(), which is the same kind of call carrying the same per-row cost.
--
-- The result was 11 HALF-HOISTED policies: the custom helper wrapped, and a bare
-- auth.uid() left in the SAME predicate. Those policies still pay a per-row call
-- on every scan, so 0030's stated goal is only half met on exactly the tables it
-- set out to fix.
--
-- MEASURED ON HOSTED 2026-08-18, not inferred. Supabase's own advisor reports
-- `auth_rls_initplan` for 23 policies; `select count(*) from
-- rls_bare_helper_calls()` returns 0 and `rls_hoisted_policy_count()` returns 24,
-- so 0030 itself has NOT regressed - these are a disjoint set it never covered.
--
-- SCOPE IS DELIBERATELY 0030'S SCOPE: the paginated list tables only. Twelve more
-- policies carry a bare auth.uid() on config/staff-bounded tables (cyprus_config,
-- mandates, offers, profiles, property_media, share_link_properties, share_links,
-- viewing_slips). 0030 excluded those tables ON PURPOSE, with its reasoning in
-- its header, and this migration does not reopen that decision.
--
-- NOTHING HERE CHANGES WHAT A POLICY MEANS. It is an evaluation-strategy change.
-- If behaviour changes, this migration has a bug - which is what the check at the
-- bottom exists to catch.
--
-- Statements were GENERATED from pg_policies, not hand-transcribed, so they
-- cannot differ from what is deployed by a typo.

-- NAMED PER MIGRATION, not `_before`. The Supabase CLI applies every migration
-- in ONE session, and a temp table lives for the whole session — 0030 creates
-- `_before` and never drops it, so a second `create temp table _before` fails
-- with 42P07 "already exists". This migration was written with the bare name
-- first and CI caught it on a branch. Suffix the migration number, and drop it
-- at the end, which 0030 does not do.
create temp table _before_0032 as
select tablename, policyname, coalesce(qual,'') as qual,
       coalesce(with_check,'') as with_check
from pg_policies
where schemaname = 'public';

drop policy contacts_update_agent on public.contacts;
create policy contacts_update_agent on public.contacts
  for update
  to public
  using (((org_id = ( SELECT current_org_id() AS current_org_id)) AND (( SELECT current_role_gnk() AS current_role_gnk) = 'agent'::user_role) AND ((assigned_agent_id = (select auth.uid())) OR (created_by = (select auth.uid())))))
  with check ((org_id = ( SELECT current_org_id() AS current_org_id)));

drop policy deals_select on public.deals;
create policy deals_select on public.deals
  for select
  to public
  using (((org_id = ( SELECT current_org_id() AS current_org_id)) AND ((( SELECT current_role_gnk() AS current_role_gnk) = ANY (ARRAY['admin'::user_role, 'listing_manager'::user_role])) OR (agent_id = (select auth.uid())) OR (created_by = (select auth.uid())))));

drop policy deals_update_agent on public.deals;
create policy deals_update_agent on public.deals
  for update
  to public
  using (((org_id = ( SELECT current_org_id() AS current_org_id)) AND (( SELECT current_role_gnk() AS current_role_gnk) = 'agent'::user_role) AND ((agent_id = (select auth.uid())) OR (created_by = (select auth.uid())))))
  with check (((org_id = ( SELECT current_org_id() AS current_org_id)) AND ((agent_id = (select auth.uid())) OR (created_by = (select auth.uid())))));

drop policy events_select on public.events;
create policy events_select on public.events
  for select
  to public
  using (((org_id = ( SELECT current_org_id() AS current_org_id)) AND ((( SELECT current_role_gnk() AS current_role_gnk) = 'admin'::user_role) OR (actor_id = (select auth.uid())))));

drop policy leads_update_agent on public.leads;
create policy leads_update_agent on public.leads
  for update
  to public
  using (((org_id = ( SELECT current_org_id() AS current_org_id)) AND (( SELECT current_role_gnk() AS current_role_gnk) = 'agent'::user_role) AND ((assigned_agent_id = (select auth.uid())) OR (assigned_agent_id IS NULL))))
  with check (((org_id = ( SELECT current_org_id() AS current_org_id)) AND ((assigned_agent_id = (select auth.uid())) OR (assigned_agent_id IS NULL))));

drop policy properties_insert on public.properties;
create policy properties_insert on public.properties
  for insert
  to public
  with check (((org_id = ( SELECT current_org_id() AS current_org_id)) AND ((( SELECT current_role_gnk() AS current_role_gnk) = ANY (ARRAY['admin'::user_role, 'listing_manager'::user_role])) OR ((( SELECT current_role_gnk() AS current_role_gnk) = 'agent'::user_role) AND (assigned_agent_id = (select auth.uid()))))));

drop policy properties_update on public.properties;
create policy properties_update on public.properties
  for update
  to public
  using (((org_id = ( SELECT current_org_id() AS current_org_id)) AND ((( SELECT current_role_gnk() AS current_role_gnk) = ANY (ARRAY['admin'::user_role, 'listing_manager'::user_role])) OR ((( SELECT current_role_gnk() AS current_role_gnk) = 'agent'::user_role) AND (assigned_agent_id = (select auth.uid()))))))
  with check ((org_id = ( SELECT current_org_id() AS current_org_id)));

drop policy tasks_delete on public.tasks;
create policy tasks_delete on public.tasks
  for delete
  to public
  using (((org_id = ( SELECT current_org_id() AS current_org_id)) AND ((( SELECT current_role_gnk() AS current_role_gnk) = 'admin'::user_role) OR (created_by = (select auth.uid())))));

drop policy tasks_select on public.tasks;
create policy tasks_select on public.tasks
  for select
  to public
  using (((org_id = ( SELECT current_org_id() AS current_org_id)) AND ((( SELECT current_role_gnk() AS current_role_gnk) = 'admin'::user_role) OR (assignee_id = (select auth.uid())) OR (created_by = (select auth.uid())))));

drop policy tasks_update on public.tasks;
create policy tasks_update on public.tasks
  for update
  to public
  using (((org_id = ( SELECT current_org_id() AS current_org_id)) AND ((( SELECT current_role_gnk() AS current_role_gnk) = 'admin'::user_role) OR (assignee_id = (select auth.uid())))))
  with check ((org_id = ( SELECT current_org_id() AS current_org_id)));

drop policy viewings_update on public.viewings;
create policy viewings_update on public.viewings
  for update
  to public
  using (((org_id = ( SELECT current_org_id() AS current_org_id)) AND ((( SELECT current_role_gnk() AS current_role_gnk) = 'admin'::user_role) OR ((( SELECT current_role_gnk() AS current_role_gnk) = 'agent'::user_role) AND (agent_id = (select auth.uid()))))))
  with check ((org_id = ( SELECT current_org_id() AS current_org_id)));

-- Self-check. Normalises BOTH sides with the SAME expression on purpose: 0030's
-- re-run once reported 24 false changes because only one side was normalised.
-- Un-hoisting the new form must reproduce the old text EXACTLY; anything else
-- means a predicate changed meaning, and the whole migration aborts.
do $$
declare
  drifted int;
  hoisted int;
  total_before int;
  total_after int;
  unhoist constant text := '\(\s*SELECT\s+auth\.uid\(\)\s+AS\s+uid\s*\)';
begin
  select count(*) into drifted
  from _before_0032 b
  join pg_policies p
    on p.schemaname = 'public'
   and p.tablename  = b.tablename
   and p.policyname = b.policyname
  where regexp_replace(coalesce(p.qual,''), unhoist, 'auth.uid()', 'gi')
          is distinct from regexp_replace(b.qual, unhoist, 'auth.uid()', 'gi')
     or regexp_replace(coalesce(p.with_check,''), unhoist, 'auth.uid()', 'gi')
          is distinct from regexp_replace(b.with_check, unhoist, 'auth.uid()', 'gi');

  if drifted <> 0 then
    raise exception '0032 aborted: % policy predicate(s) changed MEANING, not just evaluation strategy', drifted;
  end if;

  select count(*) into total_before from _before_0032;
  select count(*) into total_after from pg_policies where schemaname = 'public';
  if total_before <> total_after then
    raise exception '0032 aborted: policy count changed from % to %', total_before, total_after;
  end if;

  select count(*) into hoisted
  from pg_policies
  where schemaname = 'public'
    and (coalesce(qual,'') || ' ' || coalesce(with_check,'')) ~* '\(\s*select\s+auth\.uid';
  if hoisted <> 11 then
    raise exception '0032 aborted: expected 11 policies with a hoisted auth.uid(), found %', hoisted;
  end if;

  raise notice '0032 ok: 11 hoisted, % policies total, 0 predicates changed meaning', total_after;
end $$;

drop table _before_0032;

-- Coverage helper, mirroring 0030's pair. Zero rows means every policy on the
-- paginated list tables evaluates auth.uid() once per statement.
create or replace function public.rls_bare_auth_calls()
returns table (tablename text, policyname text)
language sql stable security definer
set search_path = public, pg_catalog as $$
  select p.tablename::text, p.policyname::text
  from pg_policies p
  where p.schemaname = 'public'
    and p.tablename in ('contacts','deals','events','leads','properties','tasks','viewings')
    and (coalesce(p.qual,'') || ' ' || coalesce(p.with_check,'')) ~* 'auth\.uid\(\)'
    and (coalesce(p.qual,'') || ' ' || coalesce(p.with_check,'')) !~* '\(\s*select\s+auth\.uid';
$$;

revoke execute on function public.rls_bare_auth_calls() from public, anon;
grant execute on function public.rls_bare_auth_calls() to authenticated;
