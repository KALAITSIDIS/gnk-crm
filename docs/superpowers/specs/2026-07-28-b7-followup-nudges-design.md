# B7 — automated follow-up nudges (design)

Date: 2026-07-28 · Roadmap: `IMPROVEMENTS.md` §B7 · Migration: **0020**
Pattern copied from: `supabase/migrations/0012_renewal_task_lifecycle.sql`

---

## 1. What this builds

Two cron-driven nudge rules, materialised as real `tasks` rows:

1. **`deal_no_contact`** — an open deal with no activity for 14 days.
2. **`viewing_feedback`** — a completed viewing whose feedback is still null
   48 hours after it was scheduled.

The roadmap's third rule ("mandate expiring in 30 days") **already exists** via
`expire_mandates()` and is not rebuilt.

Why it matters: first-response time is measured on the dashboard, but nothing
acts on it.

---

## 2. Settled decisions (operator, 2026-07-28)

| # | Question | Decision |
|---|---|---|
| 1 | What counts as "contact" on a deal? | **`deals.last_activity_at`** |
| 2 | Re-nag policy | **Once per silent period** (cycle-keyed) |
| 3 | Auto-complete when the condition clears? | **Yes — supersede, 0012-shaped** |
| 4 | Viewing-feedback threshold | **48 hours** after `scheduled_at` |
| 5 | Existing virtual feedback section | **Retire it; materialise as tasks** |
| 6 | Thresholds hardcoded or config? | **Hardcoded** in the SQL function |
| 7 | Backfill `kind` onto renewal tasks? | **Yes — `kind` is the one discriminator** |

### Why `last_activity_at` and not contact events

There is **no deal-scoped contact event in the schema today**. `contacted`,
`called`, `conversation_logged` and `chat_link_opened` are all written with
`entity_type='lead'` (or `'contact'`) — see `lib/actions/leads.ts:356,393,434,511`.
The only deal-scoped events are `created`, `updated`, `status_changed`, `won`,
`lost`, `won_override`, plus offer events. A nudge keyed to "agent-initiated
contact events on the deal" would therefore fire on every open deal and be
unsilenceable except by converting a lead.

`deals.last_activity_at` already exists, and is bumped by deal edits
(`lib/actions/deals.ts:138`), the 0011 stage-move RPC, offer create/decide
(`deals.ts:258,334`), won/lost (`deals.ts:408,481`) and `logConversation` on a
converted lead (`lib/actions/leads.ts:445`). It is the input to the health
score's activity factor, whose own cliff is **14 days** (doc 02 §C5: ≤7d full
credit, ≤14d half, beyond that zero). So the nudge fires exactly when the
health score's activity factor reaches zero — one number, one meaning.

**Known weakness, accepted:** a pure record edit (retyping a deal title) counts
as contact and buys 14 days of silence. Closing that needs a deal-scoped "Log
contact" affordance, which is outside B7. → `docs/BACKLOG.md`.

### Why the existing virtual feedback section is retired

`app/(app)/tasks/page.tsx:163` and
`components/features/dashboard/agent-dashboard.tsx:108` already render a
"Viewings awaiting feedback" section from a **live query**
(`status='completed' and feedback is null`), deliberately not task rows — the
page docstring's reasoning is that a live query "can never drift out of sync
with the viewings themselves".

That property is real, but the surface has no threshold (it nags the instant a
viewing is completed), no due date, no assignee fallback, no admin visibility,
no CSV export and no event trail. Task rows get all of those; the "cannot
drift" property is restored by the supersede invariant in §4, which fires from
a trigger the moment feedback is saved — not the next morning.

---

## 3. Schema (migration 0020)

```sql
alter table tasks add column if not exists kind text;
alter table tasks add column if not exists viewing_id uuid references viewings(id);
alter table tasks add constraint tasks_kind_chk
  check (kind is null or kind in ('mandate_renewal','deal_no_contact','viewing_feedback'));

create index if not exists tasks_nudge_deal_idx
  on tasks(deal_id, due_at) where kind = 'deal_no_contact';
create index if not exists tasks_nudge_viewing_idx
  on tasks(viewing_id) where kind = 'viewing_feedback';
```

**`kind` is the marker, and `kind is null` means "a human made this".** 0012 had
no marker of its own and used `mandate_id is not null` as a proxy; that proxy is
already read in two places (`app/(app)/tasks/page.tsx:117` for the "auto" badge,
`lib/services/task-export.ts` for the CSV "Auto" column) and would have to grow
an `or kind is not null` in both, forever. So 0020 backfills
`kind='mandate_renewal'` and re-states `expire_mandates()` to stamp it —
**the guard predicate and every other line of 0012's function stay byte-identical;
only the INSERT column list changes.**

A `CHECK` constraint (not free text like `events.entity_type`) because this is a
closed set the schema owns: a typo in the cron would otherwise mint tasks that
no surface recognises as nudges.

`docs/03_DATABASE_SCHEMA.sql` is updated in the same commit (CLAUDE.md working
method).

---

## 4. The invariants

Stated as invariants, self-healed by cron, exactly as 0012 does:

> **An OPEN `deal_no_contact` task exists iff its deal is OPEN and its due date
> equals that deal's current staleness boundary.**

> **An OPEN `viewing_feedback` task exists iff its viewing is COMPLETED and its
> feedback is still null.**

The **staleness boundary** is the cycle key, the direct analogue of 0012's
mandate expiry date:

```
boundary(deal) = (last_activity_at at time zone 'Asia/Nicosia')::date + 14
```

- The task's `due_at` is Cyprus **end-of-day of that boundary** — so it is due
  the day it appears, and never reads "overdue" for the whole of its final day
  (0012 defect #2).
- The idempotence guard is *"a task exists for THIS boundary"*, never *"any task
  exists for this deal"* — that second form is the 0006 one-shot bug 0012 was
  written to kill.
- Contact moves `last_activity_at`, which moves the boundary, which makes the
  open task stop matching → superseded. A later silence produces a **new**
  boundary and therefore a new task. That is "once per silent period".
- A deal nobody ever touches keeps exactly **one** open nudge, forever — the
  boundary never moves. No pile-up.

The viewing rule has **no cycle**, and its guard is deliberately
`not exists (any viewing_feedback task for this viewing)`. That is *not* the
0006 bug: a viewing has one feedback lifecycle and `saveViewingFeedback`
(`lib/actions/viewings.ts:250`) can only ever set feedback, never clear it, so
there is no second cycle to miss.

Tasks that stop matching are **COMPLETED (`is_done`), never deleted**, with a
`superseded` event — history keeps its shape and "Recently done" stays honest.
Guardrail 2: `events` has no UPDATE/DELETE.

---

## 5. `create_followup_nudges(p_org uuid default null)`

`language sql security definer set search_path = public`, four statements
mirroring 0012's structure: create, create, supersede, supersede.

**The `p_org` parameter exists for testability.** Cron calls it with no
arguments (all orgs). The RLS suite calls it with its fixture org id, because
RLS test 23 pins that *the suite never writes into the seeded org the dev app
uses* — an org-wide function would violate that on its first call.

**Assignee fallback, three arms** (0012 defect #3 — a NULL assignee is invisible
on every surface, since `/tasks` and the agent dashboard both filter
`assignee_id = me`):

- `deal_no_contact`: `coalesce(d.agent_id, d.created_by, oldest active org admin)`
- `viewing_feedback`: `coalesce(v.agent_id, v.created_by, oldest active org admin)`

`viewings.agent_id` is `not null`, so arm 1 always wins there today; the chain is
written anyway for symmetry and for imported data.

**Due dates.** Both are Cyprus 23:59, and both are **deterministic functions of
the source row, never of when the cron happened to run**:

- `deal_no_contact`: EOD of `boundary(deal)` (§4).
- `viewing_feedback`: EOD of the Cyprus date of `scheduled_at + 48 hours`.

So a catch-up run after cron downtime stamps the date the nudge *should* have
carried, and the task appears already overdue — which is honest — rather than
resetting the clock to today. It also makes the fixture assertions in §9 exact.

The `viewing_feedback` task also carries `property_id` (from the viewing), so it
renders the property reference on `/tasks` and in the CSV export exactly as
renewal tasks do.

**Grants.** `revoke execute … from public, anon, authenticated` (the function
walks every open deal in every org), then an **explicit
`grant execute … to service_role`**. The explicit grant is not optional: a
function's `service_role` EXECUTE rides on the PUBLIC default grant, so the
revoke kills it — the exact collateral 0010 fixed for 0007 and 0019 fixed for
0016.

**Timezone maths in SQL.** `lib/utils/tz.ts` owns Cyprus wall-clock logic and
0018's decision says not to re-derive it in SQL. That rule is about *callers*:
0018 takes window bounds as parameters because a caller exists. A cron job has
no caller, so — exactly as 0012 already does — the Cyprus EOD stamp is computed
in SQL with `at time zone 'Asia/Nicosia'`. The two must stay consistent, which
is why the expression is copied from 0012 verbatim rather than reinvented.

### Cron schedule

```sql
select cron.schedule('followup-nudges','15 3 * * *', $$select create_followup_nudges()$$);
```

**03:15 — between `expire-mandates` (03:00) and `verify-events-chain` (03:30)**,
so the night's nudge events are covered by the same run's chain check. That is
0016's own stated reason for putting the chain check at 03:30.

---

## 6. Edit-time supersede: DB triggers, not app call sites

0012 supersedes at edit time in `saveMandate`/`setMandateStatus` with actor
attribution, with cron as the nightly safety net. The same immediacy is needed
here — an agent who logs feedback and still sees "log feedback for this viewing"
until tomorrow morning stops trusting the surface.

But the app-side equivalent would be **seven call sites**
(`deals.ts:138,258,334,408,481`, `leads.ts:445`, `viewings.ts:283`) plus the
0011 `move_deal_to_stage` RPC, which is SQL-side and unreachable from
TypeScript. So this ships as two triggers instead:

```sql
create trigger deals_supersede_nudges after update on deals
for each row when (old.last_activity_at is distinct from new.last_activity_at
                   or old.status is distinct from new.status)
execute function trg_supersede_deal_nudges();

create trigger viewings_supersede_nudges after update on viewings
for each row when (old.feedback is distinct from new.feedback
                   or old.status is distinct from new.status)
execute function trg_supersede_viewing_nudges();
```

Precedent: `trg_price_history` (0005) is a `security definer` trigger that
writes an `events` row with `actor_id = auth.uid()`, for the stated reason that
trigger-level coverage catches "direct DB edits and imports too, not just app
saves". `profiles.id references auth.users(id)`, so `auth.uid()` **is** the
profile id — actor attribution is correct without a lookup.

The `WHEN` clauses keep the triggers off the health-score recompute write, which
updates `health`/`health_score` and touches neither column.

Trigger supersede writes the `superseded` event **with an actor**; the cron
writes it with **actor null** (system). Same as 0012.

---

## 7. Events and i18n

Guardrail 1: every mutation writes an events row.

| event_type | entity_type | actor | payload |
|---|---|---|---|
| `followup_task_created` | `deal` / `viewing` | null (cron) | `{kind, task_id, assignee_id, days\|hours}` |
| `superseded` | `task` | `auth.uid()` (trigger) or null (cron) | `{kind, deal_id\|viewing_id, reason}` |

Both are registered in `describeEvent` (`lib/services/events.ts`) and translated
in `messages/{en,el,ru}.json` under `events.*` — `messages.test.ts` fails CI on a
half-translated file. The `followup_task_created` line picks its message key from
`payload.kind`, following the `stages_updated` / `locations_updated` precedent.
ICU plurals for the day/hour counts, with Russian `one/few/many/other`.

**`superseded` is registered for the first time here.** 0012 has emitted it since
2026-07-20 but never added a line to `EVENT_LINES`, so it currently renders as
the raw type with underscores spaced. Fixing that is one entry and belongs in
this change, since 0020 doubles the number of places that emit it.

---

## 8. App-side changes

- **`lib/services/events.ts`** — two new `EVENT_LINES` entries.
- **`messages/{en,el,ru}.json`** — the matching `events.*` keys.
- **`app/(app)/tasks/page.tsx`** — select `kind, deal_id, viewing_id`; `isAuto`
  becomes `t.kind !== null`; **delete the virtual "Viewings awaiting feedback"
  section** and its query.
- **`components/features/tasks/task-list.tsx`** — nudge rows link to their deal
  or viewing (today only `property_id` is linked). The existing "auto" badge is
  reused unchanged.
- **`components/features/dashboard/agent-dashboard.tsx`** — delete the
  `needFeedback` query and card. **Stated consequence:** a completed viewing
  without feedback is visible on the dashboard *today* the moment it is
  completed; afterwards it appears as a task at 48h, and in the dashboard's
  "overdue tasks" card only once past Cyprus EOD of that day. To avoid losing a
  day of dashboard visibility, that card widens from
  `due_at < now()` to `due_at < end of today (Cyprus)` and is relabelled — every
  nudge is due at Cyprus EOD, so "due today" is exactly a nudge's live window.
- **`lib/services/task-export.ts`** — the `Auto` column reads `kind` instead of
  `mandate_id`, and gains the kind value so an exported task says *which* nudge
  it was.

---

## 9. Testing

**Unit (vitest).** `task-export.ts` column changes. The nudge logic itself is
SQL, so there is little pure surface to unit-test — the weight is below.

**RLS suite (`supabase/tests/rls.test.ts`), first-run clean on a fresh DB:**
- **Test 17 extended** (doc 04 tasks row, already pinned): a cron-created nudge
  with `created_by = null` is visible to its assignee, invisible to another
  agent, completable by the assignee and by an admin, and not by a third party.
  Extend, do not bypass.
- **New test 24 — `create_followup_nudges`**, all against the fixture org via
  `p_org`, asserting the invariants directly:
  1. stale open deal → exactly one task, `kind='deal_no_contact'`, `due_at` =
     Cyprus 23:59 of `last_activity + 14d`;
  2. running twice in a row creates **no second task** (same cycle);
  3. a deal whose `agent_id` and `created_by` are both null → assigned to the
     org's oldest active admin, never null;
  4. moving `last_activity_at` forward supersedes the open task (`is_done`,
     `superseded` event, task row still present) and a later silence mints a new
     one for the new boundary;
  5. winning the deal supersedes it;
  6. a viewing completed 47h ago → no task; 49h ago → one task; saving feedback
     supersedes it via the trigger with `actor_id` set, not null;
  7. `verify_events_chain` stays `true` for the fixture org throughout;
  8. anon and authenticated cannot execute the function; `service_role` can.
- Test 23's invariant holds: nothing touches the seeded dev org.

**E2E (`tests/e2e/`).** A service-role-seeded stale deal produces a nudge row on
`/tasks` with its "auto" badge and a working link to the deal; the retired
"Viewings awaiting feedback" heading is gone.

**psql fixture proofs** run by hand and written into `docs/DECISIONS.md`, in the
shape 0012's entry uses: orphan→admin fallback, EOD stamps, supersede-on-change,
no same-cycle re-nag.

**A test that only passes on a rerun is a bug in the test** (HANDOVER §4/§5).

---

## 10. Deployment order

1. Apply 0020 to hosted **by hand** via the Supabase connector's `execute_sql`
   (**not** `apply_migration` — the classifier blocks it), then
   `insert into supabase_migrations.schema_migrations (version, name) values ('0020','0020_followup_nudges.sql') on conflict do nothing;`
   Verify `non_filename_versions = 0` afterwards. HANDOVER §4.
2. **This is a production write and needs the operator's explicit go-ahead.**
3. Only then push the code. Vercel deploys on push; code that references
   `tasks.kind` before the column exists sends every user to the error boundary.
4. After pushing, check CI — local green ≠ CI green:
   `curl -s "https://api.github.com/repos/KALAITSIDIS/gnk-crm/actions/runs?per_page=5"`

`create index if not exists`, `add column if not exists` and
`create or replace function` make 0020 safely re-runnable. The `cron.schedule`
call is not idempotent — it is guarded by an
`unschedule`-if-exists so a second run does not create a duplicate job.

---

## 11. Out of scope (→ `docs/BACKLOG.md`)

- A deal-scoped **"Log contact"** action, which would let `last_activity_at`
  mean contact rather than any activity (see §2).
- **Configurable thresholds.** 14 days is the health score's own cliff (doc 02
  §C5); making it independently editable lets the nudge and the score disagree
  silently about what "stale" means. Changing it is one
  `create or replace function`. `cyprus_config` is guardrail 5's home for Cyprus
  *rates*, not operational thresholds.
- **Inactive assignees.** Both nudge rules can land a task on a deactivated
  profile if it is still the deal's/viewing's agent. 0012 has the same gap
  (`p.assigned_agent_id` is taken raw); fixing one without the other would make
  the two cron paths disagree, so both are left for a single later change.
- Escalation (re-nagging every 14 days) — one `floor()` away if the desk ever
  wants it.
