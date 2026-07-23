# BACKUP & RESTORE — drill runbook and RPO/RTO

Owner: operator. Written 2026-07-23 against hosted `yjgirvzgoiywdojnpkpd`
(eu-central-1, Postgres 17.6.1.141) at `main` = `bd00809`.

This closes `IMPROVEMENTS.md` C6. Read §1 before planning the drill — the
premise the drill was scoped under turned out to be wrong, and §1 is the reason
this document leads with *creating* a backup rather than restoring one.

---

## 1. Three findings that change the shape of this task

### 1.1 There is no backup to restore. The plan is Free.

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

Three dumps, because they cover different things and only the first is included
by default:

```bash
mkdir -p ../gnk-backups/$(date +%Y-%m-%d)
```

```bash
npx supabase db dump --db-url "$DB_URL" -f ../gnk-backups/$(date +%Y-%m-%d)/schema.sql
```

```bash
npx supabase db dump --db-url "$DB_URL" --data-only --use-copy -f ../gnk-backups/$(date +%Y-%m-%d)/data.sql
```

```bash
npx supabase db dump --db-url "$DB_URL" --role-only -f ../gnk-backups/$(date +%Y-%m-%d)/roles.sql
```

Notes that matter:

- `db dump` covers `public` by default. **`auth.users` is not in it** — add
  `--schema auth,storage` for a fourth dump if you want the two login accounts
  and the storage metadata to come back with the data. Without it a restored
  project has the business data and nobody who can log in.
- `--use-copy` matters at scale, not at 60 events, but keep it — it is what
  makes the dump reloadable in one pass later.
- Daily backups on paid plans *"do not store passwords for custom roles"*. This
  project uses the stock Supabase roles, so `roles.sql` is a formality today —
  take it anyway so the drill proves the whole shape.

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

## 4. The drill

Time each phase and write the actual minutes into §6.

1. **Create a scratch project** in the same org, region eu-central-1, Postgres
   17.x. Name it `gnk-crm-restore-drill`. It is throwaway; delete it at the end.
2. **Confirm the timezone first** — `show timezone;` must return `UTC`. If it
   does not, set it before loading anything, or §1.3 will make step 6 fail for
   the wrong reason.
3. **Restore roles, then schema, then data**, in that order, via the scratch
   project's connection string.
4. **Restore storage** — the same `supabase storage cp -r` commands with source
   and destination swapped, against the scratch project. Buckets must exist
   first, and `media` must be `public = true` (that is migration 0008's whole
   job; a restored-but-private `media` bucket serves broken images and looks
   like a code fault).
5. **Run the verification pack** — `scripts/backup/verify-restore.sql`, which
   asserts every number in §2 in one pass.
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

## 5. What "passed" means

The drill passes only if all of these hold on the restored project:

- [ ] `show timezone` = `UTC`
- [ ] every row count in §2 matches
- [ ] `verify_events_chain` = `true` for every org
- [ ] the function-grant table in §2 reproduces **exactly** — this is the TEST-2
      check, and the one most likely to differ
- [ ] `non_filename_versions` = 0 and 19 migration rows
- [ ] both cron jobs present and active
- [ ] storage object counts 9 / 2 / 15, and `media.public` = true
- [ ] the signed slip PDF for the smoke viewing downloads and opens
- [ ] a stored evidence report downloads, and its SHA-256 still matches the
      `pdf_sha256` in its event payload — the end-to-end proof that the evidence
      chain survived
- [ ] at least one login works

---

## 6. Proposed RPO / RTO — for operator sign-off

**Today, honestly stated:**

| | Current |
|---|---|
| RPO | **Unbounded.** No reachable backup exists. A project-level loss is total. |
| RTO | **Unbounded.** Nothing to restore from, so nothing to time. |

**Proposed, after §3 is running:**

| | Target | Why this number |
|---|---|---|
| **RPO** | **24 hours** | A nightly dump. At current volume (~60 events in 8 days, ~8/day) a worst-case loss is a single day of activity. Cheap, and infinitely better than today. |
| **RTO** | **4 hours** | Data volume is trivial (<1 MB DB, 755 KB storage) — restoring it is minutes. The real cost is provisioning a project, re-pointing Vercel env vars, and re-verifying. 4h is the honest figure with a human in the loop, not the machine time. |

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

1. Take one manual backup today (§3). This alone removes the largest unmitigated
   risk on the project, and takes under an hour.
2. Get it off-site (§3.3).
3. Run the drill (§4) and fill in the real timings.
4. Decide Free-plus-nightly-dump versus Pro-plus-PITR (§6) with the volume you
   actually expect in Phase 2.

Steps 1 and 2 are worth doing before anything else on the outstanding list.
Until they are done, every other item is a refinement on a system that cannot
survive losing its database.
