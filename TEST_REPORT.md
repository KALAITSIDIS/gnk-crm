# GN Real Estate OS — Full QA, Security & Improvement Audit

**Date:** 2026-07-22 · **Branch:** `qa/full-audit` · **Commit under test:** `853839a`
**Local:** Next.js 16.2.10 + local Supabase stack · **Live:** https://gnk-crm.vercel.app (read-only probing only)

---

## 1. Executive summary

This is a **well-built codebase**. That is not reassurance — it is the finding. Typecheck, lint, 258 unit tests, 25 RLS tests and a production build all pass with zero errors and zero warnings. All 11 sidebar modules load clean at 1280px and 390px with **no console errors, no 4xx/5xx, no failed requests and no horizontal overflow**. The event-log-first architecture, the row-count guards on every server action, and the tested-not-trusted RLS matrix are genuinely above the standard for an internal CRM. Seven prior module-by-module audit passes show in the code.

The defects that remain are concentrated in three places:

1. **The money the app quotes to buyers.** The Cyprus constants are correct, but transfer fees were assessed on the whole purchase price instead of **per purchaser's share** — the seeded config's own description says "per purchaser share". A couple jointly buying at €300,000 was quoted **€8,600 when the correct figure is €5,800**. Joint purchases are the norm in Paphos. **Fixed in this branch** (CALC-1).
2. **The perimeter.** The app shipped with **no security headers at all** — no `X-Frame-Options`, no CSP, no `nosniff`, no `Referrer-Policy`, on local *and* on production. For an app whose admin can irreversibly erase a contact's personal data in one click, framing was a real risk. **Fixed during this audit and covered by tests; needs a deploy to reach production.**
3. **Behaviour at volume.** Four list screens (`/leads`, `/viewings`, `/tasks`, `/keys`) apply a hard row cap with no pagination and no "showing X of Y" notice, while their headers show exact counts. Past the cap the header and the visible rows silently disagree — the same defect class as the 2026-07-21 list-scope fix, triggered by volume instead of status.

**Three findings were fixed in this branch** (CALC-1 per-purchaser fees, CALC-2 config validation, SEC-1…4 security headers), each with tests that fail loudly on regression. The rest are reported with proposed fixes, not implemented — scaling this list down is the operator's call.

### Verification evidence

| Gate | Result |
|---|---|
| `npm run typecheck` | ✅ clean |
| `npm run lint` | ✅ 0 errors, 0 warnings |
| `npm run test` (unit) | ✅ **283 passed** (24 files) — was 225 before this audit |
| `npm run test:rls` | ✅ **25 passed** |
| `npm run build` | ✅ compiled in 21.4s, no warnings |
| `npx playwright test` | ✅ **122 passed** (desktop 1280px + mobile 390px) |
| `npm audit --omit=dev` | ⚠️ **4** vulnerabilities (1 moderate, 3 high) — was 7; all remaining are inside Next's bundled tree, see DEP-2 |

### Pass/fail across all 11 modules

Legend: **Smoke** = automated load/console/network/layout at both viewports. **Flow** = a write path exercised end-to-end in this audit. **Code** = source reviewed this session.

| # | Module | Smoke (desktop) | Smoke (390px) | Flow exercised | Verdict |
|---|---|---|---|---|---|
| 1 | Dashboard | ✅ | ✅ | KPI rollup read after writes | 🟡 **Pass with issue** — PERF-3 silent sum cap |
| 2 | Leads | ✅ | ✅ | ✅ create → list → count → page → retire | ✅ **Pass** (PERF-2 fixed here) |
| 3 | Pipeline | ✅ | ✅ | board + stage totals read | 🟡 **Pass with issue** — UX-3 no test/a11y hooks |
| 4 | Properties | ✅ | ✅ | ✅ create wizard → list → archive | ✅ **Pass** |
| 5 | Contacts | ✅ | ✅ | pagination verified | ✅ **Pass** |
| 6 | Viewings | ✅ | ✅ | window bounds + truncation notice | ✅ **Pass** (PERF-2 fixed here) |
| 7 | Tasks | ✅ | ✅ | ✅ quick-add → list → page | ✅ **Pass** (PERF-2 fixed here) |
| 8 | Keys | ✅ | ✅ | ✅ server-side filter → page | ✅ **Pass** (PERF-2 fixed here) |
| 9 | Reports | ✅ | ✅ | list + chain badge read | ✅ **Pass** |
| 10 | Calculators | ✅ | ✅ | ✅ 14 E2E assertions vs statutory scale | ✅ **Pass** (CALC-1 + CALC-2 fixed here) |
| 11 | Settings | ✅ | ✅ | config-save path reviewed | ✅ **Pass** (CALC-2 fixed here) |

Screenshots: `tests/screenshots/<module>-desktop.png` and `-mobile.png` (22 files).

---

## 2. Findings by severity

### 🔴 Critical

#### CALC-1 — Transfer fees were not assessed per purchaser share ✅ FIXED IN THIS BRANCH

**Module:** Calculators · **Status:** **FIXED** · **Evidence:** `lib/services/calculators.ts` (`computeTransferFees`), `components/features/calculators/calculators-client.tsx`, `supabase/migrations/0003_seed.sql` (transfer_fees description), `tests/unit/calculators.audit.test.ts` → `[CALC-1]` block (10 tests), `tests/e2e/calculators.spec.ts` → `[CALC-1]` (3 specs)

The Cyprus Department of Lands & Surveys transfer-fee scale (3% / 5% / 8%) is **progressive per purchaser's share**, not per contract. The seeded config says so explicitly: *"Department of Lands & Surveys transfer fee bands (progressive, per purchaser share)"*. Neither `computeTransferFees` nor the Calculators screen accepts a purchaser count, so every joint purchase is over-quoted.

**Reproduction**
1. Log in, go to `/calculators`.
2. Enter `300000`. Leave "Apply 50% relief" ticked (it is on by default).
3. Read the Transfer fees total.

**Expected (couple buying jointly, 2 shares of €150,000):**
each share = €2,550 + (€65,000 × 5%) = €5,800 → gross €11,600 → **€5,800 after 50% relief**

**Actual:** €8,600 — the whole €300,000 assessed as a single share (€2,550 + €4,250 + €10,400 = €17,200 gross).

**Impact:** €2,800 overstated on a routine Paphos transaction. An agent quoting purchase costs to a couple gave them a materially wrong number. Over-quoting is commercially safer than under-quoting, but it is still wrong, and the same code path under-quoted nothing only by luck.

**Fix applied**

`computeTransferFees` now takes an optional `purchasers` count, assesses **one share** (`price / purchasers`) against the bands, then multiplies out. `TransferFeesResult` gained `purchasers` and `perShareGross` so the UI can show the working. A "Purchasers" number input (default 1, labelled "Equal shares") sits beside the price field; when it is above 1 the card explains *"Assessed per purchaser on €150.000 each — the bands restart for every buyer"*, shows the per-share band breakdown, then `Per purchaser × 2` → `Gross` → relief → `Total`. The copy summary carries the same structure.

Deliberate details:
- **Stamp duty is untouched.** It is charged on the contract and capped per document, so it must *not* be split per purchaser. There is a test named exactly that, so nobody threads `purchasers` into it later.
- **Equal shares are assumed** — the ordinary case and the only split the screen collects. Unequal shares would need a per-share price list.
- A nonsensical count (`0`, negative, `NaN`, `Infinity`) coerces to 1; a fractional one truncates rather than splitting a person.
- Omitting `purchasers` is byte-identical to the old behaviour, so nothing else that calls this function changed.

**Verified on screen** at `/calculators?price=300000` with purchasers = 2: bands €2.550 + €3.250, `Per purchaser × 2` €5.800, Gross €11.600, 50% relief −€5.800, **Total €5.800** — and stamp duty still €507,50. 10 new unit tests and 3 new E2E specs, RED before / GREEN after.

---

### 🟠 High

#### SEC-1…SEC-4 — No security headers on local or production ✅ FIXED IN THIS BRANCH

**Module:** app-wide · **Status:** **FIXED**, awaiting deploy · **Evidence:** `next.config.ts`, `tests/e2e/security.spec.ts:105`

Production `HEAD https://gnk-crm.vercel.app/login` returned only Vercel's `Strict-Transport-Security`. Absent: `X-Frame-Options`, `Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`. Root cause: `next.config.ts` had no `headers()` function.

| ID | Missing header | Consequence |
|---|---|---|
| SEC-1 | `X-Frame-Options` / `frame-ancestors` | **Clickjacking.** An admin can archive a listing, deactivate a user, or *irreversibly erase a contact's personal data* in one click. UI redressing has real, non-undoable consequences here. |
| SEC-2 | `X-Content-Type-Options: nosniff` | MIME sniffing on user-uploaded content served from Storage. |
| SEC-3 | `Referrer-Policy` | Record UUIDs live in the path (`/contacts/<uuid>`). The full URL leaked to any third-party origin via `Referer`. GDPR-relevant. |
| SEC-4 | `Permissions-Policy` | No restriction on camera/microphone/payment. |

**Fix applied** — `next.config.ts` now sets all five. Deliberately *not* a full CSP: locking `script-src` requires a nonce round-trip through `proxy.ts`, which is a behavioural change (tracked in IMPROVEMENTS.md). `frame-ancestors 'none'` is safe standalone — omitted CSP directives stay unrestricted.

`geolocation=(self)` is retained on purpose: `components/features/viewings/sign-slip.tsx` geotags the signature, and slips are the commission evidence. There is a dedicated regression test for this.

**Verified:** 27/27 security specs pass locally. **Production still needs a deploy of this branch to be protected.**

#### DEP-1 — `shadcn` was a production dependency ✅ FIXED IN THIS BRANCH

**Module:** build/deps · **Status:** **FIXED** · **Evidence:** `package.json`, `package-lock.json`, `npm audit --omit=dev`

`shadcn` sat in `dependencies`, dragging `@modelcontextprotocol/sdk` → `@hono/node-server` into the production dependency tree and accounting for 3 of the 7 audit findings, including a path-traversal advisory in `@hono/node-server`'s static file server.

**Correction to the original write-up.** It said *"it is a code generator — nothing at runtime imports it."* **That was wrong.** `app/globals.css:3` does `@import "shadcn/tailwind.css"`, and the package's exports map resolves it to a real 16 KB stylesheet. So `shadcn` is a genuine **build-time** dependency, not merely a CLI, and anyone acting on the original sentence would have been surprised.

It still belongs in `devDependencies` — that is exactly the home for build-time-only packages, and the compiled CSS is emitted into `.next` so nothing needs the package at runtime. The safety argument is not "unused" but **precedent**: `tailwindcss` is *already* a devDependency and is imported on line 1 of the same file, so this build has always depended on devDependencies being installed at build time (Vercel installs them by default).

**Verified:**
- Clean rebuild after deleting `.next` succeeds, and the emitted CSS chunk is **`40qd1pfdocoh7.css` both before and after — an identical hash, i.e. byte-identical output.** A shadcn-specific token (`--scroll-fade-t`) is still present in it.
- Lockfile now marks `shadcn`, `@modelcontextprotocol/sdk` and `@hono/node-server` as `dev: true`; version stays pinned at 4.13.0.
- **`npm audit --omit=dev`: 7 → 4 vulnerabilities.** The four that remain (`next`, `sharp`, `postcss`, `fast-uri`) are all inside Next's own bundled tree — that is DEP-2, and it is upstream.
- typecheck 0, lint 0, 283 unit, 25 RLS, 122 E2E green.

**Residual risk, stated plainly:** a build run as `npm ci --omit=dev` would now fail at the CSS import. That was already true of `tailwindcss`, so it is not a new constraint — but if a deployment pipeline ever adds `--omit=dev`, both packages need moving back, not just this one.

#### DEP-2 — `next` bundles a vulnerable `sharp` and `postcss`

**Module:** build/deps · **Status:** OPEN (upstream) · **Evidence:** `npm ls sharp`

The app's own `sharp` is `0.35.3` (patched), but `next@16.2.10` bundles `sharp@0.34.5`, which carries the libvips advisories CVE-2026-33327/33328/35590/35591 (**high**), plus `postcss <8.5.10` (moderate XSS in stringify output). `npm audit fix --force` proposes `next@9.3.3` — a catastrophic downgrade; **do not run it.**

**Fix:** wait for a Next patch release and bump, or add an `overrides` entry pinning `sharp` ≥0.35.0 for the nested copy:
```json
"overrides": { "next": { "sharp": "^0.35.3" } }
```
Test the image pipeline after — Next uses its bundled sharp for `next/image` optimization. Exposure is limited: the app processes images through its *own* sharp in server actions, and untrusted image input already goes through `processPropertyImage`.

---

### 🟡 Medium

#### CALC-2 — `cyprus_config` accepted band tables that produce wrong money ✅ FIXED IN THIS BRANCH

**Module:** Settings / Calculators · **Status:** **FIXED** · **Evidence:** `lib/services/calculators.ts:36`, `lib/actions/settings.ts:536`, `tests/unit/calculators.audit.test.ts` → `[CALC-2]` block

`saveCyprusConfig` shape-checks admin edits through `parseTransferFeesConfig` / `parseStampDutyConfig`. The old guard only checked that each band was `{up_to: number|null, rate: number}`. Everything below **saved successfully** and silently produced a wrong fee quoted to a client:

| Bad edit | Old result |
|---|---|
| Bands in descending order | Negative slice → **negative fee** |
| `rate: 3` meaning 3% | **300% fee** — the single most likely Settings typo |
| Open-ended (`up_to: null`) band not last | Loop breaks, **all later bands silently vanish** |
| `relief_pct: 50` meaning 50% | Relief exceeds the gross |
| Negative stamp-duty `cap` | Cap applied as a negative ceiling |

**Reproduction (before fix):** Settings → Cyprus config → `transfer_fees` → change the first band's `rate` from `0.03` to `3` → Save → "Saved" → `/calculators`, enter 300000 → fee quoted in the hundreds of thousands.

**Fix applied:** `isBandArray` now enforces strictly-ascending bounds, a first bound above zero, rates within 0–1, and open-ended bands only in final position; `relief_pct` must be a 0–1 fraction; `cap` must be non-negative. 12 new tests, RED before / GREEN after. The seeded production shapes still parse (existing suite unaffected).

#### PERF-2 — Four list screens were hard-capped with no pagination or disclosure ✅ FIXED IN THIS BRANCH

**Module:** Leads, Viewings, Tasks, Keys · **Status:** **FIXED** · **Evidence:** `lib/validators/pagination.ts` (+13 unit tests), `components/features/shared/pager.tsx`, the four page files; `tests/e2e/performance.spec.ts` → `[PERF-2]` (6 specs)

| Screen | Cap | Paginated? | Header count |
|---|---|---|---|
| `/leads` | `.limit(100)` | ❌ | exact (`count: "exact", head: true`) |
| `/viewings` | `.limit(500)` | ❌ | — |
| `/tasks` | `.limit(200)` | ❌ | exact |
| `/keys` | `.limit(300)` | ❌ | — |
| `/properties` | — | ✅ `.range()` | exact |
| `/contacts` | — | ✅ `.range()` | exact |

Properties and Contacts did this correctly. The other four did not. Past the cap, `/leads` would show "437 open" above 100 rows, and the other 337 were **unreachable through the UI** — there was no next page. This is exactly the header-vs-rows disagreement the 2026-07-21 list-scope fix corrected for status; volume reintroduced it.

**Fix applied**

Rather than a sixth copy of the arithmetic, the pattern was extracted: `lib/validators/pagination.ts` (`LIST_PAGE_SIZE`, `pageSchema`, `pageRange`, `totalPages`, `isRangeBeyondEnd`) plus a shared `<Pager>` that always states *"Showing 1–25 of 437 leads"* — the disclosure half of the fix — and preserves every other query param so paging never drops a filter.

Each screen needed a different shape, and two of them needed more than a `.range()`:

- **Leads / Tasks** — straight pagination. Tasks pages over the whole open set ordered by due date, so the most overdue work stays on page 1 and the Overdue/Upcoming split stays meaningful. Its "N overdue" header became an **exact DB count**, since a page-local count would now describe only the current slice.
- **Keys** — paginating alone would have **broken the register search**: the status and text filters were client-side `useState` over the fetched array, so they would silently have searched one page only. Both moved into the URL and into the query (`components/features/keys/filters.tsx`). The property *reference* lives on a joined table that PostgREST cannot reach from `.or()`, so it resolves to ids first and folds them into the same disjunction. `KeysRegister` is now presentational. The header counts (registered / out) are exact and describe the whole register, never the filtered page.
- **Viewings is a calendar, not a list**, so row pagination is the wrong shape — and the real defect there was worse than a cap. The query was `.gte(now-90d)` with **no upper bound**, ordered ascending, capped at 500: on reaching the cap it silently dropped the **furthest-future** viewings, so bookings simply stopped appearing past some date with nothing on screen saying so. Both ends of the window are now explicit (−90d to +365d), the cap is 2,000, truncation renders a visible warning naming what is hidden, and the "upcoming" header is an exact count independent of the window.

A stale or junk `?page=` is handled everywhere: PostgREST's `PGRST103` (range past the end) renders an empty page with a "Back to the first page" link instead of throwing to the T5.7 error boundary, and unparseable values degrade to page 1.

**Verified in the browser** on 40 seeded leads: page 1 shows 25 rows under *"Showing 1–25 of 40 leads · Page 1 of 2 · Next"*; page 2 shows the remaining 15 as *"Showing 26–40 of 40"*, with Previous preserving `?status=all` and dropping the redundant `page=1`. 13 new unit tests, 6 new E2E specs.

#### PERF-3 — Admin dashboard money totals silently undercount past 2,000 rows

**Module:** Dashboard · **Status:** OPEN (known, in `docs/BACKLOG.md`) · **Evidence:** `components/features/dashboard/admin-dashboard.tsx:102-142,159-160`

`OPEN PIPELINE` and `WON THIS MONTH` are summed **in TypeScript** over rows fetched with `.limit(2000)`; `Listings by status` counts over `.limit(2000)`. Counts use `count: "exact"` and stay honest, but the **€ figures do not** — past 2,000 rows they under-report with no warning on screen.

Not urgent (the desk is far from 2,000 open deals), but it is a *silent* wrong number on the headline KPI, and `Listings by status` is the one plausibly reachable within a few years.

**Fix:** move the aggregation into Postgres — an RPC returning `sum(expected_value)` and `count(*)` grouped by stage, as already scoped in `docs/BACKLOG.md`. Until then, show a "figures capped at 2,000 rows" note when the cap is hit.

#### A11Y-1 — Radix Select triggers have no accessible name, app-wide

**Module:** Properties, Leads, Settings — the **form** Selects · **Status:** OPEN · **Evidence:** `components/features/properties/create-wizard.tsx:67,84,100,116`; `components/features/leads/add-lead-dialog.tsx:99,115,133`; verified in-browser

*Scope correction (2026-07-22):* an earlier draft of this finding said "every `Select` in the app". That is too broad — the **filter** Selects set `aria-label` on the trigger and are fine (`components/features/leads/filters.tsx:48`, and `keys/filters.tsx` added in the PERF-2 pass). The defect is specific to Selects that sit under a visible `<Label>`: the label carries no `htmlFor` and the trigger no `id`, so the two are never associated.

Every `<Label>` above a shadcn/Radix `Select` is a **bare `<Label>` with no `htmlFor`**, and the `SelectTrigger` has no `id`, `aria-label` or `aria-labelledby`. Measured live on `/properties/new`:

```json
[{"i":0,"id":null,"ariaLabel":null,"labelledby":null,"text":"Standalone listing"},
 {"i":1,"id":null,"ariaLabel":null,"labelledby":null,"text":"Select type…"},
 {"i":2,"id":null,"ariaLabel":null,"labelledby":null,"text":"Sale"},
 {"i":3,"id":null,"ariaLabel":null,"labelledby":null,"text":"Select district…"}]
```

A screen-reader user hears "combobox, Select type…" with no indication of which field it is. This is a **WCAG 2.1 SC 4.1.2 (Name, Role, Value)** failure, and SC 1.3.1 for the orphaned labels. It also blocked `getByLabel()` in the E2E suite — the property-creation spec has to select by DOM index, which is documented in `tests/e2e/happy-path.spec.ts`.

**Fix:** give each trigger an id and point the label at it:
```tsx
<Label htmlFor="property-type">Property type</Label>
<Select name="property_type">
  <SelectTrigger id="property-type"><SelectValue /></SelectTrigger>
```
Then simplify the E2E helper back to name-based selection.

---

### 🟢 Low

#### UX-3 — Kanban columns have no test hook, list role or heading
`components/features/pipeline/kanban.tsx:156` — columns are plain `<div>`s; stage names are `<span>`s. No `data-stage-id`, no `role="list"`, no heading element. A screen reader gets an undifferentiated pile of text, and automated tests cannot count columns (the E2E spec asserts on stage *names* instead). **Fix:** add `data-stage-id={stage.id}`, `role="list"` + `aria-label={stage.name}`, and promote the stage name to an `<h3>`.

#### TEST-1 — The RLS suite pollutes the shared local dev database
`npm run test:rls` writes fixtures (`Test admin admin-a-…`, `RLS Stage …`, keys `K18-…`) into the same local Postgres the dev server reads, and never cleans up — because `events` is append-only and RLS denies DELETE. After one run the dev dashboard's "Top agents by activity" and "Latest events" are dominated by test rows. Harmless to production, but it makes local manual verification noisy and makes real data hard to eyeball. **Fix:** run the RLS suite against a dedicated throwaway database/schema, or namespace its org and filter that org out of dev dashboards.

#### SEC-5 — `Access-Control-Allow-Origin: *` on production responses
Production returns `Access-Control-Allow-Origin: *` on the login HTML. Low risk in practice — auth is cookie-based and the header carries no `Allow-Credentials`, so a cross-origin read of authenticated content still fails. Worth removing anyway to avoid a future change turning it into a real leak. Likely Vercel default; check project settings.

#### UX-4 — Relief and "VAT was paid" are presented as independent ticks
`calculators-client.tsx:161-176` — the two checkboxes are logically exclusive (relief applies to transfers *not* subject to VAT; VAT-paid means no transfer fee at all). The computation resolves it correctly (VAT-paid short-circuits first), so the number is right, but leaving "50% relief" ticked and visible next to a nil assessment is confusing. **Fix:** disable/grey the relief tick when "VAT was paid" is on.

---

## 3. Coverage: what was tested, and how

**Phase 0–1 (recon + static health).** Stack confirmed: Next.js 16.2.10 App Router, TypeScript strict, Supabase (Postgres/Auth/Storage/RLS, 17 migrations), next-intl (en/el/ru), Vercel, npm. **No REST API routes exist** — every mutation is a server action, which materially shrinks the attack surface. Static health is excellent: **zero** `TODO`/`FIXME`/`@ts-ignore` in app code, **two** `any`s (both benign index signatures in form types at `contacts/detail-forms.tsx:42` and `properties/detail-forms.tsx:118`), and `console.*` only in the CLI import scripts where it belongs. `.env*` is gitignored, `.env.local` untracked, and the only hardcoded JWTs are the published Supabase local-demo keys in test helpers (`iss: supabase-demo`).

**Phase 2 (automation).** Playwright installed and configured (`playwright.config.ts`), **109 specs across desktop 1280px and mobile 390px, all passing**, in five suites under `tests/e2e/`. The critical path runs end-to-end: log in → create lead → verify inbox count → read pipeline stages → create property through the wizard → verify € formatting in the list → quick-add task → confirm dashboard rollup → retire fixtures.

**Phase 4 (performance).** Measured with the browser's own buffered `PerformanceObserver` rather than Lighthouse (see "not tested" below):

| Page | LCP | CLS | Long tasks | DCL | Transfer | Requests |
|---|---|---|---|---|---|---|
| Dashboard | 648 ms | **0.000** | 2 | 625 ms | 87 KB | 35 |
| Properties | 692 ms | **0.000** | 3 | 661 ms | 87 KB | 38 |
| Reports | 444 ms | **0.000** | 2 | 332 ms | 87 KB | 35 |

CLS of exactly zero on all three is a genuinely good result and the metric a dev server does not distort. Page weight is small. No N+1 query patterns were found — list pages use explicit joins and `Promise.all` batches.

**Phase 5 (security, non-destructive).** All 11 modules plus 9 deep routes redirect anonymous visitors to `/login`. The service-role key was confirmed **absent** from `.next/static` by direct byte comparison against `.env.local`, and again from live JS responses in-browser. Login does not enumerate users and does not put credentials in the URL. Multi-tenant isolation is covered by the existing RLS suite (25 tests, including org-B blindness and the deactivated-live-JWT lockout).

**Phase 6 (unit).** 33 new tests in `tests/unit/calculators.audit.test.ts`; suite total **225 → 258**.

---

## 4. Assumptions made

1. **The seeded Cyprus constants are correct as at 2026-07-22** — I verified them against the statutory scales (transfer 3/5/8% at €85k/€170k with 50% relief and VAT-paid exemption; stamp duty nil/0.15%/0.20% at €5k/€170k capped €20k; VAT 19% standard, 5% reduced on the first 130 m²/€350k within €475k/190 m²). All correct. I am not a Cyprus tax adviser and this is not legal sign-off; `cyprus_config.verified_at` remains the operator's control.
2. **`admin@gnk.local` / `admin1234`** is the intended local seed admin.
3. **Write flows must never touch production**, so all write specs self-skip unless the base URL is localhost.
4. **Hard delete is deliberately absent** (append-only hash-chained `events`), so audit fixtures are retired into the app's own terminal states rather than removed. `supabase db reset` is the only true cleanup.
5. The seven prior module audits recorded in project history are accurate; I verified their *outcomes* (tests green, guards present) rather than re-deriving each one.

## 5. What I could not test, and why

- **Authenticated production flows and Lighthouse on live heavy pages.** Every heavy screen is behind auth; driving them on the client's live deployment means handling production credentials, which I will not do. Performance was measured on the local stack instead — re-runnable and CI-safe. Someone with prod credentials should run Lighthouse against `gnk-crm.vercel.app/dashboard` once.
- **Pipeline drag-and-drop.** dnd-kit sensors do not respond to synthetic pointer input; the keyboard path was verified in a prior session but is not covered by this Playwright suite. Needs a manual pass or a dnd-kit-specific harness.
- **Viewings and Keys write flows.** Both need pre-linked property + contact + agent fixtures; I exercised them read-only and reviewed the code. Their prior audit passes are recorded in project history.
- **Email, reminders, WhatsApp.** Not built in Phase 1 by design (doc 01 §10 Do-Not-Build).
- **Supabase Auth "leaked password protection".** A dashboard toggle, not visible in code; project history records it as still off. **Verify manually.**
- **Real GDPR/AML legal review** of the erasure design. Reviewed as code, not as law.
- **The manual production smoke test** (login + create property + sign slip on live) remains outstanding — it writes real client data and is the operator's to run.

---

## 6. The single most important thing to do first

**Deploy the pagination branch (`fix/perf-2-pagination`).**

CALC-1, CALC-2 and the security headers are already live on production (deploy `dpl_2EXQtW8f8uiUFSmMdGknuC4tqiZq`, verified on `gnk-crm.vercel.app`). PERF-2 is fixed and fully tested but **not yet deployed**.

The part of PERF-2 worth shipping soonest is not the pagination itself — it is the **viewings window**. That query had no upper bound and dropped the furthest-future bookings on hitting its cap, so an agent's calendar could simply stop showing viewings past some date with nothing on screen to explain it. Volume-dependent, silent, and it costs a missed appointment rather than a wrong number.

After that, the remaining list is genuinely hygiene:

1. **A11Y-1** — label the form Selects (~2 hours, WCAG 4.1.2).
2. **PERF-3** — push dashboard money sums into Postgres (known, in `docs/BACKLOG.md`).
3. **DEP-2** — the last 4 vulnerabilities are inside Next's bundled tree; they clear on a Next patch bump. **Never** run `npm audit fix --force` — it proposes `next@9.3.3`.
