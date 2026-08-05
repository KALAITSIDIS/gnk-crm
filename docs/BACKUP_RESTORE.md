# BACKUP & RESTORE — drill runbook and RPO/RTO

Owner: operator. Written 2026-07-23 against hosted `yjgirvzgoiywdojnpkpd`
(eu-central-1, Postgres 17.6.1.141) at `main` = `bd00809`.

This closes `IMPROVEMENTS.md` C6. Read §1 before planning the drill — the
premise the drill was scoped under turned out to be wrong, and §1 is the reason
this document leads with *creating* a backup rather than restoring one.

---

> ## ⚠️ STATUS 2026-08-05 — READ THIS FIRST IF YOU ARE MID-INCIDENT
>
> **If you are actually restoring right now, read §3.1 and §4b before running
> anything.** The dump commands are flag-sensitive, the dump does not contain the
> extensions the schema needs, and a restored project starts out *less secure*
> than its source. All three are measured, not theoretical.
>
> **Backups now exist.** §1.1, §6 and §7 below were written on 2026-07-24, when
> they did not, and their "nothing to restore from" framing is **no longer true**.
> Restore sources live in `../gnk-backups/` (outside the repo, untracked):
>
> | set | contents |
> |---|---|
> | `2026-07-30/` | `events.sql` ids 1–62 (**chain-faithful**), `business-data.json` (15 tables), auth + storage manifest, README |
> | `2026-07-31/` | all **26** Storage files + every table as JSON |
> | `2026-08-04/` | **PRIMARY** — `pg_dump.sql` (schema), `data.sql` (`auth.users` 2, `events` 73), `roles.sql`, plus the earlier hand-rolled deltas as an independent second copy. Apply order in its README; **schema-dump caveat in §3.1** |
>
> **CLOSED 2026-08-04 — `supabase db dump` has been taken.** `2026-08-04/` now
> holds `pg_dump.sql` (schema: public 29 / auth 23 / storage 8 tables, 86 RLS
> policies, 43 functions, 17 triggers), `data.sql` (**`auth.users` 2 rows**,
> `events` 73 rows, all counts matching the §2 baseline) and `roles.sql`. The
> "restore returns the data with nobody able to log in" gap is gone.
>
> **THE DRILL HAS RUN — 2026-08-05, and it passed.** Full result and the four
> defects it found: **§4b**. What it did *not* cover is the Storage half (§4
> steps 4 and 7) and **RTO, which remains unmeasured** — no stopwatch was run.
>
> The Free-plan analysis in §1.1 remains accurate and is why all of the above is
> hand-rolled.

## 1. Three findings that change the shape of this task

### 1.1 There is no backup to restore. The plan is Free. *(as of 2026-07-24 — see STATUS above)*

`HANDOVER.md` §2.2 says "Supabase takes backups; nobody has ever proven a
restore works." The first half is **not true for this project**.

The organisation `GN KALAITSIDIS's Org` is on the **Free** plan. Supabase's
backup documentation is explicit: *"We automatically back up all Pro, Team, and
Enterprise Plan projects on a daily basis"* — Free is absent from that list, and
the same page recommends that *"free tier plan projects regularly export their
data using the Supabase CLI `db dump` command and maintain off-site backups."*

A separate troubleshooting note says up to 7 daily backups are currently taken
for Free projects but only become **accessible after upgrading to a paid plan**,
and warns Supabase *"might no longer make daily backups for free projects in the
future."* So the honest position is: there is no backup you can reach today, and
no commitment that one exists tomorrow.

**This makes the risk worse than the audit recorded, not better.** The task is
not "prove the restore works" — it is "create a restore source at all", then
prove it.

### 1.2 Storage objects are in no database backup, on any plan

From the same page: *"Database backups do not include objects you store via the
Storage API, as the database only includes metadata about these objects."*

That is 26 objects / 755 KB today, and it includes the artifacts the product
exists to defend:

| Bucket | Public | Objects | Bytes | Holds |
|---|---|---|---|---|
| `documents` | no | 9 | 272,984 | KYC scans, mandates, **evidence report PDFs** |
| `media` | yes | 15 | 452,342 | property renditions |
| `signatures` | no | 2 | 29,893 | **signed viewing slip PNG + PDF** |

A database-only restore brings back `viewing_slips` rows and `documents` rows
whose files do not exist. The row says a slip was signed and its SHA-256; the
bytes that hash to it are gone. For a commission claim that is the difference
between evidence and an assertion. **Storage must be exported separately —
§3.2 — or the restore is not a restore.**

### 1.3 The event hash chain is session-`TimeZone`-dependent

This is the subtle one, and it is exactly the class of surprise TEST-2 predicted.

`trg_events_hash` (migration 0001) computes:

```sql
new.hash := encode(digest(
  coalesce(p,'') || new.org_id::text || coalesce(new.actor_id::text,'') ||
  new.entity_type || coalesce(new.entity_id::text,'') || new.event_type ||
  new.payload::text || new.occurred_at::text, 'sha256'), 'hex');
```

`occurred_at::text` renders a `timestamptz` **through the session's `TimeZone`
setting**, so the string carries the live UTC offset. `verify_events_chain`
recomputes with the same expression. Hosted currently runs `TimeZone = UTC`,
which is what every stored hash was computed under.

Restore into a project whose Postgres `TimeZone` is anything else and every hash
recomputes over a different string — `verify_events_chain` returns **false** on
data that is byte-for-byte intact. Indistinguishable, at a glance, from
tampering.

Proven read-only on hosted against event id 1:

| Rendering | String | Recompute matches stored hash |
|---|---|---|
| `TimeZone = UTC` (live) | `2026-07-15 12:46:42.427181+00` | **true** |
| `TimeZone = Asia/Nicosia` | `2026-07-15 15:46:42.427181+03` | **false** |

**Consequences, in order of importance:**

1. **The restore target must run `TimeZone = UTC`.** It is the first thing to
   check after a restore and the first thing to suspect if the chain fails.
   Check with `show timezone;` before concluding anything about integrity.
2. `TZ=Asia/Nicosia` in Vercel is the **Node** process timezone and does not
   affect the Postgres session — this is why the app has never tripped it. The
   Cyprus wall-clock logic lives in `lib/utils/tz.ts` by design (doc 02 §A11).
   Nothing here argues for changing that.
3. **Do not "fix" the hash function.** Rewriting it to use a timezone-stable
   rendering would change every future hash and invalidate every stored one,
   including hashes already printed inside issued evidence PDFs. The chain is
   append-only precisely so it cannot be rewritten. The correct mitigation is
   the operational one: pin the restore target to UTC. Logged as a note, not a
   defect.

---

## 2. Baseline — what a correct restore must reproduce

Captured from hosted 2026-07-23. These are the numbers the drill compares
against. Re-capture immediately before a drill; they will have moved.

**Row counts**

| orgs | profiles | events | contacts | properties | deals | leads | viewings | slips | documents | keys | mandates | tasks |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 2 | 60 | 2 | 2 | 1 | 3 | 1 | 1 | 3 | 1 | 1 | 0 |

Reference data: `cyprus_config` 6, `deal_stages` 26, `districts` 5.
`auth.users` 2. Latest event `2026-07-23 13:22:35.493952+00`.

**Integrity:** `verify_events_chain('00000000-0000-0000-0000-000000000001')` = `true` over 60 events.

**Migration history:** 19 rows, `non_filename_versions` = 0.

**Cron:** `expire-mandates` `0 3 * * *`, `verify-events-chain` `30 3 * * *`, both active.

**Function grants** — the TEST-2 surface. A restore that loses one of these is
broken in a way nothing on screen will show:

| Function | Security | anon | authenticated | service_role |
|---|---|---|---|---|
| `verify_events_chain` | DEFINER | ✗ | ✗ | ✓ |
| `run_chain_checks` | DEFINER | ✗ | ✗ | ✓ |
| `expire_mandates` | DEFINER | ✗ | ✗ | ✓ |
| `next_reference` | DEFINER | ✗ | ✓ | ✓ |
| `current_org_id` | DEFINER | ✗ | ✓ | ✓ |
| `current_role_gnk` | DEFINER | ✗ | ✓ | ✓ |
| `record_key_movement` | DEFINER | ✗ | ✓ | ✓ |
| `move_deal_to_stage` | INVOKER | ✗ | ✓ | ✓ |
| `add_deal_stage` | INVOKER | ✗ | ✓ | ✓ |
| `reorder_stage` | INVOKER | ✗ | ✓ | ✓ |
| `admin_dashboard_stats` | INVOKER | ✗ | ✓ | ✓ |

---

## 3. Taking a backup

Run from `gnk-crm/`. `pg_dump` is not on PATH here; the Supabase CLI (2.109.1)
runs it inside Docker, which is installed.

Both commands need credentials. **Get the connection string from Supabase →
Project Settings → Database → Connection string (URI), and the password from
your own password manager.** Do not paste either into this repo or into a chat —
`.env*` is gitignored, and the backup directory below must stay untracked too.

### 3.1 Database

> ## ⚠️ USE THE SESSION POOLER, NOT THE DIRECT HOST (verified 2026-08-04)
>
> The direct host `db.yjgirvzgoiywdojnpkpd.supabase.co` resolves to **IPv6 only**
> — a dedicated IPv4 address is a paid add-on — so from this machine (and any
> IPv4-only network) it simply times out. Measured:
>
> | host | DNS | TCP 5432 |
> |---|---|---|
> | `db.yjgirvzgoiywdojnpkpd.supabase.co` | AAAA only | ❌ fails |
> | `aws-0-eu-central-1.pooler.supabase.com` | A records | ✅ succeeds |
>
> **`$DB_URL` below must therefore be the SESSION pooler** (session mode, not
> transaction mode — `pg_dump` needs session state and the transaction pooler
> will not serve it):
>
> ```
> postgresql://postgres.yjgirvzgoiywdojnpkpd:[PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:5432/postgres
> ```
>
> Note the **username carries the project ref** (`postgres.yjgirvzgoiywdojnpkpd`),
> unlike the direct string's plain `postgres`. Percent-encode the password if it
> contains special characters.
>
> **The password cannot be looked up.** Supabase states it "isn't viewable after
> creation" — only *Reset database password* (Database → Settings), which breaks
> existing direct connections. The app is unaffected by a reset: it reaches
> Postgres through PostgREST with the API keys, not this password. Verified
> 2026-08-04: no direct Postgres connection exists anywhere in the app — no `pg`
> client, no `DATABASE_URL`, and `.env.local` holds only API keys.
>
> **It is NOT your Supabase account password.** The dashboard login identifies
> *you*; this is a Postgres role password belonging to this one project. Entering
> the account password produces `SASL auth failed / invalid password`, which is
> the most likely cause the first time this is attempted.
>
> ### 🔒 The password goes from the dashboard to the terminal and nowhere else
>
> **Never paste it into a chat, a notes file, a commit, or an issue.** It happened
> on 2026-08-04 and the password had to be reset immediately. This project has now
> lost three credentials the same way — the `service_role` key (§2b, which took
> nine attempts and most of two sessions to revoke), a live proposal-link token,
> and this. All three were cheap to rotate *because they were caught at once*;
> the expensive one was the one that sat in a transcript for four days.
>
> If a password has already been shared anywhere, treat it as burned and reset it
> before use — resetting costs nothing here, since nothing depends on it.
>
> ### Two Windows traps that cost a full round trip each
>
> - **`-p` / `--password` is ignored when `--db-url` is used.** It applies to
>   `--linked` mode. With a connection string the password must be *inside* the
>   URL, or `pg_dump` fails with `fe_sendauth: no password supplied` after
>   prompting. Percent-encode it if it contains `@ : / ? # &`.
> - **Use `npx.cmd`, not `npx`.** Plain `npx` resolves to `npx.ps1`, which
>   PowerShell's default `RemoteSigned` policy refuses to run
>   (`UnauthorizedAccess`). `npx.cmd` sidesteps the wrapper and needs no policy
>   change. Wrap the URL in **single** quotes so PowerShell cannot expand `$`.
>
> Also confirmed on the dashboard the same day: **"Free Plan does not include
> project backups"** — so §1.1's analysis still holds and self-export is the only
> path.

Three dumps, because they cover different things and no single invocation
covers all three.

> **The `--schema` flags below are not decoration and they are not
> interchangeable.** The 2026-08-05 drill (§4b) ran these commands for real. The
> schema dump and the data dump need *different* flags, and getting the schema
> one wrong is fatal on the first line that matters — it creates nothing at all.
> Everything in this section is what the drill measured, not what looks
> reasonable.

```bash
mkdir -p ../gnk-backups/$(date +%Y-%m-%d)
```

**1 — Schema. `--schema public` ONLY.**

```bash
npx.cmd supabase db dump --db-url "$DB_URL" --schema public -f ../gnk-backups/$(date +%Y-%m-%d)/schema.sql
```

Do **not** add `auth,storage` here. Those schemas are platform-managed and owned
by `supabase_admin`, so the dump emits ownership changes that **no role you can
connect as is able to perform**:

```
must be able to SET ROLE "supabase_admin"          <- line 19
must be able to SET ROLE "supabase_auth_admin"     (37 occurrences)
must be able to SET ROLE "supabase_storage_admin"  (26)
```

Under `ON_ERROR_STOP=1` — which is how you should restore — psql dies on line 19
and **nothing is created**. That is exactly what happened on the drill's first
attempt.

**2 — Data. `--schema public,auth,storage`, all three.**

```bash
npx.cmd supabase db dump --db-url "$DB_URL" --schema public,auth,storage --data-only --use-copy -f ../gnk-backups/$(date +%Y-%m-%d)/data.sql
```

`auth,storage` belongs *here*, and here it works — this is how `auth.users` comes
back, proven in the drill (2 users restored, login functional). Without it a
restored project has all the business data and nobody who can log in.
`--use-copy` is irrelevant at 73 events, but keep it: it is what makes the dump
reloadable in one pass.

**3 — Roles.**

```bash
npx.cmd supabase db dump --db-url "$DB_URL" --role-only -f ../gnk-backups/$(date +%Y-%m-%d)/roles.sql
```

Daily backups on paid plans *"do not store passwords for custom roles"*. This
project uses the stock Supabase roles, so `roles.sql` is a formality today —
take it anyway so the drill proves the whole shape.

#### ⚠️ The existing `2026-08-04/pg_dump.sql` was taken the OLD way

It was dumped with `--schema public,auth,storage` — the schema-dump mistake
above, baked into the primary backup set. Confirmed on the file: `ALTER SCHEMA
"auth" OWNER TO "supabase_admin";` sits on **line 19**, and `CREATE EXTENSION`
appears **zero** times.

It is still restorable — that is what the drill proved — but only if you either
re-dump with `--schema public` or restore it without `ON_ERROR_STOP` and accept
the `auth`/`storage` ownership statements failing harmlessly. **Prefer the
re-dump.** Mid-incident is the wrong moment to be reasoning about which errors
are safe to ignore.

### Two things the dump does NOT contain, both needed before/after a restore

The dump is a necessary half of the contract, not the whole of it. Both of the
following were measured in the drill; skipping either produces a restore that
looks finished and is not.

#### BEFORE the schema restore — enable the extensions by hand

**The dump contains zero `CREATE EXTENSION` statements.** A fresh project has no
PostGIS and no `pg_trgm`, so `properties` (`geography(point,4326)`) cannot be
created and the failure cascades:

```
type "public.geography" does not exist        -> properties, then 42 dependents
operator class "public.gin_trgm_ops" missing  -> viewing_slips (11), mandates_safe (4)
```

That is **57 errors from this cause alone**. Run this against the TARGET project
*before* loading `schema.sql`:

```sql
create extension if not exists postgis;
create extension if not exists pg_trgm;
create extension if not exists pgcrypto;
create extension if not exists "uuid-ossp";
```

With that done the drill's total error count fell 131 → 71 and RLS policies went
77 → **86/86**.

#### AFTER the restore — re-apply the grant lockdown

**Function grants do not survive the dump: `anon` comes back holding EXECUTE on
11 of 13 functions**, including `verify_events_chain`, `current_org_id` and
`current_role_gnk` (full table in §4b.3). A restored project is therefore **less
secure than the project it was copied from**, and nothing on screen says so.

Re-apply migrations **0007 / 0010 / 0019 / 0021 / 0022** — or the revokes by hand
— and re-check with `scripts/backup/verify-restore.sql` **before letting anyone
in**. `pg_cron` (all three cron jobs silently absent) and
`supabase_migrations.schema_migrations` (0 rows dumped) are the same class of
gap; see §4b.4.

### 3.2 Storage — the part no database backup covers

The CLI has native recursive copy, so this needs no bespoke script:

```bash
npx supabase storage cp -r ss:///documents ../gnk-backups/$(date +%Y-%m-%d)/storage/documents --experimental
```

```bash
npx supabase storage cp -r ss:///signatures ../gnk-backups/$(date +%Y-%m-%d)/storage/signatures --experimental
```

```bash
npx supabase storage cp -r ss:///media ../gnk-backups/$(date +%Y-%m-%d)/storage/media --experimental
```

`documents` and `signatures` are the two that carry evidentiary weight. `media`
is property photos — reproducible in principle, expensive in practice, so back
it up but restore it last.

Verify the counts match §2 (9 / 2 / 15) before calling the backup good.

### 3.3 Off-site

`../gnk-backups/` sits outside the repo deliberately. Note that the working
directory is under **OneDrive**, which is sync, not backup — a deletion
propagates. Copy the dated folder somewhere that is neither this machine nor the
same Supabase account before the drill counts as passed.

---

## 3.4 What a rehearsal on 2026-07-24 proved — read before choosing a method

A restore was executed end to end against a scratch database (`restore_drill`)
built from the 19 migrations, loading a 295-event dataset. It found four things
that change the method, not just the checklist. Full write-up: DECISIONS
`T-backup-drill-run`.

**1. A JSON/PostgREST export CANNOT back up `events`. This is the big one.**
PostgREST hands `jsonb` to JavaScript, and JavaScript numbers carry no scale, so
a payload stored as `{"to": 510000.00}` restores as `{"to": 510000}`.
`verify_events_chain` hashes `payload::text`, so that one character breaks the
hash — and because the chain is sequential, **one corrupted payload invalidates
every event after it**. In the rehearsal, an org whose chain was `true` at the
source came back `false` with identical row counts. A restored database that
looks complete and reports its own evidence chain as FAILED is indistinguishable
from a tampered one.

*Production is exposed:* 1 of 62 hosted events already carries a decimal
payload, and every price change and deal amount adds another.

**→ `supabase db dump` (pg_dump) is the PRIMARY backup and is not optional.**
`scripts/backup/export.mjs` is for **Storage** (which no database dump contains,
§1.2) and for a readable table snapshot. It marks its own manifest
`chainFaithful: false`.

**`scripts/backup/export-events.sql` is the belt to that braces** (added
2026-07-29). It emits `events` as INSERT statements straight from Postgres, with
`payload::text` re-parsed as `::jsonb` on restore — the payload never becomes a
JavaScript number, so the defect above cannot occur:

```bash
psql "$DB_URL" -At -f scripts/backup/export-events.sql -o ../gnk-backups/$(date +%Y-%m-%d)/events.sql
```

`-At` is required (the script explains why). Apply the output with
`session_replication_role = replica` — see §"Three restore hazards" — or
`trg_events_hash` recomputes the hashes and the chain then verifies against
freshly minted values, which proves nothing.

**Proven, not asserted:** against a local database seeded with
`{"to": 510000.00, "from": 499999.50}` — the exact failing shape — the file
carried the payload verbatim, and a wipe-and-restore round trip returned 26/26
rows with `verify_events_chain` **true** and the payload still reading
`510000.00`.

It covers ONE table. It is not a backup by itself: no business tables, no
`auth.users`, no Storage objects. It exists because `events` is the one table
whose corruption is both silent and total.

**2. The restore target must be a Supabase project, not a Postgres database.**
The schema will not build without `auth.uid()` and `auth.users` (51 references),
`storage.buckets`, and the `anon`/`authenticated`/`service_role` roles. Also
`pg_cron` can only be installed in ONE database per cluster, so a scratch
database beside the live one cannot take the full schema. This is why §4 step 1
says *project*.

**3. Restoring data needs three specific defences**, all now in
`scripts/backup/restore.mjs`:
- `session_replication_role = replica` for the transaction. Without it
  `trg_events_hash` fires on every inserted row and **recomputes** the hashes,
  so the chain verifies — against freshly minted values. That one line is the
  difference between restoring evidence and manufacturing it.
- `OVERRIDING SYSTEM VALUE`, because `events.id` is `GENERATED ALWAYS AS
  IDENTITY` and `verify_events_chain` walks in id order.
- An explicit column list that **excludes generated-stored columns** —
  `contacts.display_name` is one, and Postgres refuses any value for it.
- Afterwards, every sequence must be advanced past the restored maximum or the
  first write collides.

**4. `auth.users` is not in the public schema**, so neither this export nor a
default `db dump` includes it: restore those and nobody can log in. Add
`--schema public,auth,storage` — **to the DATA dump only.** On the schema dump
the same flag is fatal; §3.1 has the measured reason.

**Measured timings** (295 events, 26 tables, single small bucket — mechanical
steps only, no provisioning): export 0.7s · scratch schema from 19 migrations
9s · data restore 1s · verification instant. **The data is not the slow part at
this scale; provisioning and the human steps are.**

---

## 4. The drill

Time each phase and write the actual minutes into §6.

1. **Create a scratch project** in the same org, region eu-central-1, Postgres
   17.x. Name it `gnk-crm-restore-drill`. It is throwaway; delete it at the end.
2. **Confirm the timezone first** — `show timezone;` must return `UTC`. If it
   does not, set it before loading anything, or §1.3 will make step 6 fail for
   the wrong reason.
3. **Enable the extensions, then restore roles, then schema, then data**, in that
   order, via the scratch project's connection string. The extension step is not
   optional and it is not in the dump — see §3.1 ("BEFORE the schema restore").
   Restoring the schema first costs you 57 errors and a database with no
   `properties` table.
4. **Restore storage** — the same `supabase storage cp -r` commands with source
   and destination swapped, against the scratch project. Buckets must exist
   first, and `media` must be `public = true` (that is migration 0008's whole
   job; a restored-but-private `media` bucket serves broken images and looks
   like a code fault).
5. **Run the verification pack.** First run `scripts/backup/capture-baseline.sql`
   against the SOURCE and paste its single output row over the `expected` block
   in `scripts/backup/verify-restore.sql`; then run that pack against the
   RESTORED database. Its output labels every check **invariant** (event chain,
   function grants, cron, bucket visibility, migration history, timezone,
   slip/report files present) or **row count**. An invariant failure is real; a
   row-count failure usually just means the baseline snapshot is older than the
   source. Hardcoded counts went stale once and reported false failures — the
   worst possible signal mid-recovery, which is why capture is now a command.
6. **Verify the chain** — `select verify_events_chain(id) from organizations;`
   must be `true`. If false, re-read §1.3 before assuming corruption.
7. **Point a local app at it.** Copy `.env.local` to `.env.drill`, swap the URL
   and keys for the scratch project's, and run `npm run dev`. Log in, open
   `/reports`, and confirm the chain badge reads OK and a stored evidence report
   downloads and opens. **This is the real test** — it is the only step that
   proves database and storage came back consistent with each other.
8. **Delete the scratch project.** Free-plan org, so leaving it costs a project
   slot; it also holds a full copy of real client PII and KYC scans, which is a
   GDPR exposure of its own. Deleting it is part of the drill, not cleanup after.

---

## 4b. DRILL RESULT — executed 2026-08-05, and it found four defects

**Ran for real** against a throwaway project (`gnk-crm-restore-drill`,
eu-central-1) and, in parallel, an isolated local database. **The headline is a
pass:** the backup restores and

```
verify_events_chain = TRUE      timezone UTC
events 73/73 · contacts 2/2 · properties 2/2 · share_links 2/2 · slips 1/1 · orgs 1/1
public tables 30 · RLS policies 86/86 · auth.users 2
```

That had never been proven before. Everything below is what the drill existed to
find.

### 1. The dump contains NO `CREATE EXTENSION` — restore fails without them

A fresh project has no PostGIS or `pg_trgm`, so `properties`
(`geography(point,4326)`) cannot be created and the failure cascades:

```
type "public.geography" does not exist            -> properties, then 42 dependents
operator class "public.gin_trgm_ops" missing      -> viewing_slips (11), mandates_safe (4)
```

**Enable `postgis`, `pg_trgm`, `pgcrypto`, `uuid-ossp` on the target BEFORE
loading the schema.** With that done, errors fell 131 -> 71 and policies went
77 -> **86/86**.

### 2. Dumping `--schema public,auth,storage` is wrong for the SCHEMA dump

`auth` and `storage` are platform-managed and owned by `supabase_admin`, so the
dump emits ownership changes no connectable role can perform:

```
must be able to SET ROLE "supabase_admin"          <- FATAL at line 19
must be able to SET ROLE "supabase_auth_admin"     (37)
must be able to SET ROLE "supabase_storage_admin"  (26)
```

With `ON_ERROR_STOP=1` the restore dies immediately and nothing is created —
which is exactly what happened on the first attempt. **Schema dump: `--schema
public` only. Data dump: keep `public,auth,storage` — that is how `auth.users`
comes back.**

### 3. Function grants do NOT survive — `anon` gets EXECUTE on everything

The TEST-2 surface, and §5 already warned it was "the one most likely to
differ". It differed on **11 of 13**:

| function | expected | after restore |
|---|---|---|
| `verify_events_chain` | `anon ✗` | **`anon ✓`** |
| `expire_mandates` | `anon ✗ auth ✗ svc ✗` | **all ✓** |
| `current_org_id` / `current_role_gnk` | `anon ✗` | **`anon ✓`** |

A restored project is therefore **less secure than the source** until the
lockdown migrations (0007/0010/0019/0021/0022) are re-applied. Re-run them, or
re-apply the revokes by hand, and re-check with this pack before letting anyone
in.

### 4. `pg_cron` is absent, so all three jobs are silently gone

`expire-mandates`, `followup-nudges` and `verify-events-chain` do not exist on
the restored project — mandates stop expiring, nudges stop firing and the
nightly chain check stops running, with nothing on screen to say so. Enable
`pg_cron` and re-run the migrations that schedule them.

**Also:** `supabase_migrations.schema_migrations` is not in the dump (0 rows
restored). A later `db push` would try to re-run all 24 migrations. Re-seed that
table as part of any restore.

### What the drill did NOT cover

Storage **files** were not copied, so §4 step 4 and step 7 are still unexecuted.
That gap is what exposed the false-pass described in §5.

---

## 5. What "passed" means

The drill passes only if all of these hold on the restored project:

- [ ] `show timezone` = `UTC`
- [ ] every row count in §2 matches
- [ ] `verify_events_chain` = `true` for every org
- [ ] the function-grant table in §2 reproduces **exactly** — this is the TEST-2
      check, and the one most likely to differ
- [ ] `non_filename_versions` = 0 and **24** migration rows (19 when this list was
      written; re-check against `supabase/migrations/` rather than trusting this
      number — it moves with every migration)
- [ ] both cron jobs present and active
- [ ] storage object counts 9 / 2 / 15, and `media.public` = true
- [ ] the signed slip PDF for the smoke viewing downloads and opens
- [ ] a stored evidence report downloads, and its SHA-256 still matches the
      `pdf_sha256` in its event payload — the end-to-end proof that the evidence
      chain survived
- [ ] at least one login works

### Verifying an `events.sql` export on disk — the md5 trap

Each export header records an md5 of its **insert lines only, joined by `\n`,
with no trailing newline**. On Windows/OneDrive the file is stored CRLF, so the
obvious command gives a *different* hash and the backup looks corrupt. This cost
a false alarm on 2026-08-04 against a file that was perfectly intact — exactly
the wrong discovery to make mid-recovery. Use:

```bash
grep "^insert into events" events.sql | tr -d '\r' | printf '%s' "$(cat)" | md5sum
```

The same hash can be recomputed **inside Postgres** and compared, which is how
these exports are proven lossless end to end:

```sql
select md5(string_agg(l, E'\n' order by id)) from ( /* the format() from
  scripts/backup/export-events.sql */ ) lines;
```

Because `events` has no UPDATE or DELETE grant, an older export stays a valid
**prefix** of production forever — verified on 2026-08-04, where production's
first 62 rows still hashed to the 2026-07-30 header value. That is what makes
the delta files in `2026-08-04/` sound rather than a shortcut.

---

## 6. Proposed RPO / RTO — for operator sign-off

**Today, honestly stated:**

| | As written 2026-07-24 | **Actual, 2026-08-04** |
|---|---|---|
| RPO | **Unbounded.** No reachable backup exists. A project-level loss is total. | **Hours as of the last capture** — a full `pg_dump.sql` + `data.sql` + `roles.sql` was taken 2026-08-04, Storage 2026-07-31 (unchanged since; newest object 2026-07-23). But it is **manual and unscheduled**, so this drifts from the moment it is written. |
| RTO | **Unbounded.** Nothing to restore from, so nothing to time. | **Still untested — but now testable.** The sources are complete for the first time (schema + data + roles + files, `auth.users` included) and verified by row counts and md5. No drill has been executed, so the 4h target below remains a guess. |

**Proposed, after §3 is running** — now with the mechanical half measured rather
than guessed (§3.4):

| | Target | Why this number |
|---|---|---|
| **RPO** | **24 hours** | A nightly `db dump` + storage export. At current volume (~62 events in 12 days) a worst-case loss is a single day of activity. Cheap, and infinitely better than today. |
| **RTO** | **4 hours** | The measured mechanical path — schema from migrations, load, verify — is **~11 seconds** at this data volume. Everything else is provisioning a project, restoring Storage, re-pointing Vercel env vars, and working through §5. 4h is the honest figure with a human in the loop; it is dominated by people and provisioning, not by data. |

**When to revise:** the moment real client volume arrives, 24h stops being
acceptable for commission evidence — a lost day could contain the viewing slip a
claim rests on. At that point the answer is **Pro plan + PITR add-on**, which
takes RPO to ~2 minutes (WAL archived at 2-minute intervals). Pro is $25/mo;
7-day PITR is ~$100/mo on top. That is a business call about what the evidence
chain is worth, and it belongs to the operator, not to this document.

Note that **PITR still does not cover storage** (§1.2). The `supabase storage
cp -r` export in §3.2 remains necessary on every plan, forever.

---

## 7. Recommended sequence

1. ~~Take one manual backup today (§3).~~ **DONE 2026-07-30, extended 2026-08-04.**
2. ~~`supabase db dump`.~~ **DONE 2026-08-04** — `2026-08-04/` holds
   `pg_dump.sql`, `data.sql` and `roles.sql`, and the 2026-08-05 drill restored
   from them. **But the schema file was taken with the wrong `--schema` flag**
   (§3.1), so the open item is now a *re-take* of the schema dump, not a first
   take. Needs the database password, so it is the operator's. **Use the session
   pooler — the direct host is IPv6-only and will time out (see §3.1):**
   ```bash
   npx.cmd supabase db dump --db-url 'postgresql://postgres.yjgirvzgoiywdojnpkpd:[PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:5432/postgres' --schema public -f ../gnk-backups/$(date +%Y-%m-%d)/pg_dump.sql
   ```
3. Get it off-site (§3.3). `../gnk-backups/` is under OneDrive — sync, not backup.
4. ~~Run the drill (§4).~~ **DONE 2026-08-05, database half only** — §4b.
   Steps 4 and 7 (Storage files, app against the restored project) are still
   unexecuted, and **RTO is still unmeasured**: no stopwatch was run.
5. Decide Free-plus-nightly-dump versus Pro-plus-PITR (§6) with the volume you
   actually expect in Phase 2.

**What is left is items 2, 3 and the second half of 4.** The restore path is
proven for schema, rows, the event chain and logging in. It is **not** proven for
Storage bytes — and Storage is where the signed slips and evidence PDFs live, so
that is the half that decides whether a commission claim survives a recovery.
