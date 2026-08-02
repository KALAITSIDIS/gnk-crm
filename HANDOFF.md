# HANDOFF — 2026-07-31

Read `docs/HANDOVER.md` and `CLAUDE.md` first; this is the delta on top of them.

| | |
|---|---|
| `main` | `db3bf63`, clean, in sync with `origin/main`, only branch |
| CI | ✅ green (both `checks` and `rls`) on every push |
| Production | `gnk-crm.vercel.app` healthy — build is commit `21c25fc` |
| Hosted DB | `yjgirvzgoiywdojnpkpd` — **23 migrations**, `non_filename_versions = 0`, chain verifies, 62 events |
| Tests | **437 unit** · **29 RLS** (first-run on a fresh DB) · **165 desktop E2E**, 4 skipped |
| Cron | `expire-mandates 03:00` · `followup-nudges 03:15` · `verify-events-chain 03:30` |
| Backups | ✅ complete + verified, `../gnk-backups/2026-07-30` and `2026-07-31` (§2) |

---

## 0. START HERE

**Nothing is broken and nothing is half-finished.** The tree is clean, everything
is pushed, CI is green, and the roadmap's decision-free work is exhausted.

**One open item, and it is the operator's:** §2b — the legacy `service_role` key
was exposed in a chat transcript and is still live. Low likelihood (transcript
only, never published or committed) but it bypasses RLS entirely. Everything
needed to revoke it safely is written out there, including the blocker that
stopped eight attempts.

**Do not start B4 or B5** — both need a decision only the operator can give
(§5). **B9 is closed, not deferred.**

**The operator chose to stabilise rather than build.** Three features shipped
and none has met a real user yet. If asked "what next", the honest answer is
usage, not code: mint one proposal link, install the PWA on a phone, and look at
`/tasks` after the 03:15 cron.

A first useful check in a new session — all read-only:

```bash
cd "C:/Users/user/OneDrive/Desktop/TSOPOZIDIS/gnk-crm" && git log --oneline -3 && git status --short
```

Then verify hosted is unchanged via the Supabase connector (`execute_sql`,
read-only): migrations = 23, `non_filename_versions` = 0,
`verify_events_chain` true, and `share_links`/`tasks` row counts (both were 0 —
if either is non-zero, the desk has started using B3/B7 and that is worth
reading before doing anything else).

---

## 1. Shipped 2026-07-29/31 (all applied to hosted, pushed, CI-green)

- **B7 — follow-up nudges** (0020). Cron-driven `deal_no_contact` (14d silent) and
  `viewing_feedback` (48h) tasks, cycle-keyed like 0012, Cyprus EOD due stamps,
  three-arm assignee fallback, superseded-not-deleted. Replaced the old virtual
  "viewings awaiting feedback" section with real task rows.
- **0021** — revoked EXECUTE on 0020's two trigger functions. They were created
  after 0007's blanket lockdown and inherited Supabase's default grant.
- **0022** — removed three `service_role` grants that existed on hosted but in
  no migration. Production is reproducible from its own history again.
- **B3 — buyer proposal magic links** (0023). `/p/[token]` public page,
  `/share-links` manager. Token never stored (only `sha256`), `anon` has no
  table grant at all, exposure allowlist lives in the `resolve_share_link` RPC,
  opens counted exactly and evented once per Cyprus day, en/el/ru per link.
- **B8 — installable PWA.** Manifest, maskable icon, offline fallback,
  service worker with resilient reads. **Writes are not queued** — deliberately.
  Every cache is purged on sign-out.
- **Backup tooling** — `scripts/backup/export-events.sql` (chain-faithful
  `events` export, proven by wipe-and-restore) and a refreshed restore baseline.

---

## 2. Backups — DONE 2026-07-30/31, and verified

Production had **no** recoverable backup until 2026-07-30. It now has two
complementary sets in `../gnk-backups/` (outside the repo, untracked):

| set | contents | verification |
|---|---|---|
| `2026-07-30/` | `events.sql` (62 rows, **chain-faithful**), `business-data.json` (15 tables), `auth-and-storage-manifest.json` (2 accounts + all 26 file names/sizes), `README.md` restore guide | md5 computed **inside Postgres** and re-checked on disk — all three match |
| `2026-07-31/` | `export.mjs` output: **all 26 Storage files** + every table as JSON | every file size checked against the independent manifest; `manifest.json` confirms `source: https://yjgirvzgoiywdojnpkpd.supabase.co` |

**Keep both, and know why.** `export.mjs` warns about itself: its `events` copy
is NOT chain-faithful (PostgREST hands `jsonb` to JavaScript and numeric scale is
lost, so `verify_events_chain` fails on restore). `2026-07-31` has the FILES;
`2026-07-30/events.sql` has the events that actually restore.

**Traps learned taking it:**
- `export.mjs` reads `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` from the
  SHELL and loads no `.env`. With nothing set it falls back to
  `NEXT_PUBLIC_SUPABASE_URL` — **your local stack** — and silently backs up the
  wrong database. Always check `manifest.json`'s `source` afterwards. The old
  `2026-07-28/` folder was exactly this mistake (3 orgs, 295 events, localhost);
  it has been deleted.
- `supabase login` never persisted a token on this machine (nothing in
  `~/.supabase`, nothing in Windows Credential Manager), so `db dump`/`db push`
  were unusable all session. `--db-url` avoids `login`/`link` entirely — see
  BACKUP_RESTORE §3.
- The `media` bucket is public (0008), so its 15 files need **no credential** —
  plain HTTPS from `/storage/v1/object/public/media/…`.

**Still to do: `supabase db dump --db-url …` for a true pg_dump.** The above is
a genuine, verified safety net, but pg_dump remains the primary per
BACKUP_RESTORE §3.

---

## 2b. OPEN SECURITY ITEM — rotate the service_role key

**The legacy `service_role` key was pasted into a chat transcript on 2026-07-30
and is still live.** It bypasses RLS entirely: full read/write on client PII, KYC
documents and the evidence chain. Not committed, not posted publicly — the
exposure is the transcript only, so likelihood is low — but it must be revoked.

**It is load-bearing:** `createAdminClient()` (`lib/supabase/admin.ts`) reads
`SUPABASE_SERVICE_ROLE_KEY`, used by commission evidence, organisation settings,
contact documents, document uploads and GDPR erasure. Revoking without replacing
takes those down.

Sequence (each step must be *seen* to take effect — several attempts silently
did nothing):

1. Supabase → API Keys → *Publishable and secret* → a secret key
   (`sb_secret_…`) **already exists**; copy it with the ⧉ icon, not the eye.
2. Vercel → Environment Variables → edit `SUPABASE_SERVICE_ROLE_KEY` to that,
   and `NEXT_PUBLIC_SUPABASE_ANON_KEY` to the publishable key
   (`sb_publishable_…`, safe to share). **The row's date must change to today —
   that is the only proof it saved.**
3. Deployments → ⋯ → Redeploy, **build cache OFF** (`NEXT_PUBLIC_*` is baked
   into the client bundle at build time; a cached build keeps the old key).
4. Verify: a deployment newer than `21c25fc`; the live page ships
   `sb_publishable_…`; `/settings/organization` still works (it exercises the
   service-role path).
5. Supabase → API Keys → **Legacy anon, service_role** tab → **Disable
   JWT-based API keys**. This is the step that actually revokes it. Nothing on
   the *Publishable and secret* tab does.

**Test that it worked** — must return **401**, not 200:

```bash
curl -s -o /dev/null -w "%{http_code}\n" "https://yjgirvzgoiywdojnpkpd.supabase.co/rest/v1/organizations?select=id&limit=1" -H "apikey: <OLD_KEY>" -H "Authorization: Bearer <OLD_KEY>"
```

**Known blocker:** as of 2026-07-31 the Vercel dashboard would not persist env
edits — the rows still read *Updated Jul 15 / Jul 11* after several attempts, and
no redeploy was ever created. A **"Secure Your Account with 2FA" interstitial**
was blocking the dashboard and is the likely cause; it was skipped, but the
edits still did not save. If the dates will not change, use the CLI instead —
it prints real errors rather than failing silently:

```bash
npx vercel login && npx vercel env rm SUPABASE_SERVICE_ROLE_KEY production && npx vercel env add SUPABASE_SERVICE_ROLE_KEY production && npx vercel --prod
```

---

## 2c. Other operator-only items

**Leaked-password protection is still off** (advisor-confirmed 2026-07-29), and
`GNK-PAF-0002` still wants archiving **via the UI button** so `archiveProperty`
writes its event.

---

## 3. How to apply a migration (this changed today — HANDOVER §4 is rewritten)

The blocker was never Supabase or credentials: it was the **auto-mode
classifier** refusing `execute_sql` writes. One entry in
`.claude/settings.local.json` unblocks it:

```json
"mcp__728f3c26-074c-4f63-839e-0d81840c3291__execute_sql"
```

**The operator must add it** — an agent editing its own permission file is
blocked too, correctly. That entry permits *any* SQL through that tool in this
directory; remove the line to restore the block.

With it present: apply in **separate `execute_sql` calls** (schema → functions →
triggers → cron → the `schema_migrations` insert), **verify in a further
separate call**, then diff each function body against local normalised for
comments/whitespace. Then **run `get_advisors`** — skipping that is what caused
0021.

Two SQL-editor traps that cost most of a session: the dashboard editor can
discard DDL while a `select` in the *same run* still sees it (so verify in a
second, separate run), and it wraps a multi-statement script in one transaction,
so a failure on the trailing insert rolls back every statement before it.

---

## 4. Patterns that bit repeatedly — check these on any new object

Three bugs today were the same shape: **a new object does not inherit the
treatment an earlier migration or decision applied.**

1. **RLS policies do not imply table GRANTs.** 0002 grants each table to
   `authenticated` one by one; a table created later inherits nothing. Symptom:
   `permission denied for table …` with correct policies.
2. **Hosted grants new tables to `anon`/`authenticated` by default; local does
   not.** A migration that only GRANTs produces two different databases. Always
   `revoke all … from anon, authenticated` first, then grant back precisely.
3. **New `security definer` functions are anon-executable by default.** 0007
   locked this down; anything added since must repeat it — or, as with
   `resolve_share_link`, be a deliberate exception pinned in
   `verify-restore.sql`.

And two testing lessons:

- **Playwright's `request` fixture is authenticated.** It reported 200 for
  `/manifest.webmanifest` while real browsers got a 307 to `/login`. Test public
  surfaces with an anonymous context.
- **A test can depend on the *absence* of residue.** RLS test 24 pinned the
  orphan-deal fallback to a specific admin; the fixture org accumulates admins
  across local reruns, so it passed only on a fresh DB. CI always starts fresh,
  which is exactly how such a test hides.

---

## 5. Roadmap state

**Done:** A (all), B1, B2, B3, B6, B7, B8, B10, B11, C1 (report-only), C2, C6.

**Operator decisions taken 2026-07-29:**
- **Build nothing next — stabilise and let the desk use it.** Three features
  shipped today and none has been used in anger: the nudge cron fires nightly
  against zero open deals, no proposal link has been minted, the PWA is on
  nobody's phone. Real usage will surface better work than guessing at B4.
- **C1 finishes via Sentry.** The `/api/csp-report` handler already calls
  `Sentry.captureMessage`; `instrumentation.ts` and `instrumentation-client.ts`
  are both correctly DSN-gated and no-op without one. **Nothing to build** — it
  needs `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN` set in Vercel. Once set,
  `csp.ts` also adds the Sentry origin to `connect-src` automatically.
- **The `execute_sql` permission entry stays** in `.claude/settings.local.json`.
  Deliberate: it permits any SQL through that tool in this directory, in future
  sessions too. Kept because the alternative cost half a session, and every
  migration today was applied in separate verified steps with a body-diff
  against local afterwards. Remove the line to restore the block.
- **B9 is closed, not deferred** — the desk works in English. See IMPROVEMENTS.

**Left, both gated on an operator decision:**
- **B4 documents** — which documents? Do not invent legal text for a Cyprus agency.
- **B5 map** — tile provider, and it now needs a CSP `img-src`/`connect-src` call.

---

## 6. Known gaps

- **CSP is still Report-Only, and its verification is unachievable as written.**
  Vercel runtime-log retention is ~1h on this plan, so "browse prod then grep
  for `[csp]`" always comes back empty if done later — and empty must not be
  read as clean. Fix: check within the hour, or give the endpoint a durable sink
  (the handler already writes to Sentry; it needs a DSN). In `docs/BACKLOG.md`.
- **2FA is enforced at the application layer only.**
- **Two `csp.spec.ts` tests fail on a freshly reset local DB** (they need a
  property and contact that `happy-path.spec.ts` creates). Pre-existing, never
  reaches CI, logged in BACKLOG.
- **B8 does not queue writes.** Offline slip signing was considered and
  rejected: it would put commission evidence in a client-side queue.

---

## 7. Environment traps

- **Do not `rm -rf .next` or build while a dev server is running.**
- **The Vercel dashboard can silently swallow every action.** On 2026-07-31 a
  full-screen *"Secure Your Account with 2FA"* interstitial sat in front of the
  dashboard: env-var saves and Redeploy clicks appeared to work and nothing was
  recorded. Env rows still read *Updated Jul 15 / Jul 11* after several attempts
  and no deployment was ever created. **Verify by the row's date changing and by
  a new deployment appearing** — never by the click seeming to land. The CLI
  (`npx vercel …`) prints real errors and is the fallback.
- **`supabase login` may never persist a token** (nothing in `~/.supabase`,
  nothing in Windows Credential Manager) — even `login --token`. When that
  happens `db dump` / `db push` are unusable; use `--db-url` instead, which
  needs neither `login` nor `link`.
- **`npx supabase stop` can drop the local volume.** After any stop/start check
  `select count(*) from supabase_migrations.schema_migrations` and `db reset` if
  it is empty. After a `db reset`, PostgREST's schema cache can also be stale
  (`Could not find the table 'public.organizations' in the schema cache`).
- **A shell left `cd`'d into a directory locks it on Windows** — `rm -rf` then
  fails with "Device or resource busy". `cd` out first. OneDrive holds handles
  too, so an emptied directory may refuse to disappear.
- **`npx supabase stop` can drop the local volume** — after any stop/start,
  check `select count(*) from supabase_migrations.schema_migrations` and
  `db reset` if it is empty.
- **After `db reset`, PostgREST's schema cache can be stale** → `Could not find
  the table 'public.organizations' in the schema cache`. It clears on the reset's
  own container restart; if not, reset again.
- A silent local-stack `fetch failed` returns `data: null`, which reads exactly
  like an empty table. **Always print `error`.**
- Docker Desktop is sometimes fully down, not just flaky.
- `document_type` has no `id_passport` — it is `id_document`.
- Supabase `signOut()` defaults to **global** scope.
- The working directory is under **OneDrive**, which is sync, not backup.

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

Expect 437 unit · 29 RLS · 165 E2E (4 skipped). The E2E needs a populated
database: on a freshly reset DB the two `csp.spec.ts` detail tests fail on the
first run and pass on the second, once `happy-path.spec.ts` has created a
property and a contact.

```bash
curl -s "https://api.github.com/repos/KALAITSIDIS/gnk-crm/actions/runs?per_page=5"
```
