-- 0007: Security hardening — lock down SECURITY DEFINER RPC surface, pin
-- function search_path, and tighten the public media bucket. Closes Supabase
-- security advisors 0011 (function_search_path_mutable), 0025
-- (public_bucket_allows_listing), 0028/0029 (anon/authenticated can execute
-- SECURITY DEFINER functions). No DDL to tables; grants/policies only.
--
-- Rationale: Supabase default privileges grant EXECUTE on public-schema
-- functions to anon + authenticated. That exposed mutating definer functions
-- (expire_mandates, next_reference) at /rest/v1/rpc/* to unauthenticated
-- callers. We revoke, then re-grant EXECUTE only where a real code path needs
-- it (see docs/DECISIONS.md, T-sec).

-- ---------------------------------------------------------------------------
-- 1. Fully locked: no PostgREST caller needs these.
--    * expire_mandates      — pg_cron only (runs as superuser; grant-agnostic)
--    * verify_events_chain   — evidence.ts / rls.test.ts call it via service role
--    * trigger functions     — fired by the engine, not called; EXECUTE not needed
-- ---------------------------------------------------------------------------
revoke execute on function public.expire_mandates()            from public, anon, authenticated;
revoke execute on function public.verify_events_chain(uuid)    from public, anon, authenticated;
revoke execute on function public.protect_document_columns()   from public, anon, authenticated;
revoke execute on function public.protect_profile_columns()    from public, anon, authenticated;
revoke execute on function public.trg_events_hash()            from public, anon, authenticated;
revoke execute on function public.trg_price_history()          from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Authenticated-only: revoke anon, keep authenticated.
--    * next_reference   — called with the user JWT in lib/actions/properties.ts
--    * current_org_id / current_role_gnk — referenced by RLS policies, so the
--      authenticated role must retain EXECUTE (anon touches no RLS'd rows).
-- ---------------------------------------------------------------------------
revoke execute on function public.next_reference(uuid, text) from public, anon;
grant  execute on function public.next_reference(uuid, text) to   authenticated;

revoke execute on function public.current_org_id()   from public, anon;
grant  execute on function public.current_org_id()   to   authenticated;

revoke execute on function public.current_role_gnk() from public, anon;
grant  execute on function public.current_role_gnk() to   authenticated;

-- ---------------------------------------------------------------------------
-- 3. Pin search_path on the two functions that were missing it (advisor 0011).
--    ALTER avoids re-emitting the bodies.
-- ---------------------------------------------------------------------------
alter function public.set_updated_at()            set search_path = public;
alter function public.protect_property_reference() set search_path = public;

-- ---------------------------------------------------------------------------
-- 4. Tighten the public `media` bucket (advisor 0025). The broad SELECT policy
--    let any client enumerate every object via storage.objects. Public object
--    URLs (getPublicUrl) serve without it, and the only .list() call uses the
--    service-role client (settings/organization branding), which bypasses RLS.
--    documents / signatures remain policy-less (signed URLs only) — unchanged.
-- ---------------------------------------------------------------------------
drop policy if exists storage_media_public_read on storage.objects;
