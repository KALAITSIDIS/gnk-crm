-- =============================================================================
-- 0147 — every RLS policy evaluates current_org_id() / current_role_gnk() once
--        per statement: the last 51 bare helper calls are hoisted
--        (T-rls-hoist-rest, 2026-10-14; perf hygiene, meaning-preserving)
--
-- THE GAP (measured on the local stack at 0146 and read-only on hosted
-- 2026-10-14): current_org_id() and current_role_gnk() are `language sql
-- stable security definer set search_path`, so they are never inlined and a
-- BARE call in a policy predicate is evaluated once per row (0030 counted it:
-- 21 calls against 1 on a 20-row scan). 0030 hoisted the seven paginated list
-- tables and 0100 twelve more policies; 51 permissive policies on 19 small
-- tables were left bare ON PURPOSE — a cost decision (0030's header, "read a
-- few rows at a time"), never a safety one — and rls_bare_helper_calls()
-- looked only at the seven tables. Hosted held exactly the same 51 (plus
-- share_link_properties_insert, which 0146 hoists), byte-identical policy
-- texts (one digest over table, name, command, permissive, roles and the md5
-- of each predicate: aa98b512… on both).
--
-- THE FIX: one ALTER POLICY per affected policy — USING where the policy has
-- one, WITH CHECK where it has one (an UPDATE policy with no WITH CHECK keeps
-- none) — whose predicate is the policy's own deparsed text with each bare
-- `current_org_id()` / `current_role_gnk()` written `(select …)`. The
-- statements were GENERATED from the local stack's pg_policies after 0146
-- (never hand-typed); ALTER POLICY leaves the name, command, roles and
-- permissive flag as they were. Both helpers are STABLE, so within one
-- statement the wrapped call returns what every bare call returned: the
-- predicate means exactly what it meant (0030 / 0100's argument, measured
-- again below). Free: 0100 measured no plan cost.
-- rls_bare_helper_calls() (0030) now looks at EVERY policy in public,
-- permissive and restrictive — CREATE OR REPLACE with the same signature,
-- return type, definer, volatility and search_path, so its ACL (service_role
-- only) and the restore pack's grants row stand. Its comment, and
-- rls_bare_auth_calls' and rls_hoisted_policy_count's (which said ~50 helper
-- calls are still bare), are rewritten. rls_hoisted_policy_count() keeps its
-- seven-table scope and still reads 21 — a presence check for the list
-- tables, now paired with a schema-wide "nothing bare".
--
-- CONTRACT. No row, function signature, grant or behaviour changes; no
-- release-compat entry; lib/supabase/database.types.ts unchanged. NOT
-- deploy-coupled.
--
-- LOCKS. ALTER POLICY takes ACCESS EXCLUSIVE on its table (measured): reads
-- wait too, for the milliseconds to commit. All 19 tables are taken FIRST, in
-- ONE statement inside the preflight: the 17 table-specific ones in 0132's
-- order (cyprus_config, districts, areas, deal_stages, unit_types,
-- property_media, property_keys, key_movements, price_lists,
-- price_list_items, price_history, payment_plans, documents, mandates,
-- share_links, share_link_properties, chain_checks), then organizations and
-- profiles LAST. Every RLS check reads profiles (current_org_id()) and every
-- insert's key check reads organizations, AFTER its statement has locked its
-- own table: held first, they would stall the whole application for every
-- lock_timeout wait on the other 17, and invert the order sessions take
-- (a 40P01 against any statement on a table still to be locked). Taken last,
-- the application-wide wait covers only the final acquisitions (measured in
-- rls-hoist.test.ts: waiting on a busy documents, this file holds neither).
-- While it holds them EVERY session read still waits: apply in a quiet
-- minute, outside 02:55–04:05 UTC, away from 06:00, at the middle of an odd
-- minute that is not a multiple of five (0131 / 0132's rule — the desk-alert
-- sweep and the escalation write leads-side rows; run_chain_checks writes
-- chain_checks nightly). lock_timeout 5 s per table: a 55P03 or a 40P01 keeps nothing —
-- apply again, and do NOT write the ledger row. ONE transaction (checked).
--
-- PREFLIGHT refuses, changing nothing, unless: the policies in public that
-- call a helper bare are EXACTLY the 51 below, each permissive, for PUBLIC,
-- of its command, with exactly the predicate text it was generated from (md5
-- of qual and with_check under the fixed search_path); the three guard
-- functions are 0030 / 0100's bodies (md5) with their ACLs; and
-- rls_hoisted_policy_count() reads 21.
--
-- SELF-CHECK (0030 / 0100's, in the same transaction): every policy of the
-- schema snapshotted before the ALTERs is compared after them — the same
-- count, command, roles and permissive flag, and the same qual and with_check
-- once BOTH sides are normalised (the wrapped forms `( SELECT current_org_id()
-- AS current_org_id)` / `( SELECT current_role_gnk() AS current_role_gnk)`
-- read as the bare call, a `public.` prefix on a helper call stripped first —
-- the deparse renders either form depending on the search_path: 0030's
-- trap). Exactly the 51 changed text and nothing else did. The widened guard
-- AND an independent inline scan find no bare helper call schema-wide;
-- rls_hoisted_policy_count() still reads 21 and rls_bare_auth_calls() is
-- still empty; the guard kept its ACL and shape.
--
-- ROLLBACK, a forward migration in one transaction:
-- supabase/tests/revert-0147.ts — the 51 ALTERs with the wrapper removed
-- (each restores the text the preflight pins), 0030's guard body and comment,
-- 0100's two comments. In the same change: move the restore pack's
-- migrations pin FORWARD and drop its 0147 row; restore rls-hoist.test.ts and
-- docs/04's sentence. No data moves.
--
-- Pins that move with this file: scripts/backup/verify-restore.sql (the
-- migrations count, the 0147 row); supabase/tests/rls-hoist.test.ts;
-- docs/04_RLS_POLICY_MATRIX.md. NO EXPLICIT begin/commit — the CLI wraps the
-- file (HANDOFF §3), as does one execute_sql call; applied hosted inside the
-- md5-guarded DO (DECISIONS T-unit-type-apply-atomic). The file's LAST result
-- is a one-row summary.
-- =============================================================================

set local lock_timeout = '5s';
-- pg_get_expr's output depends on the session's search_path: generate, pin
-- and compare under the FIXED path local and hosted both use (0138's idiom)
set local search_path = "$user", public, extensions;

do $$
begin
  if current_setting('lock_timeout') <> '5s' then
    raise exception '0147 aborted: this file must run as ONE transaction (SET LOCAL lock_timeout did not take effect) — nothing was changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Preflight: the bare policies, and the guards, are what this file was
-- generated from
-- ---------------------------------------------------------------------------
do $$
declare
  v_diag text;
begin
  -- the locks ALTER POLICY needs, first — organizations and profiles LAST:
  -- every RLS check reads them (header, LOCKS)
  lock table public.cyprus_config, public.districts, public.areas, public.deal_stages,
             public.unit_types, public.property_media, public.property_keys, public.key_movements,
             public.price_lists, public.price_list_items, public.price_history, public.payment_plans,
             public.documents, public.mandates, public.share_links, public.share_link_properties,
             public.chain_checks, public.organizations, public.profiles
    in access exclusive mode;

  -- 1. the policies that call a helper bare are exactly these 51 — each
  --    permissive, for PUBLIC, of its command, with exactly this text
  --    (table, policy, command, md5(qual), md5(with_check); md5('') = none)
  with expected(tablename, policyname, cmd, qual_md5, check_md5) as (values
    ('areas', 'areas_delete', 'DELETE', 'ac7b1eb4a17649d6c777f0238546cc0b', 'd41d8cd98f00b204e9800998ecf8427e'),
    ('areas', 'areas_insert', 'INSERT', 'd41d8cd98f00b204e9800998ecf8427e', '510a3460d5675d2b3e13695db5ddc236'),
    ('areas', 'areas_select', 'SELECT', 'd9f1bed755d90f00d0c2aa4b76d9676f', 'd41d8cd98f00b204e9800998ecf8427e'),
    ('areas', 'areas_update', 'UPDATE', '510a3460d5675d2b3e13695db5ddc236', 'd9f1bed755d90f00d0c2aa4b76d9676f'),
    ('chain_checks', 'chain_checks_select', 'SELECT', 'd9f1bed755d90f00d0c2aa4b76d9676f', 'd41d8cd98f00b204e9800998ecf8427e'),
    ('cyprus_config', 'cyprus_config_insert', 'INSERT', 'd41d8cd98f00b204e9800998ecf8427e', 'fe54d16e7efbb32916d363957d6345f3'),
    ('cyprus_config', 'cyprus_config_update', 'UPDATE', 'fe54d16e7efbb32916d363957d6345f3', 'fe54d16e7efbb32916d363957d6345f3'),
    ('deal_stages', 'deal_stages_delete', 'DELETE', 'ff57aa5192d5c8649a4bacb15c5c1465', 'd41d8cd98f00b204e9800998ecf8427e'),
    ('deal_stages', 'deal_stages_insert', 'INSERT', 'd41d8cd98f00b204e9800998ecf8427e', '510a3460d5675d2b3e13695db5ddc236'),
    ('deal_stages', 'deal_stages_select', 'SELECT', 'd9f1bed755d90f00d0c2aa4b76d9676f', 'd41d8cd98f00b204e9800998ecf8427e'),
    ('deal_stages', 'deal_stages_update', 'UPDATE', '510a3460d5675d2b3e13695db5ddc236', 'd9f1bed755d90f00d0c2aa4b76d9676f'),
    ('districts', 'districts_delete', 'DELETE', '1f21c00c7a3a1a3ec79886a0b3508c45', 'd41d8cd98f00b204e9800998ecf8427e'),
    ('districts', 'districts_insert', 'INSERT', 'd41d8cd98f00b204e9800998ecf8427e', '510a3460d5675d2b3e13695db5ddc236'),
    ('districts', 'districts_select', 'SELECT', 'd9f1bed755d90f00d0c2aa4b76d9676f', 'd41d8cd98f00b204e9800998ecf8427e'),
    ('districts', 'districts_update', 'UPDATE', '510a3460d5675d2b3e13695db5ddc236', 'd9f1bed755d90f00d0c2aa4b76d9676f'),
    ('documents', 'documents_delete', 'DELETE', '510a3460d5675d2b3e13695db5ddc236', 'd41d8cd98f00b204e9800998ecf8427e'),
    ('documents', 'documents_insert', 'INSERT', 'd41d8cd98f00b204e9800998ecf8427e', '8370e6f68b1f448f396c04da76426bd6'),
    ('documents', 'documents_select', 'SELECT', '6e80d82ad7988e6a0cf46da29b9724c4', 'd41d8cd98f00b204e9800998ecf8427e'),
    ('documents', 'documents_update', 'UPDATE', '510a3460d5675d2b3e13695db5ddc236', 'd9f1bed755d90f00d0c2aa4b76d9676f'),
    ('key_movements', 'key_movements_select', 'SELECT', 'd9f1bed755d90f00d0c2aa4b76d9676f', 'd41d8cd98f00b204e9800998ecf8427e'),
    ('mandates', 'mandates_insert', 'INSERT', 'd41d8cd98f00b204e9800998ecf8427e', '510a3460d5675d2b3e13695db5ddc236'),
    ('mandates', 'mandates_update', 'UPDATE', '510a3460d5675d2b3e13695db5ddc236', 'd9f1bed755d90f00d0c2aa4b76d9676f'),
    ('organizations', 'organizations_select', 'SELECT', 'f70bc70fbbdf71cbe127d603c1225af3', 'd41d8cd98f00b204e9800998ecf8427e'),
    ('organizations', 'organizations_update', 'UPDATE', 'a8168ef1e47072571da822ddc87f628d', 'f70bc70fbbdf71cbe127d603c1225af3'),
    ('payment_plans', 'payment_plans_delete', 'DELETE', '2fe745be54b4a6dad65f8078a293a4ab', 'd41d8cd98f00b204e9800998ecf8427e'),
    ('payment_plans', 'payment_plans_insert', 'INSERT', 'd41d8cd98f00b204e9800998ecf8427e', '2fe745be54b4a6dad65f8078a293a4ab'),
    ('payment_plans', 'payment_plans_select', 'SELECT', 'd9f1bed755d90f00d0c2aa4b76d9676f', 'd41d8cd98f00b204e9800998ecf8427e'),
    ('payment_plans', 'payment_plans_update', 'UPDATE', '2fe745be54b4a6dad65f8078a293a4ab', 'd9f1bed755d90f00d0c2aa4b76d9676f'),
    ('price_history', 'price_history_select', 'SELECT', 'd9f1bed755d90f00d0c2aa4b76d9676f', 'd41d8cd98f00b204e9800998ecf8427e'),
    ('price_list_items', 'price_list_items_delete', 'DELETE', '9db7acba310df4ab07fc169e3e1ed131', 'd41d8cd98f00b204e9800998ecf8427e'),
    ('price_list_items', 'price_list_items_insert', 'INSERT', 'd41d8cd98f00b204e9800998ecf8427e', '53519acef21145027f0a9a4d72a7fa0a'),
    ('price_list_items', 'price_list_items_select', 'SELECT', '81cd8a470fa371598165cac0d8b8f2a9', 'd41d8cd98f00b204e9800998ecf8427e'),
    ('price_list_items', 'price_list_items_update', 'UPDATE', '53519acef21145027f0a9a4d72a7fa0a', '81cd8a470fa371598165cac0d8b8f2a9'),
    ('price_lists', 'price_lists_delete', 'DELETE', '0eab71098faf2f6d5611de9a3336a833', 'd41d8cd98f00b204e9800998ecf8427e'),
    ('price_lists', 'price_lists_insert', 'INSERT', 'd41d8cd98f00b204e9800998ecf8427e', '2fe745be54b4a6dad65f8078a293a4ab'),
    ('price_lists', 'price_lists_select', 'SELECT', 'd9f1bed755d90f00d0c2aa4b76d9676f', 'd41d8cd98f00b204e9800998ecf8427e'),
    ('price_lists', 'price_lists_update', 'UPDATE', '2fe745be54b4a6dad65f8078a293a4ab', 'd9f1bed755d90f00d0c2aa4b76d9676f'),
    ('profiles', 'profiles_insert', 'INSERT', 'd41d8cd98f00b204e9800998ecf8427e', '510a3460d5675d2b3e13695db5ddc236'),
    ('profiles', 'profiles_select', 'SELECT', 'd9f1bed755d90f00d0c2aa4b76d9676f', 'd41d8cd98f00b204e9800998ecf8427e'),
    ('property_keys', 'property_keys_insert', 'INSERT', 'd41d8cd98f00b204e9800998ecf8427e', '2fe745be54b4a6dad65f8078a293a4ab'),
    ('property_keys', 'property_keys_select', 'SELECT', 'd9f1bed755d90f00d0c2aa4b76d9676f', 'd41d8cd98f00b204e9800998ecf8427e'),
    ('property_keys', 'property_keys_update', 'UPDATE', '2fe745be54b4a6dad65f8078a293a4ab', 'd9f1bed755d90f00d0c2aa4b76d9676f'),
    ('property_media', 'property_media_delete', 'DELETE', '2fe745be54b4a6dad65f8078a293a4ab', 'd41d8cd98f00b204e9800998ecf8427e'),
    ('property_media', 'property_media_select', 'SELECT', 'd9f1bed755d90f00d0c2aa4b76d9676f', 'd41d8cd98f00b204e9800998ecf8427e'),
    ('property_media', 'property_media_update', 'UPDATE', '2fe745be54b4a6dad65f8078a293a4ab', 'd9f1bed755d90f00d0c2aa4b76d9676f'),
    ('share_link_properties', 'share_link_properties_select', 'SELECT', '3d37b0f8eebb0d1bfbe3a3f6bee3b285', 'd41d8cd98f00b204e9800998ecf8427e'),
    ('share_links', 'share_links_select', 'SELECT', 'd9f1bed755d90f00d0c2aa4b76d9676f', 'd41d8cd98f00b204e9800998ecf8427e'),
    ('unit_types', 'unit_types_delete', 'DELETE', '2fe745be54b4a6dad65f8078a293a4ab', 'd41d8cd98f00b204e9800998ecf8427e'),
    ('unit_types', 'unit_types_insert', 'INSERT', 'd41d8cd98f00b204e9800998ecf8427e', '2fe745be54b4a6dad65f8078a293a4ab'),
    ('unit_types', 'unit_types_select', 'SELECT', 'd9f1bed755d90f00d0c2aa4b76d9676f', 'd41d8cd98f00b204e9800998ecf8427e'),
    ('unit_types', 'unit_types_update', 'UPDATE', '2fe745be54b4a6dad65f8078a293a4ab', 'd9f1bed755d90f00d0c2aa4b76d9676f')
  ),
  actual as (
    select p.tablename::text, p.policyname::text, p.cmd, p.permissive, p.roles::text as roles,
           md5(coalesce(p.qual, '')) as qual_md5, md5(coalesce(p.with_check, '')) as check_md5
      from pg_policies p
     where p.schemaname = 'public'
       and replace(replace(replace(replace(
             coalesce(p.qual, '') || coalesce(p.with_check, ''),
             'public.current_org_id()',   'current_org_id()'),
             'public.current_role_gnk()', 'current_role_gnk()'),
             '( SELECT current_org_id() AS current_org_id)',     ''),
             '( SELECT current_role_gnk() AS current_role_gnk)', '')
           like any (array['%current_org_id()%', '%current_role_gnk()%'])
  ),
  want as (
    select e.tablename, e.policyname, e.cmd, 'PERMISSIVE'::text as permissive, '{public}'::text as roles, e.qual_md5, e.check_md5
      from expected e
  ),
  drift as (
    (select 'unexpected or changed ' || a.tablename || '.' || a.policyname as d
       from (select * from actual except select * from want) a)
    union all
    (select 'missing or changed ' || w.tablename || '.' || w.policyname
       from (select * from want except select * from actual) w)
  )
  select string_agg(d, '; ' order by d) into v_diag from drift;
  if v_diag is not null then
    raise exception '0147 aborted: the bare-helper policies are not the 51 this file was generated from (%) — nothing was changed', v_diag;
  end if;
  perform set_config('gnk.m0147_names',
    (select string_agg(p.tablename || '.' || p.policyname, ',' order by p.tablename || '.' || p.policyname)
       from pg_policies p
      where p.schemaname = 'public'
        and replace(replace(replace(replace(
              coalesce(p.qual, '') || coalesce(p.with_check, ''),
              'public.current_org_id()',   'current_org_id()'),
              'public.current_role_gnk()', 'current_role_gnk()'),
              '( SELECT current_org_id() AS current_org_id)',     ''),
              '( SELECT current_role_gnk() AS current_role_gnk)', '')
            like any (array['%current_org_id()%', '%current_role_gnk()%'])), true);

  -- 2. the three guards are 0030 / 0100's, with their grants. The grants are
  --    read as PRIVILEGES, never as ACL text: whether service_role holds
  --    EXECUTE on rls_bare_auth_calls depends on the image's default
  --    privileges, not on any migration — MEASURED 2026-10-14: hosted and
  --    fresh local stacks read {postgres=X/postgres,authenticated=X/postgres,
  --    service_role=X/postgres}, the shared local stack (built migration by
  --    migration) reads it without service_role, and pinned as text this
  --    preflight refused CI's fresh stack (run 38600602984). What a guard's
  --    grants decide is who may CALL it: never anon (nor
  --    PUBLIC, whose grant is anon's), and authenticated for
  --    rls_bare_auth_calls only.
  select string_agg(x.proname, ', ' order by x.proname) into v_diag
    from (values ('rls_bare_helper_calls', '90aac6a256ba53f176f169e0d6dd14ee', false, '{search_path=pg_catalog}'),
                 ('rls_hoisted_policy_count', '57e24ddac9d536d8ba9304e3f40ac0df', false, '{search_path=pg_catalog}'),
                 ('rls_bare_auth_calls', 'edfd09ffbd87320e5b08edb574a8bdf8', true, '{"search_path=public, pg_catalog"}'))
         x(proname, src_md5, for_authenticated, config)
   where not exists (select 1 from pg_proc p
                      where p.pronamespace = 'public'::regnamespace and p.proname = x.proname
                        and p.pronargs = 0 and p.prosecdef and p.provolatile = 's'
                        and pg_get_userbyid(p.proowner) = 'postgres'
                        and md5(replace(p.prosrc, E'\r', '')) = x.src_md5
                        -- PUBLIC's EXECUTE (a NULL ACL means it) is anon's too
                        and not has_function_privilege('anon', p.oid, 'execute')
                        and has_function_privilege('authenticated', p.oid, 'execute') = x.for_authenticated
                        and p.proconfig::text = x.config)
      or (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = x.proname) <> 1;
  if v_diag is not null then
    raise exception '0147 aborted: a guard function is not 0030 / 0100''s (%) — nothing was changed', v_diag;
  end if;
  -- the guard's ACL as this database holds it: the self-check below proves
  -- CREATE OR REPLACE kept it, without pinning text that varies by image
  perform set_config('gnk.m0147_guard_acl',
    (select p.proacl::text from pg_proc p where p.oid = 'public.rls_bare_helper_calls()'::regprocedure), true);

  -- 3. the presence check reads what 0100 left
  if public.rls_hoisted_policy_count() <> 21 then
    raise exception '0147 aborted: rls_hoisted_policy_count() reads %, not 21 — nothing was changed', public.rls_hoisted_policy_count();
  end if;

  raise notice '0147: preflight passed — the 51 bare-helper policies and the three guards are what this file was generated from';
end $$;

-- the whole schema's policies as they are now: the self-check's baseline
-- (named per migration and dropped below: the CLI applies every file in one
-- session — 0032 / 0100's lesson)
create temp table _before_0147 as
  select tablename::text as tablename, policyname::text as policyname, cmd, permissive, roles, qual, with_check
    from pg_policies
   where schemaname = 'public';

-- ---------------------------------------------------------------------------
-- The 51, hoisted (GENERATED from pg_policies; each predicate is the policy's
-- own text with its bare helper calls written `(select …)`)
-- ---------------------------------------------------------------------------

alter policy areas_delete on public.areas
  using (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = 'admin'::user_role) AND (NOT (EXISTS ( SELECT 1
   FROM properties p
  WHERE (p.area_id = areas.id))))));

alter policy areas_insert on public.areas
  with check (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = 'admin'::user_role)));

alter policy areas_select on public.areas
  using ((org_id = (select current_org_id())));

alter policy areas_update on public.areas
  using (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = 'admin'::user_role)))
  with check ((org_id = (select current_org_id())));

alter policy chain_checks_select on public.chain_checks
  using ((org_id = (select current_org_id())));

alter policy cyprus_config_insert on public.cyprus_config
  with check (((select current_role_gnk()) = 'admin'::user_role));

alter policy cyprus_config_update on public.cyprus_config
  using (((select current_role_gnk()) = 'admin'::user_role))
  with check (((select current_role_gnk()) = 'admin'::user_role));

alter policy deal_stages_delete on public.deal_stages
  using (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = 'admin'::user_role) AND (NOT (EXISTS ( SELECT 1
   FROM deals d
  WHERE (d.stage_id = deal_stages.id))))));

alter policy deal_stages_insert on public.deal_stages
  with check (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = 'admin'::user_role)));

alter policy deal_stages_select on public.deal_stages
  using ((org_id = (select current_org_id())));

alter policy deal_stages_update on public.deal_stages
  using (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = 'admin'::user_role)))
  with check ((org_id = (select current_org_id())));

alter policy districts_delete on public.districts
  using (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = 'admin'::user_role) AND (NOT (EXISTS ( SELECT 1
   FROM properties p
  WHERE (p.district_id = districts.id)))) AND (NOT (EXISTS ( SELECT 1
   FROM areas a
  WHERE (a.district_id = districts.id))))));

alter policy districts_insert on public.districts
  with check (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = 'admin'::user_role)));

alter policy districts_select on public.districts
  using ((org_id = (select current_org_id())));

alter policy districts_update on public.districts
  using (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = 'admin'::user_role)))
  with check ((org_id = (select current_org_id())));

alter policy documents_delete on public.documents
  using (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = 'admin'::user_role)));

alter policy documents_insert on public.documents
  with check (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = ANY (ARRAY['admin'::user_role, 'agent'::user_role, 'listing_manager'::user_role]))));

alter policy documents_select on public.documents
  using (((org_id = (select current_org_id())) AND (((select current_role_gnk()) = 'admin'::user_role) OR (visibility = 'internal'::text))));

alter policy documents_update on public.documents
  using (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = 'admin'::user_role)))
  with check ((org_id = (select current_org_id())));

alter policy key_movements_select on public.key_movements
  using ((org_id = (select current_org_id())));

alter policy mandates_insert on public.mandates
  with check (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = 'admin'::user_role)));

alter policy mandates_update on public.mandates
  using (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = 'admin'::user_role)))
  with check ((org_id = (select current_org_id())));

alter policy organizations_select on public.organizations
  using ((id = (select current_org_id())));

alter policy organizations_update on public.organizations
  using (((id = (select current_org_id())) AND ((select current_role_gnk()) = 'admin'::user_role)))
  with check ((id = (select current_org_id())));

alter policy payment_plans_delete on public.payment_plans
  using (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = ANY (ARRAY['admin'::user_role, 'listing_manager'::user_role]))));

alter policy payment_plans_insert on public.payment_plans
  with check (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = ANY (ARRAY['admin'::user_role, 'listing_manager'::user_role]))));

alter policy payment_plans_select on public.payment_plans
  using ((org_id = (select current_org_id())));

alter policy payment_plans_update on public.payment_plans
  using (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = ANY (ARRAY['admin'::user_role, 'listing_manager'::user_role]))))
  with check ((org_id = (select current_org_id())));

alter policy price_history_select on public.price_history
  using ((org_id = (select current_org_id())));

alter policy price_list_items_delete on public.price_list_items
  using ((((select current_role_gnk()) = ANY (ARRAY['admin'::user_role, 'listing_manager'::user_role])) AND (EXISTS ( SELECT 1
   FROM price_lists pl
  WHERE ((pl.id = price_list_items.price_list_id) AND (pl.org_id = (select current_org_id())) AND (pl.version < ( SELECT max(pl2.version) AS max
           FROM price_lists pl2
          WHERE (pl2.project_id = pl.project_id))))))));

alter policy price_list_items_insert on public.price_list_items
  with check ((((select current_role_gnk()) = ANY (ARRAY['admin'::user_role, 'listing_manager'::user_role])) AND (EXISTS ( SELECT 1
   FROM price_lists pl
  WHERE ((pl.id = price_list_items.price_list_id) AND (pl.org_id = (select current_org_id())))))));

alter policy price_list_items_select on public.price_list_items
  using ((EXISTS ( SELECT 1
   FROM price_lists pl
  WHERE ((pl.id = price_list_items.price_list_id) AND (pl.org_id = (select current_org_id()))))));

alter policy price_list_items_update on public.price_list_items
  using ((((select current_role_gnk()) = ANY (ARRAY['admin'::user_role, 'listing_manager'::user_role])) AND (EXISTS ( SELECT 1
   FROM price_lists pl
  WHERE ((pl.id = price_list_items.price_list_id) AND (pl.org_id = (select current_org_id())))))))
  with check ((EXISTS ( SELECT 1
   FROM price_lists pl
  WHERE ((pl.id = price_list_items.price_list_id) AND (pl.org_id = (select current_org_id()))))));

alter policy price_lists_delete on public.price_lists
  using (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = ANY (ARRAY['admin'::user_role, 'listing_manager'::user_role])) AND (version < ( SELECT max(pl.version) AS max
   FROM price_lists pl
  WHERE (pl.project_id = price_lists.project_id)))));

alter policy price_lists_insert on public.price_lists
  with check (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = ANY (ARRAY['admin'::user_role, 'listing_manager'::user_role]))));

alter policy price_lists_select on public.price_lists
  using ((org_id = (select current_org_id())));

alter policy price_lists_update on public.price_lists
  using (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = ANY (ARRAY['admin'::user_role, 'listing_manager'::user_role]))))
  with check ((org_id = (select current_org_id())));

alter policy profiles_insert on public.profiles
  with check (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = 'admin'::user_role)));

alter policy profiles_select on public.profiles
  using ((org_id = (select current_org_id())));

alter policy property_keys_insert on public.property_keys
  with check (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = ANY (ARRAY['admin'::user_role, 'listing_manager'::user_role]))));

alter policy property_keys_select on public.property_keys
  using ((org_id = (select current_org_id())));

alter policy property_keys_update on public.property_keys
  using (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = ANY (ARRAY['admin'::user_role, 'listing_manager'::user_role]))))
  with check ((org_id = (select current_org_id())));

alter policy property_media_delete on public.property_media
  using (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = ANY (ARRAY['admin'::user_role, 'listing_manager'::user_role]))));

alter policy property_media_select on public.property_media
  using ((org_id = (select current_org_id())));

alter policy property_media_update on public.property_media
  using (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = ANY (ARRAY['admin'::user_role, 'listing_manager'::user_role]))))
  with check ((org_id = (select current_org_id())));

alter policy share_link_properties_select on public.share_link_properties
  using ((EXISTS ( SELECT 1
   FROM share_links s
  WHERE ((s.id = share_link_properties.share_link_id) AND (s.org_id = (select current_org_id()))))));

alter policy share_links_select on public.share_links
  using ((org_id = (select current_org_id())));

alter policy unit_types_delete on public.unit_types
  using (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = ANY (ARRAY['admin'::user_role, 'listing_manager'::user_role]))));

alter policy unit_types_insert on public.unit_types
  with check (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = ANY (ARRAY['admin'::user_role, 'listing_manager'::user_role]))));

alter policy unit_types_select on public.unit_types
  using ((org_id = (select current_org_id())));

alter policy unit_types_update on public.unit_types
  using (((org_id = (select current_org_id())) AND ((select current_role_gnk()) = ANY (ARRAY['admin'::user_role, 'listing_manager'::user_role]))))
  with check ((org_id = (select current_org_id())));

-- ---------------------------------------------------------------------------
-- The guard looks at the whole schema now
-- ---------------------------------------------------------------------------
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
  'Every policy in public — permissive or restrictive — that still calls '
  'current_org_id() or current_role_gnk() outside a (select …) wrapper, i.e. '
  'once per row. Schema-wide since 0147 (0030 hoisted the 7 paginated list '
  'tables, 0100 twelve more policies, 0147 the last 51 on 19 tables). Empty '
  'means fully hoisted. Asserted by supabase/tests/rls-hoist.test.ts. '
  'The public. stripping is load-bearing: pg_policies.qual is deparsed by '
  'pg_get_expr() against the CALLER search_path, so with pg_catalog pinned the '
  'call renders as public.current_org_id() and an unqualified literal never '
  'matches — which silently inverts this guard.';

comment on function public.rls_bare_auth_calls() is
  'Every policy in public that still calls auth.uid()/auth.jwt()/auth.role() '
  'outside a (select …) wrapper, i.e. once per row. Schema-wide since 0100 '
  '(0030/0032 hoisted the 7 list tables, 0100 the remaining 12 the advisor '
  'reported). Empty means the whole schema is hoisted and Supabase''s '
  '`auth_rls_initplan` advisor should be silent. Pairs with '
  'rls_bare_helper_calls(), schema-wide for the two RLS helpers since 0147 '
  '(no policy calls either bare), and rls_hoisted_policy_count(), the '
  'presence check on the seven list tables.';

comment on function public.rls_hoisted_policy_count() is
  'How many policies on the 7 paginated list tables carry a hoisted '
  'current_org_id() call. Expected 24 after migration 0030 and 21 after 0100 '
  '(contacts/deals/leads each merged two UPDATE policies into one); 0147 does '
  'not change it. A presence check: rls_bare_helper_calls() proves no policy '
  'in the schema calls a helper bare (since 0147), this proves the list '
  'tables'' policies still exist. NOTE: counts hoisted current_org_id() ONLY; '
  'complete only together with rls_bare_helper_calls().';

-- ---------------------------------------------------------------------------
-- Self-check (0030 / 0100's): meaning unchanged, exactly the 51 rewritten,
-- nothing bare schema-wide, the guards' shape and grants kept
-- ---------------------------------------------------------------------------
create function pg_temp.n_0147(s text) returns text language sql immutable as $$
  -- the public. prefix FIRST, then the wrapper (0030's trap)
  select replace(replace(replace(replace(s,
    'public.current_org_id()',   'current_org_id()'),
    'public.current_role_gnk()', 'current_role_gnk()'),
    '( SELECT current_org_id() AS current_org_id)',     'current_org_id()'),
    '( SELECT current_role_gnk() AS current_role_gnk)', 'current_role_gnk()')
$$;

do $$
declare
  v_before int;
  v_after  int;
  v_diag   text;
  v_names  text;
begin
  select count(*) into v_before from _before_0147;
  select count(*) into v_after from pg_policies where schemaname = 'public';
  if v_after <> v_before then
    raise exception '0147 self-check: the policy count went % -> %', v_before, v_after;
  end if;

  -- every policy: the same command, roles and flag, and the same predicate
  -- once both sides are normalised
  select string_agg(b.tablename || '.' || b.policyname, ', ' order by b.tablename, b.policyname) into v_diag
    from _before_0147 b
    left join pg_policies p
      on p.schemaname = 'public' and p.tablename = b.tablename and p.policyname = b.policyname
   where p.policyname is null
      or p.cmd is distinct from b.cmd
      or p.permissive is distinct from b.permissive
      or p.roles is distinct from b.roles
      or pg_temp.n_0147(p.qual) is distinct from pg_temp.n_0147(b.qual)
      or pg_temp.n_0147(p.with_check) is distinct from pg_temp.n_0147(b.with_check);
  if v_diag is not null then
    raise exception '0147 self-check: a policy changed MEANING, not just evaluation strategy: %', v_diag;
  end if;

  -- a check that never matches passes vacuously: exactly the 51 changed text
  select string_agg(b.tablename || '.' || b.policyname, ',' order by b.tablename || '.' || b.policyname) into v_names
    from _before_0147 b
    join pg_policies p
      on p.schemaname = 'public' and p.tablename = b.tablename and p.policyname = b.policyname
   where p.qual is distinct from b.qual or p.with_check is distinct from b.with_check;
  if v_names is distinct from current_setting('gnk.m0147_names', true) then
    raise exception '0147 self-check: the rewritten policies are not exactly the 51 (rewritten: %)', coalesce(v_names, 'none');
  end if;

  -- nothing bare, schema-wide: the widened guard, and a scan that does not trust it
  select string_agg(g.tablename || '.' || g.policyname, ', ') into v_diag from public.rls_bare_helper_calls() g;
  if v_diag is not null then
    raise exception '0147 self-check: rls_bare_helper_calls() still reports %', v_diag;
  end if;
  select string_agg(p.tablename || '.' || p.policyname, ', ') into v_diag
    from pg_policies p
   where p.schemaname = 'public'
     and (select count(*) from regexp_matches(coalesce(p.qual, '') || ' ' || coalesce(p.with_check, ''),
                                              '(current_org_id|current_role_gnk)\(\)', 'g'))
         <> (select count(*) from regexp_matches(coalesce(p.qual, '') || ' ' || coalesce(p.with_check, ''),
                                                 '\( SELECT (public\.)?(current_org_id|current_role_gnk)\(\) AS (current_org_id|current_role_gnk)\)', 'g'));
  if v_diag is not null then
    raise exception '0147 self-check: a policy still calls a helper bare (independent scan): %', v_diag;
  end if;

  -- the presence checks hold
  if public.rls_hoisted_policy_count() <> 21 then
    raise exception '0147 self-check: rls_hoisted_policy_count() reads %, not 21', public.rls_hoisted_policy_count();
  end if;
  if exists (select 1 from public.rls_bare_auth_calls()) then
    raise exception '0147 self-check: rls_bare_auth_calls() is no longer empty';
  end if;

  -- the guard kept its shape and its grants (create or replace keeps the
  -- ACL; the restore pack pins it — said here too, as 0100 did)
  if not exists (select 1 from pg_proc p
                  where p.oid = 'public.rls_bare_helper_calls()'::regprocedure
                    and p.prosecdef and p.provolatile = 's' and pg_get_userbyid(p.proowner) = 'postgres'
                    and p.proconfig = array['search_path=pg_catalog']
                    and pg_get_function_result(p.oid) = 'TABLE(tablename text, policyname text)'
                    and p.proacl::text = current_setting('gnk.m0147_guard_acl', true)
                    and not has_function_privilege('anon', p.oid, 'execute')
                    and not has_function_privilege('authenticated', p.oid, 'execute')
                    and md5(replace(p.prosrc, E'\r', '')) = 'bbf45e18e481985b9d6491045388da68') then
    raise exception '0147 self-check: rls_bare_helper_calls() is not this file''s body, or lost its shape or its grants';
  end if;

  raise notice '0147: self-check passed — % policies, 51 hoisted on 19 tables with their meaning unchanged, no bare helper call in the schema', v_after;
end $$;

drop function pg_temp.n_0147(text);
drop table _before_0147;

-- for the CLI: a one-row summary (a guarded hosted apply discards it)
select format('0147 applied — %s policies hoisted on %s tables; bare helper calls schema-wide: %s; list-table hoisted count: %s',
              cardinality(string_to_array(current_setting('gnk.m0147_names', true), ',')),
              (select count(distinct split_part(x, '.', 1)) from unnest(string_to_array(current_setting('gnk.m0147_names', true), ',')) x),
              (select count(*) from public.rls_bare_helper_calls()),
              public.rls_hoisted_policy_count()) as summary;
