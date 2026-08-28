# Phase C — re-audit and build brief (2026-08-28)

> **For the next session.** This is a BRIEF, not an executed plan. It re-audits
> `IMPROVEMENTS.md` §C against the code as it stands today, fixes the order,
> and proposes what each item should become — including the upgrades worth
> taking while the code is already open.
>
> Read `HANDOFF.md` §0 and §0a first. Follow `docs/08_BUILD_PLAYBOOK.md`
> discipline: one task → implement → verify → commit. Push the branch, let CI
> rehearse, apply hosted migrations in the order the change requires, merge,
> confirm the deploy.

---

## 0. The disagreement, recorded once and then dropped

I advised against building §C now, and the operator decided to proceed. The
reason for the advice, so the next session can judge for itself rather than
inherit a mood: production holds **1 property, 2 contacts, 1 deal, 3 leads, 0
viewings, 0 offers, 0 tasks, 119 events, 2 users (both admins)**.

That matters for scope, not for permission. It changes what "done" should mean:

* **Build for the shape of the data, not its current volume.** Everything here
  must be correct at 119 events and at 10 million. That is achievable — it is
  mostly a question of not writing anything that assumes a full table.
* **Anything that cannot be verified against real data must ship with a
  fixture that supplies it.** A reporting engine tested only against zeros is a
  reporting engine tested against nothing. Seed a synthetic org and prove the
  numbers there; never seed production.
* **Resist building the parts that only pay off with volume.** They are named
  per item below under *Not now*.

---

## 1. Order — corrected, with the reason

**C5 → C4 → C3 → C7.**

`IMPROVEMENTS.md` already says C5 comes before C4 ("Do before C4"), and that C7
should not start "before there is a concrete second-office or franchise
requirement". Both still hold. C3 is genuinely independent and could run in
parallel, but it is placed third because it is the only item that opens a new
public attack surface, and doing it while the event log is being restructured
splits attention across the two riskiest changes in the list.

**C7 remains gated.** There is no second office and both users are admins.
Build it last, and only if the operator confirms a real requirement; otherwise
stop after C3 and say so.

---

## 2. C5 — event log: partitioning, checkpoints, and the hash landmine

> ### ✅ SHIPPED 2026-08-28 — migrations 0060, 0061, 0062, 0063, 0064.
> Local and hosted both applied, CI green, deployed. `docs/DECISIONS.md` `T-c5`
> has what was measured. **Three specifics below were wrong and are corrected
> in place**, because a brief that keeps a disproven detail is how the next
> session inherits it:
>
> 1. **`p_from_id default null` (under *Build*) is a latent outage**, not a
>    style choice. With the boolean wrapper also present, Postgres accepts both
>    `CREATE`s and then fails at CALL time with `function is not unique` — the
>    migration applies green and the 03:30 cron breaks. It shipped with **no
>    default**; a full walk passes `null` explicitly.
> 2. **Finding 3 misdescribes the writers.** The sweeps do NOT write computed
>    timestamps into `occurred_at`; every writer in the codebase takes
>    `default now()`, and the computed dates go into the payload and
>    `tasks.due_at`. The invariant held by construction, not by luck — which is
>    a better reason to assert it, not a worse one.
> 3. **"epoch microseconds"** was one of two equally canonical options. It
>    shipped as ISO-8601 UTC instead, because the hash is evidence and the
>    material should be legible to whoever re-derives it.
>
> And one thing the brief does not mention at all: PK `(id, occurred_at)` means
> **`id` is no longer unique on its own**, while `verify_events_chain` still
> walks by `id`. Detected by `events_partition_health()`.

### What is actually there

```
events(id bigint, org_id uuid, occurred_at timestamptz, actor_id uuid,
       entity_type text, entity_id uuid, event_type text, payload jsonb,
       prev_hash text, hash text)
indexes: events_pkey, events_entity_idx, events_time_idx      size: 144 kB, 119 rows
```

`verify_events_chain(p_org)` is a PL/pgSQL loop that walks **every row from
genesis**, ordered by `id`, recomputing sha256 per row.

### Three findings the roadmap does not mention

1. **It returns `boolean` and nothing else.** When it returns `false` you learn
   that the chain is broken and *nothing about where*. At 119 rows that is an
   afternoon of bisecting by hand; at a million it is unusable — and it will be
   returning `false` precisely when someone is under pressure. **Return the
   failing `id` and which check failed** (`prev_hash` link vs recomputed
   `hash`). This is the highest-value hour in the whole of Phase C.

2. **The hash covers `occurred_at::text`, which renders per session
   `TimeZone`.** `BACKUP_RESTORE.md` already records the consequence: a restore
   into a non-UTC project reads `false` on intact data. **This migration is the
   only sane moment to fix it**, because it is already rewriting the table —
   but changing the formula invalidates every existing hash. The upgrade is a
   **`hash_version smallint`** column: v1 rows keep the current formula, v2 rows
   hash a canonical UTC form (epoch microseconds), and verification dispatches
   on the version. Old evidence stays verifiable; new evidence stops being
   timezone-dependent.

3. **The chain is ordered by `id`; partitioning would key on `occurred_at`.**
   Those agree only while inserts are monotonic in both. A back-dated
   `occurred_at` (the instalment and reservation sweeps write timestamps they
   compute) would put a row in an earlier partition while holding a later `id`.
   The chain still verifies — it orders by `id` — but any per-partition
   optimisation that assumes "later partition ⇒ later id" breaks. **Assert the
   invariant in the migration** and keep the chain walk ordered by `id` only.

### Build

* Partition `events` by `occurred_at` **monthly RANGE**. PK becomes
  `(id, occurred_at)` — Postgres requires the partition key in the PK. Verify
  first that nothing FKs to `events.id`; today nothing does (`entity_id` is a
  bare uuid by design), which is what makes this feasible at all.
* **`events_chain_checkpoint(org_id, last_id, last_hash, verified_at)`.**
  Verification resumes from the checkpoint instead of genesis; a full walk stays
  available and is what the nightly `run_chain_checks()` should do weekly rather
  than nightly.
* Rewrite `verify_events_chain` to `verify_events_chain(p_org, p_from_id
  default null)` returning a row `(ok boolean, failed_id bigint, reason text)`.
  Keep a boolean wrapper so the 4 existing callers and the RLS tests do not
  change shape in the same migration.
* Archival: detach cold partitions, dump them with the backup script, and record
  the checkpoint that proves the detached prefix.

### Not now

Do not build tiered/cold storage, and do not move partitions off Postgres. At
144 kB the entire table fits in a CPU cache line's worth of pages. Build the
*structure* so it scales; do not build the *operations* nobody needs yet.

### Done means

Chain verification returns a diagnosable result; a deliberately corrupted row in
a test fixture is identified BY ID; `hash_version` exists with both formulas
verifying; partitioning is live with the monotonicity assertion; RLS suite green;
`run_chain_checks` still refuses `anon` and `authenticated`.

---

## 3. C4 — reporting engine

### What is actually there

`reports/` and `reports/commission-evidence/` only. `admin_dashboard_stats` is
the pattern to copy: a single SQL aggregate, **SECURITY INVOKER**, window bounds
passed in from `lib/utils/tz.ts` rather than re-derived in SQL. Six pg_cron
sweeps already exist, so the scheduled-refresh idiom is established.

> ### ✅ SHIPPED 2026-08-29 — migration 0065 + `/reports/performance`.
> Local and hosted applied, CI green, deployed. `docs/DECISIONS.md` `T-c4`.
>
> **The trap below is REAL and was understated.** Measured: an MV over an RLS
> table returned BOTH orgs' rows to an org-scoped session — directly *and*
> through a `SECURITY INVOKER` function — and the obvious repair does not
> exist: `alter materialized view … enable row level security` is refused with
> `42809`. An MV cannot be made safe by policy at all, only by never granting
> it and filtering in a wrapper. Shipped with **no MV**, as this section's
> second option recommends.
>
> **Two things this section could not have known, found by checking the
> writers rather than trusting the roadmap's vocabulary:**
>
> * `stage_changed` records stage **names**, not ids (0011). The first draft
>   read `payload->>'from_stage_id'` and would have returned zeros forever.
> * `won`/`lost` are **separate event types**, not stage changes, and their
>   payloads carry the destination stage rather than the one left — so a stage
>   funnel can count outcomes but cannot attribute them.
>
> **"Every figure a report prints can be re-derived from the events it cites"
> is only half achievable, and the shipped code says which half.** Metrics over
> mutable entity tables cannot be re-derived; only stage conversion can, and it
> declares `derived_from: "events"` in its own output.

### THE TRAP THAT WILL BITE — read before writing a line

**Materialised views do not respect RLS.** The roadmap calls C4 "a
materialised-view problem", and it is — but an MV over `events` is computed
once, for everyone, with no org filter. Selecting from it inside a SECURITY
INVOKER function does **not** re-apply row security: the rows are already
materialised. Ship that and org B reads org A's pipeline.

Two safe shapes, and the choice should be deliberate:

* **MV keyed by `org_id`, always filtered by `current_org_id()` in the reading
  view**, with the MV itself revoked from `anon` and `authenticated` so nothing
  can select it directly. Cheap, and the filter is one place.
* **No MV at all** — plain SECURITY INVOKER aggregates like
  `admin_dashboard_stats`, which stay correct by construction. At this data
  volume this is almost certainly right, and an MV can be introduced later
  behind the same function signature.

Prefer the second until a query is measurably slow. Write the MV path only when
a real timing justifies it, and add an RLS test that a second org sees nothing.

### Build

Metrics named in the roadmap: agent performance, source ROI, time-to-close,
stage conversion, price-reduction analysis.

**The upgrade worth taking: make reports CITABLE.** `events` is hash-chained and
append-only, so a report computed over it can record the `(last_id, hash)` it
was computed at. A commission dispute six months later can then re-derive the
exact figure and prove the inputs had not changed — which is the product's core
value applied to reporting rather than a new feature bolted beside it. Store it
with the generated report the way `pdf_sha256` is already stored for evidence.

Reuse: CSV export exists on 7 lists; the export helper should serve reports too.

### Not now

No custom report builder, no scheduled email delivery, no dashboard filters by
agent/office/period — that last one is refused by guardrail 6.

### Done means

Each metric has a unit test over a synthetic fixture with known answers (not
production zeros); an RLS test proves cross-org isolation; every figure a report
prints can be re-derived from the events it cites.

---

## 4. C3 — public listing API

### What is actually there — and it is more than the roadmap credits

The precedent already exists: `resolve_share_link` and `note_share_link_miss`
are anon-executable SECURITY DEFINER RPCs, and `note_share_link_miss` implements
an **IP-hash rate limit**. Share links, token hashing and expiry are all built
(`lib/services/share-links.ts`, `share-links-token.ts`). C3 is not greenfield —
it is a second, narrower consumer of a pattern this codebase has already proven.

### Build

* A **`published_listings` view** exposing only safe columns. Never:
  `owner_contact_id`, `developer_contact_id`, `internal_notes`,
  `min_acceptable_price`, `owner_net_price`, commission, or anything from
  `mandates`.
* **Reuse the quality gate as the publish predicate.** A listing below score 70
  cannot be made public internally (`PUBLISH_THRESHOLD`), so it must not be
  reachable externally either. One rule, enforced twice, defined once —
  otherwise the two will drift and the API becomes the leak.
* A **dedicated role with column-level grants**, not the app's client and never
  the service role. The roadmap is explicit and it is right.
* **ETag / `If-None-Match` from `max(updated_at)`** so a marketing site can poll
  cheaply and you can see in the logs whether it is behaving.
* Rate limit by reusing the `note_share_link_miss` idiom rather than inventing a
  second one.

### Not now

No write endpoints, no webhooks, no GraphQL, no per-consumer API keys until
there is a second consumer. One published, cacheable, read-only collection.

### Done means

An RLS test proves the anon role sees ONLY listings that are public, available
and at or above the quality gate — and specifically cannot reach a draft, an
archived row, or any withheld column. A test asserts the withheld column list by
name, so adding a column to `properties` cannot silently publish it.

---

## 5. C7 — capabilities instead of roles

**Still gated.** Do not start without a concrete second-office or franchise
requirement. If it is confirmed:

* Capability flags checked by the **same SECURITY DEFINER helpers**, so the
  **137 policies across 34 tables** do not change shape.
* Keep `current_role_gnk()` as a derived compatibility shim during the
  migration, so policies can move one at a time and the suite stays green
  throughout.
* The audit's own example is the acceptance test: a listing manager can reach
  the archived state field-by-field on the Details tab while the one-click
  Archive is admin-only. Capabilities should make that divergence expressible
  rather than accidental.

---

## 6. Standing rules that apply to all of it

* **Migrations:** separate `execute_sql` calls per stage, verify in a *further*
  call, `md5(prosrc)` local vs hosted, then `get_advisors` (HANDOFF §3).
* **Deploy order:** additive → hosted migration before the merge; destructive or
  behaviour-removing → merge, deploy, confirm the serving SHA, then apply.
* **New RLS table ⇒ `require_aal2` explicitly.** A table created after 0029 does
  not inherit it, and `rls_aal2_coverage()` must stay at 0.
* **Every new function: revoke `anon`** unless it is deliberately public, and
  confirm it is absent from `get_advisors`. This has bitten twice (0021, 0044).
* **2FA is mandatory** — fixtures enrol factors; see `lib/testing/mfa.ts`.
* **Do not seed production.** Synthetic data goes in a test org or
  `supabase/dev-fixtures.sql`.
