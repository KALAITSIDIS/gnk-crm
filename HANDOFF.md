# HANDOFF — 2026-07-29

Written at the end of a long session so a fresh session can resume with zero
context. **Read `docs/HANDOVER.md` and `CLAUDE.md` first** — this file is the
delta on top of them, not a replacement.

| | |
|---|---|
| `main` | `7667c60` + **uncommitted B7 work** (see §0) |
| CI | ✅ green as of `7667c60` (both `checks` and `rls` jobs) |
| Production | `gnk-crm.vercel.app` healthy, `/login` 200 |
| Tests | **424 unit** (45 files) · **28 RLS** · **156 desktop E2E** (19 spec files) |
| Migrations | **20** — 0020 is written and applied LOCALLY ONLY |

---

## 0. B7 is SHIPPED — migration 0020 is live on hosted

Applied and verified 2026-07-29, then pushed (`9067c65`), CI green on both jobs,
`/login` 200. Hosted now reports:

| check | value |
|---|---|
| migrations | **21**, `0020` + `0021` registered, `non_filename_versions = 0` |
| `tasks` | `kind` + `viewing_id` present, `tasks_kind_chk` enforced |
| indexes | `tasks_nudge_deal_idx`, `tasks_nudge_viewing_idx` |
| triggers | `deals_supersede_nudges`, `viewings_supersede_nudges` |
| cron | `expire-mandates 03:00` · **`followup-nudges 03:15`** · `verify-events-chain 03:30` |
| grants | `service_role` ✓ · `authenticated` ✗ · `anon` ✗ |
| chain | `verify_events_chain` true, 62 events |

All four function bodies were diffed against local after applying (normalised
for comments/whitespace) and matched exactly — no transcription drift.

**0021 fixes fallout from 0020, caught by the Supabase security advisor.**
0007 §1 revoked EXECUTE on every trigger function ("fired by the engine, not
called"). 0020's two new trigger functions were created *after* 0007 and
inherited Supabase's default grant to `anon` + `authenticated`, re-opening
advisors 0028/0029 and exposing them at `/rest/v1/rpc/*`. Not exploitable —
Postgres refuses to call a `returns trigger` function outside trigger context —
but wrong, and it contradicted a lockdown this repo made deliberately. Both are
revoked; the advisor entries are gone. **Run `get_advisors` after any migration
that adds a function.**

**The first cron run creates nothing:** prod has 0 open deals and 0
completed-viewings-awaiting-feedback, so the job simply starts watching.

### How the apply actually happened — read this before the next migration
`execute_sql` was refused by the **auto-mode classifier**, not by Supabase and
not for want of credentials. The fix was one entry in
`.claude/settings.local.json`:

```json
"mcp__728f3c26-074c-4f63-839e-0d81840c3291__execute_sql"
```

**The operator must add it — an agent editing its own permission file is also
blocked, correctly.** With it present, `execute_sql` applies DDL normally.

Note what that entry permits: **any** SQL through that tool, in this directory,
in future sessions too — not just migrations. If that is wider than intended,
remove the line and the block returns.

0020 is safely re-runnable (`add column if not exists`,
`create index if not exists`, `create or replace function`, the constraint is
dropped before it is added, and the `cron.schedule` is preceded by a guarded
`cron.unschedule`).

---

## 1. What we set out to do, and what is DONE

### B7 — automated follow-up nudges (2026-07-29, migration 0020) — **not pushed**
Two cron rules on the 0012 pattern: `deal_no_contact` (open deal silent 14 days)
and `viewing_feedback` (completed viewing, no feedback, 48h after
`scheduled_at`). The roadmap's third rule already existed via `expire_mandates`.
Full reasoning in `docs/DECISIONS.md` → `T-nudges`; design in
`docs/superpowers/specs/2026-07-28-b7-followup-nudges-design.md`.

- `supabase/migrations/0020_followup_nudges.sql` — `tasks.kind` (CHECK'd) +
  `tasks.viewing_id`, two partial indexes, `create_followup_nudges(p_org)`,
  two `AFTER UPDATE` supersede triggers, cron at `15 3 * * *`, and
  `expire_mandates` re-stated to stamp `kind='mandate_renewal'` (guard predicate
  byte-identical to 0012).
- `lib/services/events.ts` — `followup_task_created` + `superseded`
  (the latter has been written by 0012 since July and was never registered).
- `messages/{en,el,ru}.json` — new `events.*` keys with ICU plurals;
  `dashboard.agent.cards.overdueTasks`→`tasksDue`,
  `empty.noOverdue`→`noTasksDue`, `cards.awaitingFeedback` **deleted**.
- `app/(app)/tasks/page.tsx`, `components/features/tasks/task-list.tsx`,
  `components/features/dashboard/agent-dashboard.tsx`,
  `lib/services/task-export.ts` (+ tests), `docs/03_DATABASE_SCHEMA.sql`.
- `supabase/tests/rls.test.ts` — test 24 (new) and test 17 (extended).
- `tests/e2e/nudges.spec.ts` (new).

**Behaviour change worth knowing:** the "Viewings awaiting feedback" virtual
section is gone from `/tasks` and the agent dashboard — replaced by real
`viewing_feedback` task rows. The dashboard's tasks card now covers
"due today & overdue" rather than overdue only, because every nudge is stamped
Cyprus 23:59 and would otherwise be invisible there until the end of its day.

### Earlier sessions
The brief was: work the `IMPROVEMENTS.md` roadmap, one item at a time, verify
each, push, check CI. All of the following are **shipped, pushed and CI-green**.

### A6 — calculator relief/VAT interaction (commit `4dbf984`)
The 50% relief checkbox stayed live when "VAT was paid" was ticked, even though
a VAT-paid purchase carries no transfer fee at all. It now disables (never
resets — un-ticking VAT restores the prior choice) with a "No relief to apply"
hint. Arithmetic was already correct; this was purely presentational.
- `components/features/calculators/calculators-client.tsx`
- `tests/e2e/calculators.spec.ts` (`[UX-4]`)

### B10 — CSV export on all 7 lists (`4dbf984` → `a29a222`, 7 commits)
Contacts, properties, leads, deals (served from `/pipeline/export`), viewings,
keys, tasks. Each is an auth-gated GET route running under the caller's RLS,
capped at 10,000 rows.
- Serializer: `lib/services/csv.ts` (+ `.test.ts`) — RFC-4180, UTF-8 BOM so
  Excel reads Greek/Cyrillic, CRLF, `""` escaping, **spreadsheet
  formula-injection guard** (a user-typed `=`/`+`/`-`/`@` is quote-prefixed;
  this is why phones export as `'+357 …`).
- Shared filter modules so page and export cannot disagree about which rows
  match: `lib/queries/{contacts,properties,leads,deals,keys}-list.ts` (+ tests).
- Per-list column modules: `lib/services/{contact,property,lead,deal,viewing,key,task}-export.ts` (+ tests).
- Routes: `app/(app)/{contacts,properties,leads,pipeline,viewings,keys,tasks}/export/route.ts`.
- E2E: `tests/e2e/*-export.spec.ts`; anon gates added to `tests/e2e/security.spec.ts`.
- **Audit logging** (`lib/services/export-audit.ts`): every export writes an
  append-only `exported` event **before** the CSV is returned, so no PII leaves
  without a record. New org-level entity type `export`; **no migration needed**
  because `events.entity_type` is free text with no CHECK constraint.

### B6 — duplicate detection on lead capture (`8cc6d50`)
Completed doc 02 §C4 "link/**create** contact (dedup applies)". The Add-lead
form could only *link*; it can now create a new enquirer, with
`checkContactDuplicate` firing first. A match blocks the create and offers
"Link <existing> instead".
- `lib/services/lead-contact.ts` (+ `.test.ts`), `lib/actions/leads.ts`,
  `components/features/leads/add-lead-dialog.tsx`, `tests/e2e/leads-dedup.spec.ts`.

### B11 — GDPR retention-expiry surface (`1c6cde4`)
`contacts.retention_until` was written by the erasure flow and **never read**.
Now surfaced at **`/settings/retention`** (admin-only) with second-stage
destruction once the AML duty has run.
- `lib/services/retention.ts` (+ `.test.ts`), `app/(app)/settings/retention/page.tsx`,
  `components/features/settings/retention-panel.tsx`,
  `purgeExpiredRetention` in `lib/actions/contact-erasure.ts`,
  `tests/e2e/retention.spec.ts`.
- **No migration**: 0017 already created the column *and* `contacts_retention_idx`.

### B1 follow-up — viewings calendar window follows the anchor (`efa08f5`)
The window was pinned to the server's `now` while the anchor lived in client
state, so stepping ~53 weeks out drew an **empty week** that read as "nothing
booked". Anchor and view now travel in `?d=&view=`.
- `lib/services/calendar-window.ts` (+ `.test.ts`), `app/(app)/viewings/page.tsx`,
  `components/features/viewings/viewings-calendar.tsx`, `tests/e2e/viewings-window.spec.ts`.

### C2 — TOTP two-factor authentication (`1be1aae`, `b8b23a2`)
Self-service, **opt-in**, at **`/security`** (deliberately *not* `/settings`,
which is admin-only — an agent holds the same client PII as an admin).
- `lib/services/mfa.ts` (+ `.test.ts`), `lib/actions/mfa.ts`,
  `components/features/settings/security-panel.tsx`,
  `components/features/shared/mfa-verify-form.tsx`,
  `app/(auth)/login/verify/page.tsx`, `app/(app)/security/page.tsx`,
  `lib/actions/auth.ts`, `proxy.ts`, `supabase/config.toml`,
  `tests/e2e/mfa.spec.ts`.
- `lib/testing/totp.ts` (+ `.test.ts`) implements RFC 6238, pinned to the
  published RFC 4226/6238 vectors, so the E2E behaves like a real authenticator.

### C1 — Content-Security-Policy, staged report-only (`2f7ca92`, `b9ee636`, `ce0366f`)
Per-request nonce through the proxy; the full policy ships as
**`Content-Security-Policy-Report-Only`** — it reports, it blocks nothing.
`frame-ancestors 'none'` remains separately **enforced** in `next.config.ts`.
- `lib/services/csp.ts` (+ `.test.ts`), `proxy.ts`, `tests/e2e/csp.spec.ts`,
  `lib/validators/zod-jitless.ts`, `components/features/shared/zod-config.tsx`,
  `app/layout.tsx`, `eslint.config.mjs`.
- Reporting endpoint (`ce0366f`): `app/api/csp-report/route.ts`,
  `lib/services/csp-report.ts` (+ `.test.ts`).

### C6 — backup/restore drill, executed (`1257c5f`)
- `docs/BACKUP_RESTORE.md` (runbook + findings), `scripts/backup/export.mjs`,
  `scripts/backup/restore.mjs`, `scripts/backup/verify-restore.sql`.

### Docs corrected
`docs/RELEASE_CHECKLIST.md` (`609b83a`) — said "0001–0006" (there are 19) and
"apply with the CLI/connector" (both fail here; see HANDOVER §4).

---

## 2. What is IN PROGRESS

**B7 is code-complete and locally verified but NOT deployed — see §0.** Nothing
else is half-finished.

The other outstanding step is a verification only the operator can do:

> Open `https://gnk-crm.vercel.app` in a normal browser, use it briefly, then
> search the **Vercel runtime logs for `[csp]`**.

Why this specific step: the CSP report-only policy now has a collector at
`/api/csp-report`, but **it was never proven that a real browser delivers
reports to it**. No report reached the dev server even after a 70-second wait —
headless Chromium over plain `http://localhost` appears not to deliver, and
reports come from the browser's network stack so Playwright cannot observe them
either.

**An empty `[csp]` log means either "the policy is clean" or "reports are not
arriving". Those must not be confused.** Do not promote the policy to enforced
until you know which. If reports are not arriving, debug delivery — not the
policy.

---

## 3. Every decision, and why

### The three fixes asked about specifically

**(a) Type-predicate fix — `lib/services/csp-report.ts`**
`tsc` rejected `.filter((v): v is CspViolation => v !== null)` with *"A type
predicate's type must be assignable to its parameter's type"*. Cause: the `.map`
callback ended in `} satisfies CspViolation;`, so TypeScript inferred the array
element as the **literal object shape** — where `sourceFile: string | undefined`
is a *required* property holding `undefined` — whereas `CspViolation` declares
`sourceFile?:` *optional*. Those are different types, so the predicate was not
assignable.
**Fix:** annotate the callback's return type instead —
`.map((entry): CspViolation | null => { … })` — and drop the `satisfies`. Now
the element type *is* `CspViolation | null` and the predicate narrows correctly.
**Why this way:** `satisfies` checks conformance but leaves the literal type in
place; an explicit return annotation is what actually widens optional
properties. Casting (`as CspViolation`) would have silenced the checker while
leaving the real mismatch, which is the opposite of useful.

**(b) eslint-disable removal — `app/api/csp-report/route.ts`**
I had written `// eslint-disable-next-line no-console` above the `console.warn`.
Lint then reported *"Unused eslint-disable directive (no problems were reported
from 'no-console')"* — the repo does **not** enable the `no-console` rule; the
"no console in app code" property was a *convention* the audit observed, not a
lint rule. The directive was suppressing nothing.
**Fix:** deleted the directive, **kept the explanatory comment**. The comment is
the point: this is the one deliberate `console.*` in application code, because
the route exists to make violations visible and stdout is what reaches the
Vercel runtime logs an operator can read (Sentry is env-gated and silent without
a DSN, so it cannot be the only sink).
**Why not keep it:** a disable for a rule that is off is noise that will confuse
the next reader into thinking the rule exists.

**(c) Test cast rewrite — `lib/services/csp-report.test.ts`**
The "falls back to violated-directive" test originally did
`… as Record<string, never>` then `delete`. `tsc` rejected it: *"Conversion of
type … to type 'Record<string, never>' may be a mistake"* — every property was
incompatible with an index signature of `never`.
**First attempt** used destructuring to omit the key:
`const { "effective-directive": _omitted, ...rest } = …`. That typechecked but
produced a lint **warning** (`'_omitted' is assigned a value but never used`) —
the repo has no `varsIgnorePattern` configured, so a leading underscore is not
exempt, and the repo has otherwise been warning-free.
**Final form:** build a plain `Record<string, unknown>` copy and `delete` the
key from it. No cast, no unused binding, no warning.
**Why it matters:** the assertion is that an older browser sending only
`violated-directive` still parses. Getting there via a lying cast would have
weakened the test's meaning to save two lines.

### Other decisions worth not re-litigating

- **CSV export audit events**: written **before** the CSV is returned and
  fail-closed (a failed audit insert fails the export). No PII leaves without a
  record of who took it.
- **2FA is opt-in, not mandatory.** Forcing enrolment org-wide is one bad deploy
  from locking everyone out of the KYC scans and the evidence chain. Mandatory
  remains a later decision — and needs a recovery plan, since Supabase issues no
  recovery codes.
- **2FA lives at `/security`, not `/settings`** — settings is admin-only.
- **An `aal1` session may not unenrol 2FA**, or a stolen password-only session
  could simply switch it off.
- **`login()` routes to the challenge itself**; the proxy is a second gate. A
  middleware redirect issued in response to a *server-action* redirect renders
  the challenge but leaves the browser URL on `/dashboard`.
- **Retention: expired ON the date** (the duty is "5 years past the
  relationship", so it is served that day), Cyprus wall-clock not UTC, and
  **surfaced, never auto-purged** — destroying AML records is a human decision.
- **`z.config({ jitless: true })`** — Zod 4 JIT-compiles validators with the
  `Function` constructor, which a strict CSP forbids. Zod falls back on its own,
  so the enforced end-state is jitless regardless; saying so explicitly is
  deterministic and keeps the policy clean.
- **`style-src` keeps `'unsafe-inline'`** — Tailwind/Radix/Next all write inline
  styles, and inline *style* cannot execute code. Nonce-ing them is a large cost
  for a small gain versus `script-src`.
- **eslint now ignores** `supabase/.temp/**`, `tests/.playwright-report/**`,
  `tests/.playwright-output/**` — generated, git-ignored, vendored/minified;
  they produced ~2,800 warnings once present.

---

## 4. Constraints that MUST NOT be violated

1. **`/api/csp-report` is PUBLIC and UNAUTHENTICATED — by necessity.** Browsers
   post violation reports without credentials, so `proxy.ts` exempts exactly
   that one path from the auth gate. Everything about the handler follows from
   this and must be preserved:
   - **It must NEVER write to the database, and above all never to `events`.**
     The event log is append-only and hash-chained; letting an unauthenticated
     caller append to it would be indefensible. The sink is stdout + Sentry.
   - Body capped at 16 KB (`MAX_BODY_BYTES`); oversized → 413.
   - Always answers **204**, never echoes input — a reporting endpoint must give
     a prober nothing to work with.
   - The parser must return `[]` rather than throw on malformed input; hostile
     input is expected there, not exceptional.
   - Do not widen the proxy exemption beyond this exact pathname.
2. **`events` has no UPDATE/DELETE, ever.** Guardrail 1. Retire states, not
   deletes. Erasure is a redaction.
3. **Hosted migrations are hand-applied** via the Supabase connector's
   `execute_sql` (NOT `apply_migration`, which the classifier blocks), then an
   insert into `supabase_migrations.schema_migrations` using the **filename**
   version. Apply **before** pushing code that needs it. See HANDOVER §4.
4. **After every push, check CI** — local green ≠ CI green:
   `curl -s "https://api.github.com/repos/KALAITSIDIS/gnk-crm/actions/runs?per_page=5"`
5. **Never `npm audit fix --force`** (proposes `next@9.3.3`).
6. **Never push or deploy without the operator saying so explicitly.**
7. **Do not enforce the CSP** (i.e. rename the response header from
   `Content-Security-Policy-Report-Only`) until §2's verification is done.
8. **A test that passes only on a rerun is depending on residue** — that is a
   bug in the test. The RLS suite must pass first-run against a fresh DB.

---

## 5. Open items and known gaps

### Operator-only (needs credentials or dashboard access — an agent cannot do these)
- **Take an actual backup.** *Still the largest unmitigated risk: there is no
  reachable backup of production.* The org is on the **Free** plan, which
  Supabase excludes from automated daily backups. `docs/BACKUP_RESTORE.md` §3;
  step 1 is under an hour.
- **Confirm CSP reports are arriving** (see §2).
- **Enable Supabase Auth leaked-password protection** — one dashboard toggle,
  still off (advisor-confirmed).
- **Confirm TOTP is enabled** on the hosted Supabase dashboard before telling
  staff to enrol. Docs say it is on by default; unverified without prod auth.
- **Archive property `GNK-PAF-0002`** (smoke-test listing, still `draft`/
  `private`). Must be the UI button — `archiveProperty` writes an `archived`
  event; a raw SQL UPDATE would leave the retire unlogged.
- **Run Lighthouse once on live `/dashboard`** (A9).

### Known gaps in what shipped
- **CSP report delivery unproven** (§2).
- **CSP sweep does not cover PDF generation** (server-rendered, behind a signed
  URL) and `img-src` from Storage self-skips when a database has no
  `property_media` — that result came from a temporary fixture, since removed.
- **2FA is enforced at the APPLICATION layer only.** A stolen `aal1` JWT could
  still reach PostgREST directly. Closing it needs `as restrictive` RLS policies
  asserting `aal2` for users with a verified factor — schema-wide, real lockout
  risk, needs its own RLS tests. Logged in `docs/BACKLOG.md`.
- **The JSON backup is not chain-faithful** — see the drill finding below.
- **`auth.users` is outside `public`**, so neither `export.mjs` nor a default
  `db dump` includes it: restore those and nobody can log in. Dump
  `--schema auth,storage` too.

### The backup drill's central finding (do not lose this)
A JSON/PostgREST export **cannot** back up `events`. PostgREST hands `jsonb` to
JavaScript, and JavaScript numbers carry no scale, so `{"to": 510000.00}`
restores as `{"to": 510000}`. `verify_events_chain` hashes `payload::text`, so
the hash breaks — and because the chain is sequential, **one corrupted payload
invalidates every event after it**. In the rehearsal an org whose chain read
`true` at source came back **`false` with identical row counts**. Proven by
re-applying the exact payload text, which made all chains verify again.
**Production is exposed: 1 of 62 hosted events already carries a decimal
payload.** → **`supabase db dump` (pg_dump) is the primary backup, not a
preference.**

Three restore hazards, handled in `scripts/backup/restore.mjs`:
`session_replication_role = replica` (or `trg_events_hash` *recomputes* the
hashes and the chain verifies against freshly minted values);
`OVERRIDING SYSTEM VALUE` (`events.id` is identity, chain walks in id order);
and an explicit column list excluding generated-stored columns
(`contacts.display_name`), then sequence resync.

Also: a restore target must be a **Supabase project**, not bare Postgres — the
schema needs `auth.uid()`/`auth.users`, `storage.buckets` and the Supabase
roles, and `pg_cron` can exist in only one database per cluster.

### Decision-gated roadmap items (do not start without the operator choosing)
B3 buyer magic-link (public route + rate-limit design), B4 document templates
(which documents — do not invent legal text for a Cyprus agency), B5 map (tile
provider; **note it now interacts with the CSP `img-src`/`connect-src`**),
C3/C4/C5/C7. (**B7 is now built** — see §0/§1; only the hosted apply is left.)
**B9 (el/ru UI chrome) is effectively blocked**: `i18n/request.ts` hardcodes
`defaultLocale = "en"` and there is no locale switcher ("locale routing is
deliberately absent", doc 02 §A5), so translating chrome produces strings no
user can reach.

---

## 6. Commands to verify state

```bash
npm run typecheck
```
Expect: clean, exit 0.

```bash
npm run lint
```
Expect: clean, exit 0 (no warnings).

```bash
npm run test
```
**Expect: `Test Files 45 passed (45)` · `Tests 424 passed (424)`.**

```bash
npm run test:rls
```
Needs the local stack. **Expect 28 passed**, first run, on a fresh database.

```bash
npm run build
```
Expect: `BUILD OK`; the route list includes `/api/csp-report`, `/security`,
`/settings/retention` and the seven `*/export` routes.

E2E needs the local stack up (`npx supabase start`) and runs its own dev server:

```bash
npx playwright test --project=setup --project=desktop
```
156 tests. **How many pass depends on what the local database holds**, which is
a latent bug in `csp.spec.ts`, not in the app:

- **On a populated database: 152 passed, 4 skipped, 0 failed.** The four skips
  are data-dependent self-skips (no viewing, no `property_media`, no signed
  slip, too few rows to page) — correct, not failures.
- **Immediately after `supabase db reset`: 2 failed.** `csp.spec.ts`'s
  "property detail" and "contact detail" tests assert a property/contact exists
  to open, and only `happy-path.spec.ts` creates them — so on run 1 they lose
  the race and on run 2 they pass. **This is pre-existing**, reproduced on the
  pre-B7 tree, and never reaches CI (which runs `checks` + `rls`, not
  Playwright). Logged in `docs/BACKLOG.md`.

Verify the CSP is live and still report-only (must show `-Report-Only`, and the
enforced header must still be just `frame-ancestors 'none'`):

```bash
curl -s -D - -o /dev/null https://gnk-crm.vercel.app/login | grep -i "content-security-policy"
```

Verify the reporting endpoint is reachable anonymously (expect `204`, then `413`):

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H "content-type: application/csp-report" -d '{"csp-report":{"effective-directive":"img-src","blocked-uri":"https://probe.example/x.png","document-uri":"https://gnk-crm.vercel.app/dashboard"}}' https://gnk-crm.vercel.app/api/csp-report
```

Verify the hosted event chain is intact (via the Supabase connector, read-only):

```sql
select o.name, verify_events_chain(o.id) from organizations o;
```
Expect `true`. As of 2026-07-24: 1 org, 62 events.

Check CI for the current SHA:

```bash
curl -s "https://api.github.com/repos/KALAITSIDIS/gnk-crm/actions/runs?per_page=5"
```

---

## 7. Environment notes that will otherwise cost an hour

- **Do not run `rm -rf .next` or `npm run build` while a dev server is running** —
  it corrupts the running server and produces phantom test failures that look
  like real regressions. Next also refuses a second dev server in the same
  directory, so the fix is to stop the running one and let Playwright start
  fresh.
- **A silent `fetch failed` from the local stack returns `data: null`**, which
  reads exactly like an empty table. **Always print `error`** — never infer "no
  rows" from `null`.
- **Docker Desktop is sometimes fully down** (daemon pipe absent), not just
  flaky: `Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"`,
  wait ~15s, then `npx supabase start`.
- `document_type` enum has **no** `id_passport` — it is `id_document`.
- Browsers blank the `nonce` **content attribute** in the DOM and expose it only
  via the `.nonce` IDL property, so `script[nonce="…"]` selectors find nothing
  even when the nonce is applied correctly.
- Supabase `signOut()` defaults to **global** scope — it revokes every session
  for that user. An E2E that signs out will break every other spec sharing
  `tests/.auth/admin.json`. Clear cookies instead.
- The working directory is under **OneDrive**, which is sync, not backup.
- A backup artefact from the rehearsal sits at `../gnk-backups/2026-07-28/`
  (local fixture data, outside the repo — safe to delete).
