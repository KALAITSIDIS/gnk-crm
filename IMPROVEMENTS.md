# GN Real Estate OS — Improvement Roadmap

Companion to `TEST_REPORT.md` (audit 2026-07-22, branch `qa/full-audit`).
Bug fixes live in the test report; **this document is about what to build next**.

Effort is calendar time for one developer already familiar with the codebase.
Existing deferred scope lives in `docs/BACKLOG.md` — items already tracked there
are marked **[BACKLOG]** so this file does not silently fork the roadmap.

---

## A. Quick wins — ≤ 1 day each, high value

| # | Item | Why it matters for a Paphos desk | Effort | Depends on |
|---|---|---|---|---|
| A1 | ~~Per-purchaser transfer fees (CALC-1)~~ | ✅ **Done in `qa/full-audit`.** Joint purchases were quoted €2,800 too much on a €300,000 property. Now assessed per share, with a "Purchasers" field and per-share working shown. | — | ships with the branch |
| A2 | ~~Deploy this branch (SEC-1…4 + CALC-1 + CALC-2)~~ | ✅ **Done 2026-07-22.** `qa/full-audit` fast-forwarded into `main` and deployed; all six security headers verified present on `gnk-crm.vercel.app`, and the live calculator now quotes €5.800 for 300k/2 purchasers. | — | — |
| A3 | ~~Move `shadcn` to devDependencies (DEP-1)~~ | ✅ **Done** in `fix/dep-1-shadcn-devdep`. Production `npm audit` 7 → 4. Note it is a *build-time* dep (`globals.css` imports `shadcn/tailwind.css`), not just a CLI — safe because Vercel installs devDependencies at build, as `tailwindcss` already relies on. | — | ships with the branch |
| A4 | ~~Label every Select trigger (A11Y-1)~~ | ✅ **Done** in `fix/a11y-1-select-labels`. Scoped at ~15 pairs / 2h; actually **40 orphaned labels across 15 files** plus 3 controls with no label at all that only a DOM walk could find. Guarded by `tests/e2e/accessibility.spec.ts`. | — | ships with the branch |
| A5 | ~~"Showing 100 of 437" notice on capped lists~~ | ✅ **Superseded by B1** — real pagination shipped in `fix/perf-2-pagination`, so the interim notice was never needed. | — | — |
| A6 | ~~Disable the relief tick when "VAT was paid" is on (UX-4)~~ | ✅ **Done 2026-07-23.** The relief checkbox disables (not resets) with a "No relief to apply" hint whenever VAT was paid on a config that exempts it; un-ticking VAT restores the prior choice. Arithmetic was already correct — this is presentational. Guarded by `[UX-4]` in `tests/e2e/calculators.spec.ts`. | — | — |
| A7 | ~~`data-stage-id` + list semantics on kanban columns (UX-3)~~ | ✅ **Done 2026-07-23.** Columns are labelled `<section>`s with `<h3>` headings and `<ul>/<li>` deal lists; drag-and-drop verified intact by a full keyboard move. | — | ships with the branch |
| A8 | ~~Isolate the RLS suite's database (TEST-1)~~ | ✅ **Done 2026-07-23.** The suite runs in its own seeded fixture org; a full run now leaves the seeded org byte-identical. Surfaced a new finding, **TEST-2** (`run_chain_checks` is callable by no role) — see TEST_REPORT.md. | — | ships with the branch |
| A11 | ~~Decide TEST-2: should `run_chain_checks()` be callable on demand?~~ | ✅ **Done 2026-07-23** (migration 0019). Settled on evidence: 0016 enumerated `anon, authenticated` as its targets, so losing `service_role` was the same collateral 0010 fixed for 0007. `service_role` restored; anon/authenticated stay revoked because the RPC walks every event in the org. | — | ✅ hosted apply confirmed 2026-07-23 |
| A9 | **Run Lighthouse once on live `/dashboard`** | The only performance gap this audit could not close (needs prod credentials). Establishes the real-world baseline. | 30 min | prod login |
| A10 | **Turn on Supabase leaked-password protection** | One dashboard toggle. Blocks known-breached passwords at signup/reset. Long outstanding. | 5 min | Supabase dashboard |

**Suggested first push:** A2 + A3. Deploying the branch closes the headline correctness bug and the security-header gap in one go; moving `shadcn` to devDependencies slims the deploy and drops 3 of 7 vulnerabilities. Under an hour of work.

**Possible follow-up to A1:** the calculator now assumes **equal** shares. If unequal splits (say 70/30 between spouses, or an investor pair) turn out to be common on the desk, the fix is a per-share price list rather than a single count — roughly a day. Worth asking the agents before building it.

---

## B. Feature add-ons

Ordered by value-per-effort for a Cyprus advisory desk.

### B1. ~~Real pagination on Leads / Viewings / Tasks / Keys~~ — ✅ **DONE** (`fix/perf-2-pagination`)
Shipped as a shared `lib/validators/pagination.ts` + `<Pager>` rather than a fifth copy of the arithmetic. Keys also needed its filters moved from client state into the URL (a client-side filter over a paged array searches one page only), and viewings — being a calendar — got a bounded window plus a truncation notice instead of row paging.

**Follow-up ✅ DONE 2026-07-24 — the viewings window now follows the calendar's anchor.** Same class of bug as the keys filters: the window was pinned to the server's `now` while the anchor lived in client `useState`, so stepping past +365d (or before −90d) left the loaded range and drew an **empty week — indistinguishable from "nothing booked"**. The anchor and view now travel in the URL (`?d=YYYY-MM-DD&view=`), the server loads around the anchor, and a step that leaves the loaded range pushes the URL to refetch instead of lying; steps *inside* the window stay instant client-side state. New `lib/services/calendar-window.ts` (12 unit tests) is shared by the page and the calendar, so the fetch window and the "is this loaded?" check can't drift; its `addDayKey`/`weekStartKey` replaced the component's private copies. A malformed `?d=` falls back to today (real-calendar validation, so `2026-13-45` is rejected). **Proven with a booking 4 years out:** invisible from today's anchor (correctly out of window) but visible when anchored at its week — before, it was invisible from both, i.e. permanently unreachable. `tests/e2e/viewings-window.spec.ts`.

### ~~B2. Push the dashboard aggregates into Postgres~~ — ✅ **DONE 2026-07-23**
Finding PERF-3, migration 0018 `admin_dashboard_stats` (SECURITY INVOKER). The headline € KPIs no longer under-report past the row caps — proven with a rolled-back 2,100-deal probe where the old capped sum was €122,000 light. Top-agent ranking is now exact rather than a 5,000-event sample, and 9 dashboard round trips became 4. **Migration 0018 applied to hosted and live — confirmed 2026-07-23** (`admin_dashboard_stats` present, SECURITY INVOKER, anon ✗ / authenticated ✓ / service_role ✓).

### B3. Buyer proposal via expiring magic link — ✅ **DONE 2026-07-29** (migration 0023)
Shipped. Tokenised, expiring, no-login page at `/p/[token]`; manage at `/share-links`. **The token is never stored** — only `sha256(token)`, so a database leak yields no working links. `anon` has **no grant on the tables at all**: a buyer reaches data solely through `resolve_share_link`, a security-definer RPC whose SQL body enumerates the exposure allowlist, so the boundary cannot drift with a component edit. Verified end-to-end that `internal_notes`, `owner_net_price` and `min_acceptable_price` never reach the rendered DOM. Opens are counted exactly and logged to `events` **once per Cyprus day** — a bearer token may append (unlike an anonymous CSP report) but must not let a refresh loop flood the chain. Expired, revoked, unknown and malformed tokens render one identical neutral page. Agent picks en/el/ru per link, which delivers multilingual value while B9 stays blocked. Original scope note: **Why:** this is the daily unlock for an advisory desk — it replaces the WhatsApp-a-pile-of-PDFs workflow and, because opens are logged, it strengthens the commission evidence chain that is already this product's differentiator. **Depends on:** doc 01 §4 forbids buyer logins — tokenised links are the sanctioned route, so honour that constraint exactly. Needs a public route outside the `proxy.ts` auth matcher and a rate limit.

### B4. Document generation from templates — **1.5 weeks**
Viewing forms, reservation agreements, mandate renewals as branded PDFs, prefilled from the property/contact/deal record. **Why:** the `@react-pdf/renderer` pipeline, font embedding (Greek/Cyrillic already solved) and the private `documents` bucket all exist — the evidence report proved the whole stack. This is mostly template work on top of shipped infrastructure. **Depends on:** `lib/services/evidence-pdf.tsx` patterns, `pdf-fonts.ts`.

### B5. Map view for properties — **1 week**
Plot listings on a map, filter by district/area, draw a radius. **Why:** Paphos buyers think in locations ("walkable to Kato Paphos harbour"), not in list rows. **Depends on:** `location geography(point,4326)` is already populated by `map-location-fields.tsx`, and PostGIS is already enabled — the data is sitting there unused. Needs a map tile provider decision (self-hosted vs. commercial) and a CSP `img-src`/`connect-src` allowance.

### B6. Duplicate detection on inbound leads — ✅ **DONE 2026-07-24**
Completed doc 02 §C4 "link/**create** contact (dedup applies)" — the lead form could only *link* an existing contact; now it can create a new enquirer (name + phone/email), and `checkContactDuplicate` fires first. A match blocks the create and surfaces "Looks like <existing> — link them instead?" inline (one-click link), mirroring the contact create flow. **Why:** the same buyer enquires then phones — two records, split history, forked commission trail. Now the second lead links the existing contact instead of forking. Pure decision/name-split helpers in `lib/services/lead-contact.ts` (6 unit tests); `createLead` extended (creates the contact + logs its `created` event `via: lead`, then the lead). Verified end-to-end: two leads, same phone, **one contact** (no fork), both leads linked, chain intact. `tests/e2e/leads-dedup.spec.ts`. **Depends on:** `checkContactDuplicate`, `pg_trgm` (already enabled).

**Follow-up worth noting:** this covers manual lead entry. A public website lead form (B3 territory) would need the same dedup on its intake path.

### B7. Automated follow-up nudges — ✅ **DONE 2026-07-29** (migration 0020)
Cron-driven tasks: "no contact in 14 days on an active deal" and "viewing done, no feedback logged". (The third rule the original entry named, "mandate expiring in 30 days", already existed via `expire_mandates` and was **not** rebuilt.) **Why:** first-response time was already measured on the dashboard but nothing acted on it.

`create_followup_nudges(p_org uuid default null)` runs at **03:15** — between `expire-mandates` (03:00) and `verify-events-chain` (03:30), so the night's nudge events are chain-checked by the same run. Built on the 0012 renewal lifecycle, which had already solved every hard part:

- **Idempotence keyed to a cycle, not "does any task exist".** The deal cycle is the staleness **boundary** — `(last_activity_at at Cyprus)::date + 14` — stored as the task's Cyprus end-of-day due date. Contact moves `last_activity_at`, which moves the boundary, so the open task stops matching and a *later* silence is a genuinely new cycle. A deal nobody ever touches keeps exactly one open nudge, forever. The viewing rule has no cycle and guards on "any nudge for this viewing", which is correct rather than the 0006 bug: `saveViewingFeedback` can only set feedback, never clear it.
- **Cyprus 23:59 due stamps**, deterministic from the source row rather than from when the job ran — a catch-up run after downtime stamps the date the nudge *should* have carried and shows up already overdue, instead of resetting the clock.
- **Three-arm assignee fallback** (deal/viewing agent → creator → oldest active org admin). A NULL assignee is invisible on every surface.
- **Stated invariants, self-healed.** An OPEN `deal_no_contact` task exists iff its deal is OPEN and its due date is that deal's current boundary; an OPEN `viewing_feedback` task exists iff its viewing is COMPLETED with null feedback. Tasks that stop matching are COMPLETED (`superseded`), never deleted. Two `AFTER UPDATE` triggers do this at edit time with `actor_id = auth.uid()` (the `trg_price_history` pattern — chosen over app-side calls because `move_deal_to_stage` is SQL-side); cron is the actor-null nightly net.

**"Contact" is `deals.last_activity_at`** — the only workable signal, because `contacted`/`called`/`conversation_logged` are all lead-scoped, never deal-scoped. It is also the health score's activity input, whose cliff is *also* 14 days (doc 02 §C5), so the nudge fires exactly when that factor reaches zero.

**The old "Viewings awaiting feedback" virtual section is retired** from `/tasks` and the agent dashboard; `viewing_feedback` nudges replace it with real rows that carry a 48-hour threshold, a due date, an assignee, admin visibility, CSV export and an event trail. The agent dashboard's tasks card widened from "overdue" to "due today & overdue", since every nudge is due at 23:59.

`tasks.kind` (CHECK-constrained, `null` = a human typed it) is now the single system-task discriminator; `expire_mandates` was re-stated to stamp `mandate_renewal` with its guard predicate byte-identical. **Thresholds are hardcoded** — see DECISIONS `T-nudges` for why, and BACKLOG for the config option.

Proven by 18 psql fixture assertions, RLS **test 24** (invariants, `p_org` scoping, anon/authenticated denied execute) and **test 17** (system tasks have no creator, so only an admin may delete them), plus `tests/e2e/nudges.spec.ts`.

### B8. Mobile PWA for the agent day — ✅ **DONE 2026-07-29** (installable + resilient reads)
Shipped at the **installable + resilient-reads** scope, chosen deliberately over full offline. Installable to an agent's home screen (manifest, maskable icon, standalone display, shortcuts to Today / Lead inbox / Viewings); the app shell and any already-visited screen still render with the signal cut; an unvisited screen falls back to `/offline`, which states plainly that nothing was sent and nothing recorded. **Writes are not queued** — offline slip signing was considered and rejected: it would put commission evidence in a client-side queue, and that chain is the one thing in this product that must never be doubted. **Every cache is purged on sign-out** (`LogoutButton` awaits the purge before the action) — without it, a shared or stolen phone could be paged back through the previous user's KYC and client data with no session. Proven against a real production build: worker activates, a visited screen renders offline, an unvisited one shows the fallback, and the purge empties every cache (3 → 0). Original scope note: **Why:** agents run viewings from a phone in a car park; the slip must sign even on bad signal. **Depends on:** the mobile nav shipped 2026-07-15. Note: the property detail screen (tabs, media grid, forms) is still desktop-oriented and is **not** in scope here.

### B9. Finish the multilingual UI (el / ru) — ❌ **CLOSED 2026-07-29, will not build**
**Closed on an operator decision: the desk works in English.** Doc 02 §A5 already scoped Phase 1 to "English for the internal team", and the language need that actually mattered — buyers — is met by B3, whose proposal pages render in en/el/ru chosen per link. Two corrections to the record, because the previous entry misdiagnosed this: (1) it is NOT blocked by a missing locale switcher. `profiles.locale` exists and is unread; wiring it into `getRequestConfig` plus a control on `/security` is about an hour and needs no locale *routing*, which is the thing doc 02 §A5 excludes. (2) The real cost is the chrome: only **13 of 128** component/page files use translations, and 114 of the 144 existing keys are the event timeline alone. So the switcher would have to land LAST — flipping it first gives a Russian sidebar wrapped around eight English modules, which is worse than English. If this is ever reopened, that sequencing is the point. Original scope note: **Why:** Paphos sells to Russian- and Greek-speaking buyers, and `messages.test.ts` already fails CI on a half-translated file, so the guard rails are in place. **Depends on:** nothing. **Note:** the evidence PDF stays English deliberately — it is the artifact quoted in disputes.

### B10. CSV export on every list — ✅ **COMPLETE (all 7 lists, 2026-07-23/24)**
Import exists (`scripts/import/`); export did not. **Why:** accountants, lawyers and the client's own reporting all want a spreadsheet, and today the answer is a screenshot. **Depends on:** the same RLS-scoped queries the lists already run.

**Done for contacts.** The reusable pieces are in place: `lib/services/csv.ts` (RFC-4180 serializer — BOM for Excel/Greek/Cyrillic, CRLF, `""` escaping, **spreadsheet formula-injection guard** on user-typed fields), and the pattern of sharing the list's WHERE clause between page and export so "export = the filtered list you see" holds by construction (`lib/queries/contacts-list.ts` — `parseContactListFilters` + `applyContactListFilters`, used by both `app/(app)/contacts/page.tsx` and the new `app/(app)/contacts/export/route.ts`). Export is a GET route handler, so it inherits the proxy's auth gate and runs under the caller's RLS — an agent exports only their scope. Capped at 10,000 rows (PERF-2: no unbounded reads). Column mapping is a pure, unit-tested module (`lib/services/contact-export.ts`). Tests: 16 new unit + 2 E2E route-contract + the anon gate in `security.spec.ts`.

**Export audit logging — done (operator chose to log exports).** Every export writes an append-only `exported` event (new org-level entity_type `export`, `entity_id` null, one type for all lists, `payload.list`/`count`/`filters`) via `lib/services/export-audit.ts`, *before* the CSV is returned — so no PII leaves without a record of who took it, and a failed audit insert fails the export closed. The line is registered in `describeEvent` + the `events` i18n namespace (en/el/ru, ICU plurals). Verified end-to-end on the local DB: two exports produced two audit rows with the right shape, and `verify_events_chain` stays `true` across all orgs with the new event type present.

**Properties export shipped 2026-07-24** — the intricate case (mandate `excludeIds` pre-query + inner/outer embed switch + transaction-context price + retired-scope), proving the shared-query abstraction generalizes. `lib/queries/properties-list.ts` (parse + `applyPropertyListFilters` + `mandateEmbed` + `fetchMandateExcludeIds`) is used by both the page and `app/(app)/properties/export/route.ts`; columns in `lib/services/property-export.ts` (money/area as raw numbers so spreadsheets sum). Verified end-to-end: 5 properties exported + audited, chain intact.

**Leads export shipped 2026-07-24** — `lib/queries/leads-list.ts` (status scope) + `lib/services/lead-export.ts` (contact/property joins, formatted phone). Verified: 5 leads exported + audited, chain intact.

**Deals export shipped 2026-07-24** — served from `/pipeline/export` (the board is the deals view). Exports EVERY deal of the selected `deal_type` tab, not the board's 30-day closed window (that window is display-only, not a user filter; reporting wants old won deals). `lib/queries/deals-list.ts` + `lib/services/deal-export.ts` (stage name, buyer/seller aliased embeds, commission notes, raw money).

**Viewings export shipped 2026-07-24** — the calendar has no user filters, so the export covers EVERY viewing (all time), including past viewings and their signed slips (RLS-scoped), which is what commission reporting needs. `lib/services/viewing-export.ts`; no shared query module (nothing to filter).

**Keys export shipped 2026-07-24** — `lib/queries/keys-list.ts` (status + text search with the property-id pre-query, shared with the register page) + `lib/services/key-export.ts`.

**Tasks export shipped 2026-07-24** — "my tasks" (assignee-scoped) but EVERY task (open + done, all time), a personal work-history report. `lib/services/task-export.ts`.

**All seven lists now export CSV** (contacts, properties, leads, deals, viewings, keys, tasks), each auth-gated, RLS-scoped, capped at 10k, and audited via `logListExport`. Shared serializer `lib/services/csv.ts`; per-list column modules `lib/services/<entity>-export.ts`; shared filter modules `lib/queries/<list>-list.ts` where the list has searchParam filters (contacts, properties, leads, deals, keys). Every export writes an `exported` audit event before returning. 63 unit + 13 route-contract E2E across the feature; anon gates in `security.spec.ts`.

### B11. Retention-expiry surface for GDPR — ✅ **DONE 2026-07-24**
`retention_until` was written by the erasure flow but **nothing read it** — data was marked for expiry and then kept forever, leaving Article 17 half-closed. Now closed at **`/settings/retention`** (admin-only): every contact whose KYC records are held under the Cyprus AML five-year duty, soonest-first, tagged `expired` / `expiring soon` (90-day notice) / `retained`, with one-click second-stage destruction once the duty has run.

- **`lib/services/retention.ts`** — pure classification (9 unit tests). Expired **on** the retention date: the duty is "five years past the relationship", so on that date it has been served. Cyprus wall-clock day keys via `zonedParts().dayKey`, not UTC — the duty is a calendar obligation (doc 02 §A11).
- **`purgeExpiredRetention`** (in `lib/actions/contact-erasure.ts`, beside the erasure it completes) — admin-only enforced in the action, refuses to purge before the date, row-count guarded, removes storage objects only for document rows the delete actually returned, writes a `retention_purged` event. Destroys **only** the KYC documents, their files and the checklist; `erased_at`/`erased_by`, identity fields, events and viewing slips are untouched (audit trail + immutable commission evidence).
- Query is served by `contacts_retention_idx`, created in migration 0017 for exactly this. **No migration needed.**

**Verified end-to-end on a seeded fixture pair** (one lapsed, one still under duty as the control): the lapsed contact's document row, storage object and KYC checklist were destroyed and `retention_until` cleared; the still-retained contact was untouched (file still downloadable); `erased_at` survived on both; the `retention_purged` event was written; `verify_events_chain` stayed true. The UI offers no destroy button for a row still under duty — asserted in `tests/e2e/retention.spec.ts`.

**Still open (deliberate):** nothing runs automatically — expiry is surfaced, not auto-purged, because destruction of AML records should be a human decision with the reason visible. A nightly "retention lapsed" nudge task would be the natural follow-up (see B7's cron pattern). Earliest real expiry in production is 2031.

---

## C. Strategic / architecture

### C1. Content-Security-Policy with nonces — 🟡 **STAGED REPORT-ONLY 2026-07-24; enforcing is a separate decision**
The per-request nonce is threaded through `proxy.ts` and the full policy ships as **`Content-Security-Policy-Report-Only`** — it reports, it does not block. `frame-ancestors 'none'` stays separately **enforced** in `next.config.ts`, so clickjacking protection is unchanged. Full rationale in DECISIONS `T-csp`.

**The staging immediately earned its keep.** Against a *production* build, five screens reported `script-src / blockedURI: "eval"` — traced to **Zod 4's JIT validator compiler**, which builds schemas with the `Function` constructor. Dev had hidden it entirely (dev needs `'unsafe-eval'` anyway). Zod falls back on its own so it wouldn't have *broken*, but every page would have reported a violation and silently lost the fast path; since the enforced end-state is jitless regardless, `z.config({ jitless: true })` is now explicit.

**Evidence:** `lib/services/csp.ts` (10 unit tests, origins derived from env so local/prod both work) + `tests/e2e/csp.spec.ts`, which collects `securitypolicyviolation` events across 11 modules and 7 deep routes and asserts zero — **22/22 clean against a real `next start` production build** with the strict policy.

**Coverage extended 2026-07-24 — the detail-page gap is now closed.** The sweep additionally drives **property detail, contact detail, viewing detail and the slip-signing canvas** (reached by clicking through from the lists, so it uses real ids), and proves `img-src` against an actual Supabase Storage image rather than assuming it. **27/27 clean against a production build.** Routes with no data self-skip with an explicit reason instead of passing vacuously — a green run is only evidence for what actually ran.

**Reports now have somewhere to go (2026-07-24).** The policy originally named no `report-uri`, which made the whole report-only stage decorative: violations reached each visitor's console and nobody else, so "let it run in production" could not be acted on. There is now a public, auth-exempt collector at **`/api/csp-report`** (`report-uri` + `report-to`/`Reporting-Endpoints`). It never touches the database — an unauthenticated caller must never be able to append to the hash-chained event log — caps the body at 16 KB, always answers `204`, and de-duplicates per instance so one common violation cannot drown the rare interesting one. Distinct violations are logged as `[csp] …` (Vercel runtime logs) and sent to Sentry when a DSN is set.

> **Unverified:** that a real browser actually delivers reports to it. The policy demonstrably catches violations (an `img-src` probe is asserted in `csp.spec.ts`) and the endpoint demonstrably accepts and survives them (synthetic POSTs, including hostile input), but **no report reached the server in testing even after a 70-second wait** — headless Chromium over plain `http://localhost` appears not to deliver them. **Confirm in production by looking for `[csp]` in the Vercel runtime logs.** If nothing appears there after real use, delivery is the thing to debug — not the policy.

**Before enforcing (do NOT do this on local evidence alone):**
1. Let report-only run in production for a while — real data, real screens, real browsers. **First confirm reports are actually arriving** (see above); an empty log could mean "clean" or "not delivering", and those are very different.
2. Two things the local sweep still cannot exercise: **PDF generation** (the evidence report renders server-side, and the download is a signed URL) and any screen whose data does not exist locally — `property_media` is empty on a seed database, so the Storage `img-src` result above came from a temporary fixture and the test self-skips without one.
3. Then flip the response header name from `Content-Security-Policy-Report-Only` to `Content-Security-Policy` in `proxy.ts` — a one-line change, trivially revertible.

### C2. Two-factor authentication — ✅ **DONE 2026-07-24** (opt-in; DB-level enforcement outstanding)
Spec-Essential, deferred pending the client's call — the operator asked for it on 2026-07-24. TOTP via Supabase Auth, **no migration**. Full rationale in DECISIONS `T-2fa`.

**Shipped:** self-service enrolment at **`/security`** (deliberately not `/settings`, which is admin-only — an agent holds the same client PII as an admin), QR plus a copyable secret, a challenge screen at `/login/verify`, and removal behind a confirmation. Enrolment and removal both write `mfa_enrolled` / `mfa_unenrolled` events — turning a second factor *off* is what an audit needs to see. An `aal1` session may not unenrol, or a stolen password-only session could just switch 2FA off.

**Opt-in, not mandatory** — forcing enrolment org-wide is one bad deploy away from locking everyone out of the KYC scans and the evidence chain. Users who don't enrol sign in as before; once enrolled, every sign-in needs the code. Mandatory enrolment remains a later decision.

**Verified end-to-end** with a real RFC-6238 generator (`lib/testing/totp.ts`, pinned to the published RFC 4226/6238 vectors): enrol → sign out → password alone lands on the challenge → a wrong code is refused → `/contacts` stays unreachable → the right code gets in → remove. `tests/e2e/mfa.spec.ts`.

> **⚠ Enforcement is at the application layer only.** A stolen `aal1` JWT could still hit PostgREST directly and bypass the challenge. Closing that needs `as restrictive` RLS policies asserting `auth.jwt()->>'aal' = 'aal2'` for users with a verified factor (the "opted-in" template in the Supabase MFA guide, which leaves non-enrolled users untouched). Schema-wide, real lockout risk, needs its own RLS tests — **logged in BACKLOG, not bolted on here.** The app gate already defeats the realistic threat: someone with a stolen password using the web UI.

**Operator note:** hosted Supabase enables the TOTP API by default per the MFA guide; local needed `[auth.mfa.totp] enroll_enabled/verify_enabled = true` in `supabase/config.toml`. Worth confirming on the dashboard before rolling 2FA out to staff.

### C3. Public listing API for the marketing site — **2 weeks**
A read-only, published-listings-only endpoint (no PII, no internal notes, no draft/archived rows), served from a dedicated role with its own RLS policies. **Why:** it is the clean seam between the internal CRM and any future public website, and it stops anyone reaching for the service-role key to build one. **Depends on:** the `visibility`/`status` scoping already implemented in the 2026-07-21 list-scope fix, and the quality-gate score that governs publishing. **Design constraint:** never reuse the app's Supabase client — a separate anon role with column-level grants.

### C4. Reporting engine beyond commission evidence — **2 weeks**
Agent performance, source ROI, time-to-close, stage conversion, price-reduction analysis. **Why:** the `events` table is already a complete, hash-chained, append-only fact log — this is a materialised-view problem, not a data-collection problem. The raw material is unusually good. **Depends on:** C5 for anything running over years of events.

### C5. Event-log partitioning and archival — **1 week**
`events` grows forever and by design is never deleted. Every timeline, the dashboard, and `verify_events_chain` read it. **Why:** at a few million rows the chain walk and the per-entity timelines will become the app's bottleneck, and the nightly `run_chain_checks()` cron is the canary. **Fix direction:** partition by `occurred_at` range, index per partition, and keep chain verification incremental against the last verified checkpoint rather than walking from genesis. **Do before C4.**

### C6. Backup and restore drill — **runbook written 2026-07-23, execution outstanding**
**See `docs/BACKUP_RESTORE.md` and DECISIONS `T-backup-drill`.** This item was scoped as "Supabase takes backups; nobody has proven a restore" — **that premise was wrong.** The org is on the Free plan, which Supabase excludes from automated daily backups; there is no reachable backup today, so the RPO is unbounded rather than 24h. Two further findings: storage objects (signed slips, evidence PDFs, KYC scans) are in **no** database backup on any plan, and `verify_events_chain` is session-`TimeZone`-dependent, so a restore into a non-UTC project reads `false` on intact data. **Why it still matters:** the commission evidence chain is the product's core value and it is append-only — a corrupted or lost `events` table cannot be reconstructed from anywhere else. **Remaining deliverable:** take the first backup (§3, under an hour, removes most of the risk on its own), get it off-site, then run the timed drill (§4) and sign off the proposed RPO 24h / RTO 4h (§6). Verification pack `scripts/backup/verify-restore.sql` is written and self-tested 43/43 against hosted.

### C7. Role model beyond the three fixed roles — **1.5 weeks**
Today: `admin`, `agent`, `listing_manager`, enforced by `current_role_gnk()` inside RLS helpers. **Why revisit:** the audit surfaced places where role and capability diverge — a listing manager can reach the archived state field-by-field on the Details tab even though the one-click Archive is admin-only. That is a deliberate, documented decision, but it signals that "role" is starting to do too much work. **Direction:** capability flags on the profile, checked by the same SECURITY DEFINER helpers, so policy changes stay in one place. **Do not start** before there is a concrete second-office or franchise requirement — this is the kind of generalisation that costs more than it returns if built speculatively.

---

## D. Explicitly not recommended

- **`npm audit fix --force`** — it proposes `next@9.3.3`. See DEP-2 for the correct route.
- **Dashboard customisation** — guardrail 6 fixes three dashboards deliberately. Leave it.
- **Hard delete anywhere** — the append-only hash-chained `events` spine *is* the commission evidence. Retire states (archived / withdrawn / spam / lost) are the correct answer, and the GDPR erasure path already handles the one case that legally requires more.
- **WhatsApp API, KYC API, portal feeds, automated commission splits** — doc 01 §10 Do-Not-Build for Phase 1. Revisit only as a Phase 2 scope decision with the client, not as engineering initiative.
