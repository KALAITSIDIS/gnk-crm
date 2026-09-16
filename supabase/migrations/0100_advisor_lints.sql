-- 0100 — close every advisor WARNING the schema can close (2026-09-16).
--
-- The Supabase advisors on hosted read: Security 2 errors / 34 warnings,
-- Performance 12 `auth_rls_initplan` + 24 `multiple_permissive_policies`
-- warnings. This migration takes the three warning classes that a migration
-- can own to zero. It does NOT touch the four findings that are by design or
-- out of this role's reach — they are listed at the bottom so nobody spends an
-- afternoon "fixing" them again.
--
-- A. `auth_rls_initplan` (12 policies). 0030 hoisted the 7 paginated list
--    tables and left these 12 bare ON PURPOSE — "config/staff-bounded tables,
--    read a few rows at a time" — because the per-row cost was unmeasurable
--    there. That reasoning was about cost, not safety, and the advisor has
--    reported the twelve on every run since (0068 exists only to explain that
--    the repo's own guard was blind to them). Hoisting is free, so they are
--    hoisted now, exactly as 0030/0032 did: `auth.uid()` -> `(select auth.uid())`,
--    and the two helpers likewise. Statements were GENERATED from pg_policies
--    on a migration-built database, not hand-transcribed.
--
-- B. `multiple_permissive_policies` (24 findings = 4 tables x 6 roles). Each
--    of contacts / deals / leads / profiles carried TWO permissive UPDATE
--    policies (`*_update_admin` + `*_update_agent`, or `profiles_update_own`).
--    Postgres ORs permissive policies together, so two policies cost two
--    evaluations per row for the same answer. Each pair becomes one policy
--    named `<table>_update`, whose predicate is LITERALLY `(old_1) OR (old_2)`
--    for USING and for WITH CHECK — no re-factoring by hand, so the check at
--    the bottom can prove textual equivalence against the pre-migration
--    catalogue after normalising the hoist wrappers away.
--
-- C. `extension_in_public` for pg_trgm. It is relocatable; PostGIS is not.
--    Moving it changes nothing the app can see: the two trigram indexes
--    (contacts_name_trgm, properties_ref_trgm) bind their operator class by
--    OID and stay valid (probed locally: indisvalid = true, the ILIKE plan is
--    unchanged), no function body in `public` calls similarity()/show_trgm(),
--    and `extensions` is already on every role's search_path.
--
-- D. `rls_bare_auth_calls()` now looks at EVERY public table. Its seven-table
--    scope existed to tolerate the twelve; with them hoisted, a schema-wide
--    zero is finally true, and a guard that returns 0 for the whole schema is
--    the one 0068 wished for. Its grants are untouched (create or replace
--    keeps the ACL; verify-restore.sql pins it).
--
-- NOT DONE HERE, AND WHY (so the next reader does not reopen them):
--   * `security_definer_view` on mandates_safe (ERROR). Deliberate: the view
--     is the listing manager's ONLY read path to mandates (no base-table
--     policy admits that role) and it masks commission_pct/commission_notes
--     for everyone but admins and the assigned agent. `security_invoker`
--     would empty the mandate panel for listing managers, and giving them a
--     base-table policy would expose the commission columns the view exists
--     to hide. 0037 closed the write hole; the view's WHERE mirrors
--     mandates_select. Revisit only with a commission-table split.
--   * `rls_disabled_in_public` on spatial_ref_sys (ERROR). Owned by
--     supabase_admin; `alter table … enable row level security` fails with
--     "must be owner" (probed). 0099's statement-level trigger already makes
--     it read-only for the API roles. Residual = Supabase support ticket.
--   * `anon_security_definer_function_executable` (12): nine are the
--     deliberate anon surface (share links, public listing feed, portal feed —
--     pinned as anon=true in verify-restore.sql; the routes use the
--     publishable key on purpose). The three st_estimatedextent overloads are
--     PostGIS-owned: `revoke` from postgres is a WARNING-and-no-op (probed).
--   * `authenticated_security_definer_function_executable` (19): RLS helpers
--     and app RPCs that MUST be callable by signed-in users, plus the nine.
--   * `auth_leaked_password_protection`: Pro-only (402 on the PATCH, 2026-09-15)
--     and moot — no human has ever chosen a password here (HANDOFF §0 A10).
--   * Performance INFO rows (54 unindexed FKs, 29 unused indexes) are not
--     warnings; left for a measured need, not a linter.
--
-- NAMED PER MIGRATION (0032's lesson): the CLI applies every migration in ONE
-- session, so a temp table must carry the migration number and be dropped.

create temp table _before_0100 as
  select tablename, policyname, cmd, permissive, roles,
         coalesce(qual, '') as qual, coalesce(with_check, '') as with_check
    from pg_policies
   where schemaname = 'public';

-- ---------------------------------------------------------------------------
-- A. hoist the twelve (generated from pg_policies)
-- ---------------------------------------------------------------------------

drop policy cyprus_config_select on public.cyprus_config;
create policy cyprus_config_select on public.cyprus_config
  for select to public
  using (((select auth.uid()) IS NOT NULL));

drop policy mandates_select on public.mandates;
create policy mandates_select on public.mandates
  for select to public
  using (((org_id = (select current_org_id())) AND (((select current_role_gnk()) = 'admin'::user_role) OR (((select current_role_gnk()) = 'agent'::user_role) AND ((created_by = (select auth.uid())) OR (EXISTS ( SELECT 1
   FROM properties p
  WHERE ((p.id = mandates.property_id) AND (p.assigned_agent_id = (select auth.uid()))))))))));

drop policy offers_insert on public.offers;
create policy offers_insert on public.offers
  for insert to public
  with check (((org_id = (select current_org_id())) AND (((select current_role_gnk()) = 'admin'::user_role) OR (((select current_role_gnk()) = 'agent'::user_role) AND (EXISTS ( SELECT 1
   FROM deals d
  WHERE ((d.id = offers.deal_id) AND ((d.agent_id = (select auth.uid())) OR (d.created_by = (select auth.uid()))))))))));

drop policy offers_select on public.offers;
create policy offers_select on public.offers
  for select to public
  using (((org_id = (select current_org_id())) AND (((select current_role_gnk()) = ANY (ARRAY['admin'::user_role, 'listing_manager'::user_role])) OR (EXISTS ( SELECT 1
   FROM deals d
  WHERE ((d.id = offers.deal_id) AND ((d.agent_id = (select auth.uid())) OR (d.created_by = (select auth.uid())))))))));

drop policy offers_update on public.offers;
create policy offers_update on public.offers
  for update to public
  using (((org_id = (select current_org_id())) AND (((select current_role_gnk()) = 'admin'::user_role) OR (((select current_role_gnk()) = 'agent'::user_role) AND (EXISTS ( SELECT 1
   FROM deals d
  WHERE ((d.id = offers.deal_id) AND ((d.agent_id = (select auth.uid())) OR (d.created_by = (select auth.uid()))))))))))
  with check ((org_id = (select current_org_id())));

drop policy property_media_insert on public.property_media;
create policy property_media_insert on public.property_media
  for insert to public
  with check (((org_id = (select current_org_id())) AND (((select current_role_gnk()) = ANY (ARRAY['admin'::user_role, 'listing_manager'::user_role])) OR (((select current_role_gnk()) = 'agent'::user_role) AND (EXISTS ( SELECT 1
   FROM properties p
  WHERE ((p.id = property_media.property_id) AND (p.assigned_agent_id = (select auth.uid())))))))));

drop policy share_link_properties_delete on public.share_link_properties;
create policy share_link_properties_delete on public.share_link_properties
  for delete to public
  using ((EXISTS ( SELECT 1
   FROM share_links s
  WHERE ((s.id = share_link_properties.share_link_id) AND (s.org_id = (select current_org_id())) AND ((s.created_by = (select auth.uid())) OR ((select current_role_gnk()) = 'admin'::user_role))))));

drop policy share_links_insert on public.share_links;
create policy share_links_insert on public.share_links
  for insert to public
  with check (((org_id = (select current_org_id())) AND (created_by = (select auth.uid()))));

drop policy share_links_update on public.share_links;
create policy share_links_update on public.share_links
  for update to public
  using (((org_id = (select current_org_id())) AND ((created_by = (select auth.uid())) OR ((select current_role_gnk()) = 'admin'::user_role))))
  with check ((org_id = (select current_org_id())));

drop policy viewing_slips_insert on public.viewing_slips;
create policy viewing_slips_insert on public.viewing_slips
  for insert to public
  with check (((org_id = (select current_org_id())) AND (((select current_role_gnk()) = 'admin'::user_role) OR (EXISTS ( SELECT 1
   FROM viewings v
  WHERE ((v.id = viewing_slips.viewing_id) AND (v.agent_id = (select auth.uid()))))))));

drop policy viewing_slips_select on public.viewing_slips;
create policy viewing_slips_select on public.viewing_slips
  for select to public
  using (((org_id = (select current_org_id())) AND (((select current_role_gnk()) = 'admin'::user_role) OR (EXISTS ( SELECT 1
   FROM viewings v
  WHERE ((v.id = viewing_slips.viewing_id) AND (v.agent_id = (select auth.uid()))))))));

-- profiles_update_own is the twelfth; it is hoisted AND merged in section B.

-- ---------------------------------------------------------------------------
-- B. one permissive UPDATE policy per table: `(admin arm) OR (agent/own arm)`
-- ---------------------------------------------------------------------------

drop policy contacts_update_admin on public.contacts;
drop policy contacts_update_agent on public.contacts;
create policy contacts_update on public.contacts
  for update to public
  using (
    ((org_id = (select current_org_id())) AND ((select current_role_gnk()) = 'admin'::user_role))
    OR
    ((org_id = (select current_org_id())) AND ((select current_role_gnk()) = 'agent'::user_role) AND ((assigned_agent_id = (select auth.uid())) OR (created_by = (select auth.uid()))))
  )
  -- both old policies carried the same WITH CHECK, so the OR collapses
  with check ((org_id = (select current_org_id())));

drop policy deals_update_admin on public.deals;
drop policy deals_update_agent on public.deals;
create policy deals_update on public.deals
  for update to public
  using (
    ((org_id = (select current_org_id())) AND ((select current_role_gnk()) = 'admin'::user_role))
    OR
    ((org_id = (select current_org_id())) AND ((select current_role_gnk()) = 'agent'::user_role) AND ((agent_id = (select auth.uid())) OR (created_by = (select auth.uid()))))
  )
  with check (
    ((org_id = (select current_org_id())) AND ((select current_role_gnk()) = 'admin'::user_role))
    OR
    ((org_id = (select current_org_id())) AND ((agent_id = (select auth.uid())) OR (created_by = (select auth.uid()))))
  );

drop policy leads_update_admin on public.leads;
drop policy leads_update_agent on public.leads;
create policy leads_update on public.leads
  for update to public
  using (
    ((org_id = (select current_org_id())) AND ((select current_role_gnk()) = 'admin'::user_role))
    OR
    ((org_id = (select current_org_id())) AND ((select current_role_gnk()) = 'agent'::user_role) AND ((assigned_agent_id = (select auth.uid())) OR (assigned_agent_id IS NULL)))
  )
  with check (
    ((org_id = (select current_org_id())) AND ((select current_role_gnk()) = 'admin'::user_role))
    OR
    ((org_id = (select current_org_id())) AND ((assigned_agent_id = (select auth.uid())) OR (assigned_agent_id IS NULL)))
  );

-- profiles: `_admin` (org + admin) OR `_own` (id = uid). The old WITH CHECKs
-- were `org` and `id = uid AND org`; their OR is written out verbatim rather
-- than simplified to `org`, so the equivalence check below stays mechanical.
drop policy profiles_update_admin on public.profiles;
drop policy profiles_update_own on public.profiles;
create policy profiles_update on public.profiles
  for update to public
  using (
    ((org_id = (select current_org_id())) AND ((select current_role_gnk()) = 'admin'::user_role))
    OR
    (id = (select auth.uid()))
  )
  with check (
    (org_id = (select current_org_id()))
    OR
    ((id = (select auth.uid())) AND (org_id = (select current_org_id())))
  );

-- ---------------------------------------------------------------------------
-- C. pg_trgm out of public
-- ---------------------------------------------------------------------------

alter extension pg_trgm set schema extensions;

-- ---------------------------------------------------------------------------
-- D. the auth.uid() guard covers the whole schema now
-- ---------------------------------------------------------------------------

create or replace function public.rls_bare_auth_calls()
returns table (tablename text, policyname text)
language sql stable security definer
set search_path = public, pg_catalog as $$
  select p.tablename::text, p.policyname::text
    from pg_policies p
   where p.schemaname = 'public'
     -- strip every wrapped call, then anything auth.* left over is bare
     and regexp_replace(coalesce(p.qual,'') || ' ' || coalesce(p.with_check,''),
                        '\(\s*select\s+auth\.(uid|jwt|role)\(\)\s+as\s+\w+\s*\)', '', 'gi')
         ~* 'auth\.(uid|jwt|role)\(\)'
   order by 1, 2;
$$;

comment on function public.rls_bare_auth_calls() is
  'Every policy in public that still calls auth.uid()/auth.jwt()/auth.role() '
  'outside a (select …) wrapper, i.e. once per row. Schema-wide since 0100 '
  '(0030/0032 hoisted the 7 list tables, 0100 the remaining 12 the advisor '
  'reported). Empty means the whole schema is hoisted and Supabase''s '
  '`auth_rls_initplan` advisor should be silent. Pairs with '
  'rls_bare_helper_calls() and rls_hoisted_policy_count(), which keep their '
  'seven-table scope: ~50 helper calls on small tables are still bare and '
  'the advisor does not report those.';

comment on function public.rls_hoisted_policy_count() is
  'How many policies on the 7 paginated list tables carry a hoisted '
  'current_org_id() call. Expected 24 after migration 0030 and 21 after 0100 '
  '(contacts/deals/leads each merged two UPDATE policies into one). Pairs '
  'with rls_bare_helper_calls(): that one proves nothing is bare, this proves '
  'the policies still exist. NOTE: counts hoisted current_org_id() ONLY; '
  'complete only together with rls_bare_helper_calls().';

-- ---------------------------------------------------------------------------
-- E. prove it: meaning unchanged, warnings gone, nothing collateral
-- ---------------------------------------------------------------------------

create function pg_temp.n_0100(s text) returns text language sql immutable as $$
  select replace(replace(replace(replace(s,
    '( SELECT auth.uid() AS uid)',                      'auth.uid()'),
    '( SELECT current_org_id() AS current_org_id)',     'current_org_id()'),
    '( SELECT current_role_gnk() AS current_role_gnk)', 'current_role_gnk()'),
    'public.', '')
$$;

do $$
declare
  drifted      int;
  n_before     int;
  n_after      int;
  n_multi      int;
  n_bare_auth  int;
  n_bare_help  int;
  n_hoisted    int;
  trgm_schema  text;
  bad_idx      int;
  r            record;
  exp_using    text;
  exp_check    text;
begin
  -- A. the twelve minus profiles_update_own: same cmd, roles, permissive, and
  --    the same predicate once the wrappers are normalised away
  select count(*) into drifted
    from _before_0100 b
    join pg_policies p
      on p.schemaname = 'public' and p.tablename = b.tablename and p.policyname = b.policyname
   where b.policyname in ('cyprus_config_select','mandates_select','offers_insert','offers_select',
                          'offers_update','property_media_insert','share_link_properties_delete',
                          'share_links_insert','share_links_update','viewing_slips_insert',
                          'viewing_slips_select')
     and (   pg_temp.n_0100(coalesce(p.qual,''))       is distinct from pg_temp.n_0100(b.qual)
          or pg_temp.n_0100(coalesce(p.with_check,'')) is distinct from pg_temp.n_0100(b.with_check)
          or p.cmd is distinct from b.cmd
          or p.permissive is distinct from b.permissive
          or p.roles is distinct from b.roles);
  if drifted <> 0 then
    raise exception '0100 aborted: % hoisted policy predicate(s) changed MEANING, not just evaluation strategy', drifted;
  end if;

  -- B. each merged policy is textually `(old_admin) OR (old_other)` after
  --    normalisation — for USING and for WITH CHECK (collapsed when equal)
  for r in
    select * from (values
      ('contacts', 'contacts_update_admin', 'contacts_update_agent', 'contacts_update'),
      ('deals',    'deals_update_admin',    'deals_update_agent',    'deals_update'),
      ('leads',    'leads_update_admin',    'leads_update_agent',    'leads_update'),
      ('profiles', 'profiles_update_admin', 'profiles_update_own',   'profiles_update')
    ) v(tbl, p_admin, p_other, merged)
  loop
    select '(' || pg_temp.n_0100(a.qual) || ' OR ' || pg_temp.n_0100(o.qual) || ')',
           case when pg_temp.n_0100(a.with_check) = pg_temp.n_0100(o.with_check)
                then pg_temp.n_0100(a.with_check)
                else '(' || pg_temp.n_0100(a.with_check) || ' OR ' || pg_temp.n_0100(o.with_check) || ')' end
      into exp_using, exp_check
      from _before_0100 a, _before_0100 o
     where a.tablename = r.tbl and a.policyname = r.p_admin
       and o.tablename = r.tbl and o.policyname = r.p_other;
    if exp_using is null then
      raise exception '0100 aborted: pre-migration pair for % not found', r.tbl;
    end if;

    if not exists (
      select 1 from pg_policies p
       where p.schemaname = 'public' and p.tablename = r.tbl and p.policyname = r.merged
         and p.cmd = 'UPDATE' and p.permissive = 'PERMISSIVE' and p.roles = '{public}'
         and pg_temp.n_0100(coalesce(p.qual,''))       = exp_using
         and pg_temp.n_0100(coalesce(p.with_check,'')) = exp_check)
    then
      raise exception '0100 aborted: %.% is not the OR of its two predecessors (expected USING %, CHECK %)',
        r.tbl, r.merged, exp_using, exp_check;
    end if;

    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = r.tbl
                and policyname in (r.p_admin, r.p_other)) then
      raise exception '0100 aborted: an old UPDATE policy survives on %', r.tbl;
    end if;
  end loop;

  select count(*) into n_before from _before_0100;
  select count(*) into n_after  from pg_policies where schemaname = 'public';
  if n_after <> n_before - 4 then
    raise exception '0100 aborted: policy count went % -> %, expected exactly four fewer', n_before, n_after;
  end if;

  -- the advisor conditions themselves, schema-wide
  select count(*) into n_multi
    from (select tablename, cmd from pg_policies
           where schemaname = 'public' and permissive = 'PERMISSIVE'
           group by 1, 2 having count(*) > 1) m;
  if n_multi <> 0 then
    raise exception '0100 aborted: % (table, command) pair(s) still carry more than one permissive policy', n_multi;
  end if;

  select count(*) into n_bare_auth from public.rls_bare_auth_calls();
  if n_bare_auth <> 0 then
    raise exception '0100 aborted: % policy(ies) still call auth.* once per row', n_bare_auth;
  end if;

  -- the 0030 guards on the seven list tables: nothing bare, 21 present
  select count(*) into n_bare_help from public.rls_bare_helper_calls();
  if n_bare_help <> 0 then
    raise exception '0100 aborted: rls_bare_helper_calls() is no longer empty';
  end if;
  select public.rls_hoisted_policy_count() into n_hoisted;
  if n_hoisted <> 21 then
    raise exception '0100 aborted: expected 21 hoisted list-table policies, found %', n_hoisted;
  end if;

  -- C. pg_trgm moved and its indexes survived
  select n.nspname into trgm_schema
    from pg_extension e join pg_namespace n on n.oid = e.extnamespace
   where e.extname = 'pg_trgm';
  if trgm_schema is distinct from 'extensions' then
    raise exception '0100 aborted: pg_trgm is in %, not extensions', coalesce(trgm_schema, '<missing>');
  end if;
  select count(*) into bad_idx
    from pg_index i
   where i.indexrelid in ('public.contacts_name_trgm'::regclass, 'public.properties_ref_trgm'::regclass)
     and not i.indisvalid;
  if bad_idx <> 0 then
    raise exception '0100 aborted: a trigram index is invalid after the schema move';
  end if;

  -- D. the guard kept its grants (create or replace preserves the ACL, but
  --    verify-restore.sql pins this row, so say it here too)
  if not has_function_privilege('authenticated', 'public.rls_bare_auth_calls()', 'execute')
     or has_function_privilege('anon', 'public.rls_bare_auth_calls()', 'execute') then
    raise exception '0100 aborted: rls_bare_auth_calls() grants changed';
  end if;

  raise notice '0100 ok: 12 hoisted, 4 pairs merged (% -> % policies), 0 bare auth calls schema-wide, 21 list-table policies hoisted, pg_trgm in extensions',
    n_before, n_after;
end $$;

drop function pg_temp.n_0100(text);
drop table _before_0100;
