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
Shipped as a shared `lib/validators/pagination.ts` + `<Pager>` rather than a fifth copy of the arithmetic. Keys also needed its filters moved from client state into the URL (a client-side filter over a paged array searches one page only), and viewings — being a calendar — got a bounded window plus a truncation notice instead of row paging. **Follow-up worth doing:** drive the viewings window from the calendar's own anchor date, so navigating past the fetched range refetches rather than showing an empty week. ~1 day.

### ~~B2. Push the dashboard aggregates into Postgres~~ — ✅ **DONE 2026-07-23**
Finding PERF-3, migration 0018 `admin_dashboard_stats` (SECURITY INVOKER). The headline € KPIs no longer under-report past the row caps — proven with a rolled-back 2,100-deal probe where the old capped sum was €122,000 light. Top-agent ranking is now exact rather than a 5,000-event sample, and 9 dashboard round trips became 4. **Migration 0018 applied to hosted and live — confirmed 2026-07-23** (`admin_dashboard_stats` present, SECURITY INVOKER, anon ✗ / authenticated ✓ / service_role ✓).

### B3. Buyer proposal via expiring magic link — **1.5 weeks**
Tokenised, expiring, no-login link showing a curated property shortlist with photos, price, m², and the agent's contact card; every open logged to `events`. **Why:** this is the daily unlock for an advisory desk — it replaces the WhatsApp-a-pile-of-PDFs workflow and, because opens are logged, it strengthens the commission evidence chain that is already this product's differentiator. **Depends on:** doc 01 §4 forbids buyer logins — tokenised links are the sanctioned route, so honour that constraint exactly. Needs a public route outside the `proxy.ts` auth matcher and a rate limit.

### B4. Document generation from templates — **1.5 weeks**
Viewing forms, reservation agreements, mandate renewals as branded PDFs, prefilled from the property/contact/deal record. **Why:** the `@react-pdf/renderer` pipeline, font embedding (Greek/Cyrillic already solved) and the private `documents` bucket all exist — the evidence report proved the whole stack. This is mostly template work on top of shipped infrastructure. **Depends on:** `lib/services/evidence-pdf.tsx` patterns, `pdf-fonts.ts`.

### B5. Map view for properties — **1 week**
Plot listings on a map, filter by district/area, draw a radius. **Why:** Paphos buyers think in locations ("walkable to Kato Paphos harbour"), not in list rows. **Depends on:** `location geography(point,4326)` is already populated by `map-location-fields.tsx`, and PostGIS is already enabled — the data is sitting there unused. Needs a map tile provider decision (self-hosted vs. commercial) and a CSP `img-src`/`connect-src` allowance.

### B6. Duplicate detection on inbound leads — **4 days**
`checkContactDuplicate` and the merge flow already exist and are hardened; extend them to fire at lead capture and surface "this looks like an existing contact" inline. **Why:** the same buyer enquires through the website, then phones. Two records, split history, and the commission trail forks. **Depends on:** `lib/actions/merge-contacts.ts`, `pg_trgm` (already enabled).

### B7. Automated follow-up nudges — **1 week**
Cron-driven tasks: "no contact in 14 days on an active deal", "viewing done, no feedback logged", "mandate expiring in 30 days" (the last already exists via `expire_mandates`). **Why:** first-response time is already measured on the dashboard but nothing acts on it. **Depends on:** `pg_cron` (in use for `expire-mandates` and `verify-events-chain`), the `0012` renewal-task lifecycle as the pattern to copy.

### B8. Mobile PWA for the agent day — **1 week**
Installable, offline-tolerant shell for the three mobile-first screens named in `CLAUDE.md`: slip signing, agent daily dashboard, lead inbox. **Why:** agents run viewings from a phone in a car park; the slip must sign even on bad signal. **Depends on:** the mobile nav shipped 2026-07-15. Note: the property detail screen (tabs, media grid, forms) is still desktop-oriented and is **not** in scope here.

### B9. Finish the multilingual UI (el / ru) — **1 week** **[BACKLOG]**
Shared vocabulary is done (`events`, `reports`, `dashboard`); remaining is per-module chrome for properties, contacts, viewings, tasks, keys, settings. **Why:** Paphos sells to Russian- and Greek-speaking buyers, and `messages.test.ts` already fails CI on a half-translated file, so the guard rails are in place. **Depends on:** nothing. **Note:** the evidence PDF stays English deliberately — it is the artifact quoted in disputes.

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

### B11. Retention-expiry surface for GDPR — **4 days** **[BACKLOG]**
`retention_until` is written by the erasure flow but **nothing reads it**. Build the view that lists records whose AML retention has lapsed and offers the second-stage destruction. **Why:** without it the Article 17 implementation is only half-closed — data is marked for expiry and then kept forever. Earliest real expiry is 2031, so this is not urgent, but it is a known open loop.

---

## C. Strategic / architecture

### C1. Content-Security-Policy with nonces — **3 days**
This audit added `frame-ancestors 'none'`; a real `script-src`/`style-src` policy needs a per-request nonce generated in `proxy.ts` and threaded into the Next script tags. **Why:** the app renders user-supplied text (lead messages, contact notes, property descriptions in three languages) across every screen. React escapes by default, so this is defence in depth, not a patch for a known hole — but it is the difference between "we escape" and "we cannot execute injected script". **Risk:** a wrong CSP breaks the app silently in production; stage it with `Content-Security-Policy-Report-Only` first.

### C2. Two-factor authentication — **1 week**
Recorded as spec-Essential but deferred pending client confirmation. **Why:** a single admin password currently protects every client's PII, KYC passport scans, and the commission evidence chain. Supabase Auth supports TOTP natively. **Blocker:** needs the client's decision on whether it gates Phase 1 sign-off.

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
