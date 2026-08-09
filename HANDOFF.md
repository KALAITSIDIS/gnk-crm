# HANDOFF — 2026-08-08

Read `docs/HANDOVER.md` and `CLAUDE.md` first; this is the delta on top of them.
**History lives in `docs/DECISIONS.md` and git — this file is state, traps and
what to do next. Keep it short; move narrative out rather than growing it.**

**Code- and framework-level gotchas live in `docs/ENGINEERING_NOTES.md`** — the
two bugs that only exist in production, Radix/dnd-kit/next-intl traps, testing
discipline and local-stack recovery. §7 below covers *operational* traps
(Vercel, Supabase, the machine); that file covers the codebase.

| | |
|---|---|
| `main` | clean, in sync with `origin/main`, only branch (SHA: `git log --oneline -1` — deliberately not pinned here, it went stale on every commit) |
| CI | ✅ green — `checks` (typecheck · lint · unit · **build**) + `rls` |
| Production | `gnk-crm.vercel.app` healthy; **auto-deploys every push**. **A cache-restored build can keep an OLD `NEXT_PUBLIC_*` value compiled in — see §2b, it caused a login outage on 2026-08-09.** |
| Hosted DB | `yjgirvzgoiywdojnpkpd` — **27 migrations**, `non_filename_versions` = 0, chain verifies, **73 events** |
| Data | `share_links` 2 (1 live, 1 revoked) · `tasks` 0 · `deals` 1 · **all of it operator test data** (§0) |
| Tests | **468 unit** · **31 RLS** · **173 desktop E2E** (4 skipped) — all three run in CI |
| Cron | `expire-mandates 03:00` · `followup-nudges 03:15` · `verify-events-chain 03:30` |
| Backups | ✅ **`2026-08-08` is the primary** — newest automated set, `verified:true` (55 files, 73 events matching production), taken after the move and so the first written to `D:\dev\TSOPOZIDIS\gnk-backups`. `2026-08-07` is the other verified set; `2026-08-06` is the restore-*proven* one (all 73 event hashes byte-identical to production). Sets: 07-30 · 07-31 (Storage) · 08-04 (superseded) · 08-06 · 08-07 · **08-08**. Nightly at 03:45 (§2; drills §4b/§4c). **All of it is single-machine now — §3.3** |

---

## 0. START HERE

> **READ FIRST (2026-08-09). Two corrections to the confidence below.**
>
> 1. **Production had a login outage** — the disabled legacy anon key survived
>    the 08-03 rotation inside a **cache-restored build**. Fixed by setting the
>    publishable key and redeploying with build cache OFF. **§2b**.
> 2. **DO NOT enforce the CSP.** Production reports show the served HTML carries
>    **zero nonces** while the header mints one per request, because pages are
>    edge-cached; with `'strict-dynamic'` that blocks **100% of the JavaScript**.
>    Local sweeps cannot see this. **IMPROVEMENTS C1.**
>
> The sentence below said production was healthy on keys, and it was believed
> over a production error log that disagreed. Treat every "verified" claim here
> as needing a date and a re-check.

**Nothing is broken, nothing is half-finished, and there is no outstanding
security item.** Both long-standing operator items are closed: the exposed
`service_role` key is revoked (§2b) and Sentry is wired and confirmed receiving,
so C1's report-only CSP finally has a durable sink.

**C6 IS CLOSED — the restore drill ran 2026-08-05, BOTH HALVES, and PASSES.** A
throwaway project was restored from the 2026-08-04 dumps: `verify_events_chain =
true`, every row count matching production, 86/86 RLS policies, `auth.users`
back. Then the Storage half (BACKUP_RESTORE **§4c**): all **26 objects restored
byte-identical**, and **the three evidence PDFs and the signed slip PNG still
hash to the `pdf_sha256`/`sha256` in their generation events** — one of them
pulled through the app's own Download button, with the chain badge reading OK.
**The backup restores, and the evidence survives it as evidence, not just as
rows.** Scratch project deleted; local `drilltest` DB dropped; the local stack
was used as the §4c target and has been returned to its pre-drill state.

**§3.1 has been corrected to match** (2026-08-05) — it previously told the reader
to run the exact commands the drill proved do not work. **Note what that
correction exposed: `2026-08-04/pg_dump.sql` was itself taken with the wrong
`--schema` flag.** `ALTER SCHEMA "auth" OWNER TO "supabase_admin"` is on line 19
of the file and `CREATE EXTENSION` appears zero times, so the primary schema
backup carries the defect, not just the doc.

**RESOLVED 2026-08-06 — `../gnk-backups/2026-08-06/pg_dump.sql` is a correct
`--schema public` dump and is now the SCHEMA OF RECORD.** Verified rather than
assumed: zero `supabase_admin` mentions, `ON_ERROR_STOP=1` restore exit 0 with 0
errors, and object counts identical to production on all eight dimensions
(30 tables · 3 views · 86 policies · 22 functions · 13 triggers · 62 indexes ·
25 enums · 86 FKs). **BACKUP_RESTORE §7 step 2 is closed.**

**`data.sql` and `roles.sql` were taken the same day, so `2026-08-06/` is a
COMPLETE, RESTORE-VERIFIED SET** — the first that is both. Loaded end to end into
a scratch database: schema `ON_ERROR_STOP=1` exit 0, `data.sql` clean bar a benign
`spatial_ref_sys` permission error (PostGIS's own table), `verify_events_chain`
**true**, every row count and the latest-event timestamp matching production.

**And the check that actually matters: all 73 event hashes are byte-identical to
production** — `md5(string_agg(hash))` = `42cd4a8ba900245504b7d45bb3045ed6` on
both sides. `verify_events_chain = true` alone could never show that: if
`trg_events_hash` had fired during the load it would re-mint every hash and the
chain would verify against invented values. **Comparing hashes to the source is
now a §5 checklist item**, and it is the one that separates restored evidence
from manufactured evidence.

**Three traps hit getting there, all worth keeping:**

1. **`password authentication failed for user "postgres"` does NOT mean the
   username is wrong.** The pooler reports the bare role whatever you send —
   proven 2026-08-06 with a connection whose username was definitively
   `postgres.yjgirvzgoiywdojnpkpd`. An earlier version of this file claimed that
   message diagnosed a bare-`postgres` username; **it was wrong and cost most of
   an evening.** Read it as "auth failed, cause unstated" — in practice the
   password (account password instead of the project's, an unencoded special
   character, or an unreplaced placeholder). Do still use the **session pooler**
   string: the username really does need the ref, and the direct host is
   IPv6-only. Just don't diagnose from the message.
2. A failed `db dump` **leaves a 0-byte file** at the `-f` path — an empty
   `pg_dump.sql` among real backups reads as a backup. One was found and removed.
3. `-f` **does not create the directory**; it fails as an alarming-looking
   `NotFound: FileSystem.writeFile`.

**The stopgap turned out to be exactly right, which is worth knowing for next
time.** `scripts/backup/split-dump-by-schema.py` recovered a public-only schema
from the *bad* dump before the password worked, and once the real dump arrived
the two compared **statement-for-statement identical** — 581 each, zero
differences either way. So if a future incident has an unusable dump and no
reachable password, that script gets a correct schema out of it.

**Four defects, written up with fixes in BACKUP_RESTORE §4b**, every one of which
would bite during a real recovery:

1. **No `CREATE EXTENSION` in the dump.** Enable `postgis`, `pg_trgm`,
   `pgcrypto`, `uuid-ossp` on the target FIRST, or the schema cascades into 57
   errors (`geography` type missing → `properties` → 42 dependents).
2. **`--schema public,auth,storage` is wrong for the SCHEMA dump.** Those are
   `supabase_admin`-owned; fatal at line 19 under `ON_ERROR_STOP=1`. Schema =
   `--schema public` only. The DATA dump keeps all three — that is how
   `auth.users` comes back.
3. **Function grants do NOT survive — `anon` gains EXECUTE on 11 of 13.** A
   restored project is **less secure than its source** until 0007 / 0010 / 0019 /
   0021 / 0022 are re-applied. §5 predicted this was the likeliest to differ.
4. **`pg_cron` absent → all three crons silently gone**, and
   `supabase_migrations` is not dumped (0 rows), so a later `db push` would
   re-run all 25 migrations.

**A false pass in our own `verify-restore.sql` was also found and fixed.** Its
three "every slip/report file exists" checks query `storage.objects` — which
`data.sql` restores — so they reported `0 missing` against a database with **no
files at all**, on the two checks that exist to protect commission evidence.
Renamed **METADATA ONLY**. Now confirmed at the file level: `data.sql` carries
**26 `storage.objects` rows**. Green there is not evidence; §4c is.

**`scripts/backup/restore-storage.mjs` is new** — there was no storage restore
path at all before it, in any tool. §3.2's `supabase storage cp -r` commands had
**never been run in either direction** (the 2026-07-31 export was `export.mjs`),
and the CLI needs a persisted login that does not work here. The script uploads
with the right content type, `upsert`s (a database restore has already claimed
every key — otherwise 409 on all 26), creates buckets with the correct `public`
flag, and re-downloads everything to compare SHA-256 so a partial restore cannot
report success.

**RTO IS NOW MEASURED — BACKUP_RESTORE §6b.** A full restore was timed phase by
phase: **~19 s of mechanical work** locally (create DB · extensions · roles ·
schema · data · verify · lockdown · migration history · 26 Storage objects),
ending at `verify_events_chain = TRUE` with every count matching production.
**Do not quote 19 s.** Corrected for a 65.5 ms median RTT to the eu-central-1
pooler — psql waits a round trip per statement and the schema dump is 1,457 of
them — it is **~2–2.5 min over the wire**. Add **48 s** to provision a project
(measured 2026-08-06 on a real throwaway) and a **measured 72 s** Vercel rebuild:
**~4.5 minutes of machine, inside a 4-hour target.** That ratio is the finding.
Shaving the restore is pointless; the levers are the password being to hand,
scripting the Vercel env swap, and not improvising the provisioning step. Still
untimed: every human step.

**Three things the cloud run nailed down that had only ever been asserted:**
`create_project` reports `ACTIVE_HEALTHY` **48 seconds before the API serves
anything** — poll `/rest/v1/` for a 401, never trust the status field. A fresh
project has `pgcrypto` and `uuid-ossp` but **not** `postgis`, `pg_trgm` or
`pg_cron` (all three install fine, `pg_cron` included, in 1.5 s total on Free).
And **§4b.3's root cause is now proven in isolation**: on a fresh project a new
`security definer` function is `anon`-EXECUTE and a new table is `anon`-SELECT
**by default** — the platform does it, not the dump. First direct proof of §4.2
and §4.3 below.

**Both drill targets were local, and that is a real limit.** §4c and §6b both ran
against the local stack because the cloud routes need credentials the operator
holds (the DB password, and a CLI login that does not persist). Bytes, hashes,
buckets, the app path and the mechanical timings are proven; **cloud S3
behaviour, network cost and the §4b.3 grant defect are not reproducible locally**
— §6b shows `anon` correctly restricted there, which is HANDOFF §4.2, not a
contradiction of §4b. **§4b stays the authority on grants.**

**EVERY ROW IN PRODUCTION IS OPERATOR-CREATED TEST DATA. There is no live client
data yet** (operator-confirmed 2026-08-04). Contacts, properties and the
`MARIOS ANDREOU` deal were all made for testing.

> **Never infer usage from row counts.** On 2026-08-04 an agent saw a
> real-looking deal with a real agent assigned and "corrected" this file to say
> the desk had started using the system. It had not. Counts tell you what
> exists, never who created it or why. Ask, or read `events.actor_id` and the
> payloads.

What follows from it: destructive testing on hosted is cheaper than it looks —
no client PII is at risk *today*, though that changes the moment real work is
entered. And §2b's exposed key reached a test dataset, not live KYC documents;
revoking was still right, but calibrate the severity honestly.

**B3 and B7 are proven end to end in production** (2026-08-04): share link
minted → opened → revoked → re-minted, and lead → deal → `deal_no_contact`
nudge → superseded-on-contact, with correct actor attribution throughout
(system for the cron, the user for the trigger supersede) and the chain
verifying at every step. Seed rows were deleted afterwards; their events remain,
which is correct.

**Do not start B4 or B5** — both need an operator decision (§5). **B9 is closed,
not deferred.**

**What next is still usage, not code:** a real proposal link sent to a real
buyer, and the PWA on a phone. Decision-free engineering work is bug-shaped and
lives in `docs/BACKLOG.md`, not IMPROVEMENTS.

First checks in a new session — all read-only:

```bash
cd "D:/dev/TSOPOZIDIS/gnk-crm" && git log --oneline -3 && git status -sb
```

Then via the Supabase connector (`execute_sql`): migrations = 25,
`non_filename_versions` = 0, chain verifies, `events` = 73, `share_links` = 2,
`tasks` = 0.

**Two snippet corrections that read like real failures:**
`verify_events_chain` takes an argument — `verify_events_chain(p_org uuid)`;
calling it bare raises `42883 function does not exist`, which looks like a
missing migration. And `non_filename_versions` must test
`version !~ '^[0-9]{4}$'` (versions are `0001`…`0024`); the 14-digit timestamp
shape flags every row.

---

## 1. Shipped

Full write-ups in `docs/DECISIONS.md`; migrations in `supabase/migrations/`.

**2026-08-07** — 0025 `T-deal-contact` — **applied to hosted the same day via §3
and verified** (column present, 0 unbackfilled, 25 migration rows,
`non_filename_versions` 0, trigger `WHEN` reads `last_contact_at`,
`anon` cannot execute the job, `service_role` can, chain verifies, events 73).
`get_advisors` clean — no new finding; neither `create_followup_nudges` nor
`trg_supersede_deal_nudges` appears in the anon/authenticated lists.

> **The migration went out AFTER the code, and for a few minutes production ran
> code referencing a column that did not exist.** Pushing is enough to deploy
> (Vercel auto-deploys `main`) but it is NOT enough to migrate — hosted only
> changes when someone runs §3. `logConversation` on a converted lead would have
> failed in that window. **Apply the migration to hosted BEFORE pushing code that
> depends on it**, or accept a deliberate gap and say so.

The bug: the `deal_no_contact` nudge could be silenced by a typo. It keyed off `last_activity_at`, which every deal edit
stamps, so renaming a deal **closed the open chase-up** and logged
`reason: deal_contacted_or_closed` against the editing user — the log asserted
contact nobody had claimed. Silence now has its own column, `last_contact_at`,
written only by the new `logDealContact` action and by `logConversation` on a
converted lead. **The trigger's `WHEN` clause had to move with the predicate**;
the function alone would have been correct while the feature stayed broken, and
RLS test 27's second half is what caught it.

**2026-08-02/04** — 0024 `T-nudge-active-assignee` (system tasks never land on a
deactivated profile; every fallback arm active-only, nightly re-home sweep, RLS
test 26) · `T-csp-fixture` (the CSP detail tests seed their own rows instead of
depending on residue) · `T-sb-key-guard` (the client-bundle leak test would have
gone blind at key rotation) · `T-csp-413` (production was collecting CSP reports
and discarding them at 413) · `T-key-rotation` (§2b) · `T-sentry-dsn` (C1's
sink) · CI now builds on every push.

**2026-07-29/31** — B7 follow-up nudges (0020) · 0021 revoke on nudge triggers ·
0022 drop undocumented `service_role` grants · B3 buyer proposal links (0023) ·
B8 installable PWA · backup tooling (`scripts/backup/export-events.sql`).

---

## 2. Backups

Three sets in `../gnk-backups/` (outside the repo, untracked). **`2026-08-04` is
the primary — it is a real `pg_dump` and it has been restore-tested (§0).**

| set | contents |
|---|---|
| `2026-07-30/` | `events.sql` ids 1–62 (**chain-faithful**), `business-data.json` (15 tables), auth + storage manifest, restore guide |
| `2026-07-31/` | `export.mjs` output: **all 26 Storage files** + every table as JSON |
| `2026-08-04/` | superseded — its `pg_dump.sql` carries the wrong-`--schema` defect. Keep for the hand-rolled deltas (an independent second copy of `events`) and as the artefact that exposed it |
| `2026-08-06/` | **the restore-PROVEN set** — `pg_dump.sql` (`--schema public`, correct), `data.sql` (**`auth.users` 2**, `events` 73), `roles.sql`. Loaded end to end with all 73 hashes matching production; README has the evidence. No Storage of its own |
| `2026-08-07/` | **PRIMARY — first automated set, and the only COMPLETE one.** Schema · data · roles · **26 Storage objects** · table JSON · `SHA256SUMS` · `manifest.json` (`verified:true`, `problems:[]`, events 73 = live). Produced and self-verified by `capture.mjs` |

**The older sets stay valid as prefixes, and that is sound, not a shortcut.**
`events` has no UPDATE/DELETE grant, so an older export remains a valid prefix of
production forever — verified, not assumed: production's first 62 rows still hash
to the md5 in the 2026-07-30 header. Storage has not been re-copied since
2026-07-31 because the newest object anywhere still dates from 2026-07-23
(re-confirmed 2026-08-06).

**Verifying an export on disk has an md5 trap** — the header hash is over
LF-joined insert lines with no trailing newline, and OneDrive stores the file
CRLF, so the naive `grep | md5sum` makes an intact backup look corrupt. Correct
command in BACKUP_RESTORE §5.

**Keep both.** `export.mjs`'s `events` copy is NOT chain-faithful — PostgREST
hands `jsonb` to JavaScript and numeric scale is lost, so `verify_events_chain`
fails on restore. `2026-07-31` has the FILES; `2026-07-30/events.sql` has the
events that actually restore.

~~**Still to do: `supabase db dump` for a true pg_dump.**~~ **DONE** — and
re-taken correctly 2026-08-06. pg_dump is primary; the hand-rolled exports above
are the independent second copy, not the safety net of last resort they once were.

**CAPTURE IS AUTOMATED AND LIVE. First green run 2026-08-07** — `2026-08-07/`,
55 files / 1,010 KB: schema 125,258 · data 84,661 with **73 events matching
production live** · roles · **26 Storage objects** · `verified: true,
problems: []`. The scheduled task also fired unattended at 03:45:02 that morning
and exited `2` with a clear reason while the config was still incomplete, so both
the happy and the unhappy path are proven in the wild.

`scripts/backup/capture.mjs` takes a complete set in one command
and **verifies its own output**, refusing to call it a backup otherwise: zero
`supabase_admin` in the schema file, `session_replication_role = replica` on line
1 of `data.sql`, the `auth.users`/`events`/`storage.objects` COPY blocks present,
and **events-in-the-dump compared against events-live-right-now** (a truncated
dump does not error). Exit `0` verified · `1` produced but untrustworthy · `2`
refused to start. Failures also land in `manifest.json` as `verified:false`.

A scheduled task **"gnk-crm nightly backup"** runs it daily at 03:45 (after the
03:30 chain-check cron) with `--keep 14`. **It exits 2 every night until
`C:\Users\user\.gnk-crm\backup.env` is created** from the `.example` beside it —
that is the operator action (§2c). That directory is outside the repo on purpose
— a password must never land in git, and back when the workspace was under
OneDrive it would also have synced to the cloud. It **stayed on `C:`** during the
2026-08-07 move; only `REPO`/`DEST` inside `run-backup.cmd` were repointed to
`D:\dev\TSOPOZIDIS`. The task is "Interactive only", so a machine that is off or
logged out at 03:45 takes no backup silently — the log is
`C:\Users\user\.gnk-crm\backup.log`.

**Still open, and now worse: getting a copy OFF THIS MACHINE.** `../gnk-backups/`
used to be under OneDrive — sync rather than backup, but it did put a copy in the
cloud. Since 2026-08-07 it is on `D:`, a second volume in the same box. Every
backup set is now single-machine; automation does not change that.

**A verified archive is staged and waiting for a destination:**
`TSOPOZIDIS/gnk-backups-offsite-2026-08-07.tar.gz` — **2.0 MB, 141 files**, all
six sets including the first automated one, `sha256 b689df4f…0b50` (in the
adjacent `.sha256`). Verified twice: 141/141 byte-identical after extraction, and
`sha256sum -c SHA256SUMS` passing 55/55 inside the extracted `2026-08-07` set.
It is the only archive — the earlier `2026-08-06` one was deleted after checking
it was a strict subset, so there is no chance of moving the wrong file.

**Moving it is operator-only** — no off-machine destination is agent-reachable,
and it must not become one casually: it carries `auth.users` bcrypt hashes plus
the signed slips and evidence PDFs, and **`gnk-crm` is a PUBLIC repo**, so the
archive must never land in it. Verify with `sha256sum -c` **at the destination**,
not here. §3.3.

**Trap:** `export.mjs` reads `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` from
the SHELL and loads no `.env`. With nothing set it silently falls back to
`NEXT_PUBLIC_SUPABASE_URL` — **your local stack** — and backs up the wrong
database. Always check `manifest.json`'s `source`.

`scripts/backup/verify-restore.sql` is the 47-check invariant pack; it passed
against hosted on 2026-08-02 after 0024. Re-capture its baseline before a drill.

---

## 2b. Key rotation — **RESOLVED 2026-08-03**

The exposed legacy `service_role` key is **dead**. Supabase disabled the legacy
JWT pair at `2026-08-03T17:40:12Z`; a REST call with it returns
`401 Legacy API keys are disabled` and the hint names `(anon, service_role)`
explicitly. Production runs on `sb_publishable_…` / `sb_secret_…` and is healthy.

> ### ⚠ THAT LAST SENTENCE WAS WRONG, AND IT CAUSED A ~6-DAY OUTAGE (2026-08-09)
>
> **Nobody could sign in to production.** 38 requests to `/login`, **zero** to
> `/dashboard`, for hours. The cause was the thing this section declares fixed:
> production was still running the **disabled legacy anon key**, so every auth
> call returned `401 Legacy API keys are disabled`, `getUser()` saw no user, and
> every navigation bounced back to `/login`.
>
> **How it survived the rotation:** `NEXT_PUBLIC_*` is **inlined at build time**
> (see the note in `proxy.ts`), and the production build log said
> `Restored build cache from previous deployment`. A cached build keeps the OLD
> value compiled in no matter what the Vercel variable now says. The fix was to
> set the publishable key and **redeploy with build cache OFF** — a plain
> redeploy is not enough.
>
> **Two things made it expensive, both worth more than the fix:**
>
> 1. **`login()` mapped every failure to "Invalid email or password."** A total
>    auth outage was indistinguishable from a forgotten password, so it was read
>    as one. Fixed 2026-08-09: credential rejections stay vague (no account
>    oracle), everything else says "temporarily unavailable — this is not your
>    password" and goes to **Sentry**, because Vercel keeps ~1h of runtime logs
>    and nobody reports a login problem that fast. `lib/services/auth-errors.ts`.
> 2. **This paragraph was believed over the evidence.** A production
>    `AuthApiError: Legacy API keys are disabled` on `/middleware` was visible in
>    the error log on 2026-08-07 and was dismissed as a stale browser session
>    *because this file said production was healthy*. **A "verified" claim with
>    no date and no re-check is a liability.** Verify keys against the running
>    deployment, not against this sentence.
>
> **BOTH keys were stale, not one — and the guard is what found the second.**
> Fixing `NEXT_PUBLIC_SUPABASE_ANON_KEY` restored sign-in, which made the outage
> look over. It was not: `SUPABASE_SERVICE_ROLE_KEY` still held the legacy JWT,
> so everything running as service-role was silently broken — slip downloads,
> evidence reports, document and photo upload/download, media renditions,
> branding, admin invites, contact merge, GDPR erasure, and the new viewing
> confirmation. None of it errors visibly on a page you would happen to open.
>
> `lib/supabase/key-health.ts` (shipped the same day) named it on the first
> render of `/settings/organization`:
>
> ```
> 09:24  GET /settings/organization  200 [error]  [supabase-key] SUPABASE_SERVICE_ROLE_KEY holds a LEGACY JWT Supabase key…
> 09:35  GET /settings/organization  200 [info]   (silent — fixed)
> ```
>
> **The guard checks SHAPE, so silence is necessary but not sufficient** — a
> well-formed but wrong secret would also pass it. Verified by exercising a real
> service-role call instead: "Download slip (PDF)" on viewing
> `85fe47a1-…` produced a working signed Storage URL and served the PDF. That is
> the check to repeat after any future key change.
>
> Confirmed recovered: `/dashboard` and every module route serving normally.

Nine earlier attempts silently failed. **What worked: never touching the
Redeploy button.** Git pushes deploy reliably, so the env change was picked up
by pushing a commit and the deployment verified through the Vercel connector.

**If this is ever repeated, the order is not negotiable:** save env → **deploy**
→ **verify both keys in production** → *only then* disable the old pair. Vercel
injects env vars at deploy time, so before the redeploy the running app still
authenticates with the OLD keys. Everything before the toggle is reversible; the
toggle is not. Full account in DECISIONS `T-key-rotation`.

---

## 2c. Operator-only items

**Leaked-password protection is off, and it is NOT a free toggle.** It is gated
to **Supabase Pro** on this plan — a spend decision, not a click (established
2026-08-04; earlier handoffs implied otherwise and were wrong). Until the plan
changes, the advisor finding `auth_leaked_password_protection` is **accepted,
not unnoticed**. Not agent-reachable either: the connector has no auth-config
tool and the setting is platform config, not database state.

**`GNK-PAF-0002`** still wants archiving **via the UI button** so
`archiveProperty` writes its event.

~~CREATE `C:\Users\user\.gnk-crm\backup.env`.~~ **DONE 2026-08-07.** The nightly
backup is live and its first full run is green — see §2 for the result. If it
ever needs re-doing, use
`powershell -ExecutionPolicy Bypass -File C:\Users\user\.gnk-crm\set-credentials-clipboard.ps1`,
which reads both values from the clipboard, validates them and tests the key
before writing. **Do not hand-edit `backup.env`** — three attempts to do so never
reached disk.

**DELETE THE DRILL PROJECT `gnk-crm-rto-drill` (`qxkpoqxiudkrctlvrvwg`) —
DEFERRED 2026-08-06, and it does not delete.** Created that day to time
provisioning (§6b). It holds **no production data** (a probe function and an
empty table), so the cost is one free-plan project slot, not an exposure.
Production is untouched and healthy. **Deliberately parked by the operator — not
forgotten.**

**Three dashboard deletes were reported and none applied.** State when parked:
`ACTIVE_HEALTHY`, `rest/v1/` answering 401. Confirmed against a negative control
— a nonexistent ref gives HTTP 000 / DNS failure, this gives 401 exactly like
production — so it is genuinely alive and the listing is **not** stale.

**Working diagnosis: management-API writes from the operator's browser silently
no-op.** A rename also reported success and also did not persist — the listing
still shows the original name. Untried when parked: a clean incognito session,
and the Network tab (`DELETE api.supabase.com/v1/projects/<ref>` — does it fire,
does it error). If both fail it is Supabase-side and wants a support ticket.

**Do not read this as "pausing broke it" — that was the first conclusion here and
it was wrong.** Pausing genuinely blocks both delete and restore *during* the
`PAUSING` transition (66 minutes, §4 step 8), but the deletes failed just as
completely from `ACTIVE_HEALTHY` afterwards, so the pause is not the cause. What
remains true: the connector has **no delete tool** (create/pause/restore only),
so this drill leaks a project unless a human removes it. BACKUP_RESTORE §4 step 8.

---

## 3. How to apply a migration

`.claude/settings.local.json` must contain the entry that unblocks
`execute_sql` writes:

```json
"mcp__728f3c26-074c-4f63-839e-0d81840c3291__execute_sql"
```

**The operator must add it** — an agent editing its own permission file is
blocked, correctly. It permits *any* SQL through that tool in this directory;
remove the line to restore the block. Kept deliberately (§5).

With it present: apply in **separate `execute_sql` calls** (schema → functions →
triggers → cron → the `schema_migrations` insert), **verify in a further
separate call**, then diff each function body against local — `md5(prosrc)` on
both sides is exact and beats eyeballing. Then **run `get_advisors`**; skipping
it is what caused 0021.

`create or replace function` **preserves the existing ACL** — it does not reset
grants. Re-read `proacl` afterwards anyway.

Two SQL-editor traps: the dashboard editor can discard DDL while a `select` in
the *same run* still sees it (verify in a second, separate run), and it wraps a
multi-statement script in one transaction, so a failure on the trailing insert
rolls back everything before it.

---

## 4. Patterns that bit repeatedly — check these on any new object

**A new object does not inherit the treatment an earlier migration applied.**

1. **RLS policies do not imply table GRANTs.** 0002 grants each table to
   `authenticated` one by one; a later table inherits nothing. Symptom:
   `permission denied for table …` with correct policies.
2. **Hosted grants new tables to `anon`/`authenticated` by default; local does
   not.** A migration that only GRANTs produces two different databases. Always
   `revoke all … from anon, authenticated` first, then grant back precisely.
3. **New `security definer` functions are anon-executable by default.** 0007
   locked this down; anything added since must repeat it — or be a deliberate
   exception pinned in `verify-restore.sql`, as `resolve_share_link` is.

**And on tests — four ways a green test proved nothing:**

- **A self-healing step can hide the bug it heals.** 0024's step 5 re-homes
  stranded tasks in the *same* invocation that mints them, so asserting on the
  final `tasks.assignee_id` passed even with the buggy arms restored. Where a
  job both creates and repairs in one pass, **assert on the creation event, not
  the row**.
- **A guard keyed to a credential's CONTENT dies when the format changes.**
  `security.spec.ts` asserted `not.toContain("service_role")`; a modern
  `sb_secret_…` key contains no such string, so the rotation would have left it
  passing and blind. When a credential format changes, re-check every guard that
  matches on its content.
- **A test can depend on the *absence* of residue.** RLS test 24 pinned the
  orphan-deal fallback to a specific admin; the fixture org accumulates admins
  across local reruns, so it passed only on a fresh DB — and CI always starts
  fresh, which is how such a test hides.
- **Playwright's `request` fixture is authenticated.** It reported 200 for
  `/manifest.webmanifest` while real browsers got a 307 to `/login`. Test public
  surfaces with an anonymous context.

**The meta-lesson from 2026-08-02/04: every defect found was in something
already marked done.** Auditing "verified" claims beat building new surface. But
the mirror error is just as easy — see the row-counts warning in §0.

---

## 5. Roadmap state

**Done:** A (all), B1, B2, B3, B6, B7, B8, B10, B11, **C1**, C2, C6.

**Left, both gated on an operator decision:**
- **B4 documents** — which documents? Do not invent legal text for a Cyprus agency.
- **B5 map** — tile provider, plus a CSP `img-src`/`connect-src` call.

**Standing decisions:**
- **Build nothing next — stabilise and let the desk use it** (2026-07-29).
- **B9 closed, not deferred** — the desk works in English. See IMPROVEMENTS.
- **The `execute_sql` permission entry stays** (§3), deliberately, in future
  sessions too.
- **C1 is configuration, not code.** `SENTRY_DSN` (server — the CSP handler runs
  server-side, so this is the one that matters) and `NEXT_PUBLIC_SENTRY_DSN`
  (browser, *and* what puts the Sentry origin into `connect-src`). Both set and
  verified live. Source maps are deliberately not uploaded, so client stacks
  arrive minified; `tracesSampleRate` 0.1 (errors and messages unsampled).

**Decision-free work is bug-shaped and lives in `docs/BACKLOG.md`.** The named
follow-up: **human-assigned tasks are still stranded by deactivation** — 0024's
sweep covers only system-generated rows, because silently re-homing a person's
deliberate assignment is the wrong default. Wants an admin surface.

---

## 6. Known gaps

- **CSP is still Report-Only.** It now has a durable sink (Sentry), so promoting
  it to enforced is an evidence-backed decision — but it wants real traffic
  first. Vercel runtime-log retention is ~1h, so grepping stdout later always
  comes back empty, and **empty must not be read as clean**.
- **2FA is enforced at the application layer only.**
- **B8 does not queue writes.** Offline slip signing was considered and
  rejected: it would put commission evidence in a client-side queue.
- ~~Playwright does not run in CI~~ — **fixed 2026-08-04**, and it caught a real
  CSP-breaking `eval` on `/share-links` on its first run (§8, DECISIONS
  `T-share-links-eval`).

---

## 7. Environment traps

**Vercel**
- **Env vars are PER-ENVIRONMENT, and "set for Preview only" is
  indistinguishable from "not set".** Cost six deployments on 2026-08-03. When a
  value does not appear in production, check the environment ticks *before*
  suspecting the save or the build.
- **`NEXT_PUBLIC_*` is compiled in, so changing one needs a new BUILD, not a new
  request — and installing an integration does not trigger a redeploy either.**
  Checking production immediately after either change always shows the old state
  and is not evidence of failure. Push a commit, then check.
- **The dashboard can silently swallow every action** (a full-screen 2FA
  interstitial did it on 2026-07-31). Verify by the row's date changing and a new
  deployment appearing — never by the click seeming to land.
- **Do not poll a production domain in a tight loop.** ~80 requests over ten
  minutes triggered the firewall: every response became `403`
  `X-Vercel-Mitigated: challenge`, which looks exactly like an outage. Real users
  are unaffected (a browser solves the JS challenge). Wait on
  `get_deployment().state` instead. Polling a deployment's own `*.vercel.app`
  URL for a 200 never works anyway — `ssoProtection` is on for
  `all_except_custom_domains`.
- **Diagnostic that beats reasoning:** when two adjacent `NEXT_PUBLIC_*` reads in
  one function behave differently (Supabase inlined, Sentry not), the difference
  is the *environment*, not the build — it eliminates cache, bundler and
  framework in one observation.
- Logs: `get_runtime_errors` and `get_runtime_logs` with
  `group_by: statusCode|requestPath` are fast; full-text `query` tends to time
  out — scope to a `deploymentId` or a narrow window.

**Supabase / local stack**
- **`supabase login` may never persist a token** (nothing in `~/.supabase` or
  Credential Manager) — even `login --token`. `db dump` / `db push` are then
  unusable; `--db-url` needs neither `login` nor `link`.
- **`npx supabase stop` can drop the local volume.** After any stop/start check
  `select count(*) from supabase_migrations.schema_migrations` and `db reset` if
  empty. After a reset PostgREST's schema cache can be stale (`Could not find the
  table 'public.organizations' in the schema cache`); it clears on the reset's own
  container restart, otherwise reset again.
- A silent local-stack `fetch failed` returns `data: null`, which reads exactly
  like an empty table. **Always print `error`.**
- Docker Desktop is sometimes fully down, not just flaky.
- `document_type` has no `id_passport` — it is `id_document`.
- Supabase `signOut()` defaults to **global** scope.

**Machine**
- **Do not `rm -rf .next` or build while a dev server is running.**
- **A shell left `cd`'d into a directory locks it on Windows**, so an emptied
  directory may refuse to disappear. `git worktree remove` can fail this way —
  prune, then remove with PowerShell. (This bit the 2026-08-07 move: robocopy
  relocated every file but could not delete the source root, because the live
  session held it as cwd.)
- **The working tree lives on `D:\dev\TSOPOZIDIS` (moved 2026-08-07).** It is no
  longer under OneDrive — which also means no cloud copy of anything untracked,
  `gnk-backups/` included. See §3.3: the off-site gap is now wider, not narrower.
- **Disk runs tight, and a FULL disk truncated a tracked file to 0 bytes
  (2026-08-07).** `C:` hit 100% mid-session while a full Playwright run was
  going; the next `pathlib.write_text` on `HANDOFF.md` truncated it and then
  failed with `OSError: [Errno 28]`, leaving an empty file. Recovered with
  `git restore` — nothing was lost only because the file was committed.
  - **`.next` is the bulk: it reached 3.6 GB.** `tests/.playwright-output` and
    `-report` were 9 MB combined, so clearing them buys nothing; `.next` is the
    one worth deleting. Stop the dev server first (see above).
  - **Write files atomically when the disk may be tight** — temp file plus
    `os.replace`, not a direct `write_text`, which truncates before it writes.
  - **`npx playwright test` (full desktop) locally is what filled it**, because
    the run builds `.next` for `next start`. **This is no longer a constraint**:
    on `D:` the full suite ran 2026-08-08 in 6.4 minutes (168 passed / 4
    skipped) with `.next` at 2.29 GB and `C:` never moving off ~22 GB free. A
    local `supabase db reset` cycle is affordable again too — which is how the
    `csp.spec.ts` run-1 proof finally got taken (DECISIONS 2026-08-08).
  - **`git status` after a local full run: `tests/screenshots/*.png` are TRACKED
    and `modules.spec.ts` overwrites all 12 with whatever your local database
    looked like.** Run the suite right after a `db reset` and they silently
    become pictures of an empty app — `leads-desktop.png` halved, 207 KB → 102 KB
    — which is a downgrade, not a change, and it will ride along in your next
    `git add -A`. They are report artifacts, not a `toHaveScreenshot` baseline,
    so nothing fails; just `git checkout HEAD -- tests/screenshots/` unless you
    deliberately want to refresh them against populated data.
  - **Killing a backgrounded `npm run dev` leaves `next dev` alive, and Playwright
    will then reuse the wreckage.** `playwright.config.ts` sets
    `reuseExistingServer: true` against `npm run dev`, so a half-orphaned server
    on :3000 gets adopted by the next suite run. Symptom (2026-08-08): four
    unrelated specs failed — `happy-path` step 4, both anonymous `share-links`
    tests, one `csp` public-route test — and the page snapshot showed Next's
    **"Jest worker encountered 2 child process exceptions, exceeding retry
    limit"** overlay rather than any assertion problem. Nothing was wrong with the
    code; the same suite passed 170/174 minutes later on a clean server. Before
    trusting an E2E failure, check :3000 has no leftover owner — `next dev` prints
    its PID in the "Another next dev server is already running" message, and
    `Stop-Process -Id <pid> -Force` clears it. A stray dev server looks exactly
    like a real regression.
  - **Do not run `test:rls` and `test:e2e` at the same time — they share the
    local database.** TEST-1 gave the RLS suite its own fixture *org*, not its
    own database, and the E2E suite writes to that same org. Running them
    concurrently on 2026-08-09 produced a **1 failed / 30 passed** RLS result
    while an E2E fixture (a deactivated profile) happened to exist; the same
    suite was 31/31 the moment it ran alone. HANDOFF §2b already lists "a test
    can depend on the absence of residue" — this is the same hazard arriving
    from a neighbouring process rather than a previous run. Sequence them.
  - **The move to `D:` fixed the build-artifact half of this, not the disk.**
    `.next`, `node_modules` and Playwright output now land on D: (123 GB free).
    But `C:` was measured at **830 MB free of 222 GB** and the repo was only
    0.8 GB of it — the move reclaimed under a gigabyte. What actually fills C:
    is `Outlook.pst` (55.8 GB) plus `archive.pst.corrupt` (11.4 GB) — user mail
    data, leave it alone — and Docker's `docker_data.vhdx` (20.7 GB) under
    `%LOCALAPPDATA%\Docker\wsl\disk\`, which regrew on every `supabase start`.
  - **Docker's disk image was moved to `D:\docker\disk` the same day, and that
    is what actually fixed C: — 0.83 GB → 22.58 GB free.** It is a **directory
    junction**, not a Docker setting: `mklink /J "%LOCALAPPDATA%\Docker\wsl\disk"
    "D:\docker\disk"`. The documented-looking `DataFolder` key in
    `%APPDATA%\Docker\settings-store.json` is silently ignored by Docker Desktop
    4.85 — it kept the key *and* built a fresh empty disk at the default path.
    If Docker ever reports 0 images, check that the junction still exists before
    assuming data loss; the real vhdx is on D:. Images/volumes verified intact
    after the move (28 images, `supabase_db_gnk-crm` volume present).

---

## 8. Verify state

```bash
npm run typecheck && npm run lint && npm run test && npm run build
```

```bash
npm run test:rls
```

```bash
npx playwright test --project=setup --project=desktop
```

Expect **437 unit · 30 RLS · 168 E2E passed, 4 skipped** (`--list` counts 172,
including self-skips and the `setup` project). A freshly reset DB is a clean
first run — the `csp.spec.ts` detail tests seed what they need.

**What CI covers — all three jobs:**
- `checks` — typecheck · lint · unit · **build**. Takes **no secrets on purpose**:
  `npm run build` exits 0 with no `.env` at all (verified). If it ever needs
  them, something has started reaching the database at build time; investigate
  that rather than adding them.
- `rls` — the RLS suite against a real Supabase stack.
- `e2e` — **added 2026-08-04.** Desktop Playwright against a real stack **and a
  production build**. ~8 min, so pushes are slower; if that becomes a problem the
  lever is scoping it to `pull_request` + `main` rather than every push.

**The `e2e` job runs `next start`, NOT `next dev`, and that is load-bearing.**
`lib/services/csp.ts` ships `'unsafe-eval'` under dev, so `script-src`
violations are **invisible** there. On its first run this job caught a real one
(`/share-links`, DECISIONS `T-share-links-eval`) that had been live for six days.
`playwright.config.ts` sets `reuseExistingServer`, so the job starting the server
means Playwright reuses it instead of launching `npm run dev`.

**Unlike `checks`, `e2e` needs Supabase env** — the app must actually reach a
database. It exports the local stack's well-known demo values from
`supabase status -o env`; those are not secrets and never production credentials.

**Confirm a CI step actually RAN** before trusting a green tick:

```bash
curl -s "https://api.github.com/repos/KALAITSIDIS/gnk-crm/actions/runs/<RUN_ID>/jobs"
```
