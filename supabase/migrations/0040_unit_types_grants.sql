-- 0040 — give `unit_types` the grants every other table here has.
--
-- 0039 created the table and said `grant select, insert, update, delete ... to
-- authenticated`. That is what it wanted. It is not what it got, on either
-- environment:
--
--                  intended                    actual (0039)
--   hosted         authenticated=arwd          anon=arwdDxtm, authenticated=arwdDxtm
--   local          authenticated=arwd          anon=Dxtm,     authenticated=arwdDxtm
--
-- while every other RLS table in this schema reads
-- `{postgres=arwdDxtm, service_role=arwdDxtm, authenticated=arwd}` — `price_lists`
-- and `payment_plans` exactly, `properties` with `arw` because doc 04 denies it
-- DELETE.
--
-- THE TRAP, WHICH GENERALISES TO EVERY FUTURE TABLE: Supabase sets default
-- privileges on `public` that fire at CREATE TABLE, and `grant` is ADDITIVE. A
-- migration that only grants therefore ends up with the platform's grants plus
-- its own, and the difference is invisible unless somebody reads `relacl`. The
-- older tables are clean because 0001/0002 predate this project's current
-- default privileges — not because granting is enough.
--
-- **A new table needs an explicit REVOKE before its GRANT.** That is the rule;
-- this migration is the correction for the one table that missed it.
--
-- HOW EXPOSED WAS IT? Less than 0037's case, and the difference is worth
-- stating rather than glossing. `unit_types` is a TABLE with RLS enabled, so
-- anon's grant was still filtered by the policies: every one of them tests
-- `org_id = current_org_id()`, which is null outside a session, so anon could
-- neither read nor insert a row. 0037's `mandates_safe` was a SECURITY DEFINER
-- view owned by a `rolbypassrls` role, where the grant WAS the whole control.
-- This is defence in depth restored, not a hole closed — but a grant nobody
-- asked for is exactly what you want gone before a policy is ever edited.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

revoke all privileges on table public.unit_types from anon;
revoke all privileges on table public.unit_types from authenticated;

grant select, insert, update, delete on table public.unit_types to authenticated;

do $$
declare
  acl text;
begin
  if has_table_privilege('anon', 'public.unit_types', 'select')
     or has_table_privilege('anon', 'public.unit_types', 'insert')
     or has_table_privilege('anon', 'public.unit_types', 'update')
     or has_table_privilege('anon', 'public.unit_types', 'delete') then
    raise exception '0040 aborted: anon still holds a grant on unit_types';
  end if;

  if not (has_table_privilege('authenticated', 'public.unit_types', 'select')
          and has_table_privilege('authenticated', 'public.unit_types', 'insert')
          and has_table_privilege('authenticated', 'public.unit_types', 'update')
          and has_table_privilege('authenticated', 'public.unit_types', 'delete')) then
    raise exception '0040 aborted: authenticated lost a grant it needs on unit_types';
  end if;

  -- the point of the exercise: identical to the table this one was modelled on
  select relacl::text into acl from pg_class where relname = 'unit_types';
  if acl <> (select relacl::text from pg_class where relname = 'price_lists') then
    raise exception '0040 aborted: unit_types ACL % does not match price_lists', acl;
  end if;

  raise notice '0040 ok: unit_types grants now identical to price_lists';
end $$;
