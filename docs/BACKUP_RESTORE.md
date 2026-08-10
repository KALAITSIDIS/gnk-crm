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
> | `2026-08-04/` | superseded — same contents, but its `pg_dump.sql` carries the wrong-`--schema` defect (§3.1). Keep for the hand-rolled deltas and as the artefact that exposed it |
> | `2026-08-06/` | **the restore-PROVEN set.** `pg_dump.sql` (`--schema public`, correct), `data.sql` (`auth.users` 2, `events` 73), `roles.sql`. Loaded end to end; all 73 event hashes byte-identical to production. Apply order and full evidence in its README. Carries no Storage of its own — use `2026-07-31/storage/` |
> | `2026-08-07/` | **PRIMARY — the first automated set, and the only COMPLETE one.** Schema · data · roles · **26 Storage objects** · table JSON · `SHA256SUMS` · `manifest.json` saying `verified:true` with events 73 matching live. Restore from this one; `2026-08-06` is what proved the method |
>
> **CLOSED 2026-08-04 — `supabase db dump` has been taken.** `2026-08-04/` now
> holds `pg_dump.sql` (schema: public 29 / auth 23 / storage 8 tables, 86 RLS
> policies, 43 functions, 17 triggers), `data.sql` (**`auth.users` 2 rows**,
> `events` 73 rows, all counts matching the §2 baseline) and `roles.sql`. The
> "restore returns the data with nobody able to log in" gap is gone.
>
> **THE DRILL HAS RUN — 2026-08-05, both halves, and both passed.** Database:
> **§4b** (and the four defects it found). Storage and the app check: **§4c** —
> all 26 objects byte-identical, and the evidence PDFs still hash to their
> generation events. **RTO is timed in §6b**: ~19 s of mechanical work locally,
> ~2–2.5 min over the wire, +72 s to redeploy Vercel. Project provisioning and
> the human steps are still untimed and are the bulk of the 4h target.
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

### 3.0 The automated path — start here

**`scripts/backup/capture.mjs` takes a complete set in one command and refuses to
call it a backup unless it verifies.**

```bash
SUPABASE_DB_URL=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/backup/capture.mjs
```

Schema (`--schema public`), data (`--schema public,auth,storage --data-only
--use-copy`), roles, Storage objects and table JSON, into
`../gnk-backups/<date>/`, plus `SHA256SUMS` and a `manifest.json`. Flags:
`--out`, `--force` (replace today's set), `--skip-storage`, `--keep N` (retention).

**Exit codes are meaningful, because a scheduler only sees the number:**
`0` verified · `1` produced but NOT trustworthy · `2` refused to start
(bad config, or today's folder exists without `--force`).

It checks its own output against every failure this project has actually hit:

| check | the failure it catches |
|---|---|
| zero `supabase_admin` in the schema file | the wrong `--schema` flag — restore dies at line 19 (§4b.2) |
| `data.sql` line 1 is `SET session_replication_role = replica;` | otherwise `trg_events_hash` re-mints every hash on restore (§5) |
| `auth.users` / `events` / `storage.objects` COPY blocks present | a restore where nobody can log in |
| **events in the dump == events live right now** | a truncated dump, which does not error |
| size floors, and partial output deleted on failure | the 0-byte `pg_dump.sql` that reads as a backup |

Anything failing is listed on stderr *and* recorded as `verified:false` in
`manifest.json`, so a set that went wrong says so from inside.

> #### It stages, and that is load-bearing
>
> Everything is written to `.staging-<pid>/` and moved into place **only once
> every check passes**. A failed run cannot touch the destination; the worst it
> does is leave a staging folder, which the next run sweeps.
>
> This is not caution for its own sake. The first version wrote straight into
> `<date>/`, and on 2026-08-06 a failed run **destroyed the verified set already
> there**: the CLI created `pg_dump.sql` and `roles.sql` as 0-byte files (the
> cleanup deleted them, taking the good ones with them) and wrote a 41-byte
> fragment over a good 84 KB `data.sql` — too large to look empty. Recovered only
> because a snapshot had been taken first.
>
> **A backup tool that eats last night's good backup when tonight's fails is
> worse than no backup tool.** Verified by test: a deliberately failing run
> against an existing set leaves it byte-identical.

**Retention (`--keep N`) is deliberately timid.** It only considers folders it
made (those with a `manifest.json`), only prunes ones marked `verified:true`, and
keeps the N most recent. The hand-rolled historical sets have no manifest and are
untouchable by it; a failed set is kept until a human looks at it.

#### The nightly task — installed 2026-08-06

```
Task     : "gnk-crm nightly backup"     Daily 03:45     Logon Mode: Interactive only
Runs     : C:\Users\user\.gnk-crm\run-backup.cmd
Which is : node --env-file=…\backup.env capture.mjs --out …\gnk-backups --force --keep 14
Log      : C:\Users\user\.gnk-crm\backup.log   (exit=N appended per run)
REPO     : D:\dev\TSOPOZIDIS\gnk-crm        (repointed 2026-08-07)
DEST     : D:\dev\TSOPOZIDIS\gnk-backups    (repointed 2026-08-07)
```

`run-backup.cmd` hardcodes `REPO` and `DEST` as absolute paths, because Task
Scheduler's working directory is not the repo. **Moving the workspace breaks
this task, and it breaks quietly** — so the script now exits `3` and logs
`REPO not found` when `capture.mjs` is missing, instead of running `node` on a
path that no longer exists. If you relocate the workspace again, edit those two
lines first and then run the §3.2 manual invocation to prove it still works.

03:45 sits after the 03:30 `verify-events-chain` cron, so each set contains that
night's chain check.

**`C:\Users\user\.gnk-crm\` is outside the repo tree on purpose.** A database
password inside it would have synced to the cloud back when the workspace was
under OneDrive, and it must never land in git regardless. Never copy
`backup.env` into the repo either — `gnk-crm` is **public**. This directory
deliberately **stayed on `C:`** when the workspace moved to `D:` on 2026-08-07;
only `REPO` and `DEST` inside `run-backup.cmd` were repointed.

Three things to know about it:

- **It does nothing until `backup.env` exists.** Copy `backup.env.example`
  alongside it and fill in the two credentials; until then every run exits `2`
  and logs why.
- **"Interactive only" means it runs when the user is logged on.** A machine that
  is off or logged out at 03:45 silently takes no backup — check the log, or
  Task Scheduler's Last Run Result, rather than assuming.
- **It does not solve off-site** (§3.3), and since 2026-08-07 it is further from
  solving it: `DEST` is now a second volume on the same machine, with no cloud
  copy behind it.

#### Two API-key facts that cost an evening on 2026-08-06/07

Both were discovered validating the service key, and neither is obvious:

> **1. `/rest/v1/` returns 401 on this project even with a perfectly valid key.**
> Its RLS policies call `current_org_id()`, migration 0007 revoked `EXECUTE` on
> it for `anon`, and **PostgREST reports that Postgres permission error (42501)
> as HTTP 401** — indistinguishable from a bad credential unless you read the
> body. Measured with a known-good key: `/rest/v1/organizations` 401,
> `/rest/v1/districts` 401, `/rest/v1/` 401, **`/auth/v1/settings` 200.**
> **Validate a key against `/auth/v1/settings`, never a REST table.**
>
> **2. Supabase refuses secret keys sent from anything that looks like a
> browser** — `{"message":"Forbidden use of secret API key in browser"}`, HTTP
> 401. PowerShell's `Invoke-WebRequest` defaults to a `Mozilla/…` User-Agent and
> trips it. Send an explicit non-browser `-UserAgent`. `supabase-js` under Node
> is unaffected — confirmed by the first green backup, which read all 26 Storage
> objects with the same key.

Together these produced three separate false "your key is dead" verdicts against
a key that was correct all along. **If a secret key appears rejected, read the
response body before believing it.**

Health check — is the newest set good?

```bash
cat "$(ls -d ../gnk-backups/*/ | tail -1)manifest.json"
```

The rest of §3 is the manual path and the reasoning behind each flag. Read it
before changing anything above.

---

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

#### ✅ SUPERSEDED — a correct dump was taken 2026-08-06

`../gnk-backups/2026-08-06/pg_dump.sql` is a real `--schema public` dump of
production, and it is **verified, not assumed**:

- zero `supabase_admin` mentions; the only `CREATE SCHEMA` is `"public"`, line 16
- restored into a scratch database under **`ON_ERROR_STOP=1`: exit 0, 0 errors**
- object counts identical to production: **30** tables · 3 views · **86** policies
  · 22 functions · 13 triggers · 62 indexes · 25 enums · 86 FKs

**Use this file.** The 2026-08-04 `pg_dump.sql` is kept only as the historical
artefact that exposed the defect.

Getting it took three failed attempts, all worth knowing:

- > ### ⚠️ `password authentication failed for user "postgres"` DOES NOT MEAN THE USERNAME IS WRONG
  >
  > **The pooler reports the bare role in that message no matter what username
  > you sent.** Proven 2026-08-06: a connection whose username was definitively
  > `postgres.yjgirvzgoiywdojnpkpd` — parsed out of the config and printed — still
  > failed with `for user "postgres"`. **An earlier revision of this section said
  > the message diagnosed a bare-`postgres` username. It does not, and chasing
  > that cost most of an evening.**
  >
  > Treat it as what it is: **authentication failed, cause unstated.** In practice
  > it is almost always the password — the Supabase *account* password instead of
  > the project's Postgres one, an unencoded special character, or a placeholder
  > that was never replaced.
  >
  > Still use the **Session pooler** string rather than *Direct connection*: the
  > username genuinely does need the ref (`postgres.<ref>`), and the direct host
  > is IPv6-only. Just don't diagnose from that error message.
- **A failed `db dump` still creates the output file — empty.** A 0-byte
  `pg_dump.sql` was left behind by a failed attempt. In a backup directory that
  reads as a backup. Check the byte count, not just the filename.
- **`-f` does not create the directory.** The first attempt died on
  `NotFound: FileSystem.writeFile`, which looks alarming and means only that
  `mkdir -p` had not been run.

#### The derived file — kept, and it turned out to be exactly right

Before the password worked, a public-only schema was recovered from the bad
2026-08-04 dump by `scripts/backup/split-dump-by-schema.py`:

| file | |
|---|---|
| `pg_dump-public.sql` | 124 KB — schema for `public` only. **Use this one.** |
| `pg_dump-platform.sql` | 94 KB — the `auth`/`storage` remainder. A real Supabase project already has these; keep it only for reference |

The CLI **strips pg_dump's `-- Name: …; Schema: …` headers** (there are zero in
the file), so the split classifies statements by their first quoted schema
qualifier, with a splitter that understands dollar-quoted function bodies. That
is a heuristic, so it was verified by restoring rather than by reading:

- 1,026 statements parsed, **none lost** — 12 preamble · 569 public · 445 platform
- **zero** `supabase_admin` ownership statements in the public half; line 19 is now
  `CREATE SCHEMA IF NOT EXISTS "public";` where the original had the fatal one
- restored into a scratch database under **`ON_ERROR_STOP=1`: exit 0, 0 errors** —
  the test the original file fails outright
- object counts identical to production on every dimension checked:

| | tables | views | policies | functions | triggers | indexes | enums | FKs |
|---|---|---|---|---|---|---|---|---|
| production | 30 | 3 | 86 | 22 | 13 | 62 | 25 | 86 |
| restored from the derived file | **30** | **3** | **86** | **22** | **13** | **62** | **25** | **86** |

**And then the real dump arrived, which let the workaround be graded rather than
trusted.** Normalised statement-for-statement against
`pg_dump.sql`:

```
real --schema public dump : 581 statements
derived (script)          : 581 statements
in real but missing from derived : 0
in derived but not in real       : 0
```

**Identical.** The heuristic — classify by first quoted schema qualifier, with a
splitter that understands dollar-quoted bodies — reproduced a genuine
`--schema public` dump exactly. That is a real result for the next incident: if
the password is unreachable and all you have is a badly-flagged dump, this script
recovers a correct schema from it. It is still second choice, because it can only
ever reshape an existing snapshot and inherits anything that snapshot got wrong.

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

**Out:**

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/backup/export.mjs --out ../gnk-backups
```

**Back in:**

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/backup/restore-storage.mjs --from ../gnk-backups/2026-07-31
```

`documents` and `signatures` are the two that carry evidentiary weight. `media`
is property photos — reproducible in principle, expensive in practice, so back
it up but restore it last.

Verify the counts match §2 (9 / 2 / 15) before calling the backup good.
`restore-storage.mjs` does this for you: it re-downloads every object it just
uploaded and compares SHA-256 against the file on disk, so a silent partial
restore cannot report success. `--verify-only` runs that check without writing.

> **What happened to `supabase storage cp -r`?** Earlier revisions of this
> section told you to use it. **It has never been run here, in either
> direction** — the 2026-07-31 export was taken with `export.mjs`, and until
> 2026-08-05 no restore-side tool existed at all. The CLI path also needs a
> persisted CLI login, which does not reliably work on this machine (HANDOFF §7).
> The scripts need only the service key, which is the credential `export.mjs`
> already uses. If you ever do get `storage cp` working, verify it against the
> hashes rather than the file count.

### 3.3 Off-site

`../gnk-backups/` sits outside the repo deliberately.

> **This got worse on 2026-08-07, not better.** The workspace used to sit under
> OneDrive. OneDrive is sync rather than backup — a deletion propagates and so
> does an encryption — but it did keep a copy of `gnk-backups/` off this
> machine. Moving to `D:\dev\TSOPOZIDIS` removed that copy. Every backup set is
> now on **one physical machine only**, and `D:` is a second volume on the same
> box, so it survives nothing that takes the machine with it. Until a set is
> copied off, the off-site gap is total.

Copy the dated folder somewhere that is neither this machine nor the same
Supabase account.

**Package it as one checksummed archive** so the transfer is a single verifiable
step rather than 84 files that might arrive partially:

```bash
cd "D:/dev/TSOPOZIDIS" && tar -czf gnk-backups-offsite-$(date +%Y-%m-%d).tar.gz gnk-backups/ && sha256sum gnk-backups-offsite-$(date +%Y-%m-%d).tar.gz | tee gnk-backups-offsite-$(date +%Y-%m-%d).tar.gz.sha256
```

**Then verify at the destination, not here.** A checksum computed on the machine
you are copying *from* proves nothing about what arrived:

```bash
sha256sum -c gnk-backups-offsite-<date>.tar.gz.sha256
```

> ### 🔒 This archive is sensitive. It is not a public artefact.
>
> `data.sql` and `pg_dump.sql` contain `auth.users` rows including
> **`encrypted_password` bcrypt hashes**, and the Storage export contains signed
> viewing slips and evidence PDFs. **Never put it in the repo** — `gnk-crm` is a
> **public** GitHub repository — and never in a public bucket, a pastebin, a chat
> or an issue. Acceptable destinations are a personal cloud account that is not
> the Supabase one, an encrypted USB drive, or another machine.
>
> The current dataset is operator test data (§0), which lowers the stakes *today*
> and not one day longer than that.

**CURRENT ARCHIVE — `gnk-backups-offsite-2026-08-10.tar.gz`** (2026-08-10),
4.17 MB, **390 entries**, all **eight** sets including the 08-10 nightly.

```
sha256  a6360d1123975cf6b330d2240413cdfa8b1c831c7e2c3ae929a4c5fd251550ca
```

Verified twice, because a tar that lists cleanly is not a tar that restores:
extracted and `diff -r`'d against the original (**0 differences across all eight
sets**), then ran `sha256sum -c SHA256SUMS` *inside the extracted 2026-08-10 set*
(**55/55 OK, 0 failed**). Integrity holds end to end, not just at the archive
boundary.

> ### ⚠️ THREE ARCHIVES ARE ON `D:` RIGHT NOW — COPY THE 08-10 ONE
>
> `2026-08-07` (2.0 MB) and `2026-08-09` (3.4 MB) are still there alongside it.
> **Both are strict subsets of `2026-08-10` — verified 2026-08-10, 0 entries in
> either that the new archive lacks** — so deleting them loses nothing, and the
> rule this file already states is *one archive, one checksum; two of them
> invites moving the wrong file*. Three is worse. Delete the older two once the
> current one is off the machine:
>
> ```bash
> cd "D:/dev/TSOPOZIDIS" && rm gnk-backups-offsite-2026-08-07.tar.gz* gnk-backups-offsite-2026-08-09.tar.gz*
> ```

> **STILL ON THIS MACHINE — the off-site gap is OPEN as of 2026-08-10.** The
> operator's plan is to copy it to a USB drive; **until that happens nothing has
> changed**, and no line in this repo should be read as saying otherwise. There
> was no removable drive attached when the archive was built, and `D:` is a
> second volume on the same box. OneDrive is not a substitute: it syncs, so a
> deletion or an encryption propagates.
>
> **Verify AT THE DESTINATION, not here** — a checksum computed on the machine
> you copied from proves nothing about what arrived:
>
> ```bash
> sha256sum -c gnk-backups-offsite-2026-08-10.tar.gz.sha256
> ```

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
4. **Restore storage** — `node scripts/backup/restore-storage.mjs --from
   ../gnk-backups/2026-07-31`, pointed at the scratch project. It creates each
   bucket with the correct `public` flag (`media` **must** be `true` — migration
   0008's whole job; a restored-but-private `media` serves broken images and
   looks like a code fault), uploads with the right content type, and
   re-downloads every object to compare SHA-256. Do **not** use `supabase
   storage cp -r`; §3.2 explains why. Executed 2026-08-05 — **§4c**.
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
   proves database and storage came back consistent with each other. Do not stop
   at "a file downloaded": **hash it and compare against the `pdf_sha256` in its
   generation event.** A 200 proves plumbing; the hash proves evidence.
   Executed 2026-08-05 — **§4c**.
8. **Delete the scratch project, and clean up whatever else the drill touched.**
   Free-plan org, so leaving it costs a project slot; it also holds a full copy of
   the entire dataset, which is an exposure of its own even while that data is
   only test data. If the drill borrowed the local stack instead, put it back —
   remove the restored objects and rows, or you have left residue that a later
   test may quietly depend on (HANDOFF §4).

   > **⚠️ Deletion is operator-only. The Supabase connector cannot delete a
   > project** — it exposes `create_project`, `pause_project` and
   > `restore_project`, and no delete. An agent running this drill can create the
   > scratch project but never remove it, so step 8 always ends with a human in
   > the dashboard. Plan for that, or the drill quietly leaks a project every
   > time it runs.
   >
   > **And do NOT pause it as a substitute — it buys nothing and costs an hour.**
   > Measured 2026-08-06: **`PAUSING` took 66 minutes** (3,961 s) to reach
   > `INACTIVE`, and for that whole hour **both** the dashboard delete and
   > `restore_project` were refused —
   > *"no longer in a paused state, it is PAUSING, it may take a while"* — while
   > the project's REST endpoint kept answering 401. Neither gone nor
   > recoverable, for an hour, on an empty project.
   >
   > Once it finally reached `INACTIVE` the endpoint returned **540** and
   > `restore_project` succeeded immediately (`COMING_UP`). So the lock is
   > specific to the *transition*, not the paused state — but the transition is
   > long and there is no way to cancel it.
   >
   > **Leave the scratch project ACTIVE and delete it directly.** A paused
   > project is not a tidier project; it is a project nobody can act on for an
   > hour. Pause/restore state changes are also worth verifying rather than
   > trusting: the first `pause_project` call returned **503** and did not apply,
   > and a later `get_project` also 503'd — `list_projects` was the reliable read
   > throughout.
   >
   > **But do not assume ACTIVE guarantees you can delete either.** On the same
   > day, three dashboard deletes against an `ACTIVE_HEALTHY` project were
   > reported and **none applied** — nor did a rename. The project stayed alive
   > (`rest/v1/` → 401, against HTTP 000 / DNS failure for a nonexistent ref,
   > which is the control that proves it). Whatever that was, it was not the
   > pause. **Verify the deletion with `list_projects` plus a live endpoint probe;
   > a dashboard that says "deleted" is not evidence.**

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

Storage **files** were not copied. That gap is what exposed the false-pass
described in §5. It was closed the same day — **§4c**.

---

## 4c. DRILL RESULT, STORAGE HALF — executed 2026-08-05, and it PASSES

§4 steps 4 and 7, the half §4b left open. **The headline is the one thing no
previous drill had ever shown: the evidence bytes survive a restore and still
hash to what the event chain says they should.**

```
26/26 objects restored, every one SHA-256-identical to the backup
documents 9 / 272,984 B · signatures 2 / 29,893 B · media 15 / 452,342 B
media.public = true · documents + signatures unreadable to anon
```

| artefact | production event | expected SHA-256 | out of restored storage |
|---|---|---|---|
| `evidence-…870770.pdf` | 52 `pdf_sha256` | `fdb6fb3d…c661` | ✅ match |
| `evidence-…297008.pdf` | 53 `pdf_sha256` | `98a4d55e…cd30` | ✅ match |
| `evidence-…142710.pdf` | 54 `pdf_sha256` | `25e2963e…074c` | ✅ match |
| signed slip `.png` | 60 `sha256` | `b6668dec…a660` | ✅ match |

**Step 7, through the app's own code path:** `/reports` renders the chain badge
**OK**, lists all three restored reports, and *Download* → RLS-checked
`documents` read → signed URL → `200 application/pdf`, 22,639 bytes, header
`%PDF-1.3`, 25 objects, 1 page, `%%EOF` intact, SHA-256 exactly event 52's
`pdf_sha256`. **That is the end-to-end proof §5 asks for.**

### ⚠️ Read this before trusting the result: what the target actually was

The target was the **local Supabase stack**, not a fresh cloud project. Both
cloud routes were shut: a scratch project's schema restore needs the database
password (operator-held, and §3.1 forbids it entering a chat), and the CLI
storage path needs a persisted `supabase login`, which does not work here.

**Proven:** the backup files are complete and uncorrupted; the upload path
restores them byte-identically; buckets, visibility and access control come back
correct; the app serves a restored evidence PDF that still hashes to the chain.
**Not proven:** the same against Supabase's cloud S3 storage backend, at a scale
larger than 755 KB. The bytes-and-hashes result does not depend on the backend;
throughput and any S3-specific behaviour are still untested.

The app check also used three `documents` rows restored by hand — the local seed
has none — with `uploaded_by` remapped to the local admin profile, because the
database half was not re-restored locally (§4b already proved it). The storage
paths, ids, titles and timestamps are production's, unmodified.

**RTO is still unmeasured.** No stopwatch has been run, in either half.

### 1. Buckets are in no backup, and `media.public` is load-bearing

Nothing in `pg_dump.sql`, `data.sql` or the file export creates a bucket with the
right visibility. `media` must be `public = true` — that is migration 0008's
whole job, and a restored-but-private `media` serves broken images that look
exactly like a code fault. `restore-storage.mjs` now creates each bucket with the
correct flag and corrects it if it has drifted.

### 2. `storage.objects` IS in the dump. The bytes are not. Confirmed.

`data.sql` carries **26 `storage.objects` rows** — verified in the file. So a
database-only restore produces a project reporting a full set of signed slips and
evidence PDFs with **nothing behind them**, which is precisely why
`verify-restore.sql`'s file-existence checks reported `0 missing` against a
database with no files — a false pass found during this drill, on the two checks
that exist to protect commission evidence. They have since been renamed
**METADATA ONLY**, which is all they ever were. **§4c is the
byte-level proof; nothing else in the pack is.**

### 3. Content type must be set on upload, or evidence PDFs arrive unopenable

The Storage API defaults to `application/octet-stream`. An evidence PDF served
that way downloads as an opaque blob the browser will not open inline — on
screen, indistinguishable from a corrupted restore. The restore script sets it
per extension; the drill confirmed `application/pdf` and `image/png` come back.

### 4. Upload must `upsert` if the database was restored first

The restored `storage.objects` row already claims the key, so a plain upload
returns 409 *resource already exists* on **every single file**. Restore order is
therefore database → storage, with upsert — or storage first, then let the
database restore overwrite the metadata.

### Two smaller things worth knowing

- **The slip event hashes the PNG, not the PDF.** Event 60's `sha256` is the
  signature image. `viewing_slips.pdf_path` has **no recorded hash anywhere**, so
  a corrupted slip PDF is not detectable the way a corrupted report PDF is.
  Backlog, not a restore defect.
- **`data.sql` opens with `SET session_replication_role = replica;`** — line 1,
  emitted by the CLI. So §3.4's worst hazard is already handled by the dump, and
  §4b's `verify_events_chain = TRUE` was a real pass, not hashes recomputed by
  `trg_events_hash` on the way in. Worth knowing, because that distinction is
  otherwise invisible.

---

## 5. What "passed" means

The drill passes only if all of these hold on the restored project. Ticks below
record the 2026-08-05 runs (§4b database half, §4c storage half).

- [x] `show timezone` = `UTC` — §4b
- [x] every row count in §2 matches — §4b
- [x] `verify_events_chain` = `true` for every org — §4b
- [ ] the function-grant table in §2 reproduces **exactly** — this is the TEST-2
      check, and the one most likely to differ. **FAILED in §4b: `anon` regained
      EXECUTE on 11 of 13.** Re-apply 0007/0010/0019/0021/0022 (§3.1).
- [ ] `non_filename_versions` = 0 and **24** migration rows (19 when this list was
      written; re-check against `supabase/migrations/` rather than trusting this
      number — it moves with every migration). **FAILED in §4b: 0 rows dumped.**
- [ ] both cron jobs present and active — **FAILED in §4b: `pg_cron` absent, all
      three gone.**
- [x] storage object counts 9 / 2 / 15, and `media.public` = true — §4c
- [ ] the signed slip **PDF** for the smoke viewing downloads and opens — the PNG
      round-trips and matches event 60 (§4c); the PDF has no recorded hash to
      check it against, so this one cannot be fully closed as written
- [x] a stored evidence report downloads, and its SHA-256 still matches the
      `pdf_sha256` in its event payload — the end-to-end proof that the evidence
      chain survived. **§4c: all three match, and the third was pulled through
      the app's own download button, not a script.**
- [x] at least one login works — §4b (`auth.users` 2, restored from `data.sql`)
- [x] **every event hash is byte-identical to the source.** Added 2026-08-06 and
      it belongs at the top of this list — see below.

### `verify_events_chain = true` is NOT sufficient. Compare the hashes.

The chain function recomputes each hash from the row and checks it links to the
previous one. **If `trg_events_hash` fired during the load, every hash was
re-minted from the restored rows — and the chain then verifies perfectly against
values the restore itself invented.** True either way. It cannot tell restored
evidence from manufactured evidence, which is precisely the distinction a
commission claim rests on.

The check that can, and it is one query on each side:

```sql
select md5(string_agg(hash, ',' order by id)), count(*) from events;
```

Run it against the source and the restored database and compare. **2026-08-06:
`42cd4a8ba900245504b7d45bb3045ed6` over 73 rows on both** — so the 2026-08-06 set
restores the real chain, not a freshly minted one. What makes that possible is
`data.sql` line 1, `SET session_replication_role = replica;`, emitted by the CLI.

*(A benign error to expect while loading `data.sql`:
`permission denied for table spatial_ref_sys` — PostGIS's own system table, not
project data. One error, and it is not a failure.)*

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

| | As written 2026-07-24 | **Actual, 2026-08-05** |
|---|---|---|
| RPO | **Unbounded.** No reachable backup exists. A project-level loss is total. | **Hours as of the last capture** — a full `pg_dump.sql` + `data.sql` + `roles.sql` was taken 2026-08-04, Storage 2026-07-31 (still byte-current: production storage is unchanged, newest object 2026-07-23, re-confirmed 2026-08-05). But it is **manual and unscheduled**, so this drifts from the moment it is written. |
| RTO | **Unbounded.** Nothing to restore from, so nothing to time. | **Still unmeasured, but no longer unproven.** Both halves of the drill have now run and passed (§4b, §4c) — the restore *works*, including the evidence bytes. Nobody has held a stopwatch to it, so the 4h target below is still a guess, and §4b's four defects each add human time to it. |

**Proposed, after §3 is running** — now with the mechanical half measured rather
than guessed (§3.4):

| | Target | Why this number |
|---|---|---|
| **RPO** | **24 hours** | A nightly `db dump` + storage export. At current volume (~62 events in 12 days) a worst-case loss is a single day of activity. Cheap, and infinitely better than today. |
| **RTO** | **4 hours** | Kept, and now defensible rather than guessed — see §6b. The machine does ~4 minutes of the work; the other 3h 56m is provisioning, credentials and a human reading §5. **The target is dominated by people, and the way to improve it is to remove human steps, not to make the restore faster.** |

**When to revise:** the moment real client volume arrives, 24h stops being
acceptable for commission evidence — a lost day could contain the viewing slip a
claim rests on. At that point the answer is **Pro plan + PITR add-on**, which
takes RPO to ~2 minutes (WAL archived at 2-minute intervals). Pro is $25/mo;
7-day PITR is ~$100/mo on top. That is a business call about what the evidence
chain is worth, and it belongs to the operator, not to this document.

Note that **PITR still does not cover storage** (§1.2). The export in §3.2
remains necessary on every plan, forever.

---

## 6b. RTO — MEASURED 2026-08-05

A full restore was run end to end and timed phase by phase: fresh database →
extensions → roles → schema → data → verify → lockdown → migration history →
Storage. It ended with `verify_events_chain = TRUE`, `events` 73, `contacts` 2,
`properties` 2, `share_links` 2, `viewing_slips` 1, `auth.users` 2 — production
exactly.

| # | phase | measured (local) |
|---|---|---|
| A | create target database | 2,082 ms |
| B | extensions (postgis, pg_trgm, pgcrypto, uuid-ossp) | 3,643 ms |
| C | `roles.sql` | 736 ms |
| D | `pg_dump.sql` — schema, 219 KB, 1,457 statements | 4,816 ms |
| E | `data.sql` — 84 KB, 59 `COPY` blocks | 677 ms |
| F | verify chain + row counts | 519 ms |
| G | re-apply lockdown 0007/0010/0019/0021/0022 | 2,755 ms |
| H | re-seed `supabase_migrations` (24 rows, one statement) | 532 ms |
| I | Storage — 26 objects / 755 KB, incl. SHA-256 verify | 3,168 ms |
| | **total mechanical** | **≈ 19 s** |

**Do not quote 19 seconds as the RTO.** It is a local-socket number and it is the
smallest term in the problem. Three corrections, in increasing order of size:

**1. Network — the schema phase is ~20× slower over the wire.** psql waits a
round trip per statement. Measured TCP RTT from this machine to
`aws-0-eu-central-1.pooler.supabase.com`: **median 65.5 ms** (n=5, 61.7–87.1).
1,457 statements × 65.5 ms ≈ **95 s** for phase D alone, against 4.8 s locally.
`data.sql` barely moves — `COPY` streams, so it is 59 round trips, not 73 rows'
worth. Storage becomes 52 HTTPS round trips (26 up, 26 verify). **Realistic
over-the-wire mechanical total: ~2–2.5 minutes.** Derived, not measured.

**2. Vercel redeploy — 72 s, measured.** A restored project has new URL and keys,
so production must be rebuilt to pick them up (`NEXT_PUBLIC_*` is inlined at
build time — HANDOFF §7). Taken from `dpl_CmHhSe3W…`: `ready − buildingAt` =
**71.3 s**, plus 1.3 s queued.

**3. Provisioning — 48 s, measured 2026-08-06.** A throwaway project
(`gnk-crm-rto-drill`, eu-central-1) was created and polled. **Time from the
create call to PostgREST answering: 48.4 s.**

> **Do not trust the status field.** `create_project` returned
> `status: ACTIVE_HEALTHY` **immediately** — while the API was still 48 seconds
> from serving anything. Poll `https://<ref>.supabase.co/rest/v1/` until it
> returns 401 instead; that is the first moment the project is real.

**4. Everything else, and it is the actual RTO.** Unmeasured, and each of these
is minutes-to-tens-of-minutes with a human in the loop:

- **The database password.** Supabase states it "isn't viewable after creation".
  If it is not already in the password manager, the first step of the recovery is
  a password *reset* — more steps, under pressure.
- **Re-pointing three Vercel env vars by hand,** in the right environment.
  Getting that wrong cost six deployments on 2026-08-03 and looked like a build
  failure (HANDOFF §7).
- **Re-scheduling the three cron jobs** (§4b.4). `pg_cron` itself is fine — see
  below, it installs on the free plan in 105 ms — but the jobs must be recreated.
- **Working through §5 as a human**, plus deciding to restore at all.

**Machine time, all in: ~4.5 minutes.**

| term | |
|---|---|
| provision the project | **48 s** measured |
| mechanical restore over the wire | ~2–2.5 min derived (19 s measured local + RTT) |
| Vercel rebuild | **72 s** measured |

**A 4-hour target that is ~98% people.** That ratio is the finding. Shaving the
mechanical path is pointless; the levers that would actually move RTO are having
the password already to hand, scripting the Vercel env swap, and writing the
provisioning step down so nobody improvises it.

### What a FRESH cloud project actually looks like — measured 2026-08-06

Facts §3.1 and §4 had been asserting without ever checking, now checked on a real
new project:

| | |
|---|---|
| `TimeZone` | **`UTC` by default** — §1.3's requirement is met without action, but still verify it |
| Postgres | 17.6 — **but `17.6.1.155` against production's `17.6.1.141`.** A restored project is not necessarily on the source's patch version |
| already installed | `pgcrypto` 1.3, `uuid-ossp` 1.1, `pg_stat_statements`, `plpgsql`, `supabase_vault` |
| **NOT installed** | **`postgis`, `pg_trgm`, `pg_cron`** — available, but off. Exactly the §4b.1 / §4b.4 defects, from the other direction |

Enabling all of them took **1.5 s total** on cloud (postgis 1,222 ms · pg_trgm
198 ms · pgcrypto 8 ms · uuid-ossp 5 ms · **pg_cron 105 ms**) — *faster* than the
3.6 s measured locally, and `pg_cron` installs fine on the Free plan, so §4b.4's
remedy is executable.

### §4b.3's root cause, isolated and proven

The one thing a local target cannot show. On the fresh cloud project, before any
restore:

```sql
create function public._grant_probe() returns int language sql security definer …
create table public._grant_probe_tbl(id int);
```

| new object | `anon` | `authenticated` |
|---|---|---|
| `security definer` function | **EXECUTE ✓** | EXECUTE ✓ |
| table | **SELECT ✓** | SELECT ✓ |

**That is the whole mechanism.** Nothing in the dump grants `anon` anything — the
platform's default privileges do it to every new object, which is why a restored
project comes back with `anon` holding EXECUTE on 11 of 13 functions (§4b.3) and
why the lockdown migrations must be re-applied. It is also the first direct proof
of HANDOFF §4.2 and §4.3, which had been inferred from migration behaviour rather
than demonstrated.

### What this run could not test

The *restore* target was a scratch database in the **local** cluster, for the same
credential reasons as §4c — only the provisioning and fresh-project measurements
above ran on cloud. Two consequences, both making the local restore timing
*optimistic*:

- **Network is absent**, hence correction 1 above.
- **The §4b.3 grant defect cannot reproduce locally.** After restore, `anon` held
  EXECUTE on only the 4 deliberate exceptions (`resolve_share_link`,
  `note_share_link_miss`, `protect_property_reference`, `set_updated_at`) — *not*
  the 11-of-13 §4b saw on cloud. That is HANDOFF §4.2 ("hosted grants to `anon`
  by default; local does not"), visible in this run as 6
  `permission denied to change default privileges` errors, and now proven
  directly by the grant probe above. **§4b remains the authority on grants; the
  local restore says nothing about them.**

**Loading production data into a cloud project is still not reachable from here**
— `data.sql` is `COPY … FROM stdin`, which needs psql, which needs the database
password. The drill project therefore received the probes above and nothing else;
no production data ever left this machine.

The schema restore otherwise reproduced §4b exactly: **71 errors**, all of them
`must be able to SET ROLE` (65) plus those 6 — i.e. entirely the §4b.2 auth/storage
ownership defect, with the extensions enabled first as §3.1 now instructs.

---

## 7. Recommended sequence

1. ~~Take one manual backup today (§3).~~ **DONE 2026-07-30, extended 2026-08-04.**
2. ~~`supabase db dump`, re-taken with the correct flag.~~ **CLOSED 2026-08-06** —
   `2026-08-06/pg_dump.sql` is a real `--schema public` dump, restore-verified
   under `ON_ERROR_STOP=1` with object counts matching production (§3.1).
   **`2026-08-06/` is now the schema of record.**

   **`data.sql` and `roles.sql` were taken the same day**, so `2026-08-06/` is a
   **complete, restore-verified set** — the first one that is both complete and
   correctly flagged. Its README records the full verification; the headline is
   that all 73 event hashes come back byte-identical to production, not merely
   `verify_events_chain = true` (§5).
3. Get it off-site (§3.3). Since 2026-08-07 `../gnk-backups/` is on `D:` — one
   machine, no cloud copy at all.
4. ~~Run the drill (§4) and fill in the real timings.~~ **DONE 2026-08-05** —
   §4b (database), §4c (Storage + app check), **§6b (timed: ~19 s local, ~2–2.5
   min over the wire, +72 s Vercel redeploy)**. What remains untimed is
   **Supabase project provisioning** and the human steps, which are the bulk of
   the 4h target. Both drill targets were local, for credential reasons.
5. Decide Free-plus-nightly-dump versus Pro-plus-PITR (§6) with the volume you
   actually expect in Phase 2.

**What is left is items 3 and 5.** The restore path is proven end to end —
schema, rows, the event chain, logging in, and the evidence bytes still hashing
to their generation events — the schema dump is correct and verified, and RTO is
measured. The open items are **getting a copy off this machine** and **the
operator's plan decision**, plus refreshing `data.sql`/`roles.sql` into the
current folder. **None of them is "does it work" any more.**
