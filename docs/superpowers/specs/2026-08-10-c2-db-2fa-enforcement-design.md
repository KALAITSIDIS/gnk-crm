# C2 — DB-level 2FA enforcement (design)

**Date:** 2026-08-10 · **Status:** design approved, not implemented
**Owner doc:** IMPROVEMENTS C2 · **History:** DECISIONS `T-2fa`

## The gap

2FA is enforced at the **application layer only**. `proxy.ts` holds an `aal1`
session on `/login/verify`, but a stolen `aal1` JWT can still reach PostgREST
directly and read or write everything that session's role allows. DECISIONS
`T-2fa` names this and defers it here deliberately.

The realistic threat the app-layer gate already defeats is someone with a stolen
password using the web UI. What it does not defeat is someone with the token.

## Decisions taken

| question | decision |
|---|---|
| Blast radius | **Deny reads AND writes** for an `aal1` session belonging to a user who has a verified factor |
| Tables | **All 29** RLS-enabled tables in `public`. No exemptions — `cyprus_config` included |
| Users without a factor | **Untouched.** The Supabase "opt-in" template |
| Recovery from a lost device | **Out of scope.** Operator deletes the stranded factor in the Supabase dashboard; the user re-enrols at `/security` |
| Mechanism | Explicit per-table `as restrictive` policy, **plus a guard test** so a future table cannot silently ship without one |

### Why the operator decision is already settled

§5 says the `gerasimos@` question must be decided before this lands. **It was, on
2026-08-09** (BACKLOG): kept as admin, deliberately, with the consequence
recorded — *"C2 must not assume every admin has a factor."* He has no verified
factor, so the opt-in template never gates him. That is precisely what makes him
the lockout safety net. **C2 is not blocked.**

## Mechanism

One migration, **`0029_require_aal2.sql`** — hosted is at 28 and
`non_filename_versions` is 0, so the next version is `0029` and the filename must
keep the four-digit shape the §0 check asserts.

### The predicate

One function, following 0028's shape. Grants per HANDOFF §4.3 — a new
`security definer` function is `anon`-executable **by default**, which is what
migration 0021 got wrong:

```sql
create or replace function public.mfa_satisfied()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
      or not exists (
           select 1 from auth.mfa_factors f
            where f.user_id = auth.uid() and f.status = 'verified'
         );
$$;

revoke execute on function public.mfa_satisfied() from public, anon;
grant execute on function public.mfa_satisfied() to authenticated;
```

Second arm is the opt-in template: **no verified factor, never gated.**
`status = 'verified'` and not merely present — `enroll()` creates an `unverified`
factor immediately, so counting those would lock out anyone who closed the
enrolment tab (the same trap `hasVerifiedFactor` avoids in the app).

### The policies

One per table, on all 29:

```sql
create policy require_aal2 on <table> as restrictive for all to authenticated
  using (public.mfa_satisfied()) with check (public.mfa_satisfied());
```

`to authenticated`, **not** `to public`: `anon` never needs evaluating, and
scoping it this way keeps the anonymous buyer-proposal path obviously untouched
instead of resting on the predicate's second arm.

Tables (29): `areas, chain_checks, contacts, cyprus_config, deal_stages, deals,
districts, documents, events, key_movements, leads, mandates, offers,
organizations, payment_plans, price_history, price_list_items, price_lists,
profiles, properties, property_keys, property_media, reference_counters,
share_link_attempts, share_link_properties, share_links, tasks, viewing_slips,
viewings`.

`reference_counters` and `share_link_attempts` have zero permissive policies and
already deny everything to `authenticated`; they are included for uniformity so
the guard test needs no special case.

### Why gating `profiles` does not deadlock

Every other policy depends on `current_org_id()` / `current_role_gnk()`, and both
read `profiles`. They keep working because both are `security definer` owned by
`postgres`, which has `bypassrls` — verified, not assumed. Worth stating because
it reads as circular.

### What is deliberately unaffected

Verified against `pg_roles`, not inferred:

- **`service_role` — `bypassrls: true`.** The three crons and `capture.mjs` are
  outside RLS entirely.
- **`postgres` — `bypassrls: true`.** Security-definer functions it owns, which
  is how anonymous `/p/*` share links resolve, are unaffected.
- **`authenticated` / `anon` — `bypassrls: false`.** The policy bites exactly the
  sessions it should.

## The risk that matters

**If a Supabase access token does not carry the `aal` claim, `coalesce` reads
`aal1` and every user with a verified factor is denied everything** — today that
is `nontari@`, the operator's own account, on production.

The entire design rests on that claim existing. **It must be proven against a
real signed-in JWT before this goes near hosted**, not reasoned about from the
documentation. The test matrix below is built to prove it.

## Testing

The RLS suite signs in real users against the local stack, and
`lib/testing/totp.ts` is a working RFC-6238 generator (pinned to the published
RFC 4226/6238 vectors), so an `aal2` session is reachable in a test.

### 1. The claim, proven first

`mfa_satisfied()` is granted to `authenticated`, so tests call it via `rpc()` —
no extra debug surface:

| session | expected |
|---|---|
| verified factor, password only (`aal1`) | `false` |
| same user after TOTP challenge (`aal2`) | `true` |
| no factor at all (`aal1`) | `true` |

If the `aal` claim were missing, case 2 returns `false` and the suite fails
before any table is touched.

### 2. Behaviour

On `contacts` (business data), `events` (the hash chain) and `cyprus_config`
(the outlier we chose to gate):

- factored user at `aal1` — SELECT returns 0 rows, INSERT refused
- factored user at `aal2` — both succeed
- **unfactored user at `aal1` — completely unchanged.** The `gerasimos@` path and
  the most important non-regression in this change
- `anon` — a live share link still resolves through `/p/`
- `service_role` — unaffected, the cron path

### 3. The guard

Set difference between RLS-enabled tables in `public` and tables carrying
`require_aal2`, asserted empty, with an explicit exemption list that starts
empty. A future table without the policy fails CI.

This is the part that earns approach C over a plain per-table rollout: this
codebase's own history says the per-table pattern gets forgotten, and 0021 is
the proof.

## Rollout

1. **Local.** `db reset`, apply, run `npm run test:rls` and `mfa.spec.ts`.
2. **Read who has a factor on hosted** via `org_mfa_status()` (0028). This makes
   the blast radius a fact rather than an assumption; expect `nontari@` alone.
3. **Hosted** via HANDOFF §3's documented apply-and-verify steps.

No ordering hazard: this is DB-only with no code dependency, so unlike 0025 there
is no window where deployed code needs something that is not there yet. The
migration can land before, after or without a deploy.

## Recovery, in order

1. **`gerasimos@` is never gated** (no factor) — he can still sign in as admin if
   the policy misfires and locks out `nontari@`.
2. **Rollback migration** — drop the 29 policies and the function.
3. **Supabase dashboard** — delete a stranded factor; the user re-enrols at
   `/security`.

## Out of scope

- Mandatory enrolment (BACKLOG, a separate decision).
- An admin "remove another user's factor" action — considered and deferred; it is
  a new privileged surface that can itself disable someone's 2FA and would roughly
  double this change.
- Recovery codes. Supabase issues none; the practical answer remains a second
  enrolled factor per user, which is a follow-up decision.
