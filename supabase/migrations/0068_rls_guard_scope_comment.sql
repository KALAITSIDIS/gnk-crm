-- 0068 — say what rls_bare_auth_calls() actually checks.
--
-- A one-line fix for a trap that cost real time on 2026-08-29, and would have
-- cost it again.
--
-- WHAT HAPPENED. Supabase's performance advisor reports `auth_rls_initplan` for
-- TWELVE policies (profiles, property_media, mandates, share_links, offers,
-- viewing_slips, cyprus_config, share_link_properties). The obvious check is
-- this repo's own guard:
--
--   select count(*) from rls_bare_auth_calls();   ->  0
--
-- Zero. So either the advisor is wrong or migration 0032 regressed — and
-- neither is true. The guard's body is scoped to seven tables:
--
--   and p.tablename in ('contacts','deals','events','leads','properties',
--                       'tasks','viewings')
--
-- and the advisor's twelve are on tables it never looks at. It returns 0 and
-- ALWAYS WILL, however many unhoisted policies exist outside that list.
--
-- THE TWELVE ARE KNOWN AND DELIBERATE. 0032's header names them exactly —
-- "0030 excluded those tables ON PURPOSE, with its reasoning in its header, and
-- this migration does not reopen that decision." Nothing here reopens it
-- either. This migration changes no policy and no function body.
--
-- WHY IT WAS WORTH A MIGRATION ANYWAY. `rls_bare_helper_calls()` and
-- `rls_hoisted_policy_count()` both carry careful comments naming their
-- seven-table scope. `rls_bare_auth_calls()` — the one someone actually reaches
-- for when the advisor complains about `auth.uid()` — carried NO COMMENT. A
-- guard that returns 0 without saying what it looked at reads as "all clear"
-- when it means "clear in seven of thirty-odd tables". That is the same shape
-- as the traps HANDOFF §0 is full of: not a wrong answer, an answer to a
-- narrower question than the one asked.

comment on function public.rls_bare_auth_calls() is
  'Policies on the 7 PAGINATED LIST TABLES ONLY (contacts, deals, events, '
  'leads, properties, tasks, viewings) that still call auth.uid() outside a '
  '(select …) wrapper, i.e. once per row. Empty means those seven are fully '
  'hoisted — it does NOT mean the database is clean. Supabase''s '
  '`auth_rls_initplan` advisor additionally reports 12 policies on '
  'config/staff-bounded tables (cyprus_config, mandates, offers, profiles, '
  'property_media, share_link_properties, share_links, viewing_slips) which '
  '0030 excluded ON PURPOSE and 0032 declined to reopen. Those 12 are expected '
  'and this guard is blind to them by construction. Pairs with '
  'rls_bare_helper_calls() and rls_hoisted_policy_count(), which carry the same '
  'seven-table scope.';

do $$
declare
  c_auth   text;
  n_scoped int;
begin
  c_auth := obj_description('public.rls_bare_auth_calls()'::regprocedure, 'pg_proc');
  if c_auth is null then
    raise exception '0068: the comment did not take';
  end if;

  -- the sibling guards must still agree that the seven tables are clean; this
  -- migration is documentation and must not have changed behaviour
  if (select count(*) from public.rls_bare_auth_calls())   <> 0 then
    raise exception '0068: rls_bare_auth_calls() is no longer 0 — a policy regressed';
  end if;
  if (select count(*) from public.rls_bare_helper_calls()) <> 0 then
    raise exception '0068: rls_bare_helper_calls() is no longer 0 — a policy regressed';
  end if;

  select count(*) into n_scoped
    from pg_policies
   where schemaname = 'public'
     and tablename in ('contacts','deals','events','leads','properties','tasks','viewings');

  raise notice '0068: guard documented. % policies in the guarded seven-table scope; the 12 outside it are 0030/0032''s recorded decision.',
    n_scoped;
end $$;
