-- 0059 — mandatory 2FA at the DATABASE level. Operator decision, 2026-08-28.
--
-- Drops the opt-in arm from `mfa_satisfied()`. Before: a session passed if it
-- was aal2 OR the user had no verified factor. After: only aal2 passes.
--
-- ============================================================================
-- THIS IS THE SECOND HALF OF A PAIR, AND THE HALVES MUST MOVE TOGETHER.
--
-- The first half is `MFA_REQUIRED` in `lib/constants/mfa.ts`, which makes the
-- proxy send a factor-less session to /security to enrol. Ship one without the
-- other and the system contradicts itself:
--
--   * DB mandatory, app not  → a factor-less user is never prompted to enrol,
--                              and simply sees an empty CRM. `require_aal2` is
--                              RESTRICTIVE, so reads return nothing rather than
--                              erroring — the worst shape of failure available.
--   * app mandatory, DB not  → the browser gate is the only thing standing
--                              between an aal1 token and the data, which was
--                              already documented as the residual gap.
--
-- `supabase/tests/mfa-enforcement.test.ts` now asserts the DB's behaviour
-- against `MFA_REQUIRED` itself, so that contradiction fails the suite instead
-- of reaching a user. That coupling is why this migration and the constant are
-- in the same commit.
-- ============================================================================
--
-- DEPLOY ORDER: CODE FIRST, THEN THIS. Not the additive rule.
--
-- Between the two steps somebody may be invited. A new account is created
-- factor-less, so with this applied and the code not yet deployed they would be
-- blocked by RLS with no /security redirect to explain it — an empty CRM and no
-- way to fix it. Deploying the code first means the worst intermediate state is
-- a user who is prompted to enrol slightly before the database insists on it,
-- which is harmless.
--
-- WHY THE PRECONDITION IS A NOTICE AND NOT A HARD ABORT.
--
-- The obvious guard — refuse to apply while any user lacks a verified factor —
-- cannot be used here, because it is FALSE on exactly the databases that must
-- accept this migration. CI builds a fresh stack whose seed admin has no
-- factor, and a developer's local database accumulates factor-less fixture
-- users from `mfa-enforcement.test.ts`, which creates them deliberately with
-- `enrolFactor: false`. A guard that aborts on both would simply be removed by
-- whoever hit it first, which is worse than one that reports.
--
-- So it counts and says so, and the human applying to PRODUCTION checks the
-- number. Verified on hosted 2026-08-28 before applying: 2 users, both with a
-- verified TOTP factor, so nobody was locked out by this.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

create or replace function public.mfa_satisfied()
 returns boolean
 language sql
 stable security definer
 set search_path to 'public', 'auth'
as $function$
  -- Mandatory: the session must have completed a second factor. There is no
  -- longer an arm that excuses a user for having no factor at all — that is
  -- the entire change, and 0029's opt-in template is deliberately gone.
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2';
$function$;

do $$
declare
  src        text;
  acl        text;
  n_users    int;
  n_no_factor int;
  n_active_no_factor int;
begin
  select prosrc, coalesce(proacl::text, 'NULL') into src, acl
    from pg_proc where proname = 'mfa_satisfied';

  if src is null then
    raise exception '0059 aborted: mfa_satisfied() is missing';
  end if;

  -- The opt-in arm must be GONE. Asserted on the body rather than trusted,
  -- because `create or replace` silently succeeds even if the body were wrong.
  if src ilike '%mfa_factors%' or src ilike '%not exists%' then
    raise exception '0059 aborted: the opt-in arm is still in mfa_satisfied(): %', src;
  end if;

  -- `create or replace` preserves the ACL; assert it rather than assume. anon
  -- must never have been able to call this (0021's scar).
  if acl like '%anon=%' then
    raise exception '0059 aborted: anon gained EXECUTE on mfa_satisfied (acl %)', acl;
  end if;

  -- Who this actually affects. NOT an abort — see the header.
  select count(*) into n_users from auth.users;
  select count(*) into n_no_factor
    from auth.users u
   where not exists (
           select 1 from auth.mfa_factors f
            where f.user_id = u.id and f.status = 'verified');
  select count(*) into n_active_no_factor
    from auth.users u
   where u.last_sign_in_at is not null
     and not exists (
           select 1 from auth.mfa_factors f
            where f.user_id = u.id and f.status = 'verified');

  raise notice '0059: mandatory MFA live. % user(s); % without a verified factor, of which % have signed in before.',
    n_users, n_no_factor, n_active_no_factor;

  if n_active_no_factor > 0 then
    raise warning '0059: % account(s) that have signed in before now have NO access until they enrol. On a real database that is a lockout — check this is only test fixtures.',
      n_active_no_factor;
  end if;
end $$;
