-- =============================================================================
-- 0096 — PostGIS catalog guard (security & compliance audit 2026-09-15, AC-04)
--
-- WHAT THIS CLOSES. The PostGIS install grants the anon and authenticated API
-- roles full DML on public.spatial_ref_sys — a real 8,500-row reference table
-- that PostgREST exposes. Measured on hosted 2026-09-15: an anon DELETE and an
-- anon UPDATE, carrying only the publishable key that every browser loading the
-- CRM holds, each answered 204. Anyone on the internet could wipe the coordinate
-- reference data and break every geography operation (the map, area centroids,
-- the approximate-location feed). Confidentiality is not at risk — the rows are
-- the public EPSG registry — but integrity and availability are.
--
-- WHY A TRIGGER, NOT A REVOKE. The table is owned by supabase_admin and every
-- grant on it was made BY supabase_admin. `postgres` — the role every migration
-- and the management tooling run as — is not the owner, not a member of
-- supabase_admin, and not a superuser (pg_has_role(postgres, supabase_admin,
-- MEMBER) = false, measured), so `REVOKE ... FROM anon` is a silent no-op: the
-- ACL is unchanged and no error is raised. What postgres DOES hold on the table
-- is the TRIGGER privilege, so a statement-level guard is the fix that actually
-- applies from a customer-accessible role. The grants themselves remain in the
-- ACL and can only be revoked by Supabase; that residual is tracked in DECISIONS
-- T-audit-r06-postgis (a support request), and the guard stands in front of it.
--
-- The sibling objects public.geometry_columns and public.geography_columns are
-- VIEWS over the system catalogs and are not updatable (an anon DELETE answers
-- SQLSTATE 0A000, "you need an ON DELETE DO INSTEAD rule"), so they carry no
-- write hole and need no guard. anon keeps SELECT on all three — public
-- reference metadata — which is unchanged.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).
-- =============================================================================

create or replace function public.forbid_srs_api_writes() returns trigger
language plpgsql security invoker set search_path = public as $fn$
begin
  -- Reads are untouched; only writes from the two untrusted PostgREST roles are
  -- refused. postgres (migrations), supabase_admin (platform) and service_role
  -- (trusted server code) fall through this and may still write.
  if current_user in ('anon', 'authenticated') then
    raise exception 'spatial_ref_sys is read-only for API roles (audit AC-04 / 0096)'
      using errcode = 'insufficient_privilege';
  end if;
  return null; -- statement-level trigger: the return value is ignored
end $fn$;

drop trigger if exists trg_srs_api_readonly on public.spatial_ref_sys;
create trigger trg_srs_api_readonly
  before insert or update or delete or truncate on public.spatial_ref_sys
  for each statement execute function public.forbid_srs_api_writes();

-- ---- self-verification: prove the guard refuses an anon write, on every apply
-- (hosted, CI and a local reset all run this). postgres holds ADMIN on the anon
-- role, so it may briefly assume it to probe the guard from the attacker's seat.
do $$
declare
  blocked boolean := false;
begin
  if (select count(*) from pg_trigger
        where tgrelid = 'public.spatial_ref_sys'::regclass
          and tgname = 'trg_srs_api_readonly' and not tgisinternal) <> 1 then
    raise exception '0096 aborted: trg_srs_api_readonly is not installed';
  end if;

  begin
    set local role anon;
    begin
      -- srid = -99999 matches no row; the statement-level guard fires first
      delete from public.spatial_ref_sys where srid = -99999;
    exception
      when insufficient_privilege then blocked := true;
    end;
    reset role;
  exception
    when others then
      reset role;
      raise;
  end;

  if not blocked then
    raise exception '0096 aborted: an anon write to spatial_ref_sys was NOT refused';
  end if;

  raise notice '0096: spatial_ref_sys guarded — anon/authenticated writes refused, reads intact.';
end $$;
