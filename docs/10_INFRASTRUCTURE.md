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

Runs on every push and pull request. Three jobs:

| job | what it does |
|---|---|
| `checks` | install → typecheck → lint → `npm test` → `next build` → check no nonce-dependent route was prerendered |
| `rls` | boots a local Supabase stack, applies **every** migration, runs the RLS suite |
| `e2e` | boots the stack, builds, starts the production server, runs Playwright desktop |

**The `rls` and `e2e` jobs apply all 70 migrations to a fresh database on every
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
| Migrations | **70**, latest `0070_tax_reform_2026` |
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

### Local stack

`supabase/config.toml`, `project_id = "gnk-crm"`. Ports: API **54321**, DB
**54322**, Studio **54323**, Inbucket **54324**.

```bash
npx supabase start      # boots the local stack
npx supabase db reset   # re-runs all 70 migrations + seed
npm run db:types        # regenerate lib/supabase/database.types.ts
```

**After a `db reset`, 2FA is mandatory and the seeded admin has no factor.**
Run `npm run dev:2fa` to enrol one and print the TOTP secret. That script
refuses any non-local URL, deliberately.

### pg_cron — 8 scheduled jobs (all live)

```
0  3 * * *   expire-mandates              select expire_mandates()
15 3 * * *   followup-nudges              select create_followup_nudges()
20 3 1 * *   ensure-events-partitions     select ensure_events_partitions()
30 3 * * *   verify-events-chain          select run_chain_checks()
35 3 * * 0   verify-events-chain-full     select run_chain_checks_full()
45 3 * * *   expire-reservations          select expire_reservations()
50 3 * * *   warn-expiring-reservations   select warn_expiring_reservations()
55 3 * * *   remind-due-installments      select remind_due_installments()
```

Ordering is deliberate: each sweep runs after the one whose events it needs.

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
| Production URL | `https://gnk-crm.vercel.app` |
| Branch alias | `gnk-crm-git-main-gn-kalaitsidis.vercel.app` |

`fra1` is deliberate: server timing was roughly 3× worse on the default region
from Cyprus.

### Environment variables (Vercel → Settings → Environment Variables)

Names only — values live in the dashboard:

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY        (secret)
NEXT_PUBLIC_APP_URL
NEXT_PUBLIC_DEFAULT_LOCALE
TZ
SENTRY_DSN                       (server — was missing once; everything reported nowhere)
NEXT_PUBLIC_SENTRY_DSN
SENTRY_AUTH_TOKEN                (optional, source maps)
RESEND_API_KEY                   (optional)
```

**Rotating a Supabase key requires a redeploy with the build cache OFF.** A
cached build keeps the old value baked in and the change appears not to take.

Deploys are automatic from `main`. Confirm one is `READY` **and aliased to
`gnk-crm.vercel.app`** before treating it as live — a READY deployment that has
not taken the alias is not serving anyone.

---

## 4. Public surface

Three paths are unauthenticated, and `proxy.ts` names all three in one
condition so they can be read at a glance:

| path | what |
|---|---|
| `/p/…` | tokenised share links (buyer proposals, availability) |
| `/api/public/…` | the C3 listing feed |
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
