-- 0029 — DB-level 2FA enforcement (IMPROVEMENTS C2).
--
-- 2FA was enforced in the APP only: proxy.ts holds an aal1 session on
-- /login/verify, but a stolen aal1 JWT could still reach PostgREST directly and
-- read everything that session's role allows. DECISIONS T-2fa names this gap and
-- defers it to here.
--
-- OPT-IN TEMPLATE, deliberately: a user with NO verified factor is untouched.
-- That is not laziness, it is the lockout safety net — production has one admin
-- without a factor (BACKLOG, decided 2026-08-09: "C2 must not assume every admin
-- has a factor"), and he is who gets back in if this misfires.
--
-- `status = 'verified'` and not merely present: enroll() creates an `unverified`
-- factor immediately, so counting those would lock out anyone who closed the
-- enrolment tab. Same trap hasVerifiedFactor avoids in the app.
--
-- GRANTS ARE THE DANGEROUS PART (HANDOFF §4.3). A new security definer function
-- is executable by `public` — and therefore `anon` — by default. That default is
-- what migration 0021 missed.

create or replace function public.mfa_satisfied()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
      or not exists (
           select 1
             from auth.mfa_factors f
            where f.user_id = auth.uid()
              and f.status = 'verified'
         );
$$;

comment on function public.mfa_satisfied() is
  'True when the caller either holds an aal2 session or has no verified second '
  'factor at all (the Supabase opt-in template). Used by the require_aal2 '
  'restrictive policy on every RLS-enabled table. IMPROVEMENTS C2.';

revoke execute on function public.mfa_satisfied() from public, anon;
grant execute on function public.mfa_satisfied() to authenticated;

-- Coverage guard. Returns the RLS-enabled tables that do NOT carry
-- require_aal2, so a test can assert the set is empty. service_role only: it
-- describes the shape of the security model, which no ordinary session needs.
create or replace function public.rls_aal2_coverage()
returns table (missing_table text)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select t.tablename::text
    from pg_tables t
    join pg_class c
      on c.relname = t.tablename
     and c.relnamespace = 'public'::regnamespace
   where t.schemaname = 'public'
     and c.relrowsecurity
     and not exists (
           select 1
             from pg_policies p
            where p.schemaname = 'public'
              and p.tablename = t.tablename
              and p.policyname = 'require_aal2'
         )
   order by 1;
$$;

comment on function public.rls_aal2_coverage() is
  'RLS-enabled public tables missing the require_aal2 policy. Empty means full '
  'coverage. Asserted by supabase/tests/mfa-enforcement.test.ts so a new table '
  'cannot ship ungated. IMPROVEMENTS C2.';

revoke execute on function public.rls_aal2_coverage() from public, anon, authenticated;
grant execute on function public.rls_aal2_coverage() to service_role;

-- One restrictive policy per RLS-enabled table. RESTRICTIVE policies AND with
-- the permissive ones, so this narrows access and can never widen it.
--
-- `to authenticated` and NOT `to public`: anon never needs evaluating, and
-- scoping it keeps the anonymous /p/ buyer-proposal path obviously untouched
-- rather than resting on the predicate's second arm.
--
-- reference_counters and share_link_attempts have no permissive policies and
-- already deny everything to authenticated; they are included so the coverage
-- guard needs no exemption list.
--
-- Gating `profiles` does NOT deadlock: current_org_id() and current_role_gnk()
-- read it, but both are security definer owned by postgres, which has bypassrls.

create policy require_aal2 on areas                  as restrictive for all to authenticated using (public.mfa_satisfied()) with check (public.mfa_satisfied());
create policy require_aal2 on chain_checks           as restrictive for all to authenticated using (public.mfa_satisfied()) with check (public.mfa_satisfied());
create policy require_aal2 on contacts               as restrictive for all to authenticated using (public.mfa_satisfied()) with check (public.mfa_satisfied());
create policy require_aal2 on cyprus_config          as restrictive for all to authenticated using (public.mfa_satisfied()) with check (public.mfa_satisfied());
create policy require_aal2 on deal_stages            as restrictive for all to authenticated using (public.mfa_satisfied()) with check (public.mfa_satisfied());
create policy require_aal2 on deals                  as restrictive for all to authenticated using (public.mfa_satisfied()) with check (public.mfa_satisfied());
create policy require_aal2 on districts              as restrictive for all to authenticated using (public.mfa_satisfied()) with check (public.mfa_satisfied());
create policy require_aal2 on documents              as restrictive for all to authenticated using (public.mfa_satisfied()) with check (public.mfa_satisfied());
create policy require_aal2 on events                 as restrictive for all to authenticated using (public.mfa_satisfied()) with check (public.mfa_satisfied());
create policy require_aal2 on key_movements          as restrictive for all to authenticated using (public.mfa_satisfied()) with check (public.mfa_satisfied());
create policy require_aal2 on leads                  as restrictive for all to authenticated using (public.mfa_satisfied()) with check (public.mfa_satisfied());
create policy require_aal2 on mandates               as restrictive for all to authenticated using (public.mfa_satisfied()) with check (public.mfa_satisfied());
create policy require_aal2 on offers                 as restrictive for all to authenticated using (public.mfa_satisfied()) with check (public.mfa_satisfied());
create policy require_aal2 on organizations          as restrictive for all to authenticated using (public.mfa_satisfied()) with check (public.mfa_satisfied());
create policy require_aal2 on payment_plans          as restrictive for all to authenticated using (public.mfa_satisfied()) with check (public.mfa_satisfied());
create policy require_aal2 on price_history          as restrictive for all to authenticated using (public.mfa_satisfied()) with check (public.mfa_satisfied());
create policy require_aal2 on price_list_items       as restrictive for all to authenticated using (public.mfa_satisfied()) with check (public.mfa_satisfied());
create policy require_aal2 on price_lists            as restrictive for all to authenticated using (public.mfa_satisfied()) with check (public.mfa_satisfied());
create policy require_aal2 on profiles               as restrictive for all to authenticated using (public.mfa_satisfied()) with check (public.mfa_satisfied());
create policy require_aal2 on properties             as restrictive for all to authenticated using (public.mfa_satisfied()) with check (public.mfa_satisfied());
create policy require_aal2 on property_keys          as restrictive for all to authenticated using (public.mfa_satisfied()) with check (public.mfa_satisfied());
create policy require_aal2 on property_media         as restrictive for all to authenticated using (public.mfa_satisfied()) with check (public.mfa_satisfied());
create policy require_aal2 on reference_counters     as restrictive for all to authenticated using (public.mfa_satisfied()) with check (public.mfa_satisfied());
create policy require_aal2 on share_link_attempts    as restrictive for all to authenticated using (public.mfa_satisfied()) with check (public.mfa_satisfied());
create policy require_aal2 on share_link_properties  as restrictive for all to authenticated using (public.mfa_satisfied()) with check (public.mfa_satisfied());
create policy require_aal2 on share_links            as restrictive for all to authenticated using (public.mfa_satisfied()) with check (public.mfa_satisfied());
create policy require_aal2 on tasks                  as restrictive for all to authenticated using (public.mfa_satisfied()) with check (public.mfa_satisfied());
create policy require_aal2 on viewing_slips          as restrictive for all to authenticated using (public.mfa_satisfied()) with check (public.mfa_satisfied());
create policy require_aal2 on viewings               as restrictive for all to authenticated using (public.mfa_satisfied()) with check (public.mfa_satisfied());
