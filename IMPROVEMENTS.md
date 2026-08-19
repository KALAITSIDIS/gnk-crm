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
| A10 | **Turn on Supabase leaked-password protection** | ⚠️ **NOT a toggle — corrected 2026-08-04.** Gated to **Supabase Pro** on this plan, so it is a spend decision, not 5 minutes. Until the plan changes the standing `auth_leaked_password_protection` advisor finding is **accepted, not unnoticed**. Not agent-reachable either (no auth-config tool on the connector; platform config, not DB state). | plan upgrade | operator |

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

### B4. Document generation from templates — 🟡 **STARTED 2026-08-08: viewing confirmation shipped (migration 0027); the two contracts are blocked on supplied wording**

**Shipped: the viewing confirmation** (doc 01 M10's "viewing confirmations").
Generated from the record on the viewing detail page, filed as a `documents` row
with the new `viewing_confirmation` doc type, downloadable through a short-lived
signed URL. It follows `generateEvidenceReport` exactly, including the unwind
order — a failed row removes the uploaded file, a failed event removes both,
so guardrail 1 holds: no stored document without its hash-chained event. The
event carries `pdf_sha256`, so a confirmation can be proven byte-identical the
same way a slip now can (0026).

It is **not** the signed slip and says so on the page: "This confirms the
appointment above. It is not a reservation and does not commit either party to a
transaction." The slip remains the evidential artifact, signed at the viewing;
this is the sheet sent beforehand. Its GDPR line is `SLIP_GDPR_LINE`, passed in
rather than restated so the two cannot drift.

Verified at both levels. Unit (`viewing-confirmation-pdf.test.ts`, 6 tests):
Noto Sans really embedded, Greek and Cyrillic round-tripping through the PDF's
own ToUnicode map, **no unmapped glyphs** — this template's prose is full of
"confirms"/"confirmation", the same `fi` pair that once extracted as
"?rst-response" from a production report — and empty optional rows omitted
rather than drawn as bare labels. E2E (`viewing-confirmation.spec.ts`): the real
button, then the stored bytes re-downloaded and re-hashed against the event
payload, exactly one document and one event, chain still verifying.

**Deliberately NOT built: reservation agreements and mandate renewals.** Those
are contracts. Their wording is a legal question for the operator's lawyer, and
a plausible-looking generated contract is materially worse than none —
especially over a deposit. The pipeline is now proven and each is a template
plus an action once the text is supplied; **the blocker is the text, not the
engineering.**

Original scope note: viewing forms, reservation agreements, mandate renewals as branded PDFs, prefilled from the property/contact/deal record. **Why:** the `@react-pdf/renderer` pipeline, font embedding (Greek/Cyrillic already solved) and the private `documents` bucket all exist — the evidence report proved the whole stack. This is mostly template work on top of shipped infrastructure. **Depends on:** `lib/services/evidence-pdf.tsx` patterns, `pdf-fonts.ts`.

### B5. Map view for properties — ✅ **DONE AND LIVE.** Migration 0031 applied to hosted 2026-08-11; **second pass 2026-08-18** added click-through, clustering, fit-to-results and price. Radius draw DECLINED by the operator.

Properties render on a map at `/properties/map`, reached by a **Map / List toggle**
on the properties list that carries the active filters through the URL. It is a
second VIEW of the list, not a new module: it reuses `parsePropertyFilters` and
`applyPropertyListFilters` from `lib/queries/properties-list.ts`, so the two
views cannot disagree about what a filter set means.

> ### ⚠️ THIS ENTRY'S ORIGINAL "Depends on" WAS FALSE, AND IT SHAPED THE BUILD
>
> It said `location geography(point,4326)` was *"already populated by
> `map-location-fields.tsx` … the data is sitting there unused."* Checked on
> hosted 2026-08-11: the column exists and PostGIS is enabled, but **0 of 2
> properties had coordinates.** The write path works and was simply never used.
>
> **A map keyed on `location` alone would have rendered zero pins, permanently.**
> The claim was believed for months because nobody queried it.

**How a property gets a position:** exact `location` if set → else its **area**
centroid → else its **district** centroid → else it is omitted. Migration 0031
adds `centroid` to `districts` and `areas` and seeds all 15 (5 districts, 10
areas). Exact pins render teal, approximate ones amber, so a centroid is never
mistaken for a surveyed point.

**`FAM` is centred on the FREE AREA** (Paralimni / Protaras / Ayia Napa), not
Famagusta town — most of that district is in the north. Operator decision; the
migration comment says so to stop it being "corrected" later.

**Tiles: OpenFreeMap** — no account, no API key, no rate limit, commercial use
permitted, attribution rendered automatically by MapLibre. Checked before
choosing: **MapTiler's free plan explicitly excludes commercial use**, and
Nominatim's public geocoder requires 1 req/sec with mandatory caching and tells
commercial geocoding-led applications to self-host. Geocoding street addresses
was rejected for now on that basis and stays addable later with no rework — it
would populate the same `location` column.

**CSP:** `https://tiles.openfreemap.org` is allowed on `img-src` and
`connect-src` in `lib/services/csp.ts`. **The policy is ENFORCED, so removing
that entry blanks the map in production with no UI error** — `check:csp-nonce`
cannot catch it. `tests/e2e/property-map.spec.ts` asserts zero CSP violations,
and seeds its own district-only property to prove the centroid fallback actually
produces a pin.

**Radius / polygon draw — DECLINED by the operator 2026-08-18**, not merely
deferred. The technical note stands if that ever changes: a client-side circle
over the loaded GeoJSON needs no change to the migration, resolver, page or CSP,
and `ST_DWithin` is there if volume ever makes client-side filtering wrong.

#### Second pass, 2026-08-18 (`17d204f`, `e3c0464`)

**Clicking a pin or cluster opens a popup** — reference, title, price, thumbnail,
and an approximate-location note — and clicking a row opens the property. This is
not a convenience: with area and district centroids SHARED EXACTLY, several
properties sit on one coordinate, so taking the top feature would open an
arbitrary one. Pin clicks collect every feature under the point; cluster clicks
check whether the leaves share a coordinate and, when they do, list them rather
than zooming forever — **a cluster of identical points can never be split by
zoom.**

**The map fits to its results** instead of opening at a hardcoded Cyprus-wide
zoom 8, with a `maxZoom` because one property gives a degenerate bounding box.

**Clusters carry a minimum price** (`3 · from €380.000`) via `clusterProperties`.
A label on every pin does not work here — MapLibre resolves a label collision by
HIDING one, so a price over stacked pins shows one arbitrary property. Lone pins
carry their own price. An all-unpriced cluster shows its count and no price:
`["to-number", x, fallback]` does NOT fall back for null (the spec converts null
to 0), which is why an explicit `hasPrice` flag exists.

**A legend replaced the prose caption** — teal is exact, amber is approximate.
Clusters are deliberately slate: a cluster can hold both, so painting it teal
would claim a precision it cannot vouch for.

> ### ⚠️ THIS FEATURE WAS DECLARED BROKEN AND WITHDRAWN WHILE WORKING
>
> On 2026-08-18 the map was called blank in production, its link was hidden from
> users, and two of its tests were disabled. **It had been working the whole
> time.** Two instruments lied: a hidden browser tab never runs
> `requestAnimationFrame`, so MapLibre never renders and never requests a tile;
> and a worker's fetches never reach the window's resource timeline, so an
> in-page tile count reads 0 on a working map. `docs/ENGINEERING_NOTES.md` §7
> owns the trap. **Check `document.visibilityState` before believing anything
> about a canvas.**

**Still hand-entered:** exact coordinates. `map-location-fields.tsx` takes a
lat/lng pair or a pasted Google Maps link, unchanged by this work. Until someone
uses it, every pin is amber.

### B6. Duplicate detection on inbound leads — ✅ **DONE 2026-07-24**
Completed doc 02 §C4 "link/**create** contact (dedup applies)" — the lead form could only *link* an existing contact; now it can create a new enquirer (name + phone/email), and `checkContactDuplicate` fires first. A match blocks the create and surfaces "Looks like <existing> — link them instead?" inline (one-click link), mirroring the contact create flow. **Why:** the same buyer enquires then phones — two records, split history, forked commission trail. Now the second lead links the existing contact instead of forking. Pure decision/name-split helpers in `lib/services/lead-contact.ts` (6 unit tests); `createLead` extended (creates the contact + logs its `created` event `via: lead`, then the lead). Verified end-to-end: two leads, same phone, **one contact** (no fork), both leads linked, chain intact. `tests/e2e/leads-dedup.spec.ts`. **Depends on:** `checkContactDuplicate`, `pg_trgm` (already enabled).

**Follow-up worth noting:** this covers manual lead entry. A public website lead form (B3 territory) would need the same dedup on its intake path.

### B7. Automated follow-up nudges — ✅ **DONE 2026-07-29** (migration 0020)
Cron-driven tasks: "no contact in 14 days on an active deal" and "viewing done, no feedback logged". (The third rule the original entry named, "mandate expiring in 30 days", already existed via `expire_mandates` and was **not** rebuilt.) **Why:** first-response time was already measured on the dashboard but nothing acted on it.

`create_followup_nudges(p_org uuid default null)` runs at **03:15** — between `expire-mandates` (03:00) and `verify-events-chain` (03:30), so the night's nudge events are chain-checked by the same run. Built on the 0012 renewal lifecycle, which had already solved every hard part:

- **Idempotence keyed to a cycle, not "does any task exist".** The deal cycle is the staleness **boundary** — `(last_activity_at at Cyprus)::date + 14`, since 0025 `(coalesce(last_contact_at, created_at) at Cyprus)::date + 14` — stored as the task's Cyprus end-of-day due date. Contact moves that column, which moves the boundary, so the open task stops matching and a *later* silence is a genuinely new cycle. A deal nobody ever touches keeps exactly one open nudge, forever. The viewing rule has no cycle and guards on "any nudge for this viewing", which is correct rather than the 0006 bug: `saveViewingFeedback` can only set feedback, never clear it.
- **Cyprus 23:59 due stamps**, deterministic from the source row rather than from when the job ran — a catch-up run after downtime stamps the date the nudge *should* have carried and shows up already overdue, instead of resetting the clock.
- **Three-arm assignee fallback** (deal/viewing agent → creator → oldest active org admin). A NULL assignee is invisible on every surface.
- **Stated invariants, self-healed.** An OPEN `deal_no_contact` task exists iff its deal is OPEN and its due date is that deal's current boundary; an OPEN `viewing_feedback` task exists iff its viewing is COMPLETED with null feedback. Tasks that stop matching are COMPLETED (`superseded`), never deleted. Two `AFTER UPDATE` triggers do this at edit time with `actor_id = auth.uid()` (the `trg_price_history` pattern — chosen over app-side calls because `move_deal_to_stage` is SQL-side); cron is the actor-null nightly net.

> **⚠ CORRECTED 2026-08-07 (migration 0025). The paragraph below describes the
> ORIGINAL design, and that design was a defect.** Leaving it unmarked would be
> how it gets rebuilt. `deals.last_activity_at` is stamped by `lib/actions/deals.ts`
> on **every field change**, so renaming a deal read as "I spoke to the buyer":
> `trg_supersede_deal_nudges` closed the open chase-up immediately and logged
> `reason: deal_contacted_or_closed` against whoever was editing — an assertion
> about the world nobody had made. The nightly job then declined to re-mint it,
> because the boundary had moved too, so a deal could be edited weekly and never
> once be chased.
>
> **Contact now has its own column, `deals.last_contact_at`**, written only by
> `logDealContact` and by `logConversation` on a converted lead. The boundary is
> `(coalesce(last_contact_at, created_at) at Cyprus)::date + 14`, so a deal nobody
> has ever contacted is still chased 14 days after it was opened.
> `last_activity_at` is unchanged and still the health-score activity input.
> See DECISIONS `T-deal-contact`.

**"Contact" was `deals.last_activity_at`** — chosen as the only workable signal, because `contacted`/`called`/`conversation_logged` are all lead-scoped, never deal-scoped. It is also the health score's activity input, whose cliff is *also* 14 days (doc 02 §C5), so the nudge fires exactly when that factor reaches zero.

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

### C1. Content-Security-Policy with nonces — ✅ **DONE. ENFORCED IN PRODUCTION 2026-08-10.**

> ### ENFORCED — 2026-08-10. `/offline` turned out not to be a blocker.
>
> The response header moved from `Content-Security-Policy-Report-Only` to
> `Content-Security-Policy`, through a single `CSP_HEADER` constant in
> `lib/services/csp.ts` used by BOTH branches of `proxy.ts` — one constant
> because this file has already had the bug where the public `/p/` branch and
> the authenticated branch disagreed about the policy.
>
> **`/offline` was the one decision left, and reading the page settled it.** It
> is `force-static`, so under enforcement none of its scripts run — but it is
> three paragraphs of static text with no button, no client component and
> nothing to hydrate. It renders identically either way. The cost carried as an
> open question for weeks was zero. **Do not add interactivity to that page
> without moving it off `force-static` first.**
>
> **What made this safe, heaviest evidence first:**
>
> | evidence | |
> |---|---|
> | `csp.spec.ts` sweep | **27/27 clean** against a real production build — 11 modules, 7 deep routes, detail pages, signature canvas |
> | Zod 4 JIT `eval` | the one real violation report-only ever found, fixed in `zod-jitless.ts` — and it self-recovers regardless |
> | source audit | no `<iframe>`/`<embed>`/`<object>`, no `eval`/`new Function`/`javascript:`, no workers, no external script/style/font origins (`next/font` self-hosts) |
> | production report-only | clean since the nonce fix landed; Sentry holds zero unresolved CSP issues |
>
> **The reporting directives stay inside the enforced policy on purpose.** A
> blocked violation is still POSTed to `/api/csp-report` and reaches Sentry, so
> the signal does not go quiet at the exact moment it starts to matter.
>
> **Rollback is one word:** set `CSP_HEADER` back to
> `"Content-Security-Policy-Report-Only"`. The policy string, the nonce and the
> reporting endpoints are identical either way.

> **Superseded 2026-08-10 (later) — "enforcement is still a separate decision,
> blocked only by `/offline`" was true when written, and is now done. Every
> measurement below still stands.**

> ### ✅ FIXED AND VERIFIED IN PRODUCTION — 2026-08-10, `929055e`
>
> Removing the `Content-Security-Policy` key from `next.config.ts` `headers()`
> freed the header name, and the nonce landed on the first deploy. Measured, not
> assumed:
>
> ```
> /login                        22 of 22 script tags stamped   check:csp-nonce exit 0
> /p/<token>  (public, dynamic) 23 of 23 stamped
> /api/csp-echo                 all 14 directives arrive, cspCarriesNonce true
> enforcing CSP response header 0 on /login and /offline
> X-Frame-Options               DENY on both
> Vercel runtime errors, 1h     none
> ```
>
> Production now returns exactly what local returns, which was never true before.
>
> **`/offline` still stamps 0 of 24, and that is CORRECT** — it is `force-static`
> on purpose for the PWA (B8) and is on `check-static-routes`' allowlist, so it
> is built before any request nonce exists. **It is now the ONLY thing standing
> between here and enforcement**, and it is the same accepted trade as before:
> under enforcement `/offline` renders without hydrating.
>
> **What is left for C1, in order:** let the report-only policy collect real
> traffic through Sentry, decide the `/offline` trade, resolve
> `frame-src vercel.live`, then flip the header. Promoting it also restores
> `frame-ancestors` to enforcing, which is what the fix traded away.
>
> **`/api/csp-echo` NO LONGER EXISTS** — it was temporary and was removed once it
> had answered. The tables below quote what it returned; do not try to curl it.
> `npm run check:csp-nonce <url>` is the permanent check and needs no deploy.

> ### ✅ ROOT CAUSE — CONFIRMED BY MEASUREMENT 2026-08-10 (`124329b`)
>
> **`next.config.ts` sets `Content-Security-Policy: frame-ancestors 'none'` on
> `/:path*`, and on Vercel that is the value Next reads the nonce out of.**
> Production and local, same build, same commit:
>
> | `/api/csp-echo` | local | production |
> |---|---|---|
> | `cspDirectives` | all **14** of ours (`default-src`, `script-src`, … `report-to`) | **`["frame-ancestors"]`** |
> | `cspCarriesNonce` | true | **false** |
> | `cspIsFrameAncestorsOnly` | false | **true** |
>
> `getScriptNonceFromHeader` reads `frame-ancestors 'none'`, finds no nonce,
> emits `$undefined`, and stamps 0 of 22 scripts. Nothing is dropped and nothing
> is cached — **our policy is overwritten by our own config header.**
>
> **The fix is a security trade, so it is the operator's call.** Removing that
> one line frees the header name and the nonce should land. `X-Frame-Options:
> DENY` is set immediately above it and is honoured by every current browser, so
> clickjacking stays covered — but `frame-ancestors` would then be enforced only
> by `X-Frame-Options` until C1 itself goes enforcing, since the directive in the
> report-only policy reports without blocking.
>
> **Do not "fix" it by moving the same header into middleware.** A response
> header set through `NextResponse.next()` comes back round as a request header
> (measured while building the diagnostic), so that reproduces the collision by
> another route.
>
> Worth a line in `docs/ENGINEERING_NOTES.md` once settled: **a
> `Content-Security-Policy` entry in `next.config.ts` `headers()` silently
> disables Next's nonce mechanism on Vercel, and not locally.**

> ### Superseded — the suspect above is now confirmed; kept for the reasoning
>
> ### PRIME SUSPECT, 2026-08-10 — `next.config.ts` occupies the header Next reads
>
> `/api/csp-echo` (deployment `dpl_u7QkfUVBp6Z6RHZvA9BgFnzjXhfu`, `f0f9f20`) came
> back from production with something neither hypothesis predicted:
>
> | | local (nonce works) | production (nonce broken) |
> |---|---|---|
> | `x-nonce` arrived | true | **true** |
> | `content-security-policy` arrived | true | **true** |
> | **it carries a `'nonce-…'`** | **true** | **false** |
>
> **The override is not dropped at all** — both headers arrive. What arrives under
> `content-security-policy` is a policy with **no nonce in it**, so
> `getScriptNonceFromHeader` reads it, finds nothing, and emits `$undefined`.
>
> **`next.config.ts` sets `Content-Security-Policy: frame-ancestors 'none'` as a
> RESPONSE header on `/:path*`** — and a response header set through this path
> comes back round as a REQUEST header (measured separately while building the
> diagnostic; see `proxy.ts`). On Vercel that nonce-less value wins the collision
> under the exact name Next reads. Locally it does not, which is the whole
> local/production split.
>
> **It explains every observation at once**, including why `51e7050` could never
> have worked: Next prefers `content-security-policy` over the report-only name,
> and the enforcing name is precisely the one `next.config.ts` occupies.
>
> **STILL AN INFERENCE, NOT A MEASUREMENT.** `cspCarriesNonce: false` proves the
> arriving value is not ours; it does not prove the value is
> `frame-ancestors 'none'`. One boolean added to `csp-echo` confirms or kills it
> in a single deploy — **take that measurement before changing anything.**
>
> **If it is confirmed, the fix is a decision, not a patch.**
> `X-Frame-Options: DENY` is already set on the line above, so removing the CSP
> response header keeps clickjacking covered by a header every current browser
> honours — but `frame-ancestors` would then live only in the report-only policy,
> where it does not enforce. That is a real trade to make deliberately, not a
> tidy-up.

> **HYPOTHESIS TESTED AND DISPROVEN — 2026-08-10, deployment
> `dpl_6argnu7s…` (`97a41e2`), measured against production, not reasoned about.**
> `51e7050` set the **report-only header name on the request as well**, on the
> theory that Next reads `content-security-policy || content-security-policy-
> report-only` and only the first name was being dropped. It is not the name:
>
> ```
> header advertises  : 'nonce-4b405d35f8b84b6f88daed7a5b3e60ea'
> script tags        : 22        carrying it: 0        carrying nothing: 22
> check:csp-nonce    : exit 1
> ```
>
> **What that buys us, exactly as the commit predicted it would:** the drop is
> not name-specific, so Vercel is not filtering a known security-header name. It
> is either the request-header override mechanism as a whole, or the value.
> **The next experiment is the one that separates those two, and it is cheap:**
> `proxy.ts` already sets `x-nonce` on the same request object in the same call.
> An echo route that reports which of `x-nonce` / `content-security-policy` /
> `content-security-policy-report-only` actually arrived answers it in one
> deploy — if `x-nonce` survives and the CSP names do not, it is name-based
> filtering after all; if none survive, `NextResponse.next({ request: { headers }
> })` simply does not work on this platform and the nonce has to travel another
> way.
>
> **`51e7050` is now known-useless and should come out with that next push** —
> it is harmless (request-side only, identical value, first name wins) but it is
> dead weight in middleware and reads like a fix.

> **Read this block before the two below it — it corrects both.**
>
> Production still serves **22 script tags and 0 nonces** on `/login`. Sentry
> proves it independently: 4 CSP issues opened, 57 events, all on
> `/settings/organization`, all `script-src-elem`/`frame-src`.
>
> **The `force-dynamic` fix below did work, and the edge-cache diagnosis below
> it is WRONG.** Both are disproven by the same measurement:
>
> ```
> CSP-RO header      : script-src 'self' 'nonce-e6e66e74…' 'strict-dynamic'
> script tags        : 22        with a nonce: 0
> RSC payload        : "nonce":"$undefined"  on every script
> X-Vercel-Cache     : MISS      Age: 0    Cache-Control: no-store
> nonce per request  : DIFFERENT each fetch (proxy.ts runs every time)
> ```
>
> Not cached (`MISS`/`no-store`), not prerendered (`ƒ` in the build output, only
> 4 allowlisted routes emit `.html`), and 26→22 tags confirms the force-dynamic
> commit is live. **So the cache theory cannot explain it.** `$undefined` in the
> RSC payload is the real signal: Next reads the nonce from the **request-side**
> `Content-Security-Policy` header (`app-render.js` → `getScriptNonceFromHeader`),
> and it got nothing to read.
>
> **The code is correct — the platform is the variable.** `next start` against
> the *same build*, verified this session, stamps **22 of 22**. Deployed
> `proxy.ts`/`csp.ts`/`next.config.ts` are byte-identical to local, and the
> production chunk names match the local build. What fails is `NextResponse.next({
> request: { headers } })` — the `x-middleware-request-content-security-policy`
> override does not reach the renderer on Vercel. Not a size limit: it fails on a
> bare 7-header curl.
>
> **Not yet root-caused: WHICH Vercel layer drops it.** That needs a diagnostic
> deploy (echo the header back from a route), which is a push — operator's call.
>
> **`npm run check:csp-nonce <url>` now measures this against any deployment**
> and fails when the header promises a nonce the scripts do not carry. It exits 1
> on production today and 0 on local. That is the check that was missing: the
> build guard and every local run were honest and blind.
>
> Consequence unchanged and now evidenced: **enforcing today would refuse 22 of
> 22 scripts.** Do not flip the header.

> **Superseded 2026-08-09 (later) — the "FIXED" claim below is false in
> production; the prerender half of it is true. See the block above.**

> **Fixed the same day it was found.** `/login`, `/login/verify` and
> `/session-clock` were statically prerendered, so their script tags carried no
> nonce while the header minted one per request — under `'strict-dynamic'`
> (which makes browsers ignore `'self'`) that refuses **every** script.
> `export const dynamic = "force-dynamic"` on those three, which is the idiom 10
> other pages here already use. Verified against a production build rather than
> assumed: `/login` went from **26 script tags / 0 nonces** to **22 of 22 nonced,
> matching the response header exactly**.
>
> **Guarded so it cannot come back**, by a check that can actually fire.
> `scripts/check-static-routes.mjs` runs in CI right after `npm run build` and
> fails if any route outside a documented allowlist was prerendered. It has to
> live there: the E2E suite runs against `npm run dev`, where every page is
> dynamic and nonced no matter what, and unit tests run before the build. A
> negative control was run — reinstating a static `/login` fails it, removing it
> passes. (An E2E version was written first and deleted: it could only ever have
> passed.)
>
> **The one decision left is `/offline`.** It is `force-static` on purpose (B8) —
> a PWA fallback must be precacheable and must not need the server — so it can
> never carry a per-request nonce. Under enforcement it still renders its "you
> are offline" message but does not hydrate. Either accept that, or give it a
> hash-based allowance. `/_not-found` and `/_global-error` are in the same
> position and matter less.
>
> Also unresolved and separate: `frame-src https://vercel.live` is reported on
> every page — allow it or turn the Vercel toolbar off in production.
>
> Step 1 below is therefore **done and it worked**: report-only in production
> caught a break that every local sweep called clean. What remains is the
> `/offline` call, then the header flip.

> **Superseded 2026-08-09 (later) — the FINDING here is right, the CAUSE is
> wrong. `X-Vercel-Cache: HIT` was a coincidence of that fetch; the page is
> `no-store` and re-measures `MISS` with the nonce still absent. See the top
> block.**

> **The production reports finally arrived, and they say the policy does not
> hold — the opposite of what the local sweeps concluded.**
>
> Every script on `/login` is reported blocked: 18+ chunks, the inline
> bootstrap, and `frame-src https://vercel.live`. Measured directly against
> production:
>
> ```
> CSP header nonce : nonce-5936cd54e1e745198635ef0a8797e38b
> nonces in the HTML: 0        script tags: 26   with a nonce: 0
> X-Vercel-Cache   : HIT       Age: 216
> ```
>
> **The served HTML carries no nonce at all, while middleware mints a fresh one
> per request into the header.** `'strict-dynamic'` makes a browser *ignore*
> `'self'`, so with no nonce on any tag the enforced policy blocks 100% of the
> JavaScript. Flipping the header today would leave `/login` rendering as dead
> HTML — a worse outage than the auth one on the same day.
>
> **Why every local run said 22/22 and 27/27 clean:** `next start` serves the
> page dynamically, so Next stamps the request's nonce into the tags and they
> match. Production serves **edge-cached prerendered HTML** (`X-Vercel-Cache:
> HIT`), which cannot carry a per-request nonce by construction. **No local test
> can ever catch this** — the discrepancy is the caching layer, and it only
> exists in production.
>
> So step 1 below ("let it run in production for a while") did its job exactly
> as designed: it caught a break that local evidence could not. The accumulated
> violations are not noise to clear before enforcing — they are the finding.
>
> **Before this can be enforced, the nonce/cache contradiction has to be
> resolved**, and that is a real design decision rather than a header flip:
> force dynamic rendering on pages that need the nonce, or drop `'strict-dynamic'`
> and rely on `'self'` for same-origin chunks, or move to hashes. Each has a
> different cost. `vercel.live` also needs a decision — allow it in `frame-src`
> or turn the toolbar off in production.

### C1 (original entry) — ⚪ **HISTORICAL, SUPERSEDED BY THE C1 SECTION ABOVE. Not the current state:** it says "staged report-only", and the policy has been ENFORCED since 2026-08-10. Kept for the reasoning.

> **UPDATE 2026-08-03 — the "Unverified" caveat below is resolved, and checking
> it found a real bug.** Sentry is wired (`SENTRY_DSN` + `NEXT_PUBLIC_SENTRY_DSN`,
> both confirmed live: the ingest origin appears in `connect-src`, the browser SDK
> initialises, and a probe report was confirmed arriving in Sentry), so the policy
> finally has a **durable sink** instead of a ~1h stdout window.
>
> **But reports were being delivered and thrown away.** Reading the runtime logs
> inside the retention window showed `/api/csp-report` had taken three POSTs and
> **two returned 413**. The 16 KB cap assumed reports are small; the `report-to`
> shape *batches* violations into one array where every envelope repeats
> `originalPolicy` — the whole CSP string — so ~a dozen violations clears 16 KB.
> Fixed in `42d017d`: cap raised to 128 KB **and the drop is now logged**, so a
> future loss is visible rather than silent. See DECISIONS `T-csp-413`.
>
> This is exactly the trap step 1 below warns about, in a worse form than
> written: not "an empty log might mean not-delivering", but "reports arrive and
> the endpoint rejects them". **Enforcement still wants real traffic first** — the
> accumulated violations are the input to that decision, and there is no rush.
The per-request nonce is threaded through `proxy.ts` and the full policy ships as **`Content-Security-Policy-Report-Only`** — it reports, it does not block. `frame-ancestors 'none'` stays separately **enforced** in `next.config.ts`, so clickjacking protection is unchanged. Full rationale in DECISIONS `T-csp`.

**The staging immediately earned its keep.** Against a *production* build, five screens reported `script-src / blockedURI: "eval"` — traced to **Zod 4's JIT validator compiler**, which builds schemas with the `Function` constructor. Dev had hidden it entirely (dev needs `'unsafe-eval'` anyway). Zod falls back on its own so it wouldn't have *broken*, but every page would have reported a violation and silently lost the fast path; since the enforced end-state is jitless regardless, `z.config({ jitless: true })` is now explicit.

**Evidence:** `lib/services/csp.ts` (10 unit tests, origins derived from env so local/prod both work) + `tests/e2e/csp.spec.ts`, which collects `securitypolicyviolation` events across 11 modules and 7 deep routes and asserts zero — **22/22 clean against a real `next start` production build** with the strict policy.

**Coverage extended 2026-07-24 — the detail-page gap is now closed.** The sweep additionally drives **property detail, contact detail, viewing detail and the slip-signing canvas** (reached by clicking through from the lists, so it uses real ids), and proves `img-src` against an actual Supabase Storage image rather than assuming it. **27/27 clean against a production build.** Routes with no data self-skip with an explicit reason instead of passing vacuously — a green run is only evidence for what actually ran.

**Reports now have somewhere to go (2026-07-24).** The policy originally named no `report-uri`, which made the whole report-only stage decorative: violations reached each visitor's console and nobody else, so "let it run in production" could not be acted on. There is now a public, auth-exempt collector at **`/api/csp-report`** (`report-uri` + `report-to`/`Reporting-Endpoints`). It never touches the database — an unauthenticated caller must never be able to append to the hash-chained event log — caps the body at 16 KB, always answers `204`, and de-duplicates per instance so one common violation cannot drown the rare interesting one. Distinct violations are logged as `[csp] …` (Vercel runtime logs) and sent to Sentry when a DSN is set.

> **Unverified:** that a real browser actually delivers reports to it. The policy demonstrably catches violations (an `img-src` probe is asserted in `csp.spec.ts`) and the endpoint demonstrably accepts and survives them (synthetic POSTs, including hostile input), but **no report reached the server in testing even after a 70-second wait** — headless Chromium over plain `http://localhost` appears not to deliver them. **Confirm in production by looking for `[csp]` in the Vercel runtime logs.** If nothing appears there after real use, delivery is the thing to debug — not the policy.

**Before enforcing (do NOT do this on local evidence alone):** — ✅ **all three
done; enforced 2026-08-10, see the top of C1.** Step 1 ran in production and
caught two separate breaks. Step 3's "one-line change" turned out to be two call
sites, which is why it is now a single `CSP_HEADER` constant.
1. Let report-only run in production for a while — real data, real screens, real browsers. **First confirm reports are actually arriving** (see above); an empty log could mean "clean" or "not delivering", and those are very different.
2. Two things the local sweep still cannot exercise: **PDF generation** (the evidence report renders server-side, and the download is a signed URL) and any screen whose data does not exist locally — `property_media` is empty on a seed database, so the Storage `img-src` result above came from a temporary fixture and the test self-skips without one.
3. Then flip the response header name from `Content-Security-Policy-Report-Only` to `Content-Security-Policy` in `proxy.ts` — a one-line change, trivially revertible.

### C2. Two-factor authentication — ✅ **DONE.** Opt-in enrolment 2026-07-24; **DB-level enforcement LIVE ON HOSTED since 2026-08-11** (0029), operator-confirmed in a signed-in session.

> ### ✅ DB-level enforcement is LIVE — 0029 applied to hosted 2026-08-11
>
> **Verified on hosted the day it landed, in a call separate from the apply:**
> 29 migrations · `non_filename_versions` 0 · **29 `require_aal2` policies, all
> 29 correctly shaped** (restrictive · ALL · `authenticated` · both clauses) ·
> `rls_aal2_coverage()` empty · `anon` **cannot** execute the predicate ·
> `authenticated` cannot introspect coverage · `get_advisors` clean ·
> chain verifies · 74 events.
>
> **Blast radius was read BEFORE applying, not assumed:** 2 admins, exactly one
> verified factor (`nontari@`), zero on `gerasimos@` — matching the design.
>
> **Function bodies matched local once line endings were normalised.** Raw
> `md5(prosrc)` differed because the local stack applies a CRLF file while the
> hosted apply carried LF; `md5(replace(prosrc, chr(13), ''))` is identical on
> both sides. **HANDOFF §3 recommends bare `md5(prosrc)` and it will false-alarm
> every time from a Windows workstation** — strip `chr(13)` first.
>
> ~~**Still open, and it is the operator's:** sign in, pass the TOTP challenge,
> load a real page.~~ **DONE 2026-08-11 — operator signed in and `/contacts`,
> `/properties` and `/tasks` all render.**
>
> That check could not be skipped and no agent could make it. Everything else
> here is database-level, and **an RLS denial returns zero rows rather than an
> error — so "no data" and "correctly denied" look identical in the UI.** Only a
> populated page separates them.
>
> **It proves this migration specifically, not just that the app works:** a
> password-only session belonging to an account WITH a verified factor is denied
> every one of the 29 tables. Reaching `/contacts` at all therefore requires the
> TOTP challenge to have been passed and `mfa_satisfied()` to have returned true —
> which is the whole feature, exercised end to end by a real browser.
>
> Design: `docs/superpowers/specs/2026-08-10-c2-db-2fa-enforcement-design.md`
> Plan and rollback: `docs/superpowers/plans/2026-08-10-c2-db-2fa-enforcement.md`
>
> **What it does.** `0029_require_aal2.sql` adds `public.mfa_satisfied()` — true
> when the caller holds an `aal2` session **or has no verified factor at all**
> (the Supabase opt-in template) — and a `require_aal2` restrictive policy on all
> **29** RLS-enabled tables. A stolen `aal1` JWT hitting PostgREST directly then
> reads nothing.
>
> **A user with no verified factor is untouched, deliberately.** That is the
> lockout safety net: production has one admin without a factor (BACKLOG,
> 2026-08-09 — *"C2 must not assume every admin has a factor"*), and he is who
> gets back in if this misfires.
>
> **Verified locally, measured not assumed:**
>
> | check | result |
> |---|---|
> | RLS suite | **44 passed** — the pre-existing 32 unchanged, 12 new |
> | the `aal` claim exists | proven: `mfa_satisfied()` is `true` only after a real TOTP challenge |
> | unfactored user | completely unaffected — reads and writes as before |
> | `anon` buyer pages | `share-links.spec.ts` 5 passed; `anon` is not a member of `authenticated`, so the policy never evaluates for it |
> | coverage guard | `rls_aal2_coverage()` returns `[]`, and **verifies the policy's SHAPE**, not just its name |
> | plan shape | `InitPlan … loops=1` — the predicate is evaluated **once per statement**, not per row |
>
> **Two guards were proven by breaking them, not by watching them pass:**
> weakening the predicate to `status is not null` made only the
> abandoned-enrolment test fail; replacing one policy with a permissive
> `using (true)` of the same name made the coverage guard report that table.
>
> **Known red, pre-existing and NOT caused by this work:**
> `tests/e2e/mfa.spec.ts` ("password alone stops working once a factor is
> enrolled") fails at the enrolment step — the QR dialog never renders.
> Reproduced on `main` with 0029 absent, so it is not a regression. It matters
> here because it is the app-layer half of the same feature: **if enrolment is
> genuinely broken, a user who loses a device cannot re-enrol**, which is exactly
> the recovery path this design assumed works. Settle it before applying 0029.
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

### C6. Backup and restore drill — ✅ **CLOSED 2026-08-05; nightly automated backups since 2026-08-07**

> **UPDATE 2026-08-08 — this entry's headline and its 08-04 block below are both
> out of date. Read this first.**
>
> **The drill RAN on 2026-08-05, both halves, and PASSED.** A throwaway project
> was restored from the 08-04 dumps: `verify_events_chain = true`, every row count
> matching production, 86/86 RLS policies, `auth.users` back. Then the Storage
> half (BACKUP_RESTORE §4c): all **26 objects restored byte-identical**, and the
> three evidence PDFs and the signed slip PNG still hashed to the
> `pdf_sha256`/`sha256` in their generation events — one pulled through the app's
> own Download button. **The backup restores, and the evidence survives it as
> evidence rather than as rows.**
>
> **Point 1 below — "`supabase db dump` has never been taken" — is also no longer
> true.** It was taken 2026-08-06 and that set is the restore-proven schema of
> record (all 73 event hashes byte-identical to production, checked with
> `md5(string_agg(hash))` rather than by `verify_events_chain`, which cannot tell
> restored hashes from re-minted ones). A recovery today returns the data *with*
> logins.
>
> **A nightly task has run since 2026-08-07** (03:45, `--keep 14`), producing
> verified sets that check their own output; 2026-08-08 is the current primary.
> **Point 2, RTO, is the honest remainder** — the drill proved recoverability but
> was not timed against the 4h target.
>
> **And one thing got worse, not better:** `gnk-backups/` moved off OneDrive to
> `D:\dev\TSOPOZIDIS` on 2026-08-07, so every set is now single-machine with no
> cloud copy. Off-site is the open item — see BACKUP_RESTORE §3.3.

> **SUPERSEDED — UPDATE 2026-08-04 — "there is no reachable backup today" is no longer true.**
> Three sets exist in `../gnk-backups/`: chain-faithful `events` (ids 1–62, plus a
> verified 63–73 delta), business tables, all 26 Storage files, and an auth +
> storage manifest. Integrity is md5-checked **inside Postgres** and again on
> disk. RPO is ~5 days ad-hoc rather than unbounded.
>
> **Two things still open, and the first is the real one:**
> 1. **`supabase db dump` has never been taken.** `auth.users` exists only as a
>    manifest, and a manifest does not restore — a recovery today would return
>    the data with **nobody able to log in**. Needs the database password, so it
>    is the operator's.
> 2. **RTO remains unmeasured** — no drill has been executed against these
>    sources, so the 4h target is still a guess.
>
> See the STATUS block at the top of `docs/BACKUP_RESTORE.md` for the apply order.
**See `docs/BACKUP_RESTORE.md` and DECISIONS `T-backup-drill`.** This item was scoped as "Supabase takes backups; nobody has proven a restore" — **that premise was wrong.** The org is on the Free plan, which Supabase excludes from automated daily backups; **as of 2026-07-30** there was no reachable backup at all, so the RPO was unbounded rather than 24h. (Six verified sets and a nightly job later, that sentence is history — it is kept because the Free-plan exclusion is still true and is *why* all of this had to be built by hand.) Two further findings: storage objects (signed slips, evidence PDFs, KYC scans) are in **no** database backup on any plan, and `verify_events_chain` is session-`TimeZone`-dependent, so a restore into a non-UTC project reads `false` on intact data. **Why it still matters:** the commission evidence chain is the product's core value and it is append-only — a corrupted or lost `events` table cannot be reconstructed from anywhere else. ~~**Remaining deliverable:** take the first backup (§3, under an hour, removes most of the risk on its own), get it off-site, then run the timed drill (§4) and sign off the proposed RPO 24h / RTO 4h (§6).~~ **Of those three, two are done** (first backup 2026-07-30, drill 2026-08-05). **What is actually left: get a set off-site** — now the only copy is on one machine — **and time a drill to sign off RTO 4h.** Verification pack `scripts/backup/verify-restore.sql` is written and self-tested 43/43 against hosted.

### C7. Role model beyond the three fixed roles — **1.5 weeks**
Today: `admin`, `agent`, `listing_manager`, enforced by `current_role_gnk()` inside RLS helpers. **Why revisit:** the audit surfaced places where role and capability diverge — a listing manager can reach the archived state field-by-field on the Details tab even though the one-click Archive is admin-only. That is a deliberate, documented decision, but it signals that "role" is starting to do too much work. **Direction:** capability flags on the profile, checked by the same SECURITY DEFINER helpers, so policy changes stay in one place. **Do not start** before there is a concrete second-office or franchise requirement — this is the kind of generalisation that costs more than it returns if built speculatively.

---

## D. Explicitly not recommended

- **`npm audit fix --force`** — it proposes `next@9.3.3`. See DEP-2 for the correct route.
- **Dashboard customisation** — guardrail 6 fixes three dashboards deliberately. Leave it.
- **Hard delete anywhere** — the append-only hash-chained `events` spine *is* the commission evidence. Retire states (archived / withdrawn / spam / lost) are the correct answer, and the GDPR erasure path already handles the one case that legally requires more.
- **WhatsApp API, KYC API, portal feeds, automated commission splits** — doc 01 §10 Do-Not-Build for Phase 1. Revisit only as a Phase 2 scope decision with the client, not as engineering initiative.
