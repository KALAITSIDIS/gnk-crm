# Hoist the RLS helpers out of per-row evaluation (design)

**Date:** 2026-08-11 · **Status:** design approved, not implemented
**Owner doc:** `docs/BACKLOG.md` (the measured finding) · **Precedent:** migration 0029

## The finding

`current_org_id()` and `current_role_gnk()` are `stable security definer` SQL
functions. `security definer` blocks inlining, so every reference is a real call.
Used bare in a policy predicate, **they are called once per row.**

Counted on 2026-08-11 with a probe table and a probe function of the same shape
(`stable security definer plpgsql`) raising a `NOTICE` per invocation:

| policy predicate | calls for one 20-row scan |
|---|---|
| `org_id = probe_fn()` | **21** |
| `org_id = (select probe_fn())` | **1** |

Linear in result-set size. 83 of the 115 policies call `current_org_id()`; 62
call `current_role_gnk()`.

> **This was nearly recorded wrong, twice.** An earlier BACKLOG entry claimed
> "once per ROW (measured)" on the strength of one `EXPLAIN` — it was inferred,
> not measured, and plan shape does not settle it (the same function appears as
> an `Index Cond`, evaluated once as a scan key, in some plans and a `Filter` in
> others). Then two instruments gave confident zeros: `pg_stat_user_functions`
> does not track in this stack (three explicit calls moved the counter by 0), and
> `set local role` outside a transaction block is a no-op warning, so the first
> probe ran as `postgres`, bypassed RLS and evaluated no policy at all.
> **Validate a counter by making it move before trusting a zero.**

## Scope

**24 policies across the 7 paginated lists** — the screens that render hundreds
of rows, where per-row calls multiply:

| table | policies |
|---|---|
| `contacts` | 4 |
| `deals` | 4 |
| `leads` | 4 |
| `tasks` | 4 |
| `properties` | 3 |
| `viewings` | 3 |
| `events` | 2 |

`events` matters most: it grows with every action and the chain view reads it in
bulk.

**Deliberately out of scope — 62 permissive policies, in two groups** (86
permissive total, minus the 24 above; the 29 `require_aal2` restrictive policies
are separate and 0029 already wraps its predicate):

- **36 policies on tables bounded by configuration or staff count**, not by sales
  activity: `districts`, `areas`, `deal_stages`, `profiles`, `organizations`,
  `cyprus_config`, `price_lists`, `price_list_items`, `payment_plans`,
  `property_keys`.
- **26 policies on tables that DO grow but are read a few rows at a time** from
  detail pages: `documents`, `property_media`, `offers`, `mandates`,
  `share_links`, `share_link_properties`, `viewing_slips`, `key_movements`,
  `price_history`, `chain_checks`. A second pass if ever.

(Do not confuse that 62 with the unrelated 62 policies that call
`current_role_gnk()` — the two counts coincide by accident.)

**Not urgent.** At current volumes (tens of rows) the saving is microseconds.
This is worth doing before the desk puts real volume in, not because anything is
slow today.

## Mechanism

One migration, **`0030_hoist_rls_helpers.sql`**. Hosted is at 29.

24 explicit `drop policy` / `create policy` pairs — Postgres has no
`create or replace policy`. Each predicate is reproduced **verbatim** with only:

- `current_org_id()` → `(select current_org_id())`
- `current_role_gnk()` → `(select current_role_gnk())`

Explicit statements rather than a generated `DO` loop, so the diff is reviewable
line by line, matching how 0002 and 0029 are written.

**All 24 predicates currently contain no `SELECT`** (verified against
`pg_policies`), so after the rewrite the only subqueries present are the wrappers
this migration adds. That is what makes the equivalence check below exact.

### The migration verifies itself, atomically

```sql
create temp table _before as
  select tablename, policyname, qual, with_check
    from pg_policies
   where schemaname = 'public'
     and tablename in ('contacts','deals','events','leads','properties','tasks','viewings');

-- …the 24 drop/create pairs…

do $$
declare bad int;
begin
  select count(*) into bad
    from pg_policies p
    join _before b using (tablename, policyname)
   where p.schemaname = 'public'
     and (
       replace(replace(coalesce(p.qual,''),
         '( SELECT current_org_id() AS current_org_id)', 'current_org_id()'),
         '( SELECT current_role_gnk() AS current_role_gnk)', 'current_role_gnk()')
       is distinct from coalesce(b.qual,'')
       or
       replace(replace(coalesce(p.with_check,''),
         '( SELECT current_org_id() AS current_org_id)', 'current_org_id()'),
         '( SELECT current_role_gnk() AS current_role_gnk)', 'current_role_gnk()')
       is distinct from coalesce(b.with_check,'')
     );
  if bad > 0 then
    raise exception 'hoist changed % predicate(s) — aborting', bad;
  end if;
end $$;
```

Normalising the wrapper away must reproduce the original text **exactly**. A
migration runs in one transaction, so if the rewrite altered any predicate by a
character, this raises and **nothing is applied**. It cannot half-land.

The rendered forms (`( SELECT current_org_id() AS current_org_id)`) are how
Postgres stores the wrapped call; confirm the exact spelling on the local stack
before trusting the check, since a normalisation that never matches would make
the guard vacuously pass.

## Testing

1. **Behavioural equivalence — the RLS suite.** All 44 tests stay green. That
   suite covers org isolation, cross-org denial, agent-versus-admin reach and the
   active-user gate; if a rewrite changed any predicate's *meaning*, this is what
   notices. The DO block proves the text is equivalent; the suite proves the
   behaviour is.

2. **Proof the hoist worked**, not merely that it was harmless.
   `EXPLAIN (ANALYZE, VERBOSE)` on a seeded `contacts` scan should move from
   `Filter: (org_id = current_org_id())` to `Filter: (org_id = (InitPlan 1).col1)`
   with `InitPlan 1 -> Result … loops=1`. `loops=1` is the measurement.

3. **A regression guard.** Post-migration every helper call on those 7 tables
   sits inside a wrapper, so a test can strip the known wrapper text and assert
   nothing bare remains. A future policy written the old way on a hot table then
   fails CI — the same role `rls_aal2_coverage()` plays for 0029. Scope it to the
   7 tables only, or it will fail on the 62 deliberately-unwrapped policies.

## Rollout

**Local:** `db reset` → RLS suite → the `EXPLAIN` check.

**Hosted — one deliberate deviation from HANDOFF §3.** §3 says apply in
*separate* `execute_sql` calls. **This migration must go as a SINGLE call.** The
verification reads a temp table captured in the same transaction, and temp tables
do not survive across calls — but more importantly, the entire safety property is
that a mismatch aborts everything. §3's rule exists because a multi-statement
script rolling back wholesale is usually an unpleasant surprise; here it is the
design. Verification still runs in its own separate call afterwards, as §3 wants.

**Before applying, dump the 24 current definitions** from `pg_policies` to a
file. That file *is* the rollback script: a revert is the same drop/create pairs
with the wrappers removed. The originals are reconstructible from 0002 and later
migrations in git, but a dump taken minutes earlier is exact and faster.

Then: apply → verify in a separate call (24 policies wrapped, 0 bare, counts
unchanged) → `get_advisors` → sign in and load a real list page.

**No ordering hazard.** DB-only, no code depends on it, so it can land before,
after or without a deploy.

## Out of scope

- The other 62 policies (see Scope).
- Any change to what the policies *mean*. This is an evaluation-strategy change
  only; if behaviour changes, the migration has a bug.
- `auth.uid()` — 23 policies call it, but it is a Supabase-provided `stable`
  function that reads a GUC rather than a table, so the per-call cost is not
  comparable. Measure separately before assuming it is worth wrapping.
