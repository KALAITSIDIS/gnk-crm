# Improvements Execution Plan — outside report, 2026-08-23

> **For agentic workers:** implement task-by-task. Steps use checkbox (`- [ ]`)
> syntax. **One task → implement → verify → commit → next task**
> (`docs/08_BUILD_PLAYBOOK.md`). Commit format `T<phase>.<n>: description`.
> **Commit, do not push** — the standing agreement. A push triggers a Vercel
> deploy and is the operator's to run.

**Goal:** ship the three items from the 2026-08-23 outside report that survived
a code-level audit, plus the two dashboard corrections the report earned.

**Architecture:** nothing here invents a new subsystem. Task 1 is a rendering
fix. Task 2 extends an existing SQL aggregate. Phase B lifts buyer criteria out
of a JSON blob into a queryable table and computes matches on read. Phase C adds
a reservation record whose liveness is enforced by a partial unique index and
released by the same pg_cron idiom `expire_mandates` and `create_followup_nudges`
already use.

**Tech stack:** Next.js (App Router, server actions) · Supabase Postgres with RLS
· vitest (unit + RLS) · Playwright (E2E) · next-intl (en/el/ru).

---

## Why this list and not the report's list

The report proposed ten modules. Five collide with `docs/01_PROJECT_CONTEXT.md`
§10, binding under CLAUDE.md guardrail 7 (WhatsApp API and KYC API → Phase 3;
portal XML feeds → Phase 5; buyer/lawyer/bank logins and dashboard customization
→ refused permanently; AI voice → out of scope). Four more are already built —
offers, the project/unit module, the Cyprus field set, the PWA.

What is left is this file. The full reasoning is in the verdict artifact
(<https://claude.ai/code/artifact/2a1396a8-1534-4e67-8855-a4f183f7df5c>).

**Standing caveat, recorded not repeated:** production holds only operator test
data, and the standing stance since 2026-07-29 is *stabilise, don't build*. The
operator directed this build explicitly on 2026-08-23. Phase A is decision-free
correctness work and is safe regardless. **Phases B and C are new scope** — if
one real week of desk use happens first, re-read them before starting, because
that week is worth more than this plan's guesses about the desk's workflow.

---

## File map

| File | Change | Task |
|---|---|---|
| `lib/services/events.ts` | Modify — kind-aware `opened` renderer | 1 |
| `lib/services/events.test.ts` | Modify — 3 new assertions | 1 |
| `messages/{en,el,ru}.json` | Modify — one new key each | 1, 2 |
| `supabase/migrations/0042_response_time_percentiles.sql` | Create | 2 |
| `components/features/dashboard/admin-dashboard.tsx` | Modify — p50/p90 tile | 2 |
| `supabase/migrations/0043_buyer_requirements.sql` | Create | 3 |
| `supabase/tests/rls.test.ts` | Modify — tests 30, 31 | 4, 11 |
| `lib/validators/buyer-requirements.ts` | Create | 5 |
| `lib/actions/buyer-requirements.ts` | Create | 5 |
| `components/features/contacts/requirements-card.tsx` | Create | 6 |
| `lib/services/matching.ts` | Create — pure, no I/O | 7 |
| `lib/services/matching.test.ts` | Create | 7 |
| `lib/queries/matches.ts` | Create — candidate fetch | 8 |
| `components/features/contacts/matches-card.tsx` | Create | 8 |
| `components/features/properties/matching-buyers-card.tsx` | Create | 9 |
| `supabase/migrations/0044_reservations.sql` | Create | 10 |
| `lib/validators/reservations.ts` | Create | 12 |
| `lib/actions/reservations.ts` | Create | 12 |
| `components/features/properties/reservation-card.tsx` | Create | 12 |
| `docs/DECISIONS.md` | Append — one entry per phase | 1, 7, 10 |
| `docs/BACKLOG.md` | Append — deferred follow-ons | 13 |

---

## How deeply each task is specified — read this before executing

**Not uniform, deliberately.** Tasks 1, 2, 3 and 10 carry complete code and DDL,
because the files they touch were read at plan time and the content is exact.
Tasks 5, 6, 8, 9 and 12 carry exact file paths, exact behaviour, exact
constraints and the specific existing file to match — but not invented code,
because their targets (`lib/validators/contacts.ts`,
`components/features/deals/offers.tsx`, the property and contact detail pages)
were **not** read at plan time. Code written for them here would be a guess
dressed as a specification, and a wrong guess in a plan is more expensive than
an honest instruction to go and read.

Execute Phase A from this document as written. **Re-specify each Phase B and C
task against the real file immediately before starting it.**

## Definition of Done — every task

- [ ] `npm run typecheck` clean
- [ ] `npm run lint` clean
- [ ] `npm run test` green (plus `npm run test:rls` when policies are touched)
- [ ] Events written for all new mutations (guardrail 1)
- [ ] Committed with a `T<phase>.<n>:` message
- [ ] Actual command output pasted into the summary — not "tests pass"

---

# PHASE A — corrections

Decision-free. Both items are defects or measurement errors, not new scope.

> ## ✅ PHASE A SHIPPED — 2026-08-23, branch `fix/report-phase-a`
>
> | | |
> |---|---|
> | Task 1 | `d2363f1` — `T-A1: render share_link.opened by kind` |
> | Task 2 | `060a70b` — `T-A2: median and p90 first response (0042)` |
> | Verified | `npm run test` **693 passed** (691 baseline + 2) · `npm run test:rls` **49 passed on a first run** · typecheck and lint clean · dashboard read on the rendered page |
> | Local DB | at **0042**, `non_filename_versions` = 0 |
> | Hosted | **NOT applied.** 0042 still needs the HANDOFF §3 apply. Not pushed either — standing agreement |
>
> **One deviation from this plan, deliberate.** Task 2 below specifies a
> standalone `lead_response_percentiles` function. That was wrong and was
> changed during the build: 0042 **extends `admin_dashboard_stats` instead**,
> because 0018 exists to collapse round trips and the `leads_7` CTE already held
> the rows. The step text is left as written rather than back-edited, so the
> deviation stays visible; `docs/DECISIONS.md` `T-A2` carries the reasoning.
>
> **What the on-screen check caught, which no test would have.** The first
> seeding attempt wrote to the RLS **fixture** org, not the admin's, so the
> dashboard correctly rendered zeros — `admin_dashboard_stats` is SECURITY
> INVOKER and RLS scoped them out. Fixture rows were restored to exactly as
> found and the RLS suite passes 49/49 on a first run against them (A8's
> byte-identical rule). Measured after reseeding the right org: **mean 1h 5m,
> median 6m, p90 1h 8m, "4 never answered"** — the 10x mean-to-median gap the
> old single tile was hiding.

---

## Task 1: Availability links stop reporting as empty proposals

**The bug, confirmed.** `lib/services/events.ts` renders *every* `share_link`
`opened` event with the proposal sentence. Migration 0041's availability branch
writes `kind`, `locale`, `unit_count` and `available_count` — deliberately **no**
`property_count` — so `Number(p.property_count) || 0` falls through to zero and
the timeline reads *"Proposal link opened — 0 properties"* for a link that is
working correctly.

The outside report saw this line and concluded empty proposals could be created.
They cannot: `createProposal` deletes the link outright if the property insert
fails ("a proposal with no properties is not a proposal"). **Blocking empty
proposals would fix nothing.**

`revoked` is *not* affected — `revokeShareLink` is shared by both kinds and
always writes `views_at_revocation`.

The precedent for the fix is three functions below in the same registry:
`followup_task_created` already branches on `payload.kind`.

**Files:**
- Modify: `lib/services/events.ts:283-286`
- Modify: `lib/services/events.test.ts`
- Modify: `messages/en.json:252`, `messages/el.json:252`, `messages/ru.json:252`

- [x] **Step 1: Write the failing test**

In `lib/services/events.test.ts`, inside the `describeEvent registry (T3.5) —
English parity` describe block, add:

```ts
  it("renders an availability link's open by units, not by properties (0041)", () => {
    // 0041 writes kind/unit_count/available_count and NO property_count. Before
    // this fix the proposal string was used for both kinds, so a working
    // availability link logged "Proposal link opened — 0 properties".
    expect(
      describeEvent(
        ev(
          "opened",
          { kind: "availability", locale: "en", unit_count: 19, available_count: 7 },
          "share_link",
        ),
        t,
      ),
    ).toBe("Availability link opened — 7 of 19 units available");
    // singular unit, and zero available is a real state worth reading
    expect(
      describeEvent(
        ev(
          "opened",
          { kind: "availability", locale: "en", unit_count: 1, available_count: 0 },
          "share_link",
        ),
        t,
      ),
    ).toBe("Availability link opened — 0 of 1 unit available");
  });

  it("leaves the proposal open line untouched (0023)", () => {
    // A proposal payload has no `kind`, so absence must route to the proposal
    // string — this is the regression guard for the fix above.
    expect(
      describeEvent(ev("opened", { locale: "en", property_count: 3 }, "share_link"), t),
    ).toBe("Proposal link opened — 3 properties");
    expect(
      describeEvent(ev("opened", { locale: "en", property_count: 1 }, "share_link"), t),
    ).toBe("Proposal link opened — 1 property");
  });
```

- [x] **Step 2: Run it and confirm it fails for the right reason**

```bash
npm run test -- lib/services/events.test.ts
```

Expected: the first test FAILS with received `"Proposal link opened — 0 properties"`.
The second test PASSES already. **If the second one fails, stop** — the proposal
path is broken too and this plan's diagnosis is wrong.

- [x] **Step 3: Add the message key in all three locales**

`messages/en.json`, after line 252:

```json
    "shareLinkAvailabilityOpened": "Availability link opened — {available} of {total, plural, one {# unit} other {# units}} available",
```

`messages/el.json`, same position:

```json
    "shareLinkAvailabilityOpened": "Άνοιγμα συνδέσμου διαθεσιμότητας — {available} από {total, plural, one {# μονάδα} other {# μονάδες}} διαθέσιμες",
```

`messages/ru.json`, same position:

```json
    "shareLinkAvailabilityOpened": "Ссылка на наличие открыта — доступно {available} из {total, plural, one {# объекта} few {# объектов} many {# объектов} other {# объектов}}",
```

- [x] **Step 4: Make the renderer kind-aware**

In `lib/services/events.ts`, replace the `opened` entry (lines 283-286) with:

```ts
  // B3 buyer proposal links. `opened` is actor-null — the opener is a buyer,
  // not a user — and is throttled to one per link per Cyprus day (0023), so a
  // timeline shows the days a proposal was read, not every refresh.
  //
  // TWO KINDS SHARE THIS EVENT TYPE. 0041's availability branch writes
  // `kind: 'availability'` with unit_count/available_count and deliberately no
  // property_count; a proposal (0023) writes property_count and no kind. Branch
  // on `kind` like followup_task_created does — reading property_count
  // unconditionally made a working availability link log "0 properties".
  opened: (p, t) => {
    if (asText(p.kind) === "availability") {
      return t("shareLinkAvailabilityOpened", {
        available: Number(p.available_count) || 0,
        total: Number(p.unit_count) || 0,
      });
    }
    const count = Number(p.property_count) || 0;
    return t("shareLinkOpened", { count });
  },
```

- [x] **Step 5: Run the tests and the full unit suite**

```bash
npm run test -- lib/services/events.test.ts
```

Expected: PASS, both new tests.

```bash
npm run test
```

Expected: the full suite green (691 tests as of 2026-08-22, +2 here).

- [x] **Step 6: Typecheck and lint**

```bash
npm run typecheck && npm run lint
```

- [x] **Step 7: Record the decision**

Append to `docs/DECISIONS.md`:

```markdown
## T-A1 — one event type, two share-link kinds (2026-08-23)

0023 and 0041 both write `share_link.opened`. The renderer assumed one kind and
formatted every open with the proposal sentence, so an availability link logged
"Proposal link opened — 0 properties" — a correct feature reported as broken. An
outside review read that line and concluded empty proposals were creatable; they
are not (`createProposal` deletes the husk on a failed property insert), so the
fix it implied would have changed nothing.

Branch on `payload.kind` in the renderer, matching `followup_task_created`.
Rejected: writing `property_count: 0` into the availability payload to satisfy
the old string — that stores a misleading number in an append-only log to fix a
display bug, and `events` has no UPDATE to take it back.
```

- [x] **Step 8: Commit**

```bash
git rev-parse --abbrev-ref HEAD
```

Confirm you are on the intended branch — **this working tree is shared with
parallel sessions and has had its branch switched mid-task before.** Then:

```bash
git add lib/services/events.ts lib/services/events.test.ts messages/en.json messages/el.json messages/ru.json docs/DECISIONS.md
git commit -m "T-A1: render share_link.opened by kind (availability vs proposal)"
```

Stage explicit paths, never `git add -A`.

---

## Task 2: Median and 90th-percentile first response

**Why.** The admin dashboard reports *average* first response. An average hides
the tail that matters: nine leads answered in four minutes and one abandoned for
three days reads as a healthy seven-hour mean. The report is right, and the data
is already collected — `leads.received_at` and `leads.first_response_at` since
0001.

Postgres has `percentile_cont` built in, so this is an extension of the existing
`admin_dashboard_stats` aggregate (0018), not a new query path.

**Files:**
- Create: `supabase/migrations/0042_response_time_percentiles.sql`
- Modify: `components/features/dashboard/admin-dashboard.tsx`
- Modify: `messages/{en,el,ru}.json`

- [x] **Step 1: Read the existing aggregate before touching it**

```bash
sed -n '36,200p' supabase/migrations/0018_dashboard_aggregates.sql
```

You must keep `SECURITY INVOKER` — 0018's header explains it is load-bearing:
the aggregates run under the caller's RLS so they can never become a way to read
another org's totals. Keep the window bounds as parameters for the same reason
0018 gives (the Cyprus month boundary lives in `lib/utils/tz.ts` with tests;
re-deriving it in SQL would be a second source of truth).

- [x] **Step 2: Write the migration**

Create `supabase/migrations/0042_response_time_percentiles.sql`:

```sql
-- 0042 — median and p90 first-response, alongside the existing mean.
--
-- The admin dashboard reported the MEAN only. Nine leads answered in four
-- minutes and one abandoned for three days averages to about seven hours and
-- reads as healthy; the median says four minutes and the p90 says three days,
-- which is the actual story. Raised by the 2026-08-23 outside review, and the
-- data has been collected since 0001 — nothing new is recorded here.
--
-- SECURITY INVOKER is inherited from 0018 and is load-bearing: the aggregate
-- must run under the CALLER's RLS, exactly like the queries it replaced, so it
-- can never become a way to read another org's numbers.
--
-- Window bounds stay PARAMETERS for 0018's reason — the Cyprus wall-clock month
-- boundary lives in lib/utils/tz.ts with unit tests, and re-deriving it here
-- would be a second source of truth that drifts across a DST edge.
--
-- `create or replace function` PRESERVES the existing ACL (HANDOFF §3). Do not
-- re-grant; re-read `proacl` afterwards to confirm.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

create or replace function public.lead_response_percentiles(
  p_from timestamptz,
  p_to   timestamptz
)
returns table (
  answered      bigint,
  unanswered    bigint,
  mean_seconds  numeric,
  p50_seconds   numeric,
  p90_seconds   numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  with answered_leads as (
    select extract(epoch from (first_response_at - received_at)) as secs
      from leads
     where received_at >= p_from
       and received_at <  p_to
       and first_response_at is not null
       -- a negative interval means the clock was corrected, not that the desk
       -- answered before the lead arrived; exclude rather than skew the median
       and first_response_at >= received_at
  )
  select
    (select count(*) from answered_leads)::bigint,
    (select count(*) from leads
      where received_at >= p_from and received_at < p_to
        and first_response_at is null)::bigint,
    (select round(avg(secs)) from answered_leads),
    (select round(percentile_cont(0.5) within group (order by secs)) from answered_leads),
    (select round(percentile_cont(0.9) within group (order by secs)) from answered_leads);
$$;

comment on function public.lead_response_percentiles is
  'Admin dashboard first-response distribution (0042). SECURITY INVOKER — runs under caller RLS.';

do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'lead_response_percentiles'
       and p.prosecdef = false          -- security INVOKER
  ) then
    raise exception '0042 aborted: lead_response_percentiles missing or SECURITY DEFINER';
  end if;

  if has_function_privilege('anon', 'public.lead_response_percentiles(timestamptz, timestamptz)', 'execute') then
    raise exception '0042 aborted: anon can execute lead_response_percentiles';
  end if;
end $$;
```

- [x] **Step 3: Apply locally and verify in a separate call**

```bash
npx supabase migration up
```

Then verify — **a separate invocation, not the same run** (HANDOFF §3: the SQL
editor can discard DDL while a `select` in the same run still sees it):

```bash
npx supabase db query "select proname, prosecdef from pg_proc where proname = 'lead_response_percentiles'"
```

Expected: one row, `prosecdef` = `f`.

- [x] **Step 4: Add the message keys**

`messages/en.json`, in the `dashboard.kpi` namespace:

```json
      "responseMedian": "Median first response",
      "responseP90": "90th percentile",
      "responseUnanswered": "{count} never answered",
```

`messages/el.json`:

```json
      "responseMedian": "Διάμεσος χρόνος πρώτης απόκρισης",
      "responseP90": "90ό εκατοστημόριο",
      "responseUnanswered": "{count} χωρίς απάντηση",
```

`messages/ru.json`:

```json
      "responseMedian": "Медиана первого ответа",
      "responseP90": "90-й процентиль",
      "responseUnanswered": "{count} без ответа",
```

- [x] **Step 5: Render the tiles**

In `components/features/dashboard/admin-dashboard.tsx`, keep the existing
`avgFirstResponse` KPI and add two beside it, reusing the existing `Kpi`
component and the existing duration formatter that `avgFirstResponse` already
uses. The `unanswered` count goes in the `sub` slot of the median tile — an
unanswered lead is excluded from every percentile, so the count must be visible
next to them or the numbers flatter the desk.

- [x] **Step 6: Verify on screen, not only in tests**

```bash
npm run dev
```

Open `/dashboard` as an admin. **Read the actual numbers against the lead rows**
— 0041's lesson was a defect that every test passed and only the rendered page
caught. With few leads in local data, seed a spread first so p50 and p90 differ;
if they are identical, you have not tested anything.

- [x] **Step 7: Full verification**

```bash
npm run typecheck && npm run lint && npm run test
```

- [x] **Step 8: Commit**

```bash
git add supabase/migrations/0042_response_time_percentiles.sql components/features/dashboard/admin-dashboard.tsx messages/en.json messages/el.json messages/ru.json
git commit -m "T-A2: median and p90 first response on the admin dashboard"
```

- [x] **Step 9: Hosted apply — follow HANDOFF §3 exactly**

Do **not** skip the final step. Apply through `execute_sql` in separate calls,
verify in a *further* separate call, diff `md5(prosrc)` against local, then run
`get_advisors`. **Skipping the advisor run is what caused 0021.** Check
`verify_events_chain` before and after.

> **The report's other dashboard notes, deliberately not built here.** "Top
> agents by activity" is a vanity metric and the report is right — but replacing
> it needs the operator to choose which metrics (lead-to-viewing, viewing-to-offer,
> win rate, commission). That is a decision, not decision-free work; it goes to
> `docs/BACKLOG.md` in Task 13. Dashboard filters by agent/office/period are
> refused by guardrail 6 and are not going to BACKLOG either.

---

# PHASE B — buyer requirements and matching

> ## ✅ PHASE B SHIPPED — 2026-08-23, branch `feat/buyer-requirements`
>
> | | |
> |---|---|
> | Task 3 | `8647bde` T-B1 — `buyer_requirements` table, migration **0043** |
> | Task 4 | `3afc906` T-B2 — RLS test **30** |
> | Task 5 | `2d6adf9` T-B3 — validators, actions, events (3 locales) |
> | Task 7 | `1edabbb` T-B5 — the matching engine |
> | Task 8a | `a3df6bd` T-B6a — candidate queries, both directions |
> | Task 6 | `a7ea10f` T-B4 — saved searches on the contact page |
> | Tasks 8b/9 | `3a6a4c7` T-B6/B7 — both match views |
> | Verified | `npm run test` **743 passed** (+44 over Phase A) · `npm run test:rls` **50 passed, first run** · typecheck and lint clean · **both directions read on the rendered page against a hand-computed prediction** |
>
> **Three corrections to this plan, made during the build and left visible
> rather than back-edited.**
>
> 1. **Task 3's DDL was wrong.** It asserted `array_length()` on
>    `rls_aal2_coverage()`, which returns `TABLE(missing_table text)` — a SET.
>    The migration would have aborted. Caught by reading
>    `pg_get_function_result` before writing the file, not by applying it.
> 2. **`PROPERTY_FEATURE_KEYS` does not exist.** The real export is
>    `FEATURE_KEYS`, and it is narrowly typed, so membership tests need a widen.
> 3. **The plan said to read the target files first, and that was right.**
>    `ActionSectionForm`, the `SELECT_NONE` sentinel and the Radix
>    checkbox/hidden-input pairing were all discovered by reading, and inventing
>    code for them would have been wrong in three separate ways.
>
> **A tooling limit worth carrying:** Radix checkboxes cannot be driven by
> synthetic events from the browser tooling — same family as the documented
> TabsTrigger and dnd-kit limitations. The array write path is covered by
> validator unit tests and the read path was proven by setting columns directly
> and reading the rendered summary.

**Stop and re-read before starting.** Phase A is correctness. This is new scope,
and it is the largest thing in the plan. It is justified by *cheap now, expensive
later*: restructuring criteria with two contacts in the database is a migration;
with two thousand it is a project.

---

## Task 3: The `buyer_requirements` table

**The design decision.** Criteria live today in `contacts.preferences` as
free-form JSON — one search per contact, and not queryable. A real buyer has
several: "2-bed under €300k in Kato Paphos" *and* "any plot over 500 m² in
Tala". A JSON blob can hold neither the plurality nor an index.

**Deliberately NOT stored: the match score.** `quality_score` is stored, and
`lib/services/quality-score.ts` carries the warning that changing a weight makes
every stored score stale — with a `scripts/recompute-scores.mts` to repair it.
Match scores are computed on read instead, so that class of staleness cannot
exist. It costs a little CPU per page and saves a backfill script forever.

**Files:**
- Create: `supabase/migrations/0043_buyer_requirements.sql`

- [x] **Step 1: Re-read the grant trap before writing a line of DDL**

```bash
sed -n '1,40p' supabase/migrations/0040_unit_types_grants.sql
```

**A new table needs an explicit REVOKE before its GRANT.** Supabase's default
privileges on `public` fire at CREATE TABLE and `grant` is additive, so a
migration that only grants ends up with the platform's grants plus its own. 0023
documented this; 0039 did not follow it and needed 0040 to undo. Do not be the
third.

Also: 0029 put `require_aal2` on every RLS table, and **a table created after
0029 does not inherit it.** `rls_aal2_coverage()` exists to catch the omission
and an RLS test asserts it returns empty.

- [x] **Step 2: Write the migration**

Create `supabase/migrations/0043_buyer_requirements.sql`:

```sql
-- 0043 — buyer requirements as rows, not as a JSON blob.
--
-- `contacts.preferences` holds one unstructured search per contact. A real
-- buyer has several ("2-bed under 300k in Kato Paphos" AND "any plot over
-- 500 m² in Tala"), and a blob can hold neither the plurality nor an index.
-- Matching in either direction needs both.
--
-- THE SCORE IS NOT STORED, AND THAT IS THE POINT. quality_score is stored and
-- carries a standing warning that changing a weight makes every stored value
-- stale, plus scripts/recompute-scores.mts to repair it. Match scores are
-- computed on read (lib/services/matching.ts), so that failure mode cannot
-- exist here. Weights may change freely.
--
-- `contacts.preferences` is NOT dropped by this migration. It stays until the
-- backfill has been reviewed on real data and the UI no longer reads it;
-- dropping a column in the same migration that introduces its replacement
-- leaves no way back if the backfill is wrong. Removal is a BACKLOG line.
--
-- ARRAYS, NOT JOIN TABLES, for districts/areas/types. A requirement is read
-- whole, always, and never joined from the other side; `&&` on a GIN-indexed
-- array is the operator matching actually needs.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

create table if not exists public.buyer_requirements (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id),
  contact_id    uuid not null references public.contacts(id) on delete cascade,
  label         text,
  is_active     boolean not null default true,

  transaction_type transaction_type not null default 'sale',
  property_types   property_type[] not null default '{}',
  district_ids     uuid[] not null default '{}',
  area_ids         uuid[] not null default '{}',

  currency      text not null default 'EUR',
  budget_min    numeric(14,2),
  budget_max    numeric(14,2),

  bedrooms_min  int,
  bedrooms_max  int,
  bathrooms_min int,
  covered_area_min_sqm numeric(10,2),
  plot_area_min_sqm    numeric(12,2),

  -- Cyprus-specific criteria the desk actually gets asked for
  title_deed_required  boolean not null default false,
  vat_preference       vat_status,
  max_sea_distance_m   int,
  delivery_by          date,
  features_required    text[] not null default '{}',

  notes         text,
  created_by    uuid references public.profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint budget_band_ordered
    check (budget_min is null or budget_max is null or budget_min <= budget_max),
  constraint bedrooms_band_ordered
    check (bedrooms_min is null or bedrooms_max is null or bedrooms_min <= bedrooms_max)
);

create index if not exists buyer_requirements_contact_idx
  on public.buyer_requirements(contact_id);
-- the matching sweep reads active requirements org-wide, one row per buyer search
create index if not exists buyer_requirements_active_idx
  on public.buyer_requirements(org_id) where is_active;
create index if not exists buyer_requirements_districts_idx
  on public.buyer_requirements using gin (district_ids);
create index if not exists buyer_requirements_areas_idx
  on public.buyer_requirements using gin (area_ids);

alter table public.buyer_requirements enable row level security;

-- REVOKE BEFORE GRANT — 0040's rule. Supabase's default privileges fire at
-- CREATE TABLE and `grant` is additive, so granting alone leaves anon holding
-- privileges nobody asked for.
revoke all privileges on table public.buyer_requirements from anon;
revoke all privileges on table public.buyer_requirements from authenticated;

grant select, insert, update, delete on table public.buyer_requirements to authenticated;

-- Mirrors `contacts` (0002), not price_lists: a requirement is CRM data about a
-- buyer, so any agent in the org may record and edit one.
create policy buyer_requirements_select on public.buyer_requirements for select
  using (org_id = current_org_id());
create policy buyer_requirements_insert on public.buyer_requirements for insert
  with check (org_id = current_org_id());
create policy buyer_requirements_update on public.buyer_requirements for update
  using (org_id = current_org_id())
  with check (org_id = current_org_id());
create policy buyer_requirements_delete on public.buyer_requirements for delete
  using (org_id = current_org_id() and current_role_gnk() in ('admin','listing_manager'));

-- 0029 put require_aal2 on every RLS table; a table created AFTER it does not
-- inherit that. RESTRICTIVE, ALL, to authenticated, both USING and WITH CHECK —
-- same shape as every other. rls_aal2_coverage() must stay at 0.
create policy require_aal2 on public.buyer_requirements
  as restrictive for all to authenticated
  using ((select public.mfa_satisfied()))
  with check ((select public.mfa_satisfied()));

do $$
declare
  policies int;
begin
  select count(*) into policies from pg_policies
   where schemaname = 'public' and tablename = 'buyer_requirements';
  if policies <> 5 then
    raise exception '0043 aborted: expected 5 policies on buyer_requirements (4 + require_aal2), found %', policies;
  end if;

  if has_table_privilege('anon', 'public.buyer_requirements', 'select')
     or has_table_privilege('anon', 'public.buyer_requirements', 'insert')
     or has_table_privilege('anon', 'public.buyer_requirements', 'update')
     or has_table_privilege('anon', 'public.buyer_requirements', 'delete') then
    raise exception '0043 aborted: anon still holds a grant on buyer_requirements';
  end if;

  if array_length(public.rls_aal2_coverage(), 1) is not null then
    raise exception '0043 aborted: rls_aal2_coverage() is not empty';
  end if;
end $$;
```

- [x] **Step 3: Apply locally, verify separately**

```bash
npx supabase migration up
```

```bash
npx supabase db query "select tablename, count(*) from pg_policies where tablename='buyer_requirements' group by 1"
```

Expected: `buyer_requirements | 5`.

- [x] **Step 4: Regenerate types**

```bash
npm run db:types
```

- [x] **Step 5: Commit**

```bash
git add supabase/migrations/0043_buyer_requirements.sql lib/supabase/database.types.ts
git commit -m "T-B1: buyer_requirements table with RLS, aal2 and revoke-before-grant"
```

---

## Task 4: RLS tests for `buyer_requirements`

Guardrail 3: **RLS is tested, not trusted.** A migration touching policies
without updated tests is incomplete.

**Files:**
- Modify: `supabase/tests/rls.test.ts`

- [x] **Step 1: Write test 30**

Follow the shape of the existing numbered tests. Assert, at minimum:

1. an agent in org A reads a requirement belonging to org A;
2. an agent in org A reads **zero** requirements belonging to org B (insert one
   as `svc` first, or the test proves nothing);
3. an agent may INSERT and UPDATE a requirement in their own org;
4. an agent may **not** DELETE (only admin / listing_manager may);
5. `anon` reads zero and cannot insert.

**Assert on the returned error, not only on the row count.** TEST-2 hid a
permission regression for months precisely by ignoring an action's returned
error.

- [x] **Step 2: Run the RLS suite against a fresh database**

```bash
npm run test:rls
```

It must pass on the **first** run against a fresh DB. **A test that only passes
on a rerun is depending on residue** — that is a standing rule in
`tests/README.md`, not a preference.

- [x] **Step 3: Commit**

```bash
git add supabase/tests/rls.test.ts
git commit -m "T-B2: RLS test 30 — buyer_requirements org isolation and delete role gate"
```

---

## Task 5: Validators and server actions

**Files:**
- Create: `lib/validators/buyer-requirements.ts`
- Create: `lib/actions/buyer-requirements.ts`

- [x] **Step 1: Read two existing pairs first**

```bash
sed -n '1,80p' lib/validators/contacts.ts
sed -n '160,240p' lib/actions/deals.ts
```

Match their idiom exactly: a zod schema parsed from `FormData`, an action
returning `{ error: string | null; savedAt: number | null }`, `getCurrentProfile`
for org scoping, `logEvent` before `revalidatePath`.

- [x] **Step 2: Write the validator**

`lib/validators/buyer-requirements.ts` — a `saveBuyerRequirementSchema` covering
every column from Task 3, with:
- `budget_min <= budget_max` and `bedrooms_min <= bedrooms_max` as `.refine()`
  checks, so the DB constraint is never the first line of defence for a user
  error;
- empty strings coerced to `null` for every optional numeric (an untouched form
  field arrives as `""`, and `Number("")` is `0` — a silent budget of zero);
- arrays parsed from repeated form keys.

- [x] **Step 3: Write the actions**

`lib/actions/buyer-requirements.ts` exporting `saveBuyerRequirement`,
`archiveBuyerRequirement` (sets `is_active = false`; **not** a delete), and
`deleteBuyerRequirement` (admin / listing_manager, matching the policy).

**Every one writes an event** (guardrail 1) with `entityType: "contact"` and the
contact's id — the requirement belongs to the buyer's timeline, and `ENTITY_TYPES`
in `lib/services/events.ts` has no `buyer_requirement` member. Event types:
`requirement_added`, `requirement_updated`, `requirement_archived`.

- [x] **Step 4: Add the three event strings to `lib/services/events.ts` and all
      three locale files**, following Task 1's pattern.

- [x] **Step 5: Unit-test the validator**

Create `lib/validators/buyer-requirements.test.ts`. Cover at least: the empty
string → null coercion for each optional numeric, the two ordering refinements,
and array parsing from repeated keys.

```bash
npm run test -- lib/validators/buyer-requirements.test.ts
```

- [x] **Step 6: Verify and commit**

```bash
npm run typecheck && npm run lint && npm run test
git add lib/validators/buyer-requirements.ts lib/validators/buyer-requirements.test.ts lib/actions/buyer-requirements.ts lib/services/events.ts messages/en.json messages/el.json messages/ru.json
git commit -m "T-B3: buyer requirement validators, actions and events"
```

---

## Task 6: Requirements UI on the contact page

**Files:**
- Create: `components/features/contacts/requirements-card.tsx`
- Modify: `app/(app)/contacts/[id]/page.tsx`

- [x] **Step 1: Build the card** — list the contact's active requirements, each
      with an inline edit form and an archive control; an "Add requirement"
      form; archived ones behind a disclosure. Read
      `components/features/deals/offers.tsx` first and match its structure —
      it is the closest existing multi-row card with per-row actions.

- [x] **Step 2: Show the legacy blob during transition.** If
      `contacts.preferences` is non-empty and the contact has no requirement
      rows, render it read-only with a "Convert to requirement" button that
      prefills the add form. `preferences` is not dropped until Task 13's
      BACKLOG line is actioned, and a silently ignored blob is data loss the
      desk will not notice.

- [x] **Step 3: Label every Select trigger.** A11Y-1 found 40 orphaned labels
      across 15 files; `tests/e2e/accessibility.spec.ts` guards it and will fail
      the build otherwise.

- [x] **Step 4: Verify in the browser**, including a mid-form Radix
      interaction — `docs/ENGINEERING_NOTES.md` documents Radix mousedown traps
      that only appear in a real browser.

- [x] **Step 5: Verify and commit**

```bash
npm run typecheck && npm run lint && npm run test
git add components/features/contacts/requirements-card.tsx "app/(app)/contacts/[id]/page.tsx"
git commit -m "T-B4: buyer requirements card on the contact page"
```

---

## Task 7: The matching engine

**Files:**
- Create: `lib/services/matching.ts`
- Create: `lib/services/matching.test.ts`
- Modify: `docs/DECISIONS.md`

**Pure, no I/O.** The service takes a requirement and a property and returns a
verdict. Fetching candidates is Task 8's job. This is what makes it exhaustively
unit-testable without a database.

**The rules, decided here rather than deferred** (CLAUDE.md: choose the option
most consistent with docs 01–02, implement it, record it in DECISIONS):

*Hard filters — a miss disqualifies, and the reason is named:*
- `transaction_type` must equal the property's.
- If `property_types` is non-empty, the property's type must be in it.
- If `district_ids` is non-empty, the property's district must be in it.
- If `bedrooms_min` is set, the property must meet it.
- If `title_deed_required`, the property's `title_deed_status` must be `separate`.
- Price: over `budget_max` **by more than 10%** disqualifies. Within 10% is a
  soft penalty, not a rejection — a €5,000 overshoot on €300,000 is a
  negotiation, and a matcher that hides it is worse than no matcher. The
  tolerance is one exported constant, `BUDGET_TOLERANCE_PCT`.
- Property status must be sellable (not `sold`, not `archived`, not `draft`).

*Soft criteria — contribute to a 0–100 score, weighted:*
area match (25) · bedrooms above minimum (10) · covered area at or above minimum
(15) · within budget with room to spare (15) · sea distance (10) · delivery date
before `delivery_by` (10) · VAT preference (5) · each required feature present
(10 shared across the list).

Score = points earned ÷ points **applicable**, so a requirement that specifies
little is not punished for it. A criterion the requirement leaves null is
excluded from both numerator and denominator.

*Always return the misses.* The report is right that an unexplained score is
useless, and it is consistent with guardrail 6's spirit.

- [x] **Step 1: Write the types and the failing tests first**

```ts
export interface MatchVerdict {
  /** false when any hard filter failed — `score` is then 0 */
  eligible: boolean;
  /** 0–100, points earned over points applicable */
  score: number;
  /** hard filters that failed, machine-readable */
  blockers: MatchReason[];
  /** soft criteria that did not earn their points */
  misses: MatchReason[];
  /** soft criteria that did */
  hits: MatchReason[];
}

export type MatchReason =
  | { code: "transaction_type"; wanted: string; got: string }
  | { code: "property_type"; wanted: string[]; got: string }
  | { code: "district"; wanted: string[]; got: string | null }
  | { code: "area"; wanted: string[]; got: string | null }
  | { code: "budget"; max: number; got: number; overBy: number }
  | { code: "bedrooms"; min: number | null; max: number | null; got: number | null }
  | { code: "covered_area"; min: number; got: number | null }
  | { code: "title_deed"; got: string }
  | { code: "sea_distance"; max: number; got: number | null }
  | { code: "delivery"; by: string; got: string | null }
  | { code: "vat"; wanted: string; got: string }
  | { code: "feature"; feature: string }
  | { code: "status"; got: string };
```

Write `matching.test.ts` covering, at minimum:
- each hard filter rejecting on its own, with the right `blockers` code;
- a property €1 over budget scoring but flagged; a property 11% over rejected;
- **the boundary at exactly 10%** — pick the inclusive side deliberately and
  assert it, or the next reader will change it by accident;
- a requirement with only `transaction_type` set scoring 100 on any sellable
  property of that type (nothing applicable, nothing missed);
- `bedrooms_max` respected — a 5-bed is not a match for someone who asked for
  2–3;
- null-heavy inputs never throwing.

- [x] **Step 2: Run them and confirm they fail**

```bash
npm run test -- lib/services/matching.test.ts
```

- [x] **Step 3: Implement `matching.ts`** with `BUDGET_TOLERANCE_PCT` and the
      weight table as exported constants, each carrying a one-line comment on
      why that weight. Because the score is never stored, changing a weight is
      safe — say so in the header so nobody adds a recompute script.

- [x] **Step 4: Run to green, then the full suite**

```bash
npm run test -- lib/services/matching.test.ts && npm run test
```

- [x] **Step 5: Record the decision in `docs/DECISIONS.md`** — the hard/soft
      split, the 10% tolerance and its boundary, the weights, and the choice not
      to store the score.

- [x] **Step 6: Commit**

```bash
git add lib/services/matching.ts lib/services/matching.test.ts docs/DECISIONS.md
git commit -m "T-B5: matching engine — hard filters, weighted soft score, named misses"
```

---

## Task 8: Matches on the contact page

**Files:**
- Create: `lib/queries/matches.ts`
- Create: `components/features/contacts/matches-card.tsx`
- Modify: `app/(app)/contacts/[id]/page.tsx`

- [x] **Step 1: Write the candidate query.** Push every hard filter that SQL can
      express into the query — transaction type, status, district via `&&`,
      bedrooms, the budget ceiling plus tolerance — then score the survivors in
      TypeScript. Fetching the whole property table and filtering in memory is
      the PERF-3 mistake (0018) repeated.

- [x] **Step 2: Cap and disclose.** Take the top 20 by score. If more candidates
      were eligible, **say so on screen** — B1's lesson is that a silently
      truncated list is indistinguishable from a complete one.

- [x] **Step 3: Render**, one row per property: score, cover thumbnail,
      reference, price, and the misses as plain-language chips ("€12,000 over
      budget", "no separate title deed"). One requirement at a time, selectable
      when the contact has several.

- [x] **Step 4: Respect RLS.** The query runs under the caller's client, so an
      agent sees only properties they may already open. **Confirm this with a
      restricted user in the browser**, not by reading the code.

- [x] **Step 5: Verify and commit**

```bash
npm run typecheck && npm run lint && npm run test
git add lib/queries/matches.ts components/features/contacts/matches-card.tsx "app/(app)/contacts/[id]/page.tsx"
git commit -m "T-B6: matching properties on the contact page"
```

---

## Task 9: Matching buyers on the property page

**Files:**
- Create: `components/features/properties/matching-buyers-card.tsx`
- Modify: `app/(app)/properties/[id]/page.tsx`
- Modify: `lib/queries/matches.ts`

- [x] **Step 1: Add the reverse query** to `lib/queries/matches.ts` — active
      requirements whose arrays contain this property's district and whose band
      admits its price, scored with the **same** `matching.ts` functions. Two
      scoring implementations would drift within a month.

- [x] **Step 2: Render** buyer name, score, requirement label, misses, and the
      assigned agent — so a listing manager can see whose buyer it is before
      picking up the phone.

- [x] **Step 3: One E2E test.** Add to `tests/e2e/` : seed a property and a
      matching requirement, open the property, assert the buyer appears with a
      score; change the price above tolerance, assert they drop off.

```bash
npx playwright test tests/e2e/matching.spec.ts --project=setup --project=desktop
```

- [x] **Step 4: Verify and commit**

```bash
npm run typecheck && npm run lint && npm run test
git add components/features/properties/matching-buyers-card.tsx "app/(app)/properties/[id]/page.tsx" lib/queries/matches.ts tests/e2e/matching.spec.ts
git commit -m "T-B7: matching buyers on the property page"
```

---

# PHASE C — reservations

> ## ✅ PHASE C SHIPPED — 2026-08-24, merged `22246ad`
>
> | | |
> |---|---|
> | Task 10 | `a99fd17` T-C1 — `reservations` + the partial unique index, migration **0044** |
> | Task 11 | `4d61b26` T-C2 — RLS test **31** |
> | Task 12 | `737a789` T-C3 — validators, actions, transition table, property card |
> | — | `ea79780` T-C4 — **lock down `expire_reservations`, a real hole the advisor caught** |
> | Task 13 | `a0e0dfe` — DECISIONS + BACKLOG closeout |
> | Verified | `npm run test` **752** · `npm run test:rls` **51, first run** · the invariant proven in all three directions on BOTH local and hosted · full lifecycle read on the rendered page · a hold taken on production |
>
> **The advisor run earned its place.** `get_advisors` on the hosted apply
> flagged `expire_reservations()` as callable by **`anon`** over PostgREST —
> anyone unauthenticated could have force-expired every live hold in every org.
> A new function carries a PUBLIC `=X` grant; the older cron functions are clean
> only because 0007 locked them down. Fixed in T-C4, ACL now byte-identical to
> `create_followup_nudges`, advisor list back to its pre-Phase-C contents.
>
> **One more plan correction, left visible.** `cyprusEndOfDay` first hardcoded
> `+03:00` — correct in summer, an hour wrong every winter, because Cyprus is
> EET (UTC+2) outside DST. It now delegates to `tz.ts`, and a test pins both
> sides of the year. That is the third time this plan's own code was wrong and
> reading the target file first caught it.

---

## Task 10: The `reservations` table and its expiry

**The load-bearing constraint** is a partial unique index: at most one live
reservation per property. That single line is what makes "a unit held in
someone's head and sold twice" impossible, and it belongs in the database rather
than in an action, because an action can be raced.

**Files:**
- Create: `supabase/migrations/0044_reservations.sql`
- Modify: `docs/DECISIONS.md`

- [x] **Step 1: Re-read the idempotence lesson before writing the cron function**

```bash
sed -n '1,40p' supabase/migrations/0020_followup_nudges.sql
```

Carry across what 0012 and 0020 learned: idempotence keyed to a **cycle**, never
to "does any row exist" (that form is the 0006 bug that made reminders one-shot
forever); Cyprus end-of-day stamps, not midnight UTC; stated invariants,
self-healed by cron; state changes recorded as events, never as deletions.

- [x] **Step 2: Write the migration** — `reservation_status` enum
      (`held`, `confirmed`, `expired`, `released`, `converted`), the table
      (property, contact, deal, offer, amount, `held_from`, `expires_at`,
      `released_at`, `release_reason`, notes, audit columns), and:

```sql
-- THE invariant of this table. `held` and `confirmed` are the live states; a
-- second live reservation on the same property is what selling a unit twice
-- looks like in data. Enforced here rather than in the action because an action
-- can be raced and an index cannot.
create unique index if not exists reservations_one_live_per_property
  on public.reservations(property_id)
  where status in ('held', 'confirmed');
```

Plus `expires_at > held_from` as a check constraint, `revoke` before `grant`,
four policies mirroring `deals`, `require_aal2`, and the `do $$` assertion block
asserting **6** objects (5 policies + the partial index) and no anon grant.

- [x] **Step 3: Write `expire_reservations()`** — flips live rows whose
      `expires_at` has passed to `expired`, stamps `released_at`, and inserts an
      actor-null `share_link`-style system event per row
      (`entity_type = 'property'`, `event_type = 'reservation_expired'`, payload
      carrying the reservation id and contact). Never deletes. Then:

```sql
select cron.schedule('expire-reservations', '45 3 * * *', $$select expire_reservations()$$);
```

03:45 — after the existing 03:00 / 03:15 / 03:30 jobs, so a night's runs stay
readable in order.

- [x] **Step 4: Apply locally, verify in a separate call, regenerate types**

```bash
npx supabase migration up
npx supabase db query "select indexname from pg_indexes where tablename='reservations'"
npm run db:types
```

- [x] **Step 5: Prove the index actually bites**

```bash
npx supabase db query "insert into reservations (org_id, property_id, status, expires_at) select org_id, property_id, 'held', now() + interval '7 days' from reservations limit 1"
```

Expected: **ERROR**, duplicate key on `reservations_one_live_per_property`. If it
succeeds, the index predicate is wrong — an assertion that cannot fail spends a
green run on nothing.

- [x] **Step 6: Record the decision and commit**

```bash
git add supabase/migrations/0044_reservations.sql lib/supabase/database.types.ts docs/DECISIONS.md
git commit -m "T-C1: reservations table, one-live-per-property index, nightly expiry"
```

---

## Task 11: RLS tests for `reservations`

- [x] **Step 1: Write test 31** in `supabase/tests/rls.test.ts` — org isolation
      both ways, agent insert/update permitted, delete gated to admin /
      listing_manager, anon reads zero. Assert on returned errors.

- [x] **Step 2: Test the expiry function directly** — insert a reservation with
      `expires_at` in the past, call `expire_reservations()`, assert the row is
      `expired`, the event exists, and **a second call is a no-op** (idempotence
      keyed to the cycle, per 0020).

- [x] **Step 3: Run on a fresh database — must pass first time**

```bash
npm run test:rls
```

- [x] **Step 4: Commit**

```bash
git add supabase/tests/rls.test.ts
git commit -m "T-C2: RLS test 31 — reservations isolation and idempotent expiry"
```

---

## Task 12: Reservation actions and UI

**Files:**
- Create: `lib/validators/reservations.ts`
- Create: `lib/actions/reservations.ts`
- Create: `components/features/properties/reservation-card.tsx`
- Modify: `app/(app)/properties/[id]/page.tsx`

- [x] **Step 1: Actions** — `createReservation`, `extendReservation`,
      `releaseReservation` (explicit, with a reason), `confirmReservation`
      (`held` → `confirmed`). A transition table like `OFFER_TRANSITIONS` in
      `lib/validators/deals.ts`; read it first and mirror it. Terminal states
      are immutable, exactly as decided offers are.

- [x] **Step 2: Translate the unique-violation into a sentence.** Postgres
      error `23505` on `reservations_one_live_per_property` must surface as
      *"This property already has a live reservation"* — not a raw driver
      message. This is the single most likely error a user will hit.

- [x] **Step 3: Events for every transition** (guardrail 1):
      `reservation_created`, `reservation_extended`, `reservation_released`,
      `reservation_confirmed`, plus renderers and all three locales.

- [x] **Step 4: The card** — live reservation with a countdown to `expires_at`,
      the actions, and reservation history below. Show the countdown in Cyprus
      time via `lib/utils/tz.ts`; do not re-derive it.

- [x] **Step 5: Verify in the browser** — create a reservation, attempt a second
      on the same property, confirm the sentence from Step 2 appears.

- [x] **Step 6: Verify and commit**

```bash
npm run typecheck && npm run lint && npm run test
git add lib/validators/reservations.ts lib/actions/reservations.ts components/features/properties/reservation-card.tsx "app/(app)/properties/[id]/page.tsx" lib/services/events.ts messages/en.json messages/el.json messages/ru.json
git commit -m "T-C3: reservation actions, transitions and property card"
```

---

## Task 13: Close out — BACKLOG, HANDOFF, hosted apply

- [x] **Step 1: Append the deferred follow-ons to `docs/BACKLOG.md`**, each
      marked as needing explicit direction:
      - replace "top agents by activity" with conversion metrics — **needs an
        operator decision on which metrics**;
      - drop `contacts.preferences` once the requirements backfill is reviewed
        on real data;
      - price-drop campaign: on a price change, find newly-matching buyers
        (the report's automation example, now cheap because Task 7 exists);
      - reservation deposit tracking against `payment_plans`;
      - instalment reminders (payment plans exist; reminders do not).

- [x] **Step 2: Update `HANDOFF.md`** — migration count 41 → 44, the new cron
      job, new test counts **from the commands that produced them**, and the new
      tables in the RLS table count. **Date every claim.** Do not summarise this
      plan into §0; point at this file.

- [x] **Step 3: Apply 0043 and 0044 to hosted — HANDOFF §3, in full.** Separate
      `execute_sql` calls per stage, verify in a *further* separate call,
      `md5(prosrc)` diff for each function, then `get_advisors`. Check
      `verify_events_chain` **before and after** on both sides. Confirm
      `rls_aal2_coverage()` is still 0 and `anon` holds INSERT on 0 tables.

- [x] **Step 4: Do not push.** Leave the push as a one-line command in the
      handoff for the operator:

```bash
git push origin main
```

- [x] **Step 5: After the operator pushes, check CI for that SHA.** CI was red
      for five consecutive commits once and nobody noticed — every failure was
      the `rls` job only, while `checks` passed throughout. **Local green is not
      CI green.**

---

## Deliberately not in this plan

| Item | Why |
|---|---|
| Unified WhatsApp/email inbox | Phase 3 by §10. Largest build in the report, and a desk that has created zero tasks will not migrate its messaging into a CRM. |
| Portal syndication (Bazaraki, INDEX) | Phase 5 by §10, and gated on commercial terms rather than on code. |
| AML/PEP/sanctions screening | Phase 3 by §10. Manual checklist is compliant today; **EU Regulation 2024/1624 applies 10 July 2027** — that is the outside date, recorded here so it is planned for rather than rediscovered. |
| Client / external-broker portals as logins | Refused permanently by guardrail 4 ("Ever"). Extend tokenized share links instead. |
| Automation rule builder | A builder UI for a single-office tool costs more than the rules it produces. Add rules as code until someone asks for the fourth twice. |
| AI voice logging | Out of scope by §10, not merely deferred. |
| Dashboard filters by agent/office/period | Dashboard customization, refused by guardrail 6. |
| Next Best Action, owner dashboard, comparables, portal-readiness check | Genuinely good, and mine rather than the report's — they belong in `IMPROVEMENTS.md` after this plan lands, not bundled into it. |
