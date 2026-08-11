# C2 DB-level 2FA Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deny an `aal1` PostgREST session belonging to a user who has a verified second factor all read and write access to every RLS-protected table, while leaving users without a factor completely unaffected.

**Architecture:** One migration (`0029_require_aal2.sql`) adds a `security definer` predicate `public.mfa_satisfied()`, an `as restrictive for all to authenticated` policy named `require_aal2` on all 29 RLS-enabled tables, and a service-role-only introspection function `public.rls_aal2_coverage()` that reports RLS tables missing the policy. A new RLS test file proves the `aal` JWT claim exists, proves the behaviour matrix, and uses the coverage function as a CI guard so a future table cannot ship ungated.

**Tech Stack:** PostgreSQL RLS, Supabase Auth (TOTP/MFA), `@supabase/supabase-js`, Vitest (`vitest.rls.config.ts`), local Supabase stack via Docker.

**Spec:** `docs/superpowers/specs/2026-08-10-c2-db-2fa-enforcement-design.md`

---

## Preconditions

- Docker running, local stack up (`npx supabase start`). Verify with
  `docker ps --filter name=supabase`.
- After any `npx supabase stop`, confirm migrations survived:
  `select count(*) from supabase_migrations.schema_migrations` — if 0, `db reset`
  (HANDOFF §7).
- Local TOTP must be enabled — `supabase/config.toml` already sets
  `[auth.mfa.totp] enroll_enabled` / `verify_enabled` (DECISIONS `T-2fa`).

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/0029_require_aal2.sql` (create) | The predicate, the 29 policies, the coverage function, all grants |
| `supabase/tests/helpers.ts` (modify) | Export the shared test password so new tests can re-sign-in as an existing user |
| `supabase/tests/mfa-enforcement.test.ts` (create) | Claim matrix, behaviour matrix, coverage guard |
| `IMPROVEMENTS.md` (modify) | C2 status |
| `HANDOFF.md` (modify) | §5 roadmap line, §6 known gaps |
| `docs/DECISIONS.md` (modify) | `T-aal2-rls` write-up |

Tests live in a **new file**, not `rls.test.ts`: this suite enrols real TOTP
factors, and a stranded factor on a shared fixture user would gate every other
test in the suite. Dedicated per-run users only.

---

### Task 1: Export the shared test password

**Files:**
- Modify: `supabase/tests/helpers.ts:160`

- [ ] **Step 1: Replace the inline password with an exported constant**

In `supabase/tests/helpers.ts`, add near the other exports (after `SEEDED_ORG`):

```ts
/** Password every fixture user is created with. Exported so a test can sign the
 *  SAME user in again on a fresh client — which is how an aal1 session is
 *  obtained for a user who already has a verified factor. */
export const TEST_PASSWORD = "test-password-1234";
```

Then in `createTestUser`, replace the local declaration:

```ts
  const password = TEST_PASSWORD;
```

- [ ] **Step 2: Run the RLS suite to confirm nothing broke**

Run: `npm run test:rls`
Expected: PASS, `Tests 32 passed (32)`

- [ ] **Step 3: Commit**

```bash
git add supabase/tests/helpers.ts
git commit -m "test(rls): export the fixture password for re-sign-in"
```

---

### Task 2: The `mfa_satisfied()` predicate and the claim matrix

This task proves the load-bearing assumption of the whole design: that a Supabase
access token actually carries the `aal` claim. If it does not, stop — the design
does not work and every enrolled user would be locked out.

**Files:**
- Create: `supabase/migrations/0029_require_aal2.sql`
- Create: `supabase/tests/mfa-enforcement.test.ts`

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/mfa-enforcement.test.ts`:

```ts
/**
 * C2 — DB-level 2FA enforcement.
 * Requires the local Supabase stack. Run: npm run test:rls
 *
 * Uses DEDICATED per-run users. Never enrol a factor on a shared fixture user:
 * a verified factor gates that user's aal1 sessions, which would break every
 * other test in this suite.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { totp } from "@/lib/testing/totp";
import {
  ORG_A,
  TEST_PASSWORD,
  anonClient,
  createTestUser,
  ensureTestOrg,
  serviceClient,
  type TestUser,
} from "./helpers";

const run = Date.now().toString(36);
const svc = serviceClient();

/** Enrol TOTP and complete the challenge; the user's client becomes aal2. */
async function enrolAndVerify(user: TestUser): Promise<string> {
  const { data: enrolled, error: enrolErr } = await user.client.auth.mfa.enroll({
    factorType: "totp",
  });
  if (enrolErr) throw new Error(`enroll: ${enrolErr.message}`);

  const { data: ch, error: chErr } = await user.client.auth.mfa.challenge({
    factorId: enrolled.id,
  });
  if (chErr) throw new Error(`challenge: ${chErr.message}`);

  const { error: verifyErr } = await user.client.auth.mfa.verify({
    factorId: enrolled.id,
    challengeId: ch.id,
    code: totp(enrolled.totp.secret),
  });
  if (verifyErr) throw new Error(`verify: ${verifyErr.message}`);

  return enrolled.id;
}

/** A FRESH password-only session for an existing user — aal1 even if they have
 *  a verified factor. This is the stolen-token shape the policy must stop. */
async function signInAal1(email: string): Promise<SupabaseClient> {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({
    email,
    password: TEST_PASSWORD,
  });
  if (error) throw new Error(`signIn ${email}: ${error.message}`);
  return client;
}

let factored: TestUser; // has a verified factor; its client is aal2
let factoredAal1: SupabaseClient; // same user, password-only session
let plain: TestUser; // no factor at all — must stay unaffected

beforeAll(async () => {
  await ensureTestOrg(svc, ORG_A, "Test Org A", "test-org-a");

  [factored, plain] = await Promise.all([
    createTestUser(svc, `mfa-on-${run}@test.local`, "agent", ORG_A),
    createTestUser(svc, `mfa-off-${run}@test.local`, "agent", ORG_A),
  ]);

  await enrolAndVerify(factored);
  factoredAal1 = await signInAal1(factored.email);
});

describe("mfa_satisfied() — the aal claim", () => {
  it("is false for a password-only session when the user HAS a verified factor", async () => {
    const { data, error } = await factoredAal1.rpc("mfa_satisfied");
    expect(error).toBeNull();
    expect(data).toBe(false);
  });

  // If the access token did not carry `aal`, coalesce would read 'aal1' and
  // this would be false — which is exactly the failure that would lock out
  // every enrolled user in production. This assertion IS the claim check.
  it("is true for the same user once the TOTP challenge is passed", async () => {
    const { data, error } = await factored.client.rpc("mfa_satisfied");
    expect(error).toBeNull();
    expect(data).toBe(true);
  });

  it("is true for a user with no factor — the opt-in template", async () => {
    const { data, error } = await plain.client.rpc("mfa_satisfied");
    expect(error).toBeNull();
    expect(data).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:rls -- mfa-enforcement`
Expected: FAIL — all three cases error, PostgREST reporting
`Could not find the function public.mfa_satisfied without parameters`.

- [ ] **Step 3: Write the migration — predicate only**

Create `supabase/migrations/0029_require_aal2.sql`:

```sql
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
```

- [ ] **Step 4: Apply locally and run the test**

```bash
cd "D:/dev/TSOPOZIDIS/gnk-crm" && npx supabase db reset
npm run test:rls -- mfa-enforcement
```

Expected: PASS, `Tests 3 passed (3)`.

**If the second case fails (`true` expected, got `false`), STOP.** The access
token does not carry `aal` and this design cannot work as written. Do not add
policies; report it.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0029_require_aal2.sql supabase/tests/mfa-enforcement.test.ts
git commit -m "C2: mfa_satisfied() predicate, and proof the aal claim exists"
```

---

### Task 3: The coverage guard — write it before the policies exist

Written first so it fails loudly listing all 29 tables. A guard that has only
ever been seen passing has not been tested.

**Files:**
- Modify: `supabase/migrations/0029_require_aal2.sql`
- Modify: `supabase/tests/mfa-enforcement.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `supabase/tests/mfa-enforcement.test.ts`:

```ts
describe("require_aal2 coverage", () => {
  // The per-table pattern gets forgotten — migration 0021 is this repo's own
  // proof (HANDOFF §4.3). This guard is why the explicit approach is safe: a
  // new RLS table without the policy fails CI instead of shipping ungated.
  it("every RLS-enabled table in public carries the policy", async () => {
    const { data, error } = await svc.rpc("rls_aal2_coverage");
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("is not executable by an ordinary authenticated session", async () => {
    const { error } = await plain.client.rpc("rls_aal2_coverage");
    expect(error).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:rls -- mfa-enforcement`
Expected: FAIL — `Could not find the function public.rls_aal2_coverage`.

- [ ] **Step 3: Add the coverage function to the migration**

Append to `supabase/migrations/0029_require_aal2.sql`:

```sql
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
```

- [ ] **Step 4: Apply locally and confirm the guard FAILS with 29 tables**

```bash
npx supabase db reset
npm run test:rls -- mfa-enforcement
```

Expected: the coverage test FAILS, and the diff lists all 29 table names. The
grant test PASSES. **This failure is the point of the task** — it proves the
guard detects missing policies.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0029_require_aal2.sql supabase/tests/mfa-enforcement.test.ts
git commit -m "C2: coverage guard, currently failing with all 29 tables"
```

---

### Task 4: The 29 restrictive policies

**Files:**
- Modify: `supabase/migrations/0029_require_aal2.sql`

- [ ] **Step 1: Add the policies**

Append to `supabase/migrations/0029_require_aal2.sql`:

```sql
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
```

- [ ] **Step 2: Apply locally and confirm the guard now passes**

```bash
npx supabase db reset
npm run test:rls -- mfa-enforcement
```

Expected: PASS, `Tests 5 passed (5)`. The coverage test returns `[]`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0029_require_aal2.sql
git commit -m "C2: require_aal2 on all 29 RLS-enabled tables"
```

---

### Task 5: The behaviour matrix

**Files:**
- Modify: `supabase/tests/mfa-enforcement.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `supabase/tests/mfa-enforcement.test.ts`:

```ts
describe("require_aal2 behaviour", () => {
  it("an aal1 session with a verified factor reads nothing", async () => {
    for (const table of ["contacts", "events", "cyprus_config"]) {
      const { data, error } = await factoredAal1.from(table).select("*").limit(5);
      expect(error, `${table} should not error, just return nothing`).toBeNull();
      expect(data, `${table} leaked rows to an aal1 session`).toEqual([]);
    }
  });

  it("an aal1 session with a verified factor cannot write", async () => {
    const { error } = await factoredAal1
      .from("contacts")
      .insert({ org_id: ORG_A, full_name: `blocked-${run}` });
    expect(error).not.toBeNull();
  });

  it("the same user at aal2 can read and write", async () => {
    const { error: insErr } = await factored.client
      .from("contacts")
      .insert({ org_id: ORG_A, full_name: `allowed-${run}` });
    expect(insErr).toBeNull();

    const { data, error } = await factored.client
      .from("contacts")
      .select("full_name")
      .eq("full_name", `allowed-${run}`);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  // The most important non-regression in this change: this is the gerasimos@
  // path, and the reason an unfactored admin remains the lockout safety net.
  it("a user with NO factor is completely unaffected", async () => {
    const { error: insErr } = await plain.client
      .from("contacts")
      .insert({ org_id: ORG_A, full_name: `plain-${run}` });
    expect(insErr).toBeNull();

    const { data, error } = await plain.client.from("contacts").select("id").limit(1);
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
  });

  it("service_role still bypasses everything — the cron path", async () => {
    const { data, error } = await svc.from("events").select("id").limit(1);
    expect(error).toBeNull();
    expect(data).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npm run test:rls -- mfa-enforcement`
Expected: PASS, `Tests 10 passed (10)`.

These pass immediately — the policies from Task 4 already implement the
behaviour. They are regression cover, and each one fails loudly if a later
change weakens the predicate.

- [ ] **Step 3: Commit**

```bash
git add supabase/tests/mfa-enforcement.test.ts
git commit -m "C2: behaviour matrix for require_aal2"
```

---

### Task 6: Full local verification

**Files:** none — verification only.

- [ ] **Step 1: Run the whole RLS suite**

Run: `npm run test:rls`
Expected: PASS. The pre-existing count rises from 32 to 42 (32 + 10 new).

The existing 32 must still pass **unchanged**: their fixture users have no
factor, so `mfa_satisfied()` returns true for them and the restrictive policy is
a no-op. If any of the 32 now fail, the predicate is wrong — investigate before
going further.

- [ ] **Step 2: Run unit tests, typecheck and lint**

```bash
npm test && npm run typecheck && npm run lint
```
Expected: 486 unit tests pass; typecheck and lint clean.

- [ ] **Step 3: Run the two end-to-end specs that matter here**

```bash
npx playwright test tests/e2e/mfa.spec.ts tests/e2e/share-links.spec.ts --project=desktop
```

Expected: PASS.

`mfa.spec.ts` is the enrol → sign out → challenge → remove flow against a real
browser — the app path a factored user actually takes.

`share-links.spec.ts` is the **anonymous** proof the spec asks for. Its "a live
link renders the listing and leaks no private field" case exercises the
`security definer` resolution path an anonymous buyer uses, which must survive
this change untouched. Existing RLS test 2 covers anon *denial* on tables; only
this covers anon *success* through the share-link path, so running it is not
optional.

- [ ] **Step 4: Restore screenshots if the run touched them**

```bash
git status -s tests/screenshots/
git checkout HEAD -- tests/screenshots/
```

Playwright rewrites all 12 tracked screenshots (HANDOFF §7). Restore unless you
deliberately intend to refresh them.

- [ ] **Step 5: Commit only if something needed fixing**

If all green, there is nothing to commit — proceed to Task 7.

---

### Task 7: Apply to hosted — OPERATOR GATE

**Do not start this task without explicit operator approval.** It changes
production. Everything before it is local and reversible by `db reset`.

**Files:** none — hosted database only.

- [ ] **Step 1: Read who actually has a factor, BEFORE applying**

Via the Supabase connector, `execute_sql` against `yjgirvzgoiywdojnpkpd`:

```sql
select p.email, exists (
         select 1 from auth.mfa_factors f
          where f.user_id = p.id and f.status = 'verified'
       ) as has_factor
from public.profiles p
order by p.email;
```

Expected: exactly one `true` (`nontari@`). **This is the blast radius as a fact
rather than an assumption.** If more accounts have factors than expected, stop
and re-confirm with the operator — every one of them is locked out the moment
their session is aal1.

- [ ] **Step 2: Apply the migration in SEPARATE calls**

HANDOFF §3: apply in separate `execute_sql` calls, never one script — the
dashboard wraps a multi-statement script in one transaction, so a failure on the
trailing statement rolls back everything before it.

1. `mfa_satisfied()` + its `revoke`/`grant`
2. `rls_aal2_coverage()` + its `revoke`/`grant`
3. The 29 `create policy` statements
4. `insert into supabase_migrations.schema_migrations (version, name) values ('0029','require_aal2');`

> **⚠️ Step 3 IS NOT REPLAY-SAFE.** Postgres has no `create or replace policy`, so
> re-running it against a database that already has the policies fails on the
> FIRST one — verified locally: `policy "require_aal2" for table "areas" already
> exists`, aborting the batch. If an apply is interrupted part-way, **do not
> naively re-run it.** Drop what landed first, using the loop in the rollback
> block below, then re-apply from clean. Steps 1 and 2 are `create or replace`
> and are safe to repeat.

- [ ] **Step 3: Verify in a FURTHER separate call**

```sql
select
  (select count(*) from supabase_migrations.schema_migrations) as migrations,
  (select count(*) from supabase_migrations.schema_migrations where version !~ '^[0-9]{4}$') as non_filename_versions,
  (select count(*) from pg_policies where schemaname='public' and policyname='require_aal2') as policies,
  (select count(*) from public.rls_aal2_coverage()) as missing,
  has_function_privilege('anon','public.mfa_satisfied()','execute') as anon_can_exec,
  has_function_privilege('authenticated','public.mfa_satisfied()','execute') as authed_can_exec,
  has_function_privilege('authenticated','public.rls_aal2_coverage()','execute') as authed_can_introspect;
```

Expected: `migrations 29`, `non_filename_versions 0`, `policies 29`,
`missing 0`, `anon_can_exec false`, `authed_can_exec true`,
`authed_can_introspect false`.

- [ ] **Step 4: Diff the function bodies against local**

```sql
select md5(prosrc) from pg_proc where proname = 'mfa_satisfied';
```

Run the same on local and compare. `md5(prosrc)` is exact and beats eyeballing
(HANDOFF §3).

- [ ] **Step 5: Run `get_advisors`**

Use the Supabase connector's `get_advisors` with `type: "security"`. Skipping
this is what caused 0021.
Expected: no new finding naming `mfa_satisfied` or `rls_aal2_coverage`.

- [ ] **Step 6: Prove the app still works, signed in**

Sign in to `https://gnk-crm.vercel.app` as the enrolled account, complete the
TOTP challenge, and load `/contacts` and `/dashboard`. Expected: both render.

**A blank list with no error is the failure mode to watch for** — RLS denial
returns zero rows, not an exception, so "no data" and "correctly denied" look
identical in the UI.

- [ ] **Step 7: Confirm the chain still verifies**

```sql
select public.verify_events_chain('00000000-0000-0000-0000-000000000001');
```
Expected: `true`.

**Rollback if any step fails:**

Run as three separate calls. A loop, deliberately, rather than 29 typed lines —
this runs under pressure with someone locked out, and it cannot miss one:

```sql
do $$
declare r record;
begin
  for r in
    select tablename from pg_policies
     where schemaname = 'public' and policyname = 'require_aal2'
  loop
    execute format('drop policy require_aal2 on public.%I', r.tablename);
  end loop;
end $$;
```

```sql
drop function if exists public.rls_aal2_coverage();
drop function if exists public.mfa_satisfied();
delete from supabase_migrations.schema_migrations where version = '0029';
```

```sql
-- confirm: expect 0, and 28 migrations
select (select count(*) from pg_policies where schemaname='public' and policyname='require_aal2') as policies_left,
       (select count(*) from supabase_migrations.schema_migrations) as migrations;
```

`gerasimos@` has no factor and is never gated, so he can still sign in as admin
to run this if the enrolled account is locked out.

---

### Task 8: Documentation

**Files:**
- Modify: `IMPROVEMENTS.md` (C2 heading)
- Modify: `HANDOFF.md` (§5 next-work item 1, §6 known gaps)
- Modify: `docs/DECISIONS.md` (new entry)

- [ ] **Step 1: Update IMPROVEMENTS C2**

Change the heading from `✅ DONE 2026-07-24 (opt-in; DB-level enforcement outstanding)`
to record that DB-level enforcement shipped, with the verification numbers from
Task 7 step 3 quoted rather than described.

- [ ] **Step 2: Update HANDOFF §6**

Replace the line `- **2FA is enforced at the application layer only.**` with:

```markdown
- ~~**2FA is enforced at the application layer only.**~~ **ENFORCED IN THE
  DATABASE 2026-08-10** (0029). An `aal1` session belonging to a user with a
  verified factor is denied every RLS-protected table, so a stolen `aal1` JWT
  hitting PostgREST directly now reads nothing. **Opt-in template: a user with
  NO verified factor is untouched** — which is deliberate, and is what keeps an
  unfactored admin available as the lockout safety net. IMPROVEMENTS C2 owns the
  evidence; rollback is in the plan under `docs/superpowers/plans/`.
```

- [ ] **Step 3: Update HANDOFF §5**

Remove C2 from "Next engineering work" item 1 and add it to the **Done** line.
Per the §0 rule, §5 points — the evidence belongs in IMPROVEMENTS C2, not here.

- [ ] **Step 4: Write the DECISIONS entry**

Add `## 2026-08-10 · T-aal2-rls — DB-level 2FA enforcement (IMPROVEMENTS C2)`
covering: why opt-in rather than mandatory; why an explicit per-table policy plus
a guard beat gating inside `current_org_id()`; that `cyprus_config` is gated
despite holding no PII; and the `aal`-claim risk with how it was proven.

- [ ] **Step 5: Commit**

```bash
git add IMPROVEMENTS.md HANDOFF.md docs/DECISIONS.md
git commit -m "docs: C2 DB-level 2FA enforcement is live"
```

---

## Definition of done

- [ ] `npm run test:rls` — 42 passing, the original 32 unchanged
- [ ] `npm test`, `npm run typecheck`, `npm run lint` — clean
- [ ] `tests/e2e/mfa.spec.ts` — passing
- [ ] Hosted: 29 migrations, `rls_aal2_coverage()` empty, `anon` cannot execute
      the predicate, `get_advisors` clean, chain verifies
- [ ] A real signed-in session loads `/contacts` after passing the challenge
- [ ] IMPROVEMENTS C2, HANDOFF §5/§6 and DECISIONS updated
