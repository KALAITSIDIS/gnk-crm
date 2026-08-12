# RLS Helper Hoist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `current_org_id()` and `current_role_gnk()` evaluate once per statement instead of once per row on the 7 paginated list tables, without changing what any policy means.

**Architecture:** One migration (`0030_hoist_rls_helpers.sql`) drops and recreates 24 permissive policies with each helper call wrapped in a scalar subquery. The migration captures every predicate into a temp table first and, after the rewrite, asserts that normalising the wrapper away reproduces the original text exactly — raising if not. A migration is one transaction, so a mismatch aborts everything.

**Tech Stack:** PostgreSQL RLS, Supabase CLI, Vitest (`vitest.rls.config.ts`), local Supabase stack via Docker.

**Spec:** `docs/superpowers/specs/2026-08-11-rls-helper-hoist-design.md`

---

## Preconditions

- Docker running and the local stack healthy:
  `docker ps --filter name=supabase_db_gnk-crm` should show `(healthy)`.
  Docker Desktop was found stopped on 2026-08-11; start it and wait if needed.
- Local migrations present: `select count(*) from supabase_migrations.schema_migrations`
  should be 29. If 0, run `npx supabase db reset` (HANDOFF §7).
- Branch off `main` — do not work on `main` directly.

## Facts established before this plan (do not re-derive)

- **24 permissive policies** across `contacts` (4), `deals` (4), `leads` (4),
  `tasks` (4), `properties` (3), `viewings` (3), `events` (2).
- **All 24 are `to public`** — uniformly. The regenerated policies must stay that way.
- **None of the 24 contains a `SELECT`** today, which is what makes the
  equivalence check exact.
- Postgres stores a wrapped call as **`( SELECT current_org_id() AS current_org_id)`**
  — verified on the local stack. The normalisation strings depend on this exact
  spelling, including the space after `(`.
- Measured cost: **21 calls for a 20-row scan bare, 1 wrapped.**

## File Structure

| File | Responsibility |
|---|---|
| `docs/superpowers/plans/2026-08-11-rls-hoist-rollback.sql` (create) | Snapshot of the 24 ORIGINAL definitions. This is the rollback script. |
| `supabase/migrations/0030_hoist_rls_helpers.sql` (create) | Temp-table capture, 24 drop/create pairs, self-verifying DO block |
| `supabase/tests/rls-hoist.test.ts` (create) | Regression guard: no bare helper call remains on the 7 tables |
| `docs/BACKLOG.md` (modify) | Close the measured finding |
| `HANDOFF.md` (modify) | §1 Shipped entry |

---

### Task 1: Snapshot the originals — the rollback script

**Files:**
- Create: `docs/superpowers/plans/2026-08-11-rls-hoist-rollback.sql`

- [ ] **Step 1: Generate the rollback script from the CURRENT (bare) definitions**

```bash
cd "D:/dev/TSOPOZIDIS/gnk-crm" && docker exec -i supabase_db_gnk-crm \
  psql -U postgres -d postgres -tA -o /tmp/rollback.sql <<'SQL'
select string_agg(stmt, E'\n\n' order by tablename, policyname)
from (
  select tablename, policyname,
    format(
      E'drop policy %I on public.%I;\ncreate policy %I on public.%I\n  for %s to public%s%s;',
      policyname, tablename, policyname, tablename,
      lower(cmd),
      case when qual is null then '' else E'\n  using (' || qual || ')' end,
      case when with_check is null then '' else E'\n  with check (' || with_check || ')' end
    ) as stmt
  from pg_policies
  where schemaname = 'public' and permissive = 'PERMISSIVE'
    and tablename in ('contacts','deals','events','leads','properties','tasks','viewings')
) s;
SQL
docker exec -i supabase_db_gnk-crm cat /tmp/rollback.sql > docs/superpowers/plans/2026-08-11-rls-hoist-rollback.sql
```

- [ ] **Step 2: Check it looks right**

```bash
grep -c "^drop policy" docs/superpowers/plans/2026-08-11-rls-hoist-rollback.sql
grep -c "select current_org_id" docs/superpowers/plans/2026-08-11-rls-hoist-rollback.sql
```

Expected: **24** drop statements, and **0** wrapped calls — this file is the BARE
form, which is exactly what makes it a rollback.

- [ ] **Step 3: Add a header explaining what it is**

Prepend to the file:

```sql
-- ROLLBACK SCRIPT for migration 0030_hoist_rls_helpers.sql.
--
-- These are the 24 policy definitions EXACTLY as they stood before 0030, with
-- the helper calls bare. Running this file restores the pre-0030 state.
--
-- Generated from pg_policies on 2026-08-11, not hand-written, so it cannot
-- differ from what was actually deployed by a transcription slip.
--
-- Postgres has no `create or replace policy`, so each entry drops first.
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-08-11-rls-hoist-rollback.sql
git commit -m "docs(plan): snapshot the 24 pre-hoist policy definitions as a rollback script"
```

---

### Task 2: Generate the migration

The 24 predicates are NOT hand-transcribed. They are generated from
`pg_policies`, so the migration cannot differ from what is deployed by a typo.

**Files:**
- Create: `supabase/migrations/0030_hoist_rls_helpers.sql`

- [ ] **Step 1: Generate the drop/create pairs, with the helpers wrapped**

```bash
cd "D:/dev/TSOPOZIDIS/gnk-crm" && docker exec -i supabase_db_gnk-crm \
  psql -U postgres -d postgres -tA -o /tmp/pairs.sql <<'SQL'
select string_agg(stmt, E'\n\n' order by tablename, policyname)
from (
  select tablename, policyname,
    format(
      E'drop policy %I on public.%I;\ncreate policy %I on public.%I\n  for %s to public%s%s;',
      policyname, tablename, policyname, tablename,
      lower(cmd),
      case when qual is null then ''
           else E'\n  using (' || replace(replace(qual,
                  'current_org_id()',   '(select current_org_id())'),
                  'current_role_gnk()', '(select current_role_gnk())') || ')' end,
      case when with_check is null then ''
           else E'\n  with check (' || replace(replace(with_check,
                  'current_org_id()',   '(select current_org_id())'),
                  'current_role_gnk()', '(select current_role_gnk())') || ')' end
    ) as stmt
  from pg_policies
  where schemaname = 'public' and permissive = 'PERMISSIVE'
    and tablename in ('contacts','deals','events','leads','properties','tasks','viewings')
) s;
SQL
```

- [ ] **Step 2: Sanity-check the generated pairs before using them**

```bash
docker exec -i supabase_db_gnk-crm sh -c "grep -c '^drop policy' /tmp/pairs.sql; grep -c 'select current_org_id' /tmp/pairs.sql; grep -c 'current_org_id()' /tmp/pairs.sql"
```

Expected: **24** drops; wrapped `current_org_id` occurrences **> 0**; and every
`current_org_id()` occurrence must be inside a wrapper — verify by eye that no
line contains a bare `= current_org_id()` without `(select`.

- [ ] **Step 3: Assemble the migration file**

Write `supabase/migrations/0030_hoist_rls_helpers.sql` as: this header, then the
contents of `/tmp/pairs.sql` in place of the marked line, then the DO block.

```sql
-- 0030 — evaluate the RLS helpers once per statement, not once per row.
--
-- current_org_id() and current_role_gnk() are `stable security definer` SQL
-- functions. `security definer` blocks inlining, so every reference is a real
-- call, and a bare call in a policy predicate is evaluated PER ROW.
--
-- COUNTED 2026-08-11, not inferred: a probe table with a stable security definer
-- function of the same shape, raising a NOTICE per call, was scanned 20 rows.
--   org_id = probe_fn()           -> 21 calls
--   org_id = (select probe_fn())  ->  1 call
-- Plan shape does NOT settle this on its own: the same function appears as an
-- `Index Cond` (once, as a scan key) in some plans and a `Filter` in others.
--
-- SCOPE: the 7 paginated list tables only — the screens that render hundreds of
-- rows, where a per-row call multiplies. 62 other permissive policies stay bare
-- deliberately (36 on config/staff-bounded tables, 26 on tables read a few rows
-- at a time). The 29 require_aal2 policies already wrap their predicate (0029).
--
-- NOTHING HERE CHANGES WHAT A POLICY MEANS. It is an evaluation-strategy change.
-- If behaviour changes, this migration has a bug — which is what the check at the
-- bottom exists to catch.
--
-- These statements were GENERATED from pg_policies, not hand-transcribed, so
-- they cannot differ from what was deployed by a typo.

create temp table _before as
  select tablename, policyname, qual, with_check
    from pg_policies
   where schemaname = 'public' and permissive = 'PERMISSIVE'
     and tablename in ('contacts','deals','events','leads','properties','tasks','viewings');

-- >>> PASTE THE 24 GENERATED drop/create PAIRS FROM /tmp/pairs.sql HERE <<<

-- Self-check. Normalising the wrapper away must reproduce the ORIGINAL text
-- exactly. A migration is one transaction, so a mismatch aborts everything and
-- nothing half-lands.
do $$
declare
  bad int;
  detail text;
begin
  select count(*), string_agg(p.tablename || '.' || p.policyname, ', ')
    into bad, detail
    from pg_policies p
    join _before b
      on b.tablename = p.tablename and b.policyname = p.policyname
   where p.schemaname = 'public'
     and (
       replace(replace(coalesce(p.qual, ''),
         '( SELECT current_org_id() AS current_org_id)',     'current_org_id()'),
         '( SELECT current_role_gnk() AS current_role_gnk)', 'current_role_gnk()')
       is distinct from coalesce(b.qual, '')
       or
       replace(replace(coalesce(p.with_check, ''),
         '( SELECT current_org_id() AS current_org_id)',     'current_org_id()'),
         '( SELECT current_role_gnk() AS current_role_gnk)', 'current_role_gnk()')
       is distinct from coalesce(b.with_check, '')
     );

  if bad > 0 then
    raise exception '0030 changed % predicate(s), aborting: %', bad, detail;
  end if;

  -- A check that never matches would pass vacuously. Prove it saw the rewrite.
  select count(*) into bad
    from pg_policies
   where schemaname = 'public' and permissive = 'PERMISSIVE'
     and tablename in ('contacts','deals','events','leads','properties','tasks','viewings')
     and coalesce(qual,'') || coalesce(with_check,'') like '%( SELECT current_org_id()%';

  if bad <> 24 then
    raise exception '0030 expected 24 hoisted policies, found % — the rewrite did not apply', bad;
  end if;
end $$;
```

**Both checks matter.** The first proves nothing changed meaning. The second
proves something changed at all — without it, a generator that silently emitted
the bare form would pass the first check perfectly.

- [ ] **Step 4: Apply locally**

```bash
cd "D:/dev/TSOPOZIDIS/gnk-crm" && npx supabase db reset
```

Expected: completes without error. **If it raises `0030 changed N predicate(s)`
or `expected 24 hoisted policies`, STOP** — the generator produced something
that is not a faithful rewrite. Report the exception text; do not edit the check
to make it pass.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0030_hoist_rls_helpers.sql
git commit -m "0030: evaluate the RLS helpers once per statement on the 7 list tables"
```

---

### Task 3: Prove behaviour did not change

**Files:** none — verification only.

- [ ] **Step 1: Run the full RLS suite**

```bash
cd "D:/dev/TSOPOZIDIS/gnk-crm" && npm run test:rls
```

Expected: `Tests  44 passed (44)`.

This is the behavioural proof. The suite covers org isolation, cross-org denial,
agent-versus-admin reach and the active-user gate — if a rewrite changed any
predicate's meaning, this is what notices. **A failure here means the hoist is
not equivalent. Do not adjust the tests.**

- [ ] **Step 2: Commit nothing**

Verification only. If green, continue.

---

### Task 4: Prove the hoist actually worked

**Files:** none — measurement only.

- [ ] **Step 1: Measure the plan**

```bash
cd "D:/dev/TSOPOZIDIS/gnk-crm" && docker exec -i supabase_db_gnk-crm psql -U postgres -d postgres -q <<'SQL'
select id as uid, org_id from public.profiles limit 1 \gset
insert into public.contacts (org_id, first_name)
select :'org_id'::uuid, 'Hoist ' || g from generate_series(1,200) g;

begin;
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'uid','role','authenticated','aal','aal2')::text, true);
explain (analyze, verbose, costs off) select * from public.contacts;
commit;

delete from public.contacts where first_name like 'Hoist %';
SQL
```

Expected: the plan shows `InitPlan` with `loops=1` and the filter referencing
`(InitPlan N).colM` rather than `current_org_id()` directly.

`loops=1` is the measurement. Record the exact plan lines.

**`set local role` MUST be inside `begin`/`commit`** — outside a transaction it
is a no-op warning, the query runs as `postgres`, RLS is bypassed and the plan
shows no policy at all. That mistake produced a confident wrong reading on
2026-08-11.

---

### Task 5: The regression guard

**Files:**
- Create: `supabase/tests/rls-hoist.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
/**
 * Guard for migration 0030. Requires the local Supabase stack.
 *
 * On the 7 paginated list tables, every current_org_id() / current_role_gnk()
 * call must sit inside a `(select …)` wrapper so Postgres evaluates it once per
 * statement instead of once per row (counted 2026-08-11: 21 calls vs 1 on a
 * 20-row scan). A policy written the old way on one of these tables regresses
 * that silently — this test is what notices.
 *
 * Scoped to these 7 tables ON PURPOSE. 62 other permissive policies are
 * deliberately left bare; asserting globally would fail on all of them.
 */
import { describe, expect, it } from "vitest";
import { serviceClient } from "./helpers";

const HOT_TABLES = [
  "contacts",
  "deals",
  "events",
  "leads",
  "properties",
  "tasks",
  "viewings",
];

const svc = serviceClient();

describe("0030 — RLS helpers stay hoisted on the list tables", () => {
  it("no bare helper call remains on any hot table", async () => {
    const { data, error } = await svc.rpc("rls_bare_helper_calls");
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  // Not a restatement of the test above: that one proves nothing is BARE, this
  // proves the hoist is actually PRESENT. A migration that dropped all 24
  // policies and recreated none would satisfy "no bare calls" perfectly.
  it("all 24 policies on those tables are hoisted", async () => {
    const { data, error } = await svc.rpc("rls_hoisted_policy_count");
    expect(error).toBeNull();
    expect(data).toBe(24);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd "D:/dev/TSOPOZIDIS/gnk-crm" && npm run test:rls -- rls-hoist
```

Expected: FAIL — `Could not find the function public.rls_bare_helper_calls`.

- [ ] **Step 3: Add the introspection function to the migration**

Append to `supabase/migrations/0030_hoist_rls_helpers.sql`:

```sql
-- Guard function. Returns any policy on the 7 list tables that still calls a
-- helper bare. Empty means fully hoisted. service_role only, matching
-- rls_aal2_coverage() from 0029: it describes the security model's shape, which
-- no ordinary session needs.
create or replace function public.rls_bare_helper_calls()
returns table (tablename text, policyname text)
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select p.tablename::text, p.policyname::text
    from pg_policies p
   where p.schemaname = 'public'
     and p.permissive = 'PERMISSIVE'
     and p.tablename in ('contacts','deals','events','leads','properties','tasks','viewings')
     and replace(replace(
           coalesce(p.qual,'') || coalesce(p.with_check,''),
           '( SELECT current_org_id() AS current_org_id)', ''),
           '( SELECT current_role_gnk() AS current_role_gnk)', '')
         like any (array['%current_org_id()%', '%current_role_gnk()%'])
   order by 1, 2;
$$;

comment on function public.rls_bare_helper_calls() is
  'Policies on the 7 paginated list tables that still call current_org_id() or '
  'current_role_gnk() outside a (select …) wrapper, i.e. once per row. Empty '
  'means fully hoisted. Asserted by supabase/tests/rls-hoist.test.ts.';

revoke execute on function public.rls_bare_helper_calls() from public, anon, authenticated;
grant execute on function public.rls_bare_helper_calls() to service_role;

-- The positive half. "Nothing is bare" is satisfied perfectly by a database
-- where the 24 policies were dropped and never recreated, so something must
-- assert they are PRESENT and hoisted.
create or replace function public.rls_hoisted_policy_count()
returns integer
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select count(*)::int
    from pg_policies p
   where p.schemaname = 'public'
     and p.permissive = 'PERMISSIVE'
     and p.tablename in ('contacts','deals','events','leads','properties','tasks','viewings')
     and coalesce(p.qual,'') || coalesce(p.with_check,'')
         like '%( SELECT current_org_id() AS current_org_id)%';
$$;

comment on function public.rls_hoisted_policy_count() is
  'How many policies on the 7 paginated list tables carry a hoisted '
  'current_org_id() call. Expected 24 after migration 0030. Pairs with '
  'rls_bare_helper_calls(): that one proves nothing is bare, this proves the '
  'policies still exist.';

revoke execute on function public.rls_hoisted_policy_count() from public, anon, authenticated;
grant execute on function public.rls_hoisted_policy_count() to service_role;
```

- [ ] **Step 4: Apply and run**

```bash
cd "D:/dev/TSOPOZIDIS/gnk-crm" && npx supabase db reset && npm run test:rls -- rls-hoist
```

Expected: `Tests  2 passed (2)`.

- [ ] **Step 5: Prove the guard bites**

A guard nobody has watched fail is not a guard.

```bash
docker exec -i supabase_db_gnk-crm psql -U postgres -d postgres -q <<'SQL'
begin;
drop policy contacts_select on public.contacts;
create policy contacts_select on public.contacts for select to public
  using (org_id = current_org_id());
select * from public.rls_bare_helper_calls();
rollback;
SQL
```

Expected: reports `contacts | contacts_select`. If it reports nothing, the guard
is vacuous — report `BLOCKED` rather than proceeding.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0030_hoist_rls_helpers.sql supabase/tests/rls-hoist.test.ts
git commit -m "0030: guard against a policy regressing to per-row helper calls"
```

---

### Task 6: Full local verification

**Files:** none.

- [ ] **Step 1: Everything**

```bash
cd "D:/dev/TSOPOZIDIS/gnk-crm" && npm run test:rls && npm test && npm run typecheck && npm run lint
```

Expected: RLS `46 passed` (44 + 2 new), unit `486 passed`, typecheck and lint clean.

- [ ] **Step 2: The list pages, end to end**

```bash
npx playwright test tests/e2e/modules.spec.ts tests/e2e/happy-path.spec.ts --project=desktop --reporter=line
```

Expected: PASS.

`modules.spec.ts` renders every list module — including all 7 tables whose
policies changed — and `happy-path.spec.ts` walks a full flow across them. There
is no `contacts.spec.ts` or `properties.spec.ts`; these two are what actually
exercise those screens.

- [ ] **Step 3: Restore screenshots if touched**

```bash
git status -s tests/screenshots/ && git checkout HEAD -- tests/screenshots/
```

Playwright rewrites all 12 tracked screenshots (HANDOFF §7).

---

### Task 7: Apply to hosted — OPERATOR GATE

**Do not start without explicit operator approval.** Everything before this is
local and undone by `db reset`.

- [ ] **Step 1: Re-snapshot hosted's CURRENT definitions as the rollback source**

Run the Task 1 Step 1 query via the Supabase connector's `execute_sql` against
`yjgirvzgoiywdojnpkpd` and save the output. Hosted is the source of truth for
rollback — do not assume it matches local.

- [ ] **Step 2: Apply as a SINGLE call**

Paste the entire contents of `supabase/migrations/0030_hoist_rls_helpers.sql`
into ONE `execute_sql` call.

> **This deliberately deviates from HANDOFF §3**, which says apply in separate
> calls. The temp table does not survive across calls, and wholesale rollback on
> mismatch is the entire safety property here rather than the hazard §3 warns
> about. Do not split it.

- [ ] **Step 3: Record the migration, in its own call**

```sql
insert into supabase_migrations.schema_migrations (version, name)
values ('0030','hoist_rls_helpers');
```

- [ ] **Step 4: Verify, in a further separate call**

```sql
select
  (select count(*) from supabase_migrations.schema_migrations) as migrations,
  (select count(*) from public.rls_bare_helper_calls()) as bare_remaining,
  (select count(*) from pg_policies
    where schemaname='public' and permissive='PERMISSIVE'
      and tablename in ('contacts','deals','events','leads','properties','tasks','viewings')
      and coalesce(qual,'')||coalesce(with_check,'') like '%( SELECT current_org_id()%') as hoisted,
  (select count(*) from pg_policies where schemaname='public') as policies_total,
  has_function_privilege('anon','public.rls_bare_helper_calls()','execute') as anon_can_exec;
```

Expected: `migrations 30`, `bare_remaining 0`, `hoisted 24`,
**`policies_total 115` (unchanged — a drop that failed to recreate would show here)**,
`anon_can_exec false`.

- [ ] **Step 5: `get_advisors`**

Run the connector's `get_advisors` with `type: "security"`. Expected: no new
finding naming `rls_bare_helper_calls`.

- [ ] **Step 6: Load a real list page**

Sign in, complete the TOTP challenge, and load `/contacts`, `/properties` and
`/tasks`. Expected: rows render.

**An RLS mistake returns ZERO ROWS, not an error** — an empty list and a
correctly-empty list look identical. Compare against the row counts from Step 4.

**Rollback:** run the file from Task 1 (or Step 1's hosted re-snapshot), then
`delete from supabase_migrations.schema_migrations where version = '0030';`

---

### Task 8: Documentation

- [ ] **Step 1: Close the BACKLOG finding**

In `docs/BACKLOG.md`, strike through the "RLS helper functions are called ONCE
PER ROW" entry and record: shipped as 0030, scoped to the 7 list tables, with the
before/after numbers and the fact that 62 permissive policies remain bare on
purpose.

- [ ] **Step 2: Add a HANDOFF §1 entry**

Under `## 1. Shipped`, add a dated entry for 0030 naming the scope, the guard
function, and that behaviour is unchanged by construction (the migration's own
equivalence check).

- [ ] **Step 3: Commit**

```bash
git add docs/BACKLOG.md HANDOFF.md
git commit -m "docs: 0030 hoists the RLS helpers on the list tables"
```

---

## Definition of done

- [ ] `npm run test:rls` — 46 passing, the original 44 unchanged
- [ ] `npm test`, `npm run typecheck`, `npm run lint` — clean
- [ ] `EXPLAIN` shows `InitPlan … loops=1` on a `contacts` scan
- [ ] The guard was watched failing on a deliberately un-hoisted policy
- [ ] Hosted: 30 migrations, 24 hoisted, 0 bare, **115 policies total (unchanged)**,
      `get_advisors` clean
- [ ] A real signed-in session renders `/contacts`, `/properties`, `/tasks`
- [ ] BACKLOG and HANDOFF updated
