# HANDOFF — 2026-07-29

Read `docs/HANDOVER.md` and `CLAUDE.md` first; this is the delta on top of them.

| | |
|---|---|
| `main` | `7802a75`, clean, in sync with `origin/main`, only branch |
| CI | ✅ green (both `checks` and `rls`) on every push today |
| Production | `gnk-crm.vercel.app` healthy |
| Hosted DB | `yjgirvzgoiywdojnpkpd` — **23 migrations**, `non_filename_versions = 0`, chain verifies, 62 events |
| Tests | **437 unit** · **29 RLS** (first-run on a fresh DB) · **165 desktop E2E**, 4 skipped |
| Cron | `expire-mandates 03:00` · `followup-nudges 03:15` · `verify-events-chain 03:30` |

---

## 1. Shipped today (all applied to hosted, pushed, CI-green)

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

## 2. THE ONE THING THAT STILL MATTERS MOST

**There is still no backup of production.** Free plan = no automated backups.
Everything else here is polish next to this:

```bash
cd "C:/Users/user/OneDrive/Desktop/TSOPOZIDIS/gnk-crm" && npx supabase db dump --schema public,auth,storage -f backup.sql
```

`--schema public,auth,storage` is not optional: `auth.users` lives outside
`public`, and a restore without it is a database nobody can log into. Storage
objects (26: KYC scans, signed slips, property media) are files and reach no SQL
export — `scripts/backup/export.mjs` covers those.

Other operator-only items: **leaked-password protection is still off**
(advisor-confirmed today), and `GNK-PAF-0002` still wants archiving **via the UI
button** so `archiveProperty` writes its event.

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

**Left, all gated on an operator decision:**
- **B4 documents** — which documents? Do not invent legal text for a Cyprus agency.
- **B5 map** — tile provider, and it now needs a CSP `img-src`/`connect-src` call.
- **B9 el/ru chrome** — **HANDOFF previously said this was blocked by a missing
  locale switcher. That is wrong.** `profiles.locale` exists and is unread;
  wiring it into `getRequestConfig` plus a control on `/security` is about an
  hour and needs no locale *routing* (doc 02 §A5 excludes routing, not
  per-user locale). The real work is that **only 13 of 128 files use
  translations** — 114 of the 144 existing keys are the event timeline alone.
  Flipping the locale today would give a Russian sidebar around eight English
  modules, so the switcher must land *last*. And since B3 already ships el/ru to
  buyers, the open question is whether *staff* need a Greek/Russian interface.

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
