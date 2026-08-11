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
