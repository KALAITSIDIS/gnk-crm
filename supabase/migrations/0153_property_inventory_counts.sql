-- =============================================================================
-- 0153 — the dashboard's inventory is counted over exactly the properties
-- list's default scope, per kind and status (F04-C, product review 2026-10-18,
-- DECISIONS F04-C).
--
-- THE DEFECT. The admin dashboard's "Listings by status" card reads
-- admin_dashboard_stats' property_statuses key (0093, now 0140): count(*) of
-- properties where visibility <> 'archived', grouped by status. That counts
-- every KIND (standalone listings, projects, phases and units) and includes
-- WITHDRAWN rows. The properties list's default is "not archived and not
-- withdrawn" (lib/queries/properties-list.ts, resolvePropertyScope) and hides
-- units unless asked (resolvePropertyKindScope). So "available 10" on the
-- dashboard was 4 rows on the default list plus 6 on "Units only", no single
-- list view reproduced it, nothing on either screen said so, and a project
-- with status available was counted as stock beside its own units although a
-- container cannot be reserved (lib/services/quality-score.ts).
--
-- THE FIX. One new function, public.property_inventory_counts():
--   - returns (kind, status, n): live properties grouped by kind and status,
--     where live is visibility <> 'archived' AND status <> 'withdrawn' —
--     exactly the list's default "active" scope, so each (status, kind) count
--     is the row count of /properties?status=S&kind=K and each status total
--     the row count of /properties?status=S&kind=all;
--   - SECURITY INVOKER, STABLE, search_path = public: it counts under the
--     caller's RLS (properties_select: the caller's organisation; the
--     restrictive require_aal2), like admin_dashboard_stats (0018);
--   - EXECUTE for authenticated and service_role only — not PUBLIC, not anon.
-- The dashboard's Inventory card (components/features/dashboard/
-- inventory-card.tsx) reads it and links every number to the list that shows
-- it. admin_dashboard_stats is NOT touched: its property_statuses key is now
-- unread and goes the next time that function is replaced (BACKLOG).
--
-- EXISTING DATA. None read or written. The postflight's probe writes an
-- organisation and six properties inside a block that undoes them.
--
-- LOCKS. CREATE FUNCTION takes no table lock. The postflight probe inserts
-- into organizations and properties (ROW EXCLUSIVE): it waits only behind a
-- session holding SHARE or stronger on either table (a migration, a VALIDATE),
-- for at most lock_timeout (5 s) — a collision costs a clean 55P03: apply
-- again, and do NOT write the ledger row. Run twice, the file replaces the
-- function with the same body and changes nothing.
--
-- DEPLOY ORDER: hosted FIRST, then the application release whose dashboard
-- calls it (that release's Inventory card throws to the error boundary
-- without it). Additive: the deployed application never calls it. A new
-- function, no shape change of an existing one — no release-compat entry.
-- lib/supabase/database.types.ts gains this function's entry.
--
-- ROLLBACK (DECISIONS F04-C): the application release that reads the
-- function FIRST (the previous dashboard reads property_statuses, which this
-- file leaves in place), then a FORWARD migration dropping the function under
-- the same bounded lock (supabase/tests/revert-0153.ts holds the text), moving
-- the verify-restore migrations pin FORWARD and removing its 0153 row and its
-- grants_expected row. No data moves.
--
-- NUMBERING: 0150/0151 are the portal session's; 0152, 0154 and 0155 are other
-- streams of the same review. The ledger tolerates the gaps (0141's header).
--
-- Pins that move with this file: scripts/backup/verify-restore.sql (the
-- migrations count, one 0153 INTEGRITY row, one grants_expected row);
-- lib/supabase/database.types.ts (this function only). NO EXPLICIT
-- begin/commit — the CLI wraps the file (HANDOFF §3), as does one execute_sql
-- call; applied hosted inside the md5-guarded DO (DECISIONS
-- T-unit-type-apply-atomic). The file's LAST result is a read-only summary
-- for the CLI.
-- =============================================================================

-- Bounded lock waits (0113's lesson); see LOCKS above.
set local lock_timeout = '5s';

-- The file must run as ONE transaction (the CLI's wrapper, or one
-- execute_sql call): otherwise SET LOCAL is a no-op and a failed postflight
-- would not undo the function before it.
do $$
begin
  if current_setting('lock_timeout') <> '5s' then
    raise exception '0153 aborted: this file must run as ONE transaction (SET LOCAL lock_timeout did not take effect) — nothing was changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 0. Preflight — the table is what this file counts, its tenant boundary is
--    RLS, and the name is free (or this file's own, on a replay)
-- ---------------------------------------------------------------------------
do $$
declare
  v_n   int;
  v_md5 text;
begin
  -- 1. an invoker's tenant boundary is the table's RLS: it must be on, with
  --    the org-scoped properties_select and the restrictive require_aal2
  if not exists (select 1 from pg_class c
                  where c.oid = to_regclass('public.properties') and c.relkind = 'r' and c.relrowsecurity) then
    raise exception '0153 aborted: public.properties is not a table with row level security enabled — nothing was changed';
  end if;
  if not exists (select 1 from pg_policy p
                  where p.polrelid = 'public.properties'::regclass and p.polname = 'properties_select'
                    and p.polcmd = 'r' and p.polpermissive
                    and pg_get_expr(p.polqual, p.polrelid)
                        ~ '^\(org_id = \( SELECT (public\.)?current_org_id\(\) AS current_org_id\)\)$')
     or not exists (select 1 from pg_policy p
                     where p.polrelid = 'public.properties'::regclass and p.polname = 'require_aal2'
                       and p.polcmd = '*' and not p.polpermissive) then
    raise exception '0153 aborted: public.properties is not read through the org-scoped properties_select and the restrictive require_aal2 — nothing was changed';
  end if;

  -- 2. the columns the predicate and the grouping name: the 0001 enums, NOT NULL
  if (select count(*) from pg_attribute a
       where a.attrelid = 'public.properties'::regclass and a.attnum > 0 and not a.attisdropped and a.attnotnull
         and ((a.attname = 'kind'       and a.atttypid = 'public.property_kind'::regtype)
           or (a.attname = 'status'     and a.atttypid = 'public.property_status'::regtype)
           or (a.attname = 'visibility' and a.atttypid = 'public.visibility_level'::regtype))) <> 3 then
    raise exception '0153 aborted: public.properties is not (kind property_kind, status property_status, visibility visibility_level), all NOT NULL — nothing was changed';
  end if;
  if not ('archived' = any (enum_range(null::public.visibility_level)::text[]))
     or not ('withdrawn' = any (enum_range(null::public.property_status)::text[])) then
    raise exception '0153 aborted: visibility_level has no ''archived'' or property_status no ''withdrawn'' — nothing was changed';
  end if;

  -- 3. the name is free, or holds this file's own function (a replay). The
  --    digest is md5(replace(prosrc, chr(13), '')) of the body below.
  select count(*) into v_n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'property_inventory_counts';
  if v_n > 1 then
    raise exception '0153 aborted: public.property_inventory_counts already has % overloads — nothing was changed', v_n;
  end if;
  if v_n = 1 then
    select md5(replace(p.prosrc, chr(13), '')) into v_md5
      from pg_proc p
     where p.oid = to_regprocedure('public.property_inventory_counts()') and not p.prosecdef;
    if v_md5 is distinct from '08fd3810d66ff221198a022f9bf58c5c' then
      raise exception '0153 aborted: public.property_inventory_counts exists and is not this file''s (md5 %) — read it before replacing it; nothing was changed', coalesce(v_md5, 'n/a: another signature, or SECURITY DEFINER');
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. The function
-- ---------------------------------------------------------------------------
create or replace function public.property_inventory_counts()
returns table (kind public.property_kind, status public.property_status, n bigint)
language sql
stable
security invoker
set search_path = public
as $fn$
  select p.kind, p.status, count(*) as n
    from public.properties p
   where p.visibility <> 'archived'
     and p.status <> 'withdrawn'
   group by p.kind, p.status
   order by p.kind, p.status
$fn$;

-- default privileges hand a new function to PUBLIC (and, hosted, to anon)
revoke execute on function public.property_inventory_counts() from public, anon;
grant  execute on function public.property_inventory_counts() to authenticated, service_role;

comment on function public.property_inventory_counts() is
  'Live properties per kind and status (0153, F04-C): visibility <> archived AND status <> withdrawn — exactly the '
  'properties list''s default scope (lib/queries/properties-list.ts), so each (status, kind) count is the row count of '
  '/properties?status=S&kind=K. SECURITY INVOKER: counts under the caller''s RLS. Read by the admin dashboard''s '
  'Inventory card; a project or phase is one record, its units are counted as units.';

-- ---------------------------------------------------------------------------
-- 2. Postflight — the shape, the grants, then the behaviour, inside a block
--    that undoes what it writes
-- ---------------------------------------------------------------------------
do $$
declare
  sig constant text := 'public.property_inventory_counts()';
  v_org     uuid;
  v_project uuid;
  v_got     text;
begin
  if (select count(*) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
       where ns.nspname = 'public' and p.proname = 'property_inventory_counts') <> 1 then
    raise exception '0153 postflight: expected exactly one public.property_inventory_counts';
  end if;
  if not exists (select 1 from pg_proc p
                  where p.oid = to_regprocedure(sig)
                    and not p.prosecdef
                    and p.provolatile = 's'
                    and p.prolang = (select l.oid from pg_language l where l.lanname = 'sql')
                    and p.proretset and p.prorettype = 'record'::regtype
                    and p.proargnames = array['kind', 'status', 'n']
                    and p.proargmodes = array['t', 't', 't']::"char"[]
                    and p.proallargtypes = array['public.property_kind'::regtype, 'public.property_status'::regtype, 'bigint'::regtype]::oid[]
                    and pg_get_userbyid(p.proowner) = 'postgres'
                    and p.proconfig = array['search_path=public']
                    and md5(replace(p.prosrc, chr(13), '')) = '08fd3810d66ff221198a022f9bf58c5c') then
    raise exception '0153 postflight: % is not the function this file wrote (SECURITY INVOKER, STABLE, sql, TABLE(kind, status, n bigint), owner postgres, search_path=public, its body)', sig;
  end if;
  if has_function_privilege('anon', sig, 'execute')
     or not has_function_privilege('authenticated', sig, 'execute')
     or not has_function_privilege('service_role', sig, 'execute')
     or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 where p.oid = to_regprocedure(sig) and a.grantee = 0) then
    raise exception '0153 postflight: the grants on % are not authenticated + service_role, without anon or PUBLIC', sig;
  end if;

  -- behaviour, undone. As postgres the function reads every organisation (the
  -- owner is not held to RLS), so the probe organisation's share is the
  -- function's rows minus every OTHER organisation's, counted by hand — in ONE
  -- statement, so one snapshot (a STABLE function reads its caller's): a
  -- write committed elsewhere meanwhile cannot skew the difference.
  begin
    insert into public.organizations (name, slug)
      values ('0153 probe (rolled back)', '0153-probe-' || replace(gen_random_uuid()::text, '-', ''))
      returning id into v_org;
    insert into public.properties (org_id, reference, property_type, kind, status, visibility) values
      (v_org, 'ZZZ0153-S1', 'apartment', 'standalone', 'available', 'private'),
      (v_org, 'ZZZ0153-S2', 'apartment', 'standalone', 'withdrawn', 'private');
    insert into public.properties (org_id, reference, property_type, kind, status, visibility)
      values (v_org, 'ZZZ0153-P1', 'building', 'project', 'available', 'private')
      returning id into v_project;
    insert into public.properties (org_id, reference, property_type, kind, status, visibility, parent_id) values
      (v_org, 'ZZZ0153-U1', 'apartment', 'unit', 'available', 'private',  v_project),
      (v_org, 'ZZZ0153-U2', 'apartment', 'unit', 'available', 'public',   v_project),
      (v_org, 'ZZZ0153-U3', 'apartment', 'unit', 'available', 'archived', v_project);

    with f as (select * from public.property_inventory_counts()),
         o as (select p.kind, p.status, count(*) as n
                 from public.properties p
                where p.org_id <> v_org and p.visibility <> 'archived' and p.status <> 'withdrawn'
                group by p.kind, p.status)
    select coalesce(string_agg(format('%s/%s=%s', coalesce(f.kind, o.kind), coalesce(f.status, o.status),
                                      coalesce(f.n, 0) - coalesce(o.n, 0)),
                               ' ' order by coalesce(f.kind, o.kind), coalesce(f.status, o.status)), '')
      into v_got
      from f full join o on o.kind = f.kind and o.status = f.status
     where coalesce(f.n, 0) <> coalesce(o.n, 0);
    if v_got <> 'standalone/available=1 project/available=1 unit/available=2' then
      raise exception '0153 postflight: % counted the probe as "%" — expected standalone/available=1 project/available=1 unit/available=2 (the withdrawn listing and the archived unit not at all)', sig, v_got;
    end if;
    raise exception using errcode = 'P0001', message = '0153-postflight-undo';
  exception
    when raise_exception then
      if sqlerrm <> '0153-postflight-undo' then
        raise;
      end if;
  end;

  raise notice '0153: postflight passed — property_inventory_counts() is a STABLE SECURITY INVOKER for authenticated + service_role that counts live properties (not archived, not withdrawn) per kind and status';
end $$;

-- for the CLI: a read-only summary (a guarded hosted apply discards it)
select '0153 applied — property_inventory_counts(): live properties (not archived, not withdrawn) per kind and status, under the caller''s RLS' as applied;
