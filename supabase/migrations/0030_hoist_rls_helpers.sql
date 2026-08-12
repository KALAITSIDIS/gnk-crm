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
--
-- The literals below must not depend on the applying session's search_path:
-- pg_policies.qual/with_check are deparsed by pg_get_expr() against the
-- CALLER's search_path, so a session without `public` on the path (hosted is
-- applied through a connector we do not configure) renders the helper calls
-- schema-qualified as public.current_org_id(). Both _before (captured earlier
-- in this same session) and the current read need the public. prefix stripped
-- FIRST, before the wrapper is stripped, or the comparison sees every
-- predicate as "changed" and aborts the migration for a spurious reason.
--
-- Both sides get the SAME normalisation, deliberately. If only the "after" side
-- stripped the wrapper, a RE-RUN against an already-hoisted database would
-- normalise the two sides differently and raise "changed 24 predicate(s)" when
-- nothing had changed — a false alarm at the worst possible moment, retrying a
-- hosted apply.
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
       replace(replace(replace(replace(coalesce(p.qual, ''),
         'public.current_org_id()',   'current_org_id()'),
         'public.current_role_gnk()', 'current_role_gnk()'),
         '( SELECT current_org_id() AS current_org_id)',     'current_org_id()'),
         '( SELECT current_role_gnk() AS current_role_gnk)', 'current_role_gnk()')
       is distinct from replace(replace(replace(replace(coalesce(b.qual, ''),
         'public.current_org_id()',   'current_org_id()'),
         'public.current_role_gnk()', 'current_role_gnk()'),
         '( SELECT current_org_id() AS current_org_id)',     'current_org_id()'),
         '( SELECT current_role_gnk() AS current_role_gnk)', 'current_role_gnk()')
       or
       replace(replace(replace(replace(coalesce(p.with_check, ''),
         'public.current_org_id()',   'current_org_id()'),
         'public.current_role_gnk()', 'current_role_gnk()'),
         '( SELECT current_org_id() AS current_org_id)',     'current_org_id()'),
         '( SELECT current_role_gnk() AS current_role_gnk)', 'current_role_gnk()')
       is distinct from replace(replace(replace(replace(coalesce(b.with_check, ''),
         'public.current_org_id()',   'current_org_id()'),
         'public.current_role_gnk()', 'current_role_gnk()'),
         '( SELECT current_org_id() AS current_org_id)',     'current_org_id()'),
         '( SELECT current_role_gnk() AS current_role_gnk)', 'current_role_gnk()')
     );

  if bad > 0 then
    raise exception '0030 changed % predicate(s), aborting: %', bad, detail;
  end if;

  -- A check that never matches would pass vacuously. Prove it saw the rewrite.
  select count(*) into bad
    from pg_policies
   where schemaname = 'public' and permissive = 'PERMISSIVE'
     and tablename in ('contacts','deals','events','leads','properties','tasks','viewings')
     and replace(coalesce(qual,'') || coalesce(with_check,''),
                 'public.current_org_id()', 'current_org_id()')
         like '%( SELECT current_org_id()%';

  if bad <> 24 then
    raise exception '0030 expected 24 hoisted policies, found % — the rewrite did not apply', bad;
  end if;
end $$;

-- Guard function. Returns any policy on the 7 list tables that still calls a
-- helper bare. Empty means fully hoisted. service_role only, matching
-- rls_aal2_coverage() from 0029: it describes the security model's shape, which
-- no ordinary session needs.
create or replace function public.rls_bare_helper_calls()
returns table (tablename text, policyname text)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select p.tablename::text, p.policyname::text
    from pg_policies p
   where p.schemaname = 'public'
     and p.permissive = 'PERMISSIVE'
     and p.tablename in ('contacts','deals','events','leads','properties','tasks','viewings')
     and replace(replace(replace(replace(
           coalesce(p.qual,'') || coalesce(p.with_check,''),
           'public.current_org_id()',   'current_org_id()'),
           'public.current_role_gnk()', 'current_role_gnk()'),
           '( SELECT current_org_id() AS current_org_id)',     ''),
           '( SELECT current_role_gnk() AS current_role_gnk)', '')
         like any (array['%current_org_id()%', '%current_role_gnk()%'])
   order by 1, 2;
$$;

comment on function public.rls_bare_helper_calls() is
  'Policies on the 7 paginated list tables that still call current_org_id() or '
  'current_role_gnk() outside a (select …) wrapper, i.e. once per row. Empty '
  'means fully hoisted. Asserted by supabase/tests/rls-hoist.test.ts. '
  'The public. stripping is load-bearing: pg_policies.qual is deparsed by '
  'pg_get_expr() against the CALLER search_path, so with pg_catalog pinned the '
  'call renders as public.current_org_id() and an unqualified literal never '
  'matches — which silently inverts this guard.';

revoke execute on function public.rls_bare_helper_calls() from public, anon, authenticated;
grant execute on function public.rls_bare_helper_calls() to service_role;

-- The positive half. "Nothing is bare" is satisfied perfectly by a database
-- where the 24 policies were dropped and never recreated, so something must
-- assert they are PRESENT and hoisted.
create or replace function public.rls_hoisted_policy_count()
returns integer
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select count(*)::int
    from pg_policies p
   where p.schemaname = 'public'
     and p.permissive = 'PERMISSIVE'
     and p.tablename in ('contacts','deals','events','leads','properties','tasks','viewings')
     and replace(coalesce(p.qual,'') || coalesce(p.with_check,''),
                 'public.current_org_id()', 'current_org_id()')
         like '%( SELECT current_org_id() AS current_org_id)%';
$$;

comment on function public.rls_hoisted_policy_count() is
  'How many policies on the 7 paginated list tables carry a hoisted '
  'current_org_id() call. Expected 24 after migration 0030. Pairs with '
  'rls_bare_helper_calls(): that one proves nothing is bare, this proves the '
  'policies still exist. '
  'NOTE: this counts hoisted current_org_id() calls ONLY. It is a presence '
  'check, and it is complete only in combination with rls_bare_helper_calls(), '
  'which is what catches a bare current_role_gnk(). Safe today because all 24 '
  'policies reference current_org_id(); if that ever stops being true, this '
  'function needs widening.';

revoke execute on function public.rls_hoisted_policy_count() from public, anon, authenticated;
grant execute on function public.rls_hoisted_policy_count() to service_role;
