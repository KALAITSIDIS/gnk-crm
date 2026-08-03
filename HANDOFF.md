# HANDOFF — 2026-08-02

Read `docs/HANDOVER.md` and `CLAUDE.md` first; this is the delta on top of them.

| | |
|---|---|
| `main` | `4d18ab0`, clean, in sync with `origin/main`, only branch |
| CI | ✅ green (`checks` + `rls`); `checks` now **builds** too (2026-08-03) |
| Production | `gnk-crm.vercel.app` healthy — `/login` 200; **auto-deploys every push** (§2b) |
| Hosted DB | `yjgirvzgoiywdojnpkpd` — **24 migrations**, `non_filename_versions = 0`, chain verifies, 62 events |
| Tests | **437 unit** · **30 RLS** · **167 desktop E2E**, 4 skipped (`--list` says 171 total) |
| Cron | `expire-mandates 03:00` · `followup-nudges 03:15` · `verify-events-chain 03:30` |
| Backups | ✅ complete + verified, `../gnk-backups/2026-07-30` and `2026-07-31` (§2) |

---

## 0. START HERE

**Nothing is broken and nothing is half-finished.** The tree is clean, `main` is
pushed and in sync, CI is green, and hosted is at 24 migrations matching the
repo. Two diagnosed defects were closed on 2026-08-02 — 0024 (§1) and the
`csp.spec.ts` residue dependency (§6).

**The long-standing open item is CLOSED.** §2b — the exposed `service_role` key —
was revoked on 2026-08-03 and verified from both ends: the legacy pair returns
`401 Legacy API keys are disabled`, and production is healthy on the new
publishable/secret pair. **There is now no known outstanding security item.**

**Do not start B4 or B5** — both need a decision only the operator can give
(§5). **B9 is closed, not deferred.**

**The desk still has not used the system.** `share_links` = 0, `tasks` = 0,
events = 62, all unchanged since 2026-07-31. The nudge cron has been firing
nightly against zero open deals. If asked "what next", the honest answer is
still usage, not code: mint one proposal link, install the PWA on a phone, and
look at `/tasks` after the 03:15 cron.

A first useful check in a new session — all read-only:

```bash
cd "C:/Users/user/OneDrive/Desktop/TSOPOZIDIS/gnk-crm" && git log --oneline -3 && git status -sb
```

Then verify hosted via the Supabase connector (`execute_sql`, read-only):
migrations = 24, `non_filename_versions` = 0, chain verifies, and
`share_links`/`tasks` row counts (both were 0 — if either is non-zero, the desk
has started using B3/B7 and that is worth reading before doing anything else).

**Two snippet corrections, found the hard way on 2026-08-02.**
`verify_events_chain` takes an argument — `verify_events_chain(p_org uuid)`;
calling it bare raises `42883 function does not exist`, which reads like a
missing migration and is not. And `non_filename_versions` must test
`version !~ '^[0-9]{4}$'` (versions are `0001`…`0024`, matching the migration
filenames); the 14-digit timestamp shape reports every row as non-conforming.
`scripts/backup/verify-restore.sql` had the right regex all along.

---

## 1. Shipped

### 2026-08-02 — applied to hosted, pushed, CI-green

- **0024 — system tasks never land on a deactivated profile**
  (`T-nudge-active-assignee`). 0012's three-armed fallback only checked
  `is_active` on the **third** arm, so `deal_no_contact`, `viewing_feedback` and
  `mandate_renewal` could all assign a task to a profile nobody can sign in as —
  invisible like the 0012 NULL bug, but no longer *looking* unassigned, so no
  orphan surface could find it. Every arm is now active-only; a new step 5 in
  `create_followup_nudges` re-homes stranded open system tasks nightly (it runs
  15 min after `expire-mandates`, so one place owns the invariant for all three
  kinds); a one-time backfill repaired existing rows. RLS test 26 pins it.
  **The hosted backfill was a provable no-op** — `tasks` = 0 — and it re-homed 3
  rows locally.
  - Body diff done as `md5(prosrc)`: hosted and local are byte-identical.
  - ACLs re-read after the replace: `create_followup_nudges` keeps
    `service_role`, `expire_mandates` keeps **none** (0022's deliberate state).
    `create or replace` preserves ACLs — it does not reset them.
  - `get_advisors` returned the same set as before the change. No 0021 repeat.
- **`csp.spec.ts` no longer depends on test residue** (`T-csp-fixture`). The two
  detail tests seed their own property and contact when the list is empty,
  preferring a real row when one exists, and sweep them by marker afterwards.
  Verified without a `db reset` by forcing the empty branch — see §6.

### 2026-07-29/31 (all applied to hosted, pushed, CI-green)

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

## 2b. ~~OPEN SECURITY ITEM~~ — **RESOLVED 2026-08-03: the key is revoked**

**Done. The exposed `service_role` key is dead.** Supabase disabled the legacy
JWT pair at `2026-08-03T17:40:12.572433+00:00`. Nothing here is outstanding; the
procedure below is kept as the record of how it was done and what nearly went
wrong.

Evidence, all captured after the toggle:

| check | result |
|---|---|
| `get_publishable_keys` → legacy `anon` | `disabled: true` (was `false`) |
| REST call with the legacy key | **401** `Legacy API keys are disabled` — and the hint names **`(anon, service_role)`**, so the exposed key is confirmed dead directly, not by the shared-`iat` inference |
| REST call with `sb_publishable_…` | 200 |
| prod `/login` | 200 |
| prod `/p/…` (public client + `resolve_share_link` round-trip) | 200, correct "link no longer available" page, no error boundary |
| prod `/dashboard` | 307 → `/login` |
| prod `/offline`, `/manifest.webmanifest` | 200, 200 |
| `/settings/organization` (service-role path, operator-checked) | loads |

**What made it work on the tenth attempt, after nine silent failures:** the
Redeploy button was never used. Git pushes deploy reliably (verified: six
consecutive `READY` production deployments), so the env change was picked up by
pushing commit `aae6dc1`, and the resulting deployment `dpl_D3WRnCp…` was
confirmed `READY` and aliased to `gnk-crm.vercel.app` through the Vercel
connector. Every step was checked by a positive observation rather than by a
click appearing to land.

**Order that must be preserved if this is ever repeated:** save env → **deploy**
→ **verify both keys in production** → *only then* disable the legacy pair.
Vercel injects env vars at deploy time, so before the redeploy the running app
is still authenticating with the OLD keys; disabling first revokes what
production is actively using. Everything before the toggle is reversible and the
toggle is not.

<details>
<summary>Original item and procedure (historical)</summary>

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
3. Deployments → ⋯ → Redeploy, **build cache OFF**. (Keep doing this — it is
   cheap and removes all doubt — but see the correction below: the stated reason
   does not actually apply to this app.)
4. Verify: a deployment newer than `21c25fc`; sign in, and
   `/settings/organization` still loads (it exercises the service-role path).
   **Do NOT look for `sb_publishable_…` in the page — see below.**
5. Supabase → API Keys → **Legacy anon, service_role** tab → **Disable
   JWT-based API keys**. This is the step that actually revokes it. Nothing on
   the *Publishable and secret* tab does.

**Pre-flight done for you on 2026-08-02 — the swap is safe.** Two things that
would have made step 2 a production incident were checked instead of assumed:

- **No code assumes the JWT key format.** Every use of
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`
  (`lib/supabase/{client,server,admin,public}.ts`, `proxy.ts`) passes the env var
  straight to `createClient`. Nothing decodes it, reads its claims, or matches
  its shape.
- **The publishable key really works against hosted.** Tested live with
  `sb_publishable_OLvLtIvinqqMuY-Y4ppIEg_Bj9ldXxj`: PostgREST accepts it as
  `anon` (protected tables answer `42501 permission denied`, i.e. RLS refusing —
  not the key being rejected), `contacts` returns no PII, and
  `resolve_share_link` — the one RPC a buyer's proposal link needs — returns
  `200 null` for an unknown token. So B3 links keep working after the swap.

**Correction to step 3/4: no Supabase key of any kind reaches the browser.**
Step 4 told you to confirm "the live page ships `sb_publishable_…`". **There is
nothing there to find, before or after the rotation** — so following it as
written would show you an empty result and imply the redeploy failed, which is
exactly the misread that cost eight attempts last time.

Verified three independent ways on 2026-08-03:
- `createBrowserClient` is called in exactly one place, `lib/supabase/client.ts`,
  and **nothing imports that module**. The app is server components + server
  actions throughout.
- None of the 63 chunks in a production `.next/static` build contains a
  JWT-shaped string, or even `supabase.co`.
- The same scan over the chunks prod actually serves on `/login` found neither
  the legacy key nor a publishable one.

`NEXT_PUBLIC_SUPABASE_ANON_KEY` **is** still load-bearing — `lib/supabase/
server.ts`, `lib/supabase/public.ts` and `proxy.ts` all read it — but they run on
the server. So the honest verification for that half is simply **that you can
sign in**: a wrong publishable key makes GoTrue reject the session, and step 4
already has you sign in to reach `/settings/organization`. The two halves of
step 4 therefore cover both keys between them, once the impossible sub-check is
removed.

Leave the cache-off redeploy in place anyway — it costs nothing and rules out
any server-side build-time inlining.

**A trap this uncovered, now fixed (commit below).** The client-bundle leak test
in `tests/e2e/security.spec.ts` asserted `not.toContain("service_role")`. A
modern `sb_secret_…` key contains no such string, so **the moment you finish
this rotation that guard would have gone on passing while no longer able to
detect a leaked secret key.** It now also scans for `sb_secret_` and for any
non-publishable `sb_` key. Proven by planting a fake secret in the login bundle
and watching the old assertions pass while the new one caught it.

**Test that it worked — no need for the old key's value.** The exposed key lives
only in the 2026-07-31 transcript, so a later session cannot curl it. Use the
Supabase connector instead: `get_publishable_keys` returns the legacy `anon`
entry with a `disabled` field.

- **Before:** `{"name":"anon","type":"legacy","disabled":false, … "iat":1783611943}`
- **After disabling:** that entry reads `disabled: true` (or is gone).

Both legacy keys — `anon` and `service_role` — are JWTs signed by the same
secret and share that `iat`, so the state of one tells you the state of the
other. If `anon` is disabled, the exposed `service_role` key is dead too.

Then confirm production still serves: `/login` 200, and `/settings/organization`
loads for a signed-in admin (that page uses `createAdminClient()`, so it is the
one that proves the replacement secret key is actually wired).

If you still have the old value to hand, the direct check is a request to
`/rest/v1/organizations?select=id&limit=1` with it as both `apikey` and
`Authorization: Bearer` — must return **401**, not 200.

**The blocker is narrower than it looked — git pushes deploy fine.** Checked via
the Vercel connector on 2026-08-03: every one of the day's six pushes produced a
`READY` production deployment, automatically. So the Git→Vercel pipeline is
healthy and it is specifically the **dashboard's** env-save and Redeploy controls
that were swallowing actions.

**Therefore: never use the Redeploy button for this.** After saving the env vars,
push any commit — that builds a fresh deployment with the new environment and
gives you a SHA to verify against. Confirm it with `list_deployments` and match
`meta.githubCommitSha`; a positive observation beats an absence.

Note the old step-4 check "a deployment newer than `21c25fc`" is now useless —
production passed that six deployments ago. Compare against the SHA you just
pushed instead.

**Order matters and is not negotiable: deploy → verify → then disable.** Vercel
injects env vars at deploy time, so until a new deployment is live, production is
still authenticating with the OLD keys. Disabling the legacy keys before that
revokes what the running app is actively using.

**Known blocker:** as of 2026-07-31 the Vercel dashboard would not persist env
edits — the rows still read *Updated Jul 15 / Jul 11* after several attempts, and
no redeploy was ever created. A **"Secure Your Account with 2FA" interstitial**
was blocking the dashboard and is the likely cause; it was skipped, but the
edits still did not save. If the dates will not change, use the CLI instead —
it prints real errors rather than failing silently:

```bash
npx vercel login && npx vercel env rm SUPABASE_SERVICE_ROLE_KEY production && npx vercel env add SUPABASE_SERVICE_ROLE_KEY production && npx vercel --prod
```

</details>

---

## 2c. Other operator-only items

**Leaked-password protection is still off — and it is NOT a free toggle.**
Established 2026-08-03: the setting is gated to **Supabase Pro** on this
project's plan, so closing it is a spend decision, not a click. Previous
handoffs implied it was one switch away and that was wrong. Until the plan
changes, the advisor finding `auth_leaked_password_protection` will keep
appearing and should be read as *accepted*, not *unnoticed*. Not reachable by
agent in any case: the Supabase connector has no auth-config tool, and the
setting is platform config rather than database state (the `auth` schema holds
only data tables — there is no `auth.config` to write).

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

A fourth, learned on 0024: **a self-healing step can hide the bug it heals.**
Step 5 re-homes stranded tasks in the *same* invocation that mints them, so a
test asserting on the final `tasks.assignee_id` passed even with the buggy arms
put back. Confirmed by actually reverting them rather than reasoning about it.
Test 26 now also asserts the assignee **as minted**, read from the
`followup_task_created` event written before the sweep. Whenever a job both
creates and repairs in one pass, assert on the creation event, not the row.

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
- **C1 finishes via Sentry — DSNs set 2026-08-03.** The `/api/csp-report`
  handler calls `Sentry.captureMessage`; `instrumentation.ts` (server, reads
  `SENTRY_DSN`) and `instrumentation-client.ts` (browser, reads
  `NEXT_PUBLIC_SENTRY_DSN`) are both genuinely DSN-gated — re-verified by reading
  them, not assumed — so each is a true no-op without a value. `csp.ts` adds the
  Sentry origin to `connect-src` from `NEXT_PUBLIC_SENTRY_DSN` via `proxy.ts`.
  **Nothing was built for this; it was configuration only.**
  - **Both vars matter and they do different jobs.** `SENTRY_DSN` is what gives
    C1 its durable sink (the CSP handler runs server-side).
    `NEXT_PUBLIC_SENTRY_DSN` instruments the browser *and* is what puts the
    Sentry origin in `connect-src` — set only the first and the policy would
    block Sentry the day it is enforced.
  - **How to verify the DSNs actually took effect**, since env changes need a
    new deployment and the dashboard cannot be trusted to report one: the
    `content-security-policy-report-only` response header must gain the Sentry
    origin. Before it was set, production served exactly
    `connect-src 'self' https://yjgirvzgoiywdojnpkpd.supabase.co wss://yjgirvzgoiywdojnpkpd.supabase.co`
    — so the origin appearing is a positive observation, not an absence.
    That header proves `NEXT_PUBLIC_SENTRY_DSN` only; `SENTRY_DSN` is proved by
    a CSP report actually landing in the Sentry project.
  - Source-map upload is deliberately skipped (no build plugin), so client stack
    traces arrive minified. `tracesSampleRate` is 0.1 on both — errors and
    messages are unsampled, only performance traces are.
- **The `execute_sql` permission entry stays** in `.claude/settings.local.json`.
  Deliberate: it permits any SQL through that tool in this directory, in future
  sessions too. Kept because the alternative cost half a session, and every
  migration today was applied in separate verified steps with a body-diff
  against local afterwards. Remove the line to restore the block.
- **B9 is closed, not deferred** — the desk works in English. See IMPROVEMENTS.

**Left, both gated on an operator decision:**
- **B4 documents** — which documents? Do not invent legal text for a Cyprus agency.
- **B5 map** — tile provider, and it now needs a CSP `img-src`/`connect-src` call.

**Decision-free work that is left is bug-shaped, not roadmap-shaped.** The
roadmap itself is exhausted, but `docs/BACKLOG.md` holds diagnosed defects that
need no decision — that is where to look next, not IMPROVEMENTS. The two named
here on 2026-08-02 are both dealt with (0024, and the `csp.spec.ts` residue fix
in §6). What remains there is mostly nice-to-have, with one genuine follow-up:
- **Human-assigned tasks are still stranded by deactivation** — 0024's sweep is
  deliberately limited to system-generated rows, because re-homing a person's
  deliberate assignment silently is the wrong default. Wants an admin surface
  ("tasks held by deactivated users", with an explicit reassign), which pairs
  with the org-wide overdue/unassigned view already in BACKLOG.

---

## 6. Known gaps

- **CSP is still Report-Only.** Retention is ~1h on this plan, so "browse prod
  then grep for `[csp]`" comes back empty if done later — and empty must not be
  read as clean. Give the endpoint a durable sink (the handler already writes to
  Sentry; it needs a DSN), or check inside the hour.
  - **2026-08-03: doing exactly that found something worse.** Reports *were*
    being delivered — and two of three were answered **413** and discarded,
    with no log line on that path. The 16 KB cap assumed reports are small; the
    `report-to` shape batches violations into one array where every envelope
    repeats `originalPolicy` (the whole CSP string), so ~a dozen violations
    clears 16 KB. Fixed in `42d017d`: cap raised to 128 KB and **the drop is now
    logged**. See DECISIONS `T-csp-413`.
  - Reading the runtime logs is now easy and worth doing after any prod change —
    the Vercel connector exposes `get_runtime_errors` and `get_runtime_logs`
    (`group_by: statusCode` / `requestPath` is fast; full-text `query` tends to
    time out — scope to a `deploymentId` or a narrow window instead).
- **2FA is enforced at the application layer only.**
- ~~Two `csp.spec.ts` tests fail on a freshly reset local DB~~ — **fixed
  2026-08-02.** They now seed their own property and contact when the list is
  empty (preferring a real row when one exists) and sweep them by marker
  afterwards. See DECISIONS `T-csp-fixture`.
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

Expect 437 unit · 30 RLS · 167 E2E passed, 4 skipped (`--list` counts 171
including the self-skips and the `setup` project). The `csp.spec.ts` detail
tests no longer need a populated database — they seed what they need — so a
freshly reset DB is now a clean first run.

```bash
curl -s "https://api.github.com/repos/KALAITSIDIS/gnk-crm/actions/runs?per_page=5"
```

**What CI does and does not cover.** `checks` = typecheck · lint · unit ·
**build** (added 2026-08-03; until then a broken production build was called
green on push and only failed later on Vercel). `rls` = the RLS suite against a
real stack. The build step takes **no secrets on purpose** — `npm run build`
exits 0 with no `.env` at all, verified by moving `.env.local` aside, because
every route is server-rendered on demand and nothing imports
`lib/supabase/client.ts`. If that step ever starts needing secrets, something
has begun reaching the database at build time; investigate that rather than
adding them.

**Playwright still does not run in CI.** All 167 desktop E2E tests — including
the `security.spec.ts` bundle-leak guard — only execute when someone runs them
locally. Adding them needs a Supabase stack plus a dev server in the workflow
(the `rls` job already proves the stack part is possible) and would add real
minutes per push, so it is left as a deliberate choice rather than assumed.
Confirm a step actually RAN before trusting it:

```bash
curl -s "https://api.github.com/repos/KALAITSIDIS/gnk-crm/actions/runs/<RUN_ID>/jobs"
```
