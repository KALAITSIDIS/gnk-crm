-- =============================================================================
-- 0010 — Restore service_role EXECUTE lost in 0007 (audit fix, 2026-07-16)
--
-- 0007 revoked EXECUTE `from public` on the definer functions. service_role
-- is not a superuser — its EXECUTE came from that PUBLIC default grant, so
-- the revoke silently broke two real code paths that 0007's own comments
-- promise to keep working:
--   * verify_events_chain — lib/services/evidence.ts (commission evidence
--     report) and supabase/tests/rls.test.ts call it with the admin client
--     (caught by RLS test 12 the first time the suite ran after 0007).
--   * next_reference — scripts/import/properties.mts generates references
--     through the service-role client during CSV import.
-- anon/authenticated stay revoked exactly as 0007 intended.
-- =============================================================================

grant execute on function public.verify_events_chain(uuid) to service_role;
grant execute on function public.next_reference(uuid, text) to service_role;
