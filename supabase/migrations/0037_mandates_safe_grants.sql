-- 0037 — take back the grants on `mandates_safe` that nobody ever asked for.
--
-- Found 2026-08-21 while applying 0036, by capturing the view's ACL before
-- replacing it. Hosted read:
--
--   anon          = arwdDxtm
--   authenticated = arwdDxtm
--
-- while 0002 grants `select` to `authenticated` AND NOTHING ELSE, and no
-- migration has ever revoked anything here. Hosted picked the rest up from
-- Supabase's default privileges on `public`; local did not. Hosted has been the
-- outlier since the view was created.
--
-- WHY THE WRITE BITS ARE THE PROBLEM, and not merely untidy:
--
--   * `mandates_safe` is a simple view over one table, so Postgres makes it
--     AUTO-UPDATABLE — `information_schema.views.is_insertable_into` is YES.
--   * Its owner is `postgres`, which has `rolbypassrls`, and the view is not
--     `security_invoker`. A write routed through it is therefore performed as
--     the owner and DOES NOT GO THROUGH `mandates` RLS.
--   * RLS is the only thing stopping a non-admin creating mandates or setting
--     `commission_pct` — the number the business gets paid on.
--   * INSERT is the live path: an auto-updatable view without WITH CHECK OPTION
--     does not apply its own WHERE clause to inserts, so a row need not be
--     visible through the view to be written through it. UPDATE and DELETE are
--     bounded by that WHERE, which for `anon` matches nothing.
--
-- This was established from catalogue facts. No write was attempted against
-- production to confirm it, and none is needed: the three properties above are
-- each independently observable.
--
-- THE FIX IS TO MAKE HOSTED SAY WHAT 0002 ALREADY SAYS. On local this is very
-- nearly a no-op (it removes `Dxtm` from anon, which is TRUNCATE/REFERENCES/
-- TRIGGER/MAINTAIN on a view — meaningless but equally unasked-for). Nothing in
-- the app can break: every mandate write goes through the BASE TABLE as an
-- admin, and no code path reads this view as `anon`.
--
-- `service_role` is deliberately untouched. 0022 dealt with service_role grants
-- on its own terms and this migration is not the place to reopen that.
--
-- The two other views in `public` — `geography_columns` and `geometry_columns` —
-- carry the same broad grants and are deliberately left alone: they arrive with
-- PostGIS, are views over `pg_catalog`, and are not this project's to manage.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

revoke all privileges on table public.mandates_safe from anon;
revoke all privileges on table public.mandates_safe from authenticated;

-- restore exactly what 0002 asked for, and only that
grant select on table public.mandates_safe to authenticated;

do $$
begin
  -- listing managers read mandates ONLY through this view; losing SELECT here
  -- would empty the mandate panel for them without any error to explain it
  if not has_table_privilege('authenticated', 'public.mandates_safe', 'select') then
    raise exception '0037 aborted: authenticated must keep SELECT on mandates_safe';
  end if;

  if has_table_privilege('authenticated', 'public.mandates_safe', 'insert')
     or has_table_privilege('authenticated', 'public.mandates_safe', 'update')
     or has_table_privilege('authenticated', 'public.mandates_safe', 'delete') then
    raise exception '0037 aborted: authenticated still holds a write grant on mandates_safe';
  end if;

  if has_table_privilege('anon', 'public.mandates_safe', 'select')
     or has_table_privilege('anon', 'public.mandates_safe', 'insert')
     or has_table_privilege('anon', 'public.mandates_safe', 'update')
     or has_table_privilege('anon', 'public.mandates_safe', 'delete') then
    raise exception '0037 aborted: anon still holds a grant on mandates_safe';
  end if;

  raise notice '0037 ok: mandates_safe is SELECT for authenticated and nothing for anon';
end $$;
