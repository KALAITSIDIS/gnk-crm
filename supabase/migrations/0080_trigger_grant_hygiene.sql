-- 0080 — the last two trigger bodies join the no-execute posture.
--
-- Found by the 2026-09-01 post-audit review's new fail-closed grants check
-- (verify-restore.sql `grant_unpinned`, added the same day): every trigger
-- function in the schema had its EXECUTE revoked from public/anon/
-- authenticated back in 0007/0021 ("callable by nobody over PostgREST") —
-- except `set_updated_at` and `protect_property_reference`, which still
-- carry the default PUBLIC grant.
--
-- SEVERITY: hygiene, not a hole. Both return `trigger`, and PostgREST
-- refuses to expose trigger-returning functions as RPCs, so the grant was
-- never reachable from outside. The point is consistency: the restore pack
-- pins "trigger bodies: callable by nobody", and a posture that is true for
-- six of eight trigger functions is a posture nobody can verify mechanically.
--
-- Idempotent by nature (revoke of an absent grant is a no-op).
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

revoke execute on function public.set_updated_at()             from public, anon, authenticated;
revoke execute on function public.protect_property_reference() from public, anon, authenticated;

do $$
declare
  bad text;
begin
  select string_agg(p.proname, ', ') into bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('set_updated_at', 'protect_property_reference')
     and (has_function_privilege('anon', p.oid, 'EXECUTE')
          or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  if bad is not null then
    raise exception '0080 aborted: still executable by app roles: %', bad;
  end if;

  -- and they must still exist — a typo'd revoke would have errored above,
  -- but assert the pair is present so this file self-documents its scope
  if (select count(*) from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('set_updated_at', 'protect_property_reference')) <> 2 then
    raise exception '0080 aborted: expected both trigger functions to exist';
  end if;

  raise notice '0080: set_updated_at + protect_property_reference revoked from app roles — all trigger bodies now no-execute';
end $$;
