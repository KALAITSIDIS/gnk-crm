# 10 — INFRASTRUCTURE

Where this app runs: GitHub, Supabase, Vercel. Written 2026-08-29 as a handoff
to a second working environment.

> ## ⚠️ THIS REPOSITORY IS PUBLIC
>
> `github.com/KALAITSIDIS/gnk-crm` is **PUBLIC**. Verified 2026-08-29.
>
> **No secret goes in this file, or in any tracked file, ever.** `.env*` is
> gitignored (`.gitignore:39`), `.env.local` has never been committed, and a
> scan for key-shaped strings across every tracked file found only prose about
> key *formats* — no actual keys. Keep it that way.
>
> Everything below is an IDENTIFIER, not a credential. Project refs and team ids
> are not secrets — the Supabase ref already ships to every browser inside
> `NEXT_PUBLIC_SUPABASE_URL`. Anything that IS a secret is named here with a
> pointer to the dashboard that holds it, and nothing more.

---

## 1. GitHub

| | |
|---|---|
| Repo | `https://github.com/KALAITSIDIS/gnk-crm` |
| Visibility | **PUBLIC** |
| Default branch | `main` |
| Owner | `KALAITSIDIS` |

**Branch rhythm** (`HANDOFF.md` working agreements): branch → push → let CI
rehearse → apply the hosted migration in the order the change requires → merge
→ confirm the deploy → delete the branch. Nothing is committed straight to
`main`.

### CI — `.github/workflows/ci.yml`

Runs **once per commit**: on every push, and on a pull request only when the
PR's head branch lives in a fork. A PR from a branch in this repository already
ran on its push, so its `pull_request` run skips at every job — the `if:` each
job carries; DECISIONS `T-ci-one-run-per-commit` (2026-09-14, when the first PR
ever opened here ran the workflow twice on one commit). Three jobs:

| job | what it does |
|---|---|
| `checks` | install → typecheck → lint → `npm test` → `next build` → check no nonce-dependent route was prerendered |
| `rls` | boots a local Supabase stack, applies **every** migration, runs the RLS suite |
| `e2e` | boots the stack, builds, starts the production server, runs Playwright desktop |

**The `rls` and `e2e` jobs apply every migration in `supabase/migrations/` to a fresh database on every
run.** That is why several migrations carry `do $$ … raise exception … $$`
blocks: a migration whose own assertion fails takes CI red before anything
reaches a person.

**No `supabase/setup-cli` action.** The CLI is an exact devDependency
(`"supabase": "2.115.0"`, no caret) and the jobs call `npx supabase`. Pinning it
in the workflow instead was tried and rejected — it put the version in two
places that must be hand-synced. `package-lock.json` is the only place it lives.

---

## 2. Supabase

| | |
|---|---|
| Project ref / id | `yjgirvzgoiywdojnpkpd` |
| Organization | `ljahqvdqbuzeqmrjgdky` |
| Region | `eu-central-1` (EU — required, doc 01) |
| Postgres | 17.6.1.141 |
| DB host | `db.yjgirvzgoiywdojnpkpd.supabase.co` |
| Migrations | **86**, latest `0086_etag_covers_alt` — `npx supabase migration list --linked` is the answer that cannot go stale; HANDOFF's Hosted DB row carries the story |
| Extensions | `postgis`, `pg_trgm`, `pgcrypto`, `pg_cron` |

### Secrets you must carry over yourself

Get these from the Supabase dashboard → Project Settings → API. They are **not**
in this repo:

* `NEXT_PUBLIC_SUPABASE_ANON_KEY` — publishable, ships to the browser
* `SUPABASE_SERVICE_ROLE_KEY` — **secret**, server-only, bypasses RLS

**USE THE MODERN KEY FORMAT.** Legacy JWT keys (`eyJ…`) were disabled on
2026-08-03 and both were briefly the disabled pair in production — see
`HANDOFF.md` §2b. Current keys are `sb_publishable_…` and `sb_secret_…`.
`lib/supabase/key-health.ts` detects the legacy shape and says so.


### Auth settings that are not code

* **Public sign-up is OFF** (`disable_signup: true`, set through the Management API on
  2026-09-13 — audit SEC-02). The app never calls `auth.signUp`; every account comes
  from `inviteUser` → `auth.admin.createUser`. Anyone can confirm the posture without
  a login: `GET {SUPABASE_URL}/auth/v1/settings` with the publishable key must show
  `"disable_signup":true`. The local stack mirrors it in `supabase/config.toml`
  (`[auth] enable_signup = false`) and `supabase/tests/signup-disabled.test.ts` fails
  if that line drifts back. Turning it on again is a decision, not a convenience.

### Local stack

`supabase/config.toml`, `project_id = "gnk-crm"`. Ports: API **54321**, DB
**54322**, Studio **54323**, Inbucket **54324**.

```bash
npx supabase start      # boots the local stack
npx supabase db reset   # re-runs every migration in `supabase/migrations/` + seed
npm run db:types        # regenerate lib/supabase/database.types.ts
```

**After a `db reset`, 2FA is mandatory and the seeded admin has no factor.**
Run `npm run dev:2fa` to enrol one and print the TOTP secret. That script
refuses any non-local URL, deliberately.

### pg_cron — 12 scheduled jobs (all live)

```
0  3 * * *   expire-mandates              select expire_mandates()
10 3 * * *   redact-stale-enquiries       select redact_stale_enquiries()
15 3 * * *   followup-nudges              select create_followup_nudges()
20 3 1 * *   ensure-events-partitions     select ensure_events_partitions()
30 3 * * *   verify-events-chain          select run_chain_checks()
35 3 * * 0   verify-events-chain-full     select run_chain_checks_full()
45 3 * * *   expire-reservations          select expire_reservations()
50 3 * * *   warn-expiring-reservations   select warn_expiring_reservations()
55 3 * * *   remind-due-installments      select remind_due_installments()
*/10 * * * * lead-sla                     select raise_lead_sla_tasks()      (0098: chases a website lead unanswered after an hour)
*/2 * * * *  enquiry-alerts               select enquiry_alerts_sweep()      (0103: the desk-alert sweep, POSTed through pg_net; URL and bearer from Vault — raises when either is absent)
*/5 * * * *  lead-escalation              select raise_lead_escalations()    (0107: mints a lead_escalation job for a website lead still unanswered past the policy's working-time wait; the alert sweep sends it. OFF until Settings → Lead escalation enables it)
```

Ordering is deliberate: each sweep runs after the one whose events it needs.

Since 0074 the jobs have a witness: `cron_health()` (service_role-only) returns
per-job facts and the admin dashboard renders the verdict — a job with no
success inside its schedule's allowance (26h nightly / 8d weekly / 32d monthly,
`lib/services/cron-health.ts`) shows amber there. A restored database shows
**all eight unhealthy** until the jobs are recreated (BACKUP_RESTORE §4b.4) —
that is the panel doing its job, not a false alarm.

### The desk-alert sweep (0101) — an application route, reached by a pg_cron job since 0103

A website enquiry's desk e-mail is a `notification_jobs` row written by
`submit_public_enquiry` in the lead's own transaction; the e-mail is one
provider attempt against that row. Three callers run the same worker
(`lib/services/enquiry-alert-worker.ts`):

| Caller | When | What it covers |
|---|---|---|
| the enquiry route's `after()` | within a second of the 202 | the normal case — the desk is told at once, as before 0101 |
| the staff retry (inbox row → **Retry alert**) | on demand | a terminal failure a person wants sent again |
| **the sweep**, `GET\|POST /api/internal/enquiry-alerts` | on a schedule | everything the first two never reached: an invocation killed after the commit, a provider that said 503, a lapsed lease. **This is what makes the alert recoverable.** |

The sweep is gated by `CRON_SECRET` as a bearer token (`Authorization: Bearer
…`, constant-time compare). Without the variable it answers 503 and runs
nothing; rows keep waiting and the inbox says "Desk alert queued".

**Who calls the sweep:**

* **Vercel cron, daily at 06:00 UTC (±59 min), from `vercel.json` — ARMED
  2026-09-21.** The most a Hobby plan allows (once per day; a more frequent
  expression fails the deployment). Vercel sends `Authorization: Bearer
  $CRON_SECRET` on its own; the variable was set in Production (Secret type)
  and the deployment redeployed that day, and the arming was MEASURED: a
  wrong or missing bearer answers 401 where it answered 503 unarmed. Worst
  case, a row the accelerator missed is sent within a day rather than never.
  Rotate the value on the Environment Variables page and redeploy; the
  pg_net job below must then get the same value in Vault.
* **`pg_cron` + `pg_net` every two minutes — the cadence the retry schedule
  was written for — ARMED 2026-09-21 by migration 0103 (`enquiry-alerts`,
  the eleventh job in the table above).** The operator took the extension
  decision that day: `pg_net` 0.20.3 was installed on hosted by hand, the
  Vault secrets `crm_url` (`https://gnk-crm.vercel.app`) and `cron_secret`
  (the SAME value as Vercel's `CRON_SECRET`) were created through the
  dashboard (Integrations → Vault), and the job body `enquiry_alerts_sweep()`
  (SECURITY INVOKER; postgres and service_role only) reads both from Vault at
  run time and `net.http_post`s — nothing in `cron.job`'s command text holds
  a value. Rotating `CRON_SECRET` therefore means updating the Vault secret
  too, or the sweep answers 401 every two minutes (visible in
  `net._http_response`; pg_net is asynchronous: the response lands there,
  kept for its `ttl` of six hours, the run itself in `cron.job_run_details`).
  **A missing secret is loud, a wrong one is not:** the function RAISES
  naming the absent secret, the run is recorded `failed`, and the admin
  dashboard's cron-health card shows the job amber within the hour (it
  allows this job one hour without a success) — whereas a wrong value posts
  and gets 401, which only `net._http_response` shows. The migration itself
  needs no secret to apply (CI's fresh stack has no hook before migrations,
  and the first cut, which refused, killed `rls` and `e2e` at `supabase
  start`); `supabase/seed.sql` plants local placeholders on `db reset`, and
  the restore pack asserts both Vault rows exist after a restore — a restore
  into a NEW project cannot decrypt the old rows and must recreate them.
* **What the card judges (0105).** pg_cron
  records every `enquiry-alerts` run `succeeded` the moment `net.http_post`
  queues the request (production: 0.03 s, every time), so `cron_health()` alone
  could not tell a working sweep from one answered 401 every two minutes.
  Since 0105 `enquiry_alerts_sweep()` records each request it queues in
  `enquiry_alert_sweep_runs` and, at the start of the next run, reconciles the
  previous answers from `net._http_response` (grace 90 s; `no_response` after
  10 min; rows kept 30 days) into one outcome per request: `ok` (the worker
  completed — an EMPTY QUEUE is ok), `unconfigured` (200 with `skipped:
  unconfigured` — the route runs, no alert can be sent, NOT a success),
  `worker_failed` (`ok:false`, 503, 500), `unauthorized` (401/403 — the two
  copies of the secret have drifted), `timeout`, `connect_error`, `malformed`
  (a 200 that is not the worker's body), `http_error`. `enquiry_alert_sweep_health()`
  summarises (service_role-only) and `lib/services/enquiry-alert-sweep-health.ts`
  judges: no completed run for 15 min, three failures in a row, three requests
  without an answer, ANY desk-alert row still due 10 min past its time (with the
  oldest's age), or an unconfigured provider — each turns the `enquiry-alerts`
  line on the admin dashboard amber whatever pg_cron says. Read the record by
  hand: `select outcome, count(*), max(queued_at) from enquiry_alert_sweep_runs
  group by 1`.
* **A person, after an incident:**
  `curl -sS -X POST -H "Authorization: Bearer $CRON_SECRET" https://gnk-crm.vercel.app/api/internal/enquiry-alerts`
  — the answer is the run's counts: **200 `ok: true`** with the counts (an
  empty queue is `claimed: 0`; an unarmed provider says `skipped:
  "unconfigured"`), **503 `ok: false`** with `error: {stage, code}` when the
  queue could not be reached — never a 200 that reads as "nothing due"
  (review C). The same line goes to Sentry with the code only.

**The budget (review B).** One invocation has `maxDuration = 60`; the run is
given 45 s of it and claims only what that fits at the provider's 8-second
worst case plus 2 s of round trips per row — **four rows**, whatever
`?limit=` asks (a smaller number is honoured). A batch whose sends were slow
hands the rest back UNATTEMPTED (`released`: the attempt the claim counted is
given back). The lease is raised to outlive the budget.

**The key window (review A).** Every automatic retry reuses one Resend
idempotency key, which Resend keeps for 24 hours. The database's
`notification_key_window()` (0102) is 20 hours and the claim refuses any
row whose FIRST attempt is older — closing it as `failed` /
`key_window_expired` for a decision; a row never attempted is eligible
however old. The worker checks the same window before it sends and refuses
to schedule a retry — the schedule's step or the provider's Retry-After,
which is honoured in full — that would land past it (`retry_beyond_window`).
The inbox reads both as "needs a decision" and offers **Retry alert**: the
one place a key rotates, on a person's say-so, with a fresh lifetime.
Retries back off 1 → 2 → 4 … 64 minutes over eight attempts (~2h07m when
the sweep runs on time); `accepted` means Resend accepted the message —
nothing here confirms delivery.

### Account lockout runbook (SEC-03)

Who can no longer sign in, and what unlocks them:

* **Forgot password, has their authenticator.** Any admin: Settings → Users →
  Invite-era flow does not apply — there is no self-service email reset in
  Phase 1. The admin creates a new one-time password for them via the Supabase
  dashboard (Auth → Users → Reset password) or hands the task to the operator.
  The user then changes it on **/security** (Change password) so the admin
  stops knowing it.
* **Lost phone (2FA), knows their password.** Any *other* admin: Settings →
  Users → **Reset 2FA** on their row. Factors are deleted through the admin
  API, the target is signed out everywhere, the reset lands in the event log
  (`mfa_reset`), and their next password login walks them through fresh
  enrolment. Verify the request is really theirs — in person or on a call you
  placed. Self-reset is deliberately refused: removing your own factor goes
  through /security, which requires the very authenticator being removed
  (aal2), so a stolen password can never shed the second factor.
* **The solo admin locked out of 2FA.** No in-app path on purpose. Escape via
  the Supabase dashboard (project owner login, which has its own MFA): SQL
  editor → `select id from auth.users where email = '...'`, then Auth → Users
  → the user → delete the TOTP factor; or the same via the admin API with the
  service-role key from `~/.gnk-crm/backup.env`. Log what you did as an
  operator note — nothing writes the event for you on this path.
* **Deactivated account.** That is not a lockout, it is a decision — Settings
  → Users → Reactivate (flag + login ban lift together, evented).

### Applying a migration to hosted

The full discipline is `HANDOFF.md` §3. In short: separate calls per stage,
**verify in a further separate call**, compare `md5(prosrc)` local vs hosted,
then run `get_advisors`.

Two things that will bite:

* **Compare `md5(replace(prosrc, chr(13), ''))`, not `md5(prosrc)`.** Hosted
  carries CRLF for anything applied from Windows through the connector, so a
  raw md5 differs on byte-identical code.
* **`supabase migration up` is not used against hosted.** Migrations are applied
  by hand and recorded with an explicit
  `insert into supabase_migrations.schema_migrations (version, name)`. Using
  `apply_migration` instead stamps a timestamp-shaped version and breaks the
  `non_filename_versions = 0` invariant.

### Invariants to check after any migration

```sql
select (select count(*) from rls_aal2_coverage())            as aal2_gaps,        -- must be 0
       (select count(*) from events_partition_health())      as partition_health, -- must be 0
       (select count(*) from supabase_migrations.schema_migrations
         where version !~ '^[0-9]{4}$')                      as bad_versions,     -- must be 0
       (select ok from verify_events_chain(
          (select id from organizations limit 1), null))     as chain_ok;         -- must be true
```

---

## 3. Vercel

| | |
|---|---|
| Project | `gnk-crm` — `prj_5EOlvnaUYvGUaHpfNGiJy7rwQFyu` |
| Team | `gn-kalaitsidis` — `team_7UnPtMNxGLzHtM7WVBuajduo` (Hobby plan) |
| Framework | Next.js |
| Region | `fra1` — set in `vercel.json`, **not** default |
| Ignored Build Step | `ignoreCommand` in `vercel.json` — a push whose only changes are under `docs/` or in `*.md` files is **not built** (since 2026-09-21) |
| Production URL | `https://gnk-crm.vercel.app` |
| Branch alias | `gnk-crm-git-main-gn-kalaitsidis.vercel.app` |

`fra1` is deliberate: server timing was roughly 3× worse on the default region
from Cyprus.

**The Ignored Build Step exists because of Functions Storage.** The Hobby
plan holds 10 GB of function bundles across every deployment Vercel still
stores — and it keeps a deleted or expired deployment's bundle for its 30-day
recovery period, so the retention policy set on 2026-09-07 could not show in
the number before October. On 2026-09-21 the team read 10.87 GB and Vercel's
changelog (2026-09-16) says a team over the cap "can be blocked from
deploying". A gnk-crm deployment is ~22 MB of bundle (page functions 14.7 MB
each, shared files stored once), and a third of the retained deployments that
day were the preview plus the production build of a `docs/handoff-*` branch —
the same bundle rebuilt because a markdown file changed. `git diff --quiet
HEAD^ HEAD -- . ':!docs' ':!*.md'` exits 0 for exactly those pushes and Vercel
skips the build; anything else (code, migrations, `vercel.json`, no parent
commit) builds. Consequences to know:

* A docs-only merge to `main` produces a **Canceled** deployment record, not a
  READY one, and production keeps serving the previous SHA — which is the same
  code. When the HANDOFF ritual says "confirm the deploy", a docs-only merge is
  confirmed by the previous production deployment still being current.
* A branch pushed with several commits at once is judged by its last commit
  only (Vercel's documented shape). That can skip a *preview*; a production
  deploy compares the merge commit against the previous `main`, so it is only
  skipped when the whole PR was docs.
* `tests/unit/vercel-ignored-build-step.test.ts` runs the real command string
  against throwaway repositories: a pathspec edit that would skip a code push
  fails there first.
* Usage: `vercel.com/gn-kalaitsidis/~/usage` → Deployment Storage → Functions
  Storage. Per-function sizes for one deployment: its **Resources** view.

### Environment variables (Vercel → Settings → Environment Variables)

Names only — values live in the dashboard:

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY        (secret)
NEXT_PUBLIC_APP_URL
TZ
SENTRY_DSN                       (server — was missing once; everything reported nowhere)
NEXT_PUBLIC_SENTRY_DSN
SENTRY_AUTH_TOKEN                (optional, source maps)
RESEND_API_KEY                   (optional; arms the desk alert AND the lead escalation, 0107 — the escalation's recipients are profiles chosen on Settings → Lead escalation, never an env var)
ENQUIRY_ALERT_TO                 (with it; the desk address — comma-separated for more than one)
ENQUIRY_ALERT_FROM               (optional; the alert's From. Set to a verified sending address to also arm the visitor acknowledgement, 0098 — never resend.dev for that)
ENQUIRY_FORWARD_KEY              (secret; = gnk-web's CRM_FORWARD_KEY — the site proves it is the forwarder, 2026-09-06)
IP_HASH_SALT                     (secret; salts the rate-limit fingerprints — unset falls back to the public project URL and logs it)
SITE_REVALIDATE_URL              (the site's revalidate door, https://gnk-web.vercel.app/api/revalidate — 2026-09-13, REL-01)
SITE_REVALIDATE_KEY              (secret; = gnk-web's SITE_REVALIDATE_KEY — the CRM proves a knock is its own; unset = the site refreshes on its timers alone, logged once)
CRON_SECRET                      (secret; the bearer token the desk-alert sweep requires, 0101 — Vercel's cron sends it unprompted once set; the pg_net job reads the same value from Vault. Unset = the sweep answers 503 and pending desk alerts wait; the enquiry route still sends at once)
```

**Rotating a Supabase key requires a redeploy with the build cache OFF.** A
cached build keeps the old value baked in and the change appears not to take.

Deploys are automatic from `main`. Confirm one is `READY` **and aliased to
`gnk-crm.vercel.app`** before treating it as live — a READY deployment that has
not taken the alias is not serving anyone.

---

## 4. Public surface

Five paths pass the session gate, and `proxy.ts` names all five in one
condition so they can be read at a glance:

| path | what |
|---|---|
| `/p/…` | tokenised share links (buyer proposals, availability) |
| `/api/public/…` | the C3 listing feed and the enquiry door |
| `/api/portals/…` | the portal feed, by 64-hex token (0095) |
| `/api/internal/…` | **not public**: the desk-alert sweep (0101), gated in the route by `CRON_SECRET` as a bearer token — sessionless because a scheduler has none |
| `/offline` | PWA fallback |

Live feed: `https://gnk-crm.vercel.app/api/public/listings?org=gnk`

Anything placed under those prefixes is public by construction.

---

## 5. Backups

`docs/BACKUP_RESTORE.md` owns this in full. The parts that matter here:

* `supabase db dump --schema public,auth,storage` is the primary backup.
  Omitting `auth` restores a database nobody can log in to.
* `scripts/backup/export-events.sql` is the belt to that braces for `events`
  alone — a JSON/PostgREST export **cannot** back up that table, because
  JavaScript numbers lose numeric scale and the hash chain is computed over
  `payload::text`.
* Restores need `set session_replication_role = replica` or the hash trigger
  re-mints every hash and the chain verifies against invented values.
* A pre-partition snapshot of production sits in
  `gnk-backups/events-pre-partition-2026-08-28.sql` with a sha256 beside it.

---

## 6. Reading order for a new environment

1. `HANDOFF.md` §0 and §0a — state, traps, what is next. **Start here.**
2. `CLAUDE.md` — guardrails and working method.
3. `docs/DECISIONS.md` — why things are the way they are.
4. This file — where it all runs.

`docs/03_DATABASE_SCHEMA.sql` is a **Phase 1 design record, not the current
schema** — see its own header. `supabase/migrations/` is the authority.
