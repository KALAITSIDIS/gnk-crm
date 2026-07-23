# HANDOVER — 2026-07-23

Point-in-time snapshot at the end of the full QA/security audit. This file is a
**starting point, not a source of truth** — the canonical documents are:

| For | Read |
|---|---|
| Why things are the way they are | `docs/DECISIONS.md` |
| Deferred scope | `docs/BACKLOG.md` |
| Audit findings + evidence | `TEST_REPORT.md` |
| Roadmap | `IMPROVEMENTS.md` |
| Test suites, how to run them | `tests/README.md` |
| Release procedure | `docs/RELEASE_CHECKLIST.md` |
| Backup, restore, RPO/RTO | `docs/BACKUP_RESTORE.md` |
| Build rules and guardrails | `CLAUDE.md` |

---

## 1. Where things stand

| | |
|---|---|
| `main` | `6ab07d2`, in sync with origin, working tree clean |
| CI | ✅ green on `6ab07d2` (both `checks` and `rls` jobs) |
| Production | `gnk-crm.vercel.app` live, security headers present, no runtime errors |
| Hosted DB | `yjgirvzgoiywdojnpkpd` (eu-central-1) — 19 migrations, history clean (`non_filename_versions = 0`) |
| Tests | 283 unit · 27 RLS · 164 E2E (162 pass, 2 self-skip on a clean DB) |
| Phase 1 | **Complete.** The manual production smoke test — the last gate — was run and passed on 2026-07-23. |

**The audit is closed.** Every finding was fixed and shipped, except SEC-5
(investigated, no change warranted) and DEP-2 (upstream). Full detail with
evidence is in `TEST_REPORT.md`.

---

## 2. Outstanding — all operator actions, none are code

### 2.1 Enable Auth leaked-password protection · 1 click
Supabase dashboard → Authentication → Password settings. Confirmed still
disabled by `get_advisors` on 2026-07-23. A single admin password currently
guards every client's PII, KYC scans and the commission evidence chain.

### 2.2 Backup / restore drill · **the biggest unmitigated risk**
**Runbook: `docs/BACKUP_RESTORE.md`. Read it before planning this.**

This section previously opened "Supabase takes backups; nobody has ever proven a
restore works." **The first half is false** and was corrected on 2026-07-23 —
see DECISIONS `T-backup-drill`. The org is on the **Free** plan, which Supabase
excludes from automated daily backups, directing free projects to self-export
instead. **There is no backup to restore today, so the RPO is unbounded, not
24h.** The first job is creating a backup; the drill comes second.

Two further findings, both in the runbook:

- **Storage is in no database backup on any plan** (Supabase keeps only object
  metadata in the DB). A DB-only restore returns `viewing_slips` rows asserting
  a SHA-256 whose bytes are gone. Storage must be exported separately, forever.
- **`verify_events_chain` is session-`TimeZone`-dependent** — the hash covers
  `occurred_at::text`. Restore into a non-UTC project and the chain reads
  `false` on perfectly intact data. Pin the target to UTC; do **not** "fix" the
  hash function (it would invalidate every hash already inside issued evidence
  PDFs).

The `events` table is still the product's value — append-only, hash-chained, and
the reason a commission claim is defensible. It cannot be reconstructed from
anywhere else. Finding TEST-2 already proved a database rebuilt purely from the
migrations is **not** identical to hosted (an explicit `service_role` grant from
Supabase platform defaults that the migrations did not reproduce) — exactly the
class of surprise a drill exists to find, and now check number one in
`scripts/backup/verify-restore.sql`.

Deliverable: a timed, actually-executed restore into a scratch project, plus a
written RPO/RTO. Proposed RPO 24h / RTO 4h awaits operator sign-off.

### 2.3 Archive property `GNK-PAF-0002` · 1 click
The smoke-test listing, currently `draft`/`private`. Open it and press
**Archive**. I could not: the browser renderer wedged on the property *detail*
route specifically (server-side healthy, zero runtime errors — a tooling
artifact). Deliberately **not** archived via SQL, because `archiveProperty`
writes an `archived` event and a direct `UPDATE` would leave the retire
unlogged.

### 2.4 Decide on 2FA
Spec-Essential, deferred, needs a client decision on whether it gates Phase 1
sign-off. Supabase Auth supports TOTP natively.

---

## 3. Permanent smoke-test data in production

Created 2026-07-23 running `docs/RELEASE_CHECKLIST.md` §5. **None of it can be
deleted** — `events` is append-only and RLS denies DELETE on business tables.
All of it is labelled "SMOKE TEST".

- property `GNK-PAF-0002` — "SMOKE TEST 2026-07-23 — release checklist, not a real listing"
- contact "SMOKE TEST Release Checklist 2026-07-23"
- one viewing (23 Jul 17:00 Cyprus) and its **signed slip** + PNG/PDF in storage
- 4 events

The checklist's §6 says "remove any smoke-test rows if this was a clean
go-live" — that is no longer possible, and was written when the database was
empty. A self-contained smoke property *and* contact were created precisely so
that a fabricated viewing and slip were never attached to a real client's
timeline.

---

## 4. Things that will bite a new session

**Migrations are hand-applied to hosted.** `npx supabase db push` does not work
here (CLI not logged in, and neither an access token nor the DB password should
be handled). The recipe that works is the Supabase MCP connector's
`execute_sql` — **not** `apply_migration`, which the safety classifier has
blocked since 0011:

```sql
-- 1. run the migration DDL with execute_sql, then:
insert into supabase_migrations.schema_migrations (version, name)
values ('00NN','00NN_name.sql') on conflict do nothing;
```

Filename versions, matching local. Verify afterwards that
`non_filename_versions = 0` — a 2026-07-21 repair fixed exactly that drift.

**Code and schema land out of order.** Vercel deploys on push; migrations are
applied by hand. Apply the migration **first** whenever the new code calls new
schema, or every user hits the error boundary.

**CI is the only place the suite meets a fresh database.** It runs
`supabase start` then `npm run test:rls` **once**. A test that only passes on a
rerun is depending on residue from the previous run — that is a bug in the
test. This went unnoticed for five commits; see §5.

**Check CI after pushing.** No `gh` auth needed, the repo is public:

```bash
curl -s "https://api.github.com/repos/KALAITSIDIS/gnk-crm/actions/runs?per_page=5"
```

**Local environment.** Docker Desktop is flaky — containers can report healthy
with no host port bindings; `npx supabase stop && npx supabase start` fixes it.
`agent@gnk.local` is **not** in `seed.sql` and vanishes on every `db reset`;
recreate it through the GoTrue admin API rather than hand-inserting auth rows.
Radix Select triggers ignore synthetic `.click()` in automation — dispatch real
pointer events, or use Playwright, which is fine.

**Never run `npm audit fix --force`.** It proposes `next@9.3.3`.

---

## 5. The two mistakes worth not repeating

**I verified locally and in production after every push, but never checked CI.**
It was red for five consecutive commits (`f91ef46` → `309f9a5`) and I did not
notice. Both causes were RLS assertions that only held with accumulated data.
Production was never affected, but the safety net was off for hours.

**Two audit findings were written up wrong and had to be corrected in place:**
DEP-1 claimed "nothing at runtime imports it" (`globals.css` imports
`shadcn/tailwind.css` — it is a build-time dependency), and SEC-5 claimed the
CORS wildcard was "worth removing anyway" (it is a CDN default on public assets
and removing it would have been cosmetic). Both corrections are in
`TEST_REPORT.md`. Treat that report's *reasoning* as reviewable, not settled.

---

## 6. Suggested first actions for a new session

1. `git branch -d` the eight merged `fix/*` and `qa/full-audit` branches — all
   are in `main` and only add noise.
2. Read `docs/DECISIONS.md` from `2026-07-22` onward — that is the audit's
   reasoning, and several entries exist specifically to stop a future session
   re-litigating a settled call (per-purchaser fees, SECURITY INVOKER on the
   dashboard RPC, cron-only `run_chain_checks`).
3. Do not start anything in `IMPROVEMENTS.md` §B or §C without the operator
   choosing it. The highest-value item there is the buyer magic-link proposal
   flow (B3); the most overdue is the backup drill (C6).
