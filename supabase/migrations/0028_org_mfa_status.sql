-- 0028 — let an admin see WHO has a second factor.
--
-- `Settings → Users` renders Name / Email / Role / Status / Actions and nothing
-- about 2FA, so an admin cannot tell that another admin is password-only. That
-- is not hypothetical: on 2026-08-09 production had two full admins, one with
-- TOTP and one with none and no sign-in for over three weeks, and finding it
-- took a hand-written query against `auth.mfa_factors`. No product surface
-- would ever have shown it. C2's whole point is knowing who is protected.
--
-- `auth.mfa_factors` is not reachable from the app: PostgREST does not expose
-- the `auth` schema, and `@supabase/auth-js` 2.x has no PUBLIC admin call for
-- another user's factors (`listFactors` exists only on a user's own client).
-- Hence a security definer function — the narrowest one that answers the
-- question.
--
-- Returns a BOOLEAN PER PROFILE, never the factors themselves. Nothing here
-- exposes factor ids, secrets, friendly names or timestamps; "does this
-- colleague have a second factor" is the whole question, and the answer is one
-- bit. A leak of this function's output tells an attacker who is worth
-- phishing, which is a real but much smaller surface than the rows behind it.
--
-- Gated INSIDE the body on `current_role_gnk() = 'admin'` rather than by grant
-- alone, so a non-admin gets zero rows instead of an error — and so the check
-- travels with the function rather than living in whatever calls it.
--
-- GRANTS ARE THE DANGEROUS PART (HANDOFF §4.3). A new security definer function
-- is executable by `public` — and therefore `anon` — by default. That default is
-- exactly what migration 0021 missed. Revoked explicitly below, then granted
-- only to `authenticated`; `service_role` needs no grant because it bypasses
-- RLS anyway and never calls this.

create or replace function org_mfa_status()
returns table (profile_id uuid, has_verified_factor boolean)
language sql
stable
security definer
set search_path = public, auth
as $$
  select
    p.id,
    exists (
      select 1
        from auth.mfa_factors f
       where f.user_id = p.id
         and f.status = 'verified'
    )
  from profiles p
  where p.org_id = current_org_id()
    and current_role_gnk() = 'admin';
$$;

comment on function org_mfa_status() is
  'Per-profile "has a verified second factor" for the caller''s org, admin-only '
  '(gated in the body, so a non-admin gets zero rows). Exists because auth.mfa_factors '
  'is unreachable from PostgREST and auth-js has no public admin call for another '
  'user''s factors. Returns one boolean per profile and never factor detail.';

revoke execute on function public.org_mfa_status() from public, anon;
grant execute on function public.org_mfa_status() to authenticated;
