# DECISIONS

Running log of implementation decisions made where the docs were ambiguous or
silent. Format: date · task · decision · rationale.

- **2026-07-20 · T-audit (keys, migration 0013)** — Keys audit fixes; supersedes
  the T4.6 three-statement movement design below. (1) All four movements now go
  through `record_key_movement` (0013), SECURITY DEFINER: the old flow was
  check-then-act (two concurrent checkouts both passed the app-side status
  read), split across the user client (movement insert) and the service role
  (cache update) with the event outside any transaction. Definer is deliberate —
  doc 04 lets agents MOVE keys while only admin/LM may UPDATE `property_keys`,
  so the derived status/holder cache can't ride the user's client; the function
  re-implements the matrix (org scope, mover roles, per-action transitions),
  row-locks the key, refuses unverifiable holder ids (cross-org/inactive
  profiles fall back to the typed name instead of being cached verbatim), and
  commits movement + cache + event atomically. (2) The dormant enum states are
  now reachable: `transfer` → `with_owner` (from in_office/checked_out),
  `mark_lost` → `lost` (last holder stays on the row for accountability), and
  `return` doubles as recovery from with_owner/lost. (3) Key meta (code/
  description) is editable by admin/LM per the matrix — row-count-guarded, no-op
  saves write nothing, code changes log `updated {from,to}`. (4) Key codes are
  unique per org (physical tags; 23505 → friendly error in register/edit).
  (5) `/keys` queries unwrap; per-key history dialog reads the full movement
  trail; the property Activity tab merges `entity_type='key'` events for its
  keys (they carry the key's id, so the property-only filter never showed
  them). (6) New RLS test 18 pins the doc 04 property_keys row + RPC guards
  (suite: 22 green).

- **2026-07-19 · T-fix (maps short link)** — The Details "Paste Google Maps
  link" field rejected `maps.app.goo.gl` share links (the default form mobile
  Google Maps "Share" produces). Root cause: a short link carries no
  coordinates in the URL — they only exist after its redirect
  (`…/maps/search/34.77,+32.41?entry=tts`), and the browser can't follow it
  (the short-link host sends no CORS headers). Two-part fix. (1) `parseMapsCoords`
  now also reads the `/maps/search|place|dir/lat,+lng` path form and decodes
  percent-escapes first (so `%2C` commas and consent-page `continue=<url>`
  wrappers resolve). (2) A new server action `resolveMapsShortLink` follows the
  redirect server-side via `lib/utils/maps-resolver.ts`. SSRF-guarded: entry
  must be a known Google short-link host (`maps.app.goo.gl`/`goo.gl`/`g.co`/
  `share.google`), each hop is only followed while it stays on a Google host,
  coordinates are read from the `Location` header so the final page is never
  fetched, 5-hop cap, 4s timeout, auth-gated. Read-only — no DB write, no event
  (the point is still persisted, with its event, only when the Details form is
  submitted). Decided this is in-scope bug-fixing (the field already advertises
  the feature), not a new external integration under the doc 01 §10 Do-Not-Build
  list.

- **2026-07-16 · T-audit (dashboards)** — Dashboard audit fixes. (1) Every
  dashboard query is now unwrapped via `lib/supabase/unwrap.ts` — a failed
  query THROWS to the T5.7 error boundary instead of silently rendering
  `data: null` as €0/empty; doc 05 error states require a broken dashboard to
  look broken. (2) Card badges and KPI counts use PostgREST `count: "exact"`
  so they show the true total, not the length of the limit-capped list (10
  overdue rows no longer masquerade as "10 total"). Summed values still
  aggregate in TS over capped rows — SQL-side RPC aggregates are BACKLOG.
  (3) Admin calendar windows (today, month start, mandate-expiry ≤30d) are
  Cyprus wall-clock days via the tz helpers, matching the agent dashboard
  (doc 02 §A11); rolling 7d/30d windows stay instant-relative. The agent
  day-end is the next Cyprus midnight by day-key, not +24h (DST days are
  23/25h). (4) "Hot buyers idle 3+ days" now filters
  `contact_types @> '{buyer}'` — doc 05 says buyers; previously any hot
  contact (seller, lawyer…) appeared. Contacts without the buyer type drop
  out by design. (5) `media_deleted` events now carry the original filename,
  recovered best-effort from the photo's `media_uploaded` event
  (property_media never stored a filename; events are append-only so old
  rows stay bare). (6) Admin "Latest events" lines are annotated
  (property reference · actor name) via EventTimeline's `note`. (7) Both
  dashboards read strings from the `dashboard` i18n namespace (en/el/ru) —
  they were the last hardcoded-English screens touched by T5.3. Shared card
  chrome deduplicated into `components/features/dashboard/card.tsx`.

- **2026-07-15 · T-sec (migration 0007)** — Security-advisor hardening. Supabase
  default privileges expose EXECUTE on public-schema functions to `anon` +
  `authenticated`, so the `SECURITY DEFINER` helpers were callable
  unauthenticated via `/rest/v1/rpc/*` — including the mutating `expire_mandates`
  and `next_reference`. 0007 revokes EXECUTE from `public`/`anon` on all of
  them, re-granting `authenticated` only where a real path needs it:
  `next_reference` (property create, [properties.ts:44]), `current_org_id` /
  `current_role_gnk` (referenced by RLS policies). `expire_mandates` (cron-only),
  `verify_events_chain` (service-role only) and the trigger functions are fully
  locked. Also pinned `search_path` on `set_updated_at` /
  `protect_property_reference`, and dropped the broad `storage_media_public_read`
  policy (public object URLs and the service-role branding `.list()` don't need
  it; it only let clients enumerate the bucket). Applied to hosted
  `yjgirvzgoiywdojnpkpd` and re-scanned. **Accepted (won't-fix) advisors:**
  `mandates_safe` SECURITY DEFINER view (deliberate owner-rights view, T0.4);
  `spatial_ref_sys` RLS + `postgis`/`pg_trgm`/`st_estimatedextent` in `public`
  (PostGIS-owned, read-only reference data); `reference_counters` RLS-no-policy
  (intended locked table, only `next_reference` writes it); the residual
  `authenticated`-only flags on `next_reference`/`current_org_id`/
  `current_role_gnk` (required by the app/RLS). **Still manual:** enable Auth
  leaked-password protection (HaveIBeenPwned) — a dashboard toggle, no SQL.

- **2026-07-09 · T0.2** — `[analytics] enabled = false` in `supabase/config.toml`.
  The analytics container (Logflare) requires the Docker daemon exposed on
  `tcp://localhost:2375`, which is off by default on Windows. Analytics is not
  used by any Phase 1 feature.

- **2026-07-09 · T0.4** — `mandates_safe` implements org isolation + role row
  rules inside the view (owner-rights view, not `security_invoker`), because LM
  has no base-table policy and an invoker-rights view would return LM zero rows.
  Doc 04 pattern updated in the same commit.

- **2026-07-09 · T0.5** — Local dev admin (`admin@gnk.local` / `admin1234`) is
  seeded via `supabase/seed.sql` (local resets only — hosted deploys don't run
  it). Production admin is created via the Supabase dashboard per doc 07.

- **2026-07-09 · T0.5** — Login page ships email+password only. The
  forgot-password flow (doc 05) is deferred to the Phase 2 email work (Resend +
  reset page) — see BACKLOG.

- **2026-07-10 · T1.2** — The reference is generated inside the create action at
  final submit (atomically with the insert), not when step 1 completes —
  abandoned wizards must not burn sequence numbers. Step 1 shows a
  `GNK-{DISTRICT}-####` preview instead.

- **2026-07-10 · T1.2** — Wizard offers kinds `standalone` and `project` only;
  units/phases are created from the project's units page (T1.6) where the parent
  is known.

- **2026-07-10 · T1.2** — Reference immutability enforced by DB trigger
  (migration 0004, synced to doc 03), not just a read-only field.

- **2026-07-10 · T2.3** — Merge does NOT rewrite historical events (doc 02 §C3
  says "move events references", but events are immutable and the hash chain
  covers entity_id — repointing would break `verify_events_chain` and violate
  CLAUDE.md guardrail 1, which outranks). Operational tables are repointed via
  service role; the contact timeline queries events for the contact PLUS all
  contacts merged into it (`merged_into_id`), so combined history still shows.

- **2026-07-11 · T3.2** — Offers have no hard delete ("CRUD" in the playbook
  notwithstanding): offers feed the commission evidence report (doc 02 §C6), so
  removing rows would orphan evidence. `withdrawn` is the soft delete. Editing
  (amount/terms/validity/contact) is allowed only while an offer is open
  (submitted/countered) and is evented with a change diff; decided offers are
  immutable — record a new offer instead.

- **2026-07-11 · T3.2** — Accepting an offer is refused while the deal already
  has another accepted offer (one accepted offer per deal keeps the T3.4 won
  guard unambiguous). Terminal statuses (accepted/rejected/withdrawn/expired)
  stamp `decided_at` and allow no further transitions.

- **2026-07-14 · T5.7** — Hardening & release. Sentry (`@sentry/nextjs`) is
  wired via `instrumentation.ts` + `instrumentation-client.ts`, both strictly
  env-gated: no DSN → `Sentry.init` never runs → a complete no-op (dev/CI are
  unaffected, and a deploy without the secret can't throw at startup). The
  build plugin / `withSentryConfig` wrapper is intentionally omitted — source
  maps aren't uploaded (stacks minified) but errors are still captured; this
  keeps `next build` stock and avoids destabilizing the release. Resilience:
  one app-level `error.tsx`, a root `global-error.tsx` (own html/body), and a
  branded `not-found.tsx` for the many `notFound()` calls — all report to
  Sentry. NO `loading.tsx` added anywhere: it triggers the Next 16.2.10
  queued-suspense-reveal hydration freeze (DECISIONS T3.5, BACKLOG). Production
  smoke test (login + create-property + sign-slip) is left MANUAL in
  docs/RELEASE_CHECKLIST.md — it writes real data to prod and needs prod
  creds, so it's the operator's to run, not the build's.

- **2026-07-14 · T5.6** — Import scripts are standalone `.mts` run by Node's
  native type-stripping (`node --env-file=.env.local scripts/import/*.mts`) —
  no tsx dependency, no build step. They're self-contained (only node_modules,
  no `@/` app imports) and EXCLUDED from the app tsconfig/eslint; validated by
  running them, not by CI typecheck. Node strip-only mode forbids TS parameter
  properties and enums — the Report class uses explicit fields (note for future
  scripts). Service role throughout; `imported` events insert via the same
  path as any write so the hash-chain trigger keeps `verify_events_chain` true
  (confirmed). Dedup: contacts by normalized phone then email; properties by
  reference; owner contacts by phone. Auto-referenced properties (blank
  reference) can't be deduped on re-run — that's inherent; provide references
  to make a property import idempotent. `resolveOrg` requires `--org` when the
  DB has >1 org (local has Test Org B from the RLS suite). Photo-folder media
  ingestion (doc 09 `photo_folder`) is deferred — BACKLOG.

- **2026-07-14 · T5.5** — Tasks. The feedback nudge stays a live QUERY
  rendered as a virtual section on /tasks (and the agent dashboard), NOT
  materialized task rows — task rows for it would need syncing when feedback
  arrives and could drift; the mandate-renewal auto-tasks ARE rows (created
  by expire_mandates, T4.5) and show an AUTO chip via `mandate_id`. Quick-add
  due dates store as Cyprus end-of-day (23:59 wall clock → UTC) so a task due
  "today" only turns overdue after the day actually ends. Done/reopen write
  `completed`/`reopened` events on entity `task` (acceptance).

- **2026-07-14 · T5.4** — Settings. Invites create the auth user with a
  ONE-TIME password shown once to the admin (no SMTP in Phase 1 — invite
  emails + self-service reset ride the Phase 2-3 email integration; doc 05's
  "reset 2FA" is skipped for the same reason, BACKLOG). Deactivation sets
  `is_active=false` AND bans the auth user (876000h) so the login itself is
  refused, not just the profile flagged; reactivation lifts both. Stage
  reordering parks the moving stage on sort_order -1 before swapping — the
  unique (org, deal_type, sort_order) index forbids a direct swap. New stages
  insert before the terminal won/lost stages, which shift up to stay last.
  cyprus_config saves shape-check transfer_fees/stamp_duty with the calculator
  parsers before writing (guardrail 5: a typo cannot produce nonsense fees).
  Branding uploads overwrite fixed paths in the public media bucket
  (branding/logo.png, branding/watermark.png — the watermark path the T1.4
  media pipeline already reads); cache-busted by the file's updated_at.

- **2026-07-14 · T5.3** — Dashboards. Guardrail 6 fixes three dashboards;
  listing managers get the AGENT view (their "my …" blocks scope to their own
  id) until the Owner/Developer dashboard ships in a later phase. Aggregations
  run in TS over minimal selects because PostgREST aggregate functions are
  disabled; the equivalent SQL sits in a comment above every query
  (acceptance: numbers reproducible by manual SQL — verified for all seven
  admin blocks). Stage bars filter by deal COUNT, not value, so €0-value
  pipelines still render (display "€X · N"). Charts are plain CSS bars — no
  chart library enters the stack for five bar lists. "Hot buyer idle" = no
  contact-scoped event within 3 days (contacts with zero events count as
  idle). The T4.3 feedback nudge moved to the agent dashboard per doc 05;
  admin KPI "won this month" carries the T3.4 acceptance forward.

- **2026-07-13 · T5.2** — Evidence report. The footer "report hash" is the
  SHA-256 of the canonical JSON of the ROWS (recomputable by regenerating with
  the same filters), not of the PDF file — the file contains the hash, so it
  cannot contain its own digest; the PDF file's SHA-256 goes into the
  `evidence_report_generated` event payload instead. Assembly runs on the
  caller's RLS client (what the agent can't see stays out of the report); the
  service role is used only for slip PNG downloads and the chain RPC. Stored
  with doc_type `other` (the enum has no report type — extend it if reports
  multiply). Scope: events from the contact plus its deals/viewings/offers/
  leads; a property filter narrows to that property's entities and drops
  contact-level rows. Preview skips slip-image downloads; the PDF embeds them.
  `getMandateDocumentUrl` generalized into `lib/actions/documents.ts`
  (`getDocumentDownloadUrl`) — one RLS-checked signed-URL path for all
  private documents.

- **2026-07-13 · T5.1** — Calculators. Pure band math in
  `lib/services/calculators.ts` with tolerant config parsers — malformed
  `cyprus_config` renders an explicit error card, never NaN results. C8's
  "embedded on property/deal" is delivered as prefilled `/calculators?price=`
  links from the deal header (expected value) and property header (asking
  price) rather than duplicating calculator UI on three pages. Copy-summary
  uses the async Clipboard API with an execCommand fallback for contexts
  without transient activation. Summary strings are EN-only for Phase 1
  (i18n-ready: single composition point, moves to messages when EL/RU ship).

- **2026-07-13 · T4.6** — Keys. The movement row is the RLS-checked user
  action (append-only; new RLS test 13 proves UPDATE/DELETE stick for every
  role); the key row's status/current-holder is a derived cache updated with
  the service role AFTER the movement insert succeeds — the matrix allows
  agents to move keys but reserves register-row edits for admin/LM, so the
  cache write can't ride the user's client. Checkout requires `in_office`,
  return requires `checked_out`; `with_owner`/`lost` and the
  `transfer`/`mark_lost` actions exist in the enums but get UI in a later
  phase (BACKLOG). Holder can be a staff profile or a free-text external name
  (lawyer, cleaner) — spec's checkout dialog implies non-staff holders.

- **2026-07-13 · T4.5** — Mandates. `expire_mandates()` (migration 0006, doc 03
  synced) now also creates renewal tasks: one per active mandate inside its
  reminder window, assigned to `properties.assigned_agent_id` (fallback: the
  mandate's creator), idempotent via new `tasks.mandate_id`. Both the task
  creation and the expiry flip write system events (actor null). All UI mandate
  reads go through `mandates_safe` — including the property-header badge and
  the live quality-score inputs — so LM sees rows with commission masked and
  the badge still renders correctly for every role. Mandate CRUD is admin-only
  (mirrors RLS); `expired` is cron-only, admin transitions are draft→active
  and draft/active→terminated. Signed agreements upload to the private
  `documents` bucket + a `documents` row (`mandate_agreement`) linked via
  `signed_document_id`; downloads mint a 120s signed URL after an RLS-checked
  row read. Score staleness: the cron flip does NOT recompute quality/health
  (recomputes are TS-side, in-action) — scores refresh on the next mutation,
  same precedent as T3.3.

- **2026-07-13 · T4.4** — Route builder is a fourth view mode on `/viewings`
  (doc 05 puts the day route builder on that screen). Saving stamps
  `route_date` + 1-based `route_order` on each viewing and writes ONE summary
  `route_updated` event ({route_date, stops}) instead of N per-viewing events
  — reordering is one user action, and per-stop events would spam the log.
  Agents see only their own scheduled viewings in the builder (matching the
  RLS update policy so a save can't half-fail); admin routes across agents.
  The printable sheet lives at `/route-sheet` in a chromeless `(print)` route
  group (auth still enforced by proxy.ts), excludes cancelled viewings, and
  orders by the saved route_order. `initialRouteOrder` (unit-tested) seeds the
  builder: saved order for that day first, then unrouted stops by start time;
  a route saved for a different date is treated as stale and ignored.

- **2026-07-12 · T4.3** — Viewing feedback is written as a **property-scoped**
  event (`entity_type='property'`, `event_type='viewing_feedback'`, payload
  carries `viewing_id` + rating/notes) so it surfaces directly on the property
  activity timeline (C7 acceptance) without the timeline query needing to join
  viewings. Status changes (complete/cancel/no-show) stay viewing-scoped
  `status_changed {from,to}`, reusing the existing registry line. Feedback is
  gated to `completed` viewings; the agent-dashboard nudge lists the current
  user's completed viewings with `feedback is null`. Calendar cards now link to
  the new `/viewings/[id]` detail (property/sign/status/feedback all live
  there), so the per-card property and sign links were removed to declutter.

- **2026-07-12 · T4.2** — Slip signing. Added `@react-pdf/renderer` (the
  stack's sanctioned PDF lib, also needed for the C6 evidence report) and
  render the slip PDF server-side inside the sign action. The signature pad is
  dependency-free — a plain canvas with pointer events on a white background
  (white so the PNG has no alpha, keeping the PDF embed and SHA-256 stable).
  Both the PNG and PDF live in the private `signatures` bucket, uploaded with
  the service role (bucket has no RLS policies by design, doc 04); downloads go
  through `getSlipDownloadUrl`, which RLS-checks the slip row then mints a
  120s signed URL. One slip per viewing is enforced three ways: UI (already-
  signed state), an existence check in the action, and the `viewing_id` unique
  constraint. Verified end-to-end: the PNG re-downloaded from storage hashes to
  the stored `signature_sha256`.

- **2026-07-12 · T4.1** — Viewing times convert through an explicit Cyprus
  wall-clock ↔ UTC helper (`lib/utils/tz.ts`), never the browser's local zone:
  `zonedWallClockToUtc` reads a datetime-local value as Asia/Nicosia and stores
  UTC; `zonedParts` pre-computes each viewing's Cyprus day-bucket + minutes on
  the server so the calendar client does no tz math. All conversions pass the
  zone to Intl, so a UTC CI box and a Cyprus laptop agree (unit-tested across
  the DST boundary). Double-booking is advisory, not enforced: the create
  action never blocks, the dialog shows a live clash warning, and the calendar
  flags overlapping same-agent viewings. `EntityPicker` gained an optional
  `onChange` so the dialog can react to the agent selection.

- **2026-07-12 · T3.5** — Removed `app/(app)/properties/loading.tsx`. Its
  Suspense boundary triggers a Next 16.2.10 bug (dev-verified): the segment's
  suspense reveal stays queued (`<!--$~-->` markers) and NOTHING below
  `/properties` ever hydrates — tabs, forms, and media DnD were silently dead
  while SSR HTML looked fine. Isolated by bisection: minimal static page on the
  route still failed; removing loading.tsx fixed it; error.tsx is innocent and
  stays. Restore the skeleton when Next ships a fix (BACKLOG).

- **2026-07-11 · T3.3** — Health recompute writes NO event: the score is
  derived state and every trigger (deal save, offer change, KYC save, legal
  save, conversation log) already writes its own event — same precedent as
  the property quality score (§A8). The score + factor snapshot live on the
  deal (`health_score`, `health.factors`) so kanban cards render breakdown
  tooltips without per-card joins. Mandate CRUD doesn't exist yet (T4.5) —
  its recompute hook lands there; until then mandate changes surface at the
  next deal-side mutation.

- **2026-07-11 · T3.2** — UUID form fields validate with `z.guid()`, not Zod
  4's `z.uuid()`. Postgres' `uuid` type accepts any 32-hex-digit value, but
  Zod 4 `.uuid()` enforces RFC 4122 variant bits and rejected the seeded
  `11111111-…` admin id — the silent-drop `optionalUuid` helper then turned a
  round-tripped agent_id into `null` and deleted the assignment on save
  (caught in T3.2 browser verification via the event log's change diff).
  Fixed in deals + properties validators; audit of the remaining strict
  usages is in BACKLOG.

- **2026-07-16 · T-audit-leads** — UPDATE policies with role checks only in
  USING leak their WITH CHECK to other roles: Postgres ORs the USING pool and
  the WITH CHECK pool of permissive policies *independently*, so the org-only
  `with check` on `leads_update_admin`/`deals_update_admin` was satisfiable by
  agents, letting them hand their own lead/deal to a third party (app-layer
  blocked, RLS not). Migration 0009 repeats the role check in the admin WITH
  CHECKs and pins the agent ones: leads new-row must stay self-assigned or
  unassigned (inbox actions work without claiming; releasing back to the pool
  is allowed); deals new-row must keep an ownership anchor (`agent_id` or
  `created_by` = uid), so a deal's creator may change its working agent but
  nobody can hand a deal fully away. Same-shaped policies on
  contacts/properties/viewings/tasks were reviewed and left as-is: their
  matrix rows don't promise a no-hand-off invariant, and cross-member
  hand-off there is normal collaboration (BACKLOG holds a follow-up to
  confirm that reading with the client).
- **2026-07-16 · T-audit-leads** — Lead actions verify affected rows before
  logging events. RLS USING filters an UPDATE to 0 rows *without* an error,
  so mark-called/close/convert on another agent's lead used to no-op silently
  and still log `called`/`lost`/`converted` events for mutations that never
  happened — poisoning the append-only evidence log. All lead mutations now guard
  ownership app-side (admin / assigned agent / unassigned), use conditional
  updates (`.is("first_response_at", null)`, `.in("status", open)`) for
  exactly-once stamps and race-safe closes, and `.select("id")`-check row
  counts before writing their event. Convert is two-phase with a
  pre-generated deal id: insert deal → conditionally flip the lead
  (`.in("status", open)`); the FK `leads_converted_fk` forces this order —
  the deal must exist before the lead can point at it (caught in browser
  verification). A convert that loses the race deletes its deal again via the
  admin client (authenticated has no DELETE on deals by design), so a failed
  convert can no longer strand an orphan deal. Convert also stamps
  `first_response_at` — converting is a response, the inbox clock must stop
  (ResponseClock also freezes for non-open leads now).

- **2026-07-16 · T-audit-pipeline** — Kanban stage moves are atomic and
  RLS-honest; stage tenure gets its own column. Four decisions from the
  pipeline audit:
  1. `move_deal_to_stage(uuid, uuid)` RPC (0011, SECURITY INVOKER): the deal
     UPDATE and its `stage_changed` event commit in one transaction, closing
     the same phantom-event hole T-audit-leads closed app-side (a listing
     manager's drag used to log an event for a move RLS had filtered to 0
     rows). The row lock also serializes concurrent moves, so the event's
     `from` stage is always the stage actually left. Won/lost targets are
     refused in the function — the guarded T3.4 flows stay the only close path.
  2. `deals.stage_entered_at` (0011): "days in stage" was derived from
     `updated_at`, which the `deals_updated` trigger touches on every write —
     including health recomputes — so the counter reset on any edit. Backfill:
     latest `stage_changed` event, else `created_at`.
  3. Client-called actions that throw were converted to result objects
     (`moveDealToStage`, `updateOfferStatus`): Next.js strips thrown Server
     Action messages in production, so every guard text (e.g. "use the guarded
     flow") surfaced as a generic digest error in prod. Result objects are now
     the convention for anything a client component calls directly.
  4. The pipeline board shows won/lost deals closed in the last 30 days as
     read-only cards (their columns were permanently empty because the board
     only loaded `status = open`); their droppables are disabled client-side.
     Remaining `.select("id")` row-count guards were added to deal/offer
     updates (`updateDealSection`, `saveOffer`, `updateOfferStatus`,
     `markDealWon`, `markDealLost`) per the T-audit-leads pattern.

- **2026-07-17 · T-audit-properties** — Properties module audit fix-all.
  Decisions and fixes:
  1. `deletePropertyDocument` now proves the row delete happened
     (`.delete().select("id")`, plus an `entity_type = 'property'` check)
     BEFORE the admin-client storage removal. Previously any authenticated
     role could call the action, RLS filtered the delete to 0 rows, and the
     code still destroyed the stored file and logged a phantom
     `document_deleted` — a non-admin could permanently break a document.
  2. The T-audit-leads/pipeline pattern is now applied across properties:
     `.select("id")` row-count guards + result objects on
     `updatePropertySection`, `setMediaCover`, `moveMedia`, `updateUnitStatus`
     (agents saving non-assigned properties used to get a fake "Saved" toast
     plus a phantom `property.updated` event). UI mirrors RLS: section forms
     render a disabled fieldset with a read-only note for non-editors, media
     manage buttons are admin/LM-only, unit forms admin/LM-only.
  3. The publish gate scores current row + pending updates (merged), not the
     stale stored row — filling the missing fields and flipping to Public in
     one save works now. `recomputeQualityScore` reads `mandates_safe` instead
     of the `mandates` base table: LMs have no base-table SELECT, so their
     saves wrote scores 10 points low on mandated properties (flip-flopping
     stored scores depending on who saved last).
  4. Event diffs compare jsonb with sorted keys (`lib/utils/diff.ts`, unit
     tested): Postgres re-orders jsonb keys, so multilang fields logged a
     phantom `updated` diff on every no-change save.
  5. List filters match the badge semantics: `mandate=none` = no active AND no
     expired (draft/terminated-only still counts as none), `mandate=expired`
     excludes properties that also hold an active mandate. Transaction filters
     include `sale_or_rent` in both Sale and Rent; € bounds check
     `rent_price_month` in rent context (rent-only listings used to vanish
     when any price was typed). Checkbox fields (`has_storage`, land
     utilities) store `false`, not NULL, and land-panel columns are only
     written for land rows. Area is clearable via a "— (no area)" sentinel
     option.

- **2026-07-17 · T-audit-contacts** — Contacts module audit fix-all.
  Decisions and fixes:
  1. The row-count-guard pattern reaches contacts: `updateContactSection`
     proves its update via `.select("id")` before logging the event (agents on
     non-own contacts and listing managers used to get a fake "Saved" toast
     plus a phantom `contact.updated` event — RLS filtered the write to 0 rows
     while `events` INSERT is org-wide, so the bogus row landed). New RLS test
     16 pins the matrix row. UI mirrors RLS: `ActionSectionForm` gained
     `readOnly` (disabled fieldset + note), wired from the page for LMs,
     non-owner agents and archived contacts. jsonb diffs now use
     `lib/utils/diff.ts` (`changedValue`), killing the phantom
     preferences/KYC diffs; `languages`/`contact_types` are stored sorted.
  2. Archive is the contacts "delete" (doc 04) and now exists in the UI:
     `archiveContact`/`unarchiveContact` actions (RLS decides who; row-count
     guarded; events `archived`/`unarchived`), an Archive/Unarchive header
     button, and an Active/Archived list filter. Merged-away losers can't be
     unarchived (their references were repointed); archived contacts are
     read-only everywhere including document upload.
  3. Merge hardening: refuses an archived PRIMARY; a half-applied merge
     (archive step done, repoints failed) is now resumable — re-running with
     the same pair finishes the idempotent repoints/backfill instead of dying
     on "already archived". Backfill logic moved to pure
     `lib/services/merge-backfill.ts` (unit-tested): a conflicting duplicate
     phone is parked in `additional_phones` (schema column previously never
     written) and dedup checks (`checkContactDuplicate`, profile-save dup
     check) now match additional phones too; assignment/psychology/source/
     preferred_channel backfill when the primary lacks them; KYC/banking/
     preferences move wholesale ONLY into an empty primary (never mixed); a
     conflicting duplicate email is recorded as `dropped` on the merged event.
     Notes append is marker-idempotent. Full RPC atomicity stays in BACKLOG.
  4. `preferences.areas` stores area IDs (the importer already wrote IDs; the
     UI wrote EN names — imported preferences never displayed). The form now
     posts IDs and transitionally matches either ID or legacy name, so
     existing name-based rows still light up and self-heal to IDs on the next
     save. No data migration needed.
  5. Contact detail gained the spec'd Deals tab (deals where the contact is
     buyer or seller, RLS-scoped) and Documents tab (mirrors the property
     documents pattern: private bucket, `entity_type='contact'`, KYC doc-type
     subset, admin-only delete with row-count guard). Profile tab gained the
     schema-only fields `source_detail` (was silently nulled on every save —
     written by the action but collected by no form), `preferred_channel`,
     `gdpr_notes`, an admin-only "Assigned agent" select (the list filter
     existed but nothing could set assignment; RLS hand-off is the documented
     0009 decision), and read-only "also reachable at" additional phones.
  6. The topbar ⌘K search is real now (`GlobalSearch` on the existing
     `searchEntities` action: properties + contacts + quick-add links) — it
     was a decorative static div. Clearable selects use a shared
     `SELECT_NONE` sentinel ("—" item) so source/psychology/channel/purpose/
     feasibility can be un-set; deactivated agents render "(inactive)" in the
     list instead of "—" (looked unassigned).

- **2026-07-20 · T-audit-tasks** — Tasks audit pass (fix-all).
  1. Renewal-task lifecycle reworked (migration 0012). The 0006 idempotence
     guard (`not exists (ANY task for the mandate)`) made reminders ONE-SHOT:
     renewing a mandate is an in-place `expiry_date` update, so after the
     first reminder no later cycle could ever fire, and the open task went
     stale (old due/title). New invariant: **an OPEN renewal task exists iff
     its mandate is ACTIVE with a MATCHING expiry** — the guard is keyed per
     expiry cycle (task's Cyprus due DATE = mandate `expiry_date`; date not
     timestamp, so pre-0012 midnight-UTC rows still match), `saveMandate` /
     `setMandateStatus` complete open tasks the moment an admin breaks the
     invariant (`superseded` event WITH actor), and the nightly cron
     supersedes as actor-null safety net. Superseded tasks are COMPLETED,
     never deleted — history keeps its shape and "Recently done" stays
     honest. Renewal due_at is now Cyprus 23:59 end-of-day like quick-add
     (was midnight UTC = "overdue" all of the final day). Assignee fallback
     chain grew a third arm: property agent → mandate creator → oldest
     active org admin — imported mandates (no `created_by`) on unassigned
     properties were producing NULL-assignee tasks that NO surface showed
     (/tasks and the agent dashboard both filter `assignee_id = me`).
     Backfills: stale open tasks superseded, surviving midnight-UTC stamps
     moved to EOD (same calendar day), orphans reassigned to the org admin —
     each with system events.
  2. `toggleTaskDone` got the repo-standard row-count guard, folded into the
     write: `.eq(id).neq("is_done", done).select("id")`. Creators can SELECT
     tasks only the assignee/admin may UPDATE, so the old unguarded update
     could toast "Done" and log a phantom `completed` event off an RLS 0-row
     no-op; the `.neq` also makes rapid double-toggles single-fire. 0 rows =
     explicit error, no event.
  3. /tasks page queries unwrap via `lib/supabase/unwrap.ts` (failures throw
     to the boundary instead of rendering "0 open"), and the header/nudge
     counts use `count: "exact"` (dashboard-audit conventions).
  4. New RLS test 17 pins the doc 04 tasks row: assignee/creator visibility,
     creator-can't-toggle (the silent no-op behind #2), assignee/admin
     update, creator/admin delete, LM insert. Suite: 21 green.
  5. Quick-add `due_date` now rejects malformed values instead of silently
     dropping them (was: task saved with no due date).

- **2026-07-20 · T-audit-settings** — Settings module audit pass (fix-all).
  1. **Deactivation is instant now** (migration 0014). `current_org_id()` /
     `current_role_gnk()` gained `and is_active`: a deactivated profile makes
     both return NULL, failing every policy predicate for that user on the
     next statement — a live JWT no longer rides out its ~1h TTL with full
     access (the auth ban only blocks NEW token issuance). App-side,
     `getCurrentProfile` selects and enforces `is_active` as belt and braces
     for pre-0014 environments. RLS test 19 pins it: live session, flag
     flipped service-side, all reads/writes die, reactivation restores.
  2. **`setUserActive` was the last phantom-0-row bug** — and the worst one:
     the RLS-scoped profile update silently no-ops for a cross-org/unknown
     UUID, but the SERVICE-ROLE ban that followed would hit ANY auth user in
     the instance, then log a bogus event. Now: RLS-scoped existence check
     first, row-count-guarded flag update, ban after — and if the ban errors
     the flag is reverted so UI state never claims what the login doesn't
     have. `setUserRole`, `renameStage`, `renameArea`, `updateOrgName` and
     `saveCyprusConfig` got the same `.select()` guards (an unknown config
     key previously toasted "saved" off a 0-row update).
  3. **Stage add/reorder are atomic RPCs** (0014: `add_deal_stage`,
     `reorder_stage`, SECURITY INVOKER, 0011/0013 pattern). The app-side
     park-at(-1) swap ran as three round-trips — a failure stranded the
     stage at sort_order -1 — and the append's terminal-shift loop was
     equally non-atomic, with events outside any transaction. Both RPCs
     row-lock, row-count-guard every write, refuse duplicate names
     (case-insensitive), and write `stages_updated` in-transaction. RLS
     test 20 covers admin/non-admin, terminal-stays-last, dup names, edge
     no-ops, and no-parked-stage invariants.
  4. **Branding uploads decode-verify with sharp** (client MIME is not
     evidence): format must be png, watermark must carry an alpha channel —
     a corrupt watermark used to break EVERY later public-photo upload
     inside the T1.4 pipeline as per-file "unreadable image" errors.
  5. **Invite dialog is reusable**: `useActionState` kept the first invite's
     credentials forever, so a second invite needed a page reload. The flow
     is now a keyed child remounted by an explicit "Done" (accidental
     Escape keeps the one-shown-once password recoverable); the credentials
     screen shows email + password and copies both.
  6. Layout-gate note: Next.js renders pages in PARALLEL with the layout, so
     the settings layout's "Admins only" screen never stopped page RSCs from
     executing their reads. Harmless here (all reads are org-visible or
     public-bucket by design) but each settings page now short-circuits for
     non-admins — do not rely on layout gates for anything sensitive.
  7. Polish: cyprus_config `source_note` is clearable (the `|| undefined`
     transform made saved notes permanent); stages order by `deal_type` then
     `sort_order` (group order was tie-luck); districts by seeded
     `sort_order`, areas alphabetically (was uuid order); add/rename inputs
     submit on Enter; `dealType` zod-enum'd (`DEAL_TYPES` in validators);
     new validators/settings unit tests.

- **2026-07-20 · T-audit-reports** — Reports (commission evidence) audit
  fix-all. (1) Both PDFs (evidence + slip) now embed Noto Sans LGC
  (`lib/assets/fonts/`, OFL; registered in `pdf-fonts.ts`, force-traced into
  serverless bundles via `outputFileTracingIncludes` — react-pdf reads fonts
  from disk, so Vercel import tracing never sees them). Built-in Helvetica is
  Latin-1 only: Greek/Cyrillic names rendered as tofu in every stored PDF.
  Courier stays for hex digests (ASCII); U+2192 has no glyph in Noto LGC, so
  event lines render "->" at PDF time only (report hash reads the raw rows).
  (2) Chain check is tri-state: preview skips the org-wide walk entirely
  (`verifyChain: false` — it is O(all org events) in plpgsql and ran on every
  GET), generation requires it, and an RPC *failure* now refuses generation
  instead of printing "chain FAILED" — a transient error was
  indistinguishable from tamper on an evidential document (this exact RPC
  already broke once in prod, see 0010). (3) Row order — and with it the T5.2
  "recomputable" report hash — is now deterministic: events select `id`,
  order by `occurred_at, id`, and `sortChronological` tiebreaks on id
  (insertion = hash-chain order). The canonical hash form is UNCHANGED (id
  excluded), so hashes of previously stored reports stay recomputable.
  (4) Date filters are Cyprus-local days via `zonedDateRangeToUtc` (half-open
  upper bound; the old `T00:00:00Z`–`T23:59:59Z` filter shifted boundary
  events by 2–3h and dropped sub-second ones); slips honour the same window.
  (5) Truncation is honest: hitting the 500/family cap flags the preview and
  REFUSES generation (was: silent omission). (6) The PDF names its generator
  and scope ("events visible to this user" for non-admins — RLS keeps other
  actors' and system events out of agent reports by design, T5.2). (7) A
  property filter now pulls the property's own event family (price/status/
  legal changes; media churn excluded) and lead/offer rows resolve their
  property refs. (8) Admin-generated reports store `visibility='admin_only'`
  (they carry the full org record; `internal` let any agent download them).
  (9) Generation is transactional-ish: documents-insert failure removes the
  uploaded file; logEvent failure rolls back row + file (guardrail 1: no
  stored report without its event). Unit tests cover the new pure pieces;
  `server-only` is stubbed for vitest via alias (`lib/testing/`).

- **2026-07-21 · T-audit-reports-2** — Reports follow-ups from the T-audit-reports
  BACKLOG block, all shipped. Migrations **0015** (enum value) + **0016**
  (backfill, `chain_checks`, cron) — split because Postgres cannot USE a new
  enum value in the transaction that adds it, and the CLI wraps each migration
  file in one transaction.
  1. **`document_type` gained `evidence_report`** (T5.2 said to extend it "if
     reports multiply"). Existing rows backfilled by `storage_path like
     '%/reports/evidence-%'` — the path column is trigger-frozen, the title is
     admin-editable, so the path is the reliable key.
  2. **/reports lists generated reports** (RLS does the access control: the
     admin_only visibility set in T-audit-reports already hides admin-generated
     reports from agents) with uploader + download, plus a nightly chain badge.
  3. **`chain_checks`** caches one `verify_events_chain()` result per org,
     refreshed by pg_cron at 03:30 (after expire-mandates at 03:00, so its
     events are covered) and seeded at migration time so the badge is live
     immediately. Staff SELECT their org row; NO insert/update/delete policies
     and `run_chain_checks()` is revoked from authenticated — only cron writes.
     RLS test 21 pins all of that. This replaces the O(all org events) walk the
     preview used to run on every GET; generation still verifies live.
  4. **Verify a report** (`verifyEvidenceReport`): upload the PDF (SHA-256
     recomputed server-side) or paste a digest — `extractSha256Hex` pulls a
     64-hex run out of pasted text so a copied PDF footer line works — and
     match it against `events.payload->>pdf_sha256`. Deliberately RLS-scoped,
     not service-role: "no match" therefore honestly means "no such report in
     the log VISIBLE TO YOU", and the UI says so. Proves a printed report
     byte-identical to what was generated.
  5. **Deal filter** (doc 05 "contact + optional property/deal"). Semantics,
     since viewings/leads carry no deal_id: the deal pins deals+offers to that
     one deal, and viewings/leads/property-events narrow through the deal's
     property. A deal with NO property narrows them to none rather than
     guessing. Unknown/invisible deal id = explicit error, not a silent
     unfiltered report. `deal_id` also lands in the generation event payload.
  Reports i18n stays in BACKLOG with every other module's i18n line.

- **2026-07-21 · T-audit-reports-2 (follow-up, same day)** — Made the reports
  code migration-order-independent after noticing the Vercel deploy of
  `8924be0` went live while hosted was still pre-0015: inserting
  `doc_type = 'evidence_report'` against a DB without the enum value would
  have broken Generate PDF in production. Two changes: the generate action
  retries the insert with `'other'` when Postgres reports an invalid enum
  value (0016's storage_path-keyed backfill relabels those rows once the
  migration lands — remove the shim when every environment is on 0015+), and
  the /reports list matches `storage_path like '%/reports/evidence-%'` rather
  than `doc_type`, which needs no enum value at all and survives title edits.
  General rule this reinforces: a migration that adds an enum value must not
  be a hard dependency of the deploy that ships with it — Vercel deploys on
  push, hosted migrations are applied by hand (classifier-blocked for the
  agent), so code and schema always land out of order here.

- **2026-07-21 · T-list-scope** — Retired records now leave the working lists.
  The user asked whether it is acceptable that admins cannot delete leads or
  properties. It is: doc 04 denies DELETE on every business table on purpose
  (the `events` spine is append-only and hash-chained; `verify_events_chain`
  gates evidence-report generation, so orphaning events would cost the product
  its commission evidence). The real defect was that the *retire* states doc 04
  names as the delete replacement were never wired into the list queries, so
  nothing ever left the screen:
  1. **Leads** — `/leads` fetched every lead regardless of status while the
     header counted only open ones (the reported symptom: "0 open" above two
     visible closed leads). New `leadFiltersSchema` + `leadStatusesForFilter`
     (lib/validators/contacts.ts) and a `LeadsFilters` select. Default scope is
     `open`; `closed` and `all` are scopes, and each of the six concrete
     statuses can be picked directly. The default writes NO query param, so a
     bare `/leads` is the open inbox.
  2. **Properties** — a property retires via status `withdrawn` and/or
     visibility `archived` (doc 04), but the list applied neither. New `scope`
     filter (`active` default / `archived` / `all`) with the retirement rule
     "either one alone means retired" — a withdrawn listing is off the working
     list whatever its visibility, and vice versa.
  The one subtlety worth keeping: `resolvePropertyScope` makes an explicit
  status/visibility filter WIN over the default active scope. Picking
  "Withdrawn" from the status filter while scope is `active` would otherwise
  AND two contradictory conditions and return an empty list, making the status
  filter look broken. Unit-tested in lib/validators/properties.test.ts.
  Header counts on /leads stay open-scoped on purpose — they are inbox-health
  metrics ("N awaiting first response"), not a count of the rows below.

- **2026-07-21 · T-property-archive** — One-click Archive / Restore on property
  detail, mirroring the contacts archive button so the retire gesture is the
  same across modules. Retiring a property previously meant knowing to open the
  Details tab and set status and/or visibility by hand. No migration, no policy
  change: `archiveProperty` / `restoreProperty` are ordinary RLS-scoped updates
  with the repo-standard `.select("id")` row-count guard.

  **Admin-only, enforced in the actions and not left to RLS.** Both actions
  open with `if (profile.role !== "admin") return { error: "Admins only." }`,
  matching the settings/mandates convention. This is not belt-and-braces: the
  properties UPDATE policy admits listing managers on ANY org property and
  agents on their assigned ones, so hiding the button would not have been a
  control at all. Proven by psql JWT-impersonation — an LM's `update
  properties set visibility='archived'` returns `UPDATE 1`, i.e. the database
  would happily let them retire a listing. Retiring is an owner decision, so
  the app is the gate. (Non-admins can still reach the same end state field by
  field on the Details tab, which is deliberate — that is the existing edit
  right, just not a one-click retire.)

  Three rules, pinned by `resolveRestoreUpdates` unit tests because they are
  the easy things to get wrong later:
  1. **Archive writes `visibility` only, never `status`.** Status is market
     truth. A villa that SOLD must still read `sold` after archiving, or the
     outcome disappears from reporting and from the timeline. Archiving answers
     "should this show up", which is a visibility question. Verified live: a
     sold property archived and restored came back `sold`.
  2. **Restore returns visibility to `private`, never `public`.** Un-archiving
     must not silently republish a listing — that is an explicit Details-tab
     decision behind the quality-score publish gate.
  3. **Restore also clears a `withdrawn` status back to `available`**, because
     withdrawn is the OTHER retire marker the T-list-scope filter honours.
     Leaving it set would drop the row straight back into the Archived list and
     make Restore look broken. Every other status survives untouched.
  `resolveRestoreUpdates` lives in lib/validators/properties.ts, not the
  actions file — "use server" modules may only export async functions (see the
  2026-07-16 prod crash note).

- **2026-07-21 · T-contact-erasure (migration 0017)** — GDPR Article 17 erasure
  for contacts. Full design + the legal reasoning:
  `docs/superpowers/specs/2026-07-21-gdpr-contact-erasure-design.md`.

  **Erasure is a REDACTION, not a delete, and that is forced by the data model,
  not a shortcut.** Three of the six places personal data lives cannot be
  rewritten: `events.payload` carries `contact_name`/`signer_name` and is
  covered by the `trg_events_hash` chain (editing one breaks
  `verify_events_chain` from that row on and blocks ALL evidence-report
  generation); `viewing_slips` hold the signer's name, signature image and GPS
  and are immutable by doc 04 because they are the commission evidence;
  generated evidence PDFs have names in bytes whose SHA-256 is recorded in the
  log. Two legal bases cover retaining them — GDPR Art.17(3)(e) (defence of
  legal claims) and Art.17(3)(b) with the Cyprus AML 5-year customer
  due-diligence retention duty. A "delete everything" button would destroy the
  commission evidence AND breach a statutory duty, so it is not built.

  What ships: the profiling layer is cleared (notes, psychology, preferences,
  source detail, telegram, additional phones, nationality, languages, banking
  readiness, marketing consent), `temperature` is forced to `inactive` so the
  contact can never resurface on a marketing/hot-buyer surface, the contact is
  archived and frozen read-only, and `leads.message` — the person's own words,
  an ordinary column and NOT hash-chained — is replaced with a marker.
  Identity fields (name/phone/email) are kept by operator decision so past
  transactions stay readable.

  **The KYC branch is decided per contact, and it is the reason the planner is
  a separate pure module.** No deal, no viewing slip and no mandate means no
  customer due-diligence relationship ever existed, so the documents and their
  storage objects are destroyed outright and the KYC checklist is wiped. With
  any of those, the files are retained and `retention_until` is stamped 5 years
  out — the checklist IS the due-diligence record in that case. That branch
  decides whether a passport scan is destroyed, so `planContactErasure` lives
  in `lib/services/erasure.ts` with no I/O and is unit-tested, including a test
  asserting identity fields never appear in the patch and one asserting the
  audit payload never becomes a copy of the erased data.

  Admin-only enforced in the action, not just the UI — the contacts UPDATE
  policy also admits the assigned/creating agent, the same lesson as
  `T-property-archive`. Confirmation is a typed contact name because erasure is
  irreversible by design. The `contact.erased` event carries categories and
  counts only (fields cleared, leads redacted, documents deleted vs retained,
  retention date, AML basis) and is append-only, so it is the compliance record
  and cannot be quietly undone.

  Not built, deliberately: anything that acts on `retention_until` (earliest
  real expiry is 2031 — BACKLOG), erasure of `deals.commission_notes` (retained
  under the legal-claims basis), and any undo.

- **2026-07-21 · T-audit-reports-3** — Reports i18n (the last open line from the
  T-audit-reports block) + the first REAL evidence report generated on prod.
  1. **`reports` namespace in en/el/ru** (127 keys per locale), wired with
     `getTranslations` (pages, generate/verify actions) and `useTranslations`
     (builder, verify component). Phase 1 still renders English —
     `i18n/request.ts` pins `defaultLocale` and locale routing is deliberately
     absent (doc 02 §A5) — so this makes the module translatable, exactly as
     the dashboard pass did.
  2. **Action errors translate too.** `assembleEvidence` now returns an
     `EvidenceFailure` carrying an `errorKey` (+ an optional untranslatable
     `message` detail) instead of English prose, so the preview page and the
     generate action each render it in the caller's language; the Zod schema
     carries key names, not sentences. Passthrough Postgres/storage messages
     stay verbatim.
  3. **The PDF stays English, deliberately.** It is the evidential artifact
     quoted in commission disputes, and its event lines come from
     `describeEvent`, whose vocabulary is shared with every timeline in the app.
     Translating the report chrome while the event rows stayed English would
     read worse than a consistently English document. Translating
     `describeEvent` is a separate app-wide job — BACKLOG.
  4. **New `messages.test.ts` compiles every message in every locale.** The
     first version PASSED against a deliberately malformed message: next-intl
     swallows format errors and falls back to the key path. It now installs an
     `onError` that rethrows, re-verified by sabotaging a message and watching
     it fail (INVALID_MESSAGE: MALFORMED_ARGUMENT). Key parity with English is
     asserted per locale, so a half-translated file fails CI.
  5. **First real prod report** (user-authorized): contact MARIOS ANDREOU, 19
     events, `chain_ok = true`, stored `admin_only` with
     `doc_type = 'evidence_report'` (the 0015 enum path, no fallback). The
     stored report hash matched the preview hash exactly — the T-audit-reports
     determinism fix confirmed on real data — and the PDF verified "Authentic"
     through the new tool on the live site.

- **2026-07-22 · T-audit-events-i18n** — `describeEvent` (the event-line
  vocabulary shared by every timeline: property/contact/deal/lead/keys
  activity, the dashboard "Latest events", and the commission evidence record)
  is now translatable, closing the last i18n line in BACKLOG.
  1. **`describeEvent(e, t)` takes a translator** — a minimal `EventTranslator`
     type so the module stays free of next-intl and unit-testable with a plain
     function. Each registry entry still does the payload branching in TS
     (which message, what values) but the fixed text lives in the `events`
     namespace (en/el/ru). Only the TEMPLATE translates; interpolated payload
     data (names, section keys, channels, stage names, user-typed reasons, file
     names, de-DE-formatted money) stays exactly as stored — a Greek user still
     sees the reason a lead was lost in the language it was typed.
  2. **`EventTimeline` is now an async server component** that calls
     `getTranslations("events")` and passes the request-locale translator down.
     All four call sites (dashboard, deal/contact/property detail) are RSCs, so
     no page changed. A localized `events.noActivity` replaces the old
     hardcoded English default.
  3. **The evidence record stays English** (preview AND PDF), per
     T-audit-reports-3. `assembleEvidence` builds its lines with a translator
     pinned to English. **NOT via `getTranslations({locale:"en"})`** — that was
     the first attempt and it rendered the preview in Greek, because
     `i18n/request.ts`'s `getRequestConfig` hardcodes `defaultLocale` and
     ignores the requested locale, so an explicit-locale `getTranslations`
     silently follows whatever locale is live. Fixed with `createTranslator`
     over the imported `en` messages (request-config-independent). Proven by
     generating a report while the request locale was Russian: the PDF came out
     fully English and its hash matched the el-mode preview.
  4. **ICU pluralization is a real gain over the old string concat:** "1 event"
     not "1 events" (en), and correct Slavic forms in Russian ("9 событий" =
     the *many* form). The events unit test now runs a fake translator (proves
     the line routes through `t`, RED before the refactor) plus real-English
     parity; `messages.test.ts` compiles every `events` message in all three
     locales and pins key parity, so a half-translated file fails CI.

- **2026-07-22 · T-audit-pdf-ligatures** — Generated PDFs looked correct but
  their TEXT LAYER was lossy: a real production commission report extracted as
  "Lead corrected — ?rst-response reset" / "chain veri?ed", and the report hash
  extracted as nothing at all. Both matter — an evidence document gets
  text-searched and quoted, and the hash is exactly what a verifier pastes into
  "Verify a report".
  1. **Ligatures.** @react-pdf/renderer shapes with fontkit and draws the
     resulting glyphs itself, bypassing pdfkit's `encode()` — the only path
     that records `glyph.codePoints` into the ToUnicode CMap. A substituted
     `fi`/`ff` glyph therefore lands in the embedded subset with NO ToUnicode
     entry. react-pdf exposes no way to pass OpenType features (textkit
     hardcodes `font.layout(str, undefined, …)`), so we disable the
     substitutions in the fonts we bundle: `scripts/fonts/disable-ligatures.mjs`
     renames the `liga`-family FeatureRecord tags in GSUB to an inert uppercase
     tag (length-preserving — no offsets move). Re-run it if the fonts are ever
     re-downloaded from upstream. Noto is OFL with NO Reserved Font Name, so
     modifying and redistributing under the same name is permitted.
  2. **Courier.** The hash lines used `fontFamily: "Courier"`, a standard-14
     font that embeds without a ToUnicode CMap — its text cannot be copied or
     searched *at all*. Both PDFs now set hashes in the embedded Noto Sans with
     slight letterSpacing. Monospace is not needed for correctness here: the
     hex alphabet (0-9a-f) contains none of the confusable pairs (O/0, l/1/I)
     that motivate a monospace face for digests.
  3. **Regression test.** `lib/testing/pdf-text.ts` decodes what a PDF actually
     draws — resolving `/Fn` -> font object -> `/ToUnicode` per font, since each
     embedded subset has its own glyph-id space — and surfaces unmapped glyphs
     as U+FFFD. The evidence PDF test asserts ligature-prone words round-trip,
     that the report hash is extractable, and that no unmapped glyph exists
     anywhere. Note this checks the copy/paste layer, NOT the visual page.
  Already-stored reports keep their original (lossy) text layer — they are
  immutable artifacts; only newly generated ones benefit.

## 2026-07-23 · T-audit-perf3 — dashboard aggregates move into SQL

The admin dashboard summed money in TypeScript over row-capped fetches
(deals/leads/properties `.limit(2000)`, events `.limit(5000)`). Counts had been
exact since 2026-07-16, but the € figures had not: past the cap the headline
"Open pipeline" and "Won this month" tiles under-reported with nothing on
screen saying so. Measured, not assumed — a rolled-back probe adding 2,100 open
deals showed the RPC at €2,845,000 against the old capped sum's €2,723,000, a
silent €122,000 shortfall.

Migration 0018 adds `admin_dashboard_stats(p_month_start, p_d7, p_d30)`
returning jsonb.

- **SECURITY INVOKER, not DEFINER.** The aggregates must run under the caller's
  RLS, exactly like the queries they replace. A DEFINER function here would be
  a cross-org read primitive one bug away from leaking another org's pipeline.
  RLS test 22 reconciles each org's RPC output against that org's own row-level
  query and asserts the two orgs differ.
- **Window bounds are parameters.** The Cyprus wall-clock month boundary lives
  in `lib/utils/tz.ts` with unit tests (doc 02 §A11). Re-deriving it in SQL
  would create a second source of truth that could drift across a DST edge, so
  the caller passes the instants in.
- **`stage_id` only, no names.** The RPC returns stage ids; the page still
  reads `deal_stages` for names and ordering. That table is tiny and the join
  belongs where the i18n/labelling already is.
- **Two indexes.** `deals_stage_idx` is partial on `status='open'`, so the
  won-this-month window had no usable index at all — that predicate has always
  been unindexed, the RPC just made it the aggregate of record. `leads_status_idx`
  leads with `(org_id, status, …)`, so a `received_at` range across all statuses
  could not use it either. Added `deals_won_idx` and `leads_received_idx`.
- **Top agents is now exact.** It previously ranked whatever fell inside the
  most recent 5,000 events, so a busy month could rank the wrong people.

Side effect: 9 dashboard round trips became 4.

Deployment note: this is the first audit fix carrying a migration. 0018 must be
applied to hosted BEFORE the code deploys, or every admin hits the error
boundary. `create index if not exists` + `create or replace function` make the
migration safely re-runnable.

## 2026-07-23 · T-audit-test2 — run_chain_checks stays server-side, but must be callable

Migration 0016 locked down `run_chain_checks()` with
`revoke execute … from public, anon, authenticated`. Because a function's
`service_role` EXECUTE rides on the PUBLIC default grant, that left the
function callable by **no role at all** — the same accident 0010 had already
fixed once, for 0007.

Production never noticed: the nightly `verify-events-chain` pg_cron job runs as
its owner, so the chain cache kept refreshing at 03:30. It stayed hidden
because RLS test 21 called the RPC, ignored the returned error, and passed on
rows 0016 had seeded at migration time. Moving the RLS suite into its own org
(T-audit-test1) was what exposed it — a fixture org created after the migration
has no seeded row.

Decision: restore `service_role` only (0019).

- 0016 enumerated `anon, authenticated` as the roles to lock out. `public` was
  there to drop the default grant. Losing `service_role` was collateral, not
  intent — identical to 0007, and 0010 set the precedent for the repair.
- **anon and authenticated stay revoked.** `verify_events_chain` walks every
  event in the org; an on-demand full walk triggerable from any logged-in
  browser session would be a self-inflicted DoS. The `/reports` page reads the
  cached `chain_checks` row, which is why 0016 introduced that cache.
- Being able to force a re-verification is genuinely needed — after a restore,
  a bulk import, or any incident that casts doubt on the event log — but it is
  a server-side operation, not a UI affordance.

Test 21 now asserts the call SUCCEEDS for service_role and stays denied for
anon and authenticated. Verified by sabotage: revoking the grant makes it fail
with 42501, the precise state it used to swallow.

Standing lesson: a test that calls an action and ignores the returned error can
hide a permission regression indefinitely. Assert on `error` even when the
call is only setup.

## 2026-07-23 · T-backup-drill — the backup premise was wrong; runbook written

Scoped as "prove the restore works" (`IMPROVEMENTS.md` C6, `HANDOVER.md` §2.2).
Verifying the starting conditions before writing the drill found three things
that change the task. Full runbook in `docs/BACKUP_RESTORE.md`; verification
pack in `scripts/backup/verify-restore.sql`. **No code or schema was changed.**

1. **There is no backup to restore.** The org is on the **Free** plan. Supabase
   documents daily backups for Pro/Team/Enterprise only, and tells free-tier
   projects to self-export with `supabase db dump` and keep off-site copies. A
   troubleshooting note adds that free-project dailies are taken but only become
   reachable *after upgrading*, with no commitment to keep taking them. So the
   audit's "Supabase takes backups, nobody has proven a restore" understated it:
   the RPO today is unbounded, not 24h. The first task is creating a backup, not
   restoring one.

2. **Storage is in no database backup, on any plan** — Supabase states backups
   exclude Storage API objects, holding only their metadata. That is 26 objects
   today: the signed viewing-slip PNG+PDF, three evidence report PDFs, KYC
   documents, property renditions. A DB-only restore returns `viewing_slips`
   rows asserting a SHA-256 whose bytes no longer exist — the row claims
   evidence that is gone. Storage export via `supabase storage cp -r` is
   therefore mandatory forever, including later on Pro+PITR.

3. **`verify_events_chain` is session-`TimeZone`-dependent.** `trg_events_hash`
   hashes `occurred_at::text`, and a `timestamptz` renders through the session
   `TimeZone`, carrying the UTC offset into the digest. Hosted runs `UTC`, which
   is what every stored hash was computed under. Proven read-only on event id 1:
   the stored hash recomputes `true` against `…427181+00` and `false` against
   the `Asia/Nicosia` rendering `…427181+03`.

   **Decision: mitigate operationally, do not touch the hash function.** Pin the
   restore target to `TimeZone = UTC` and check `show timezone` before drawing
   any conclusion from a chain failure. Rewriting the digest to a
   timezone-stable rendering would invalidate every hash already stored —
   including hashes printed inside issued evidence PDFs, which are immutable
   artifacts. The chain is append-only precisely so it cannot be rewritten.
   `TZ=Asia/Nicosia` on Vercel is the Node process timezone and does not reach
   the Postgres session, which is why the app has never tripped this; the Cyprus
   wall-clock logic stays in `lib/utils/tz.ts` (doc 02 §A11) unchanged.

The verification pack asserts 43 checks in one query — row counts, seed counts,
migration history, cron, bucket visibility, the chain, storage-file existence
for slips and evidence reports, and the full function-grant matrix (the TEST-2
surface, where a lost `service_role` grant is invisible on screen). Run against
hosted as a self-test: **43/43 pass**. Proven able to fail, not just to pass —
re-pointing the slip and evidence checks at a bucket without the files reports
`1 missing` and `3 missing`, which is precisely the DB-only-restore signature.

Proposed **RPO 24h / RTO 4h** on a nightly self-managed dump, for operator
sign-off, with Pro+PITR (RPO ~2 min, ~$125/mo) as the revision trigger once real
client volume arrives. Both figures are in §6 of the runbook.

## 2026-07-23 · T-csv-export — contacts CSV export (IMPROVEMENTS B10)

First list export. Establishes the pattern the other lists will copy, plus a few
choices worth not re-litigating.

- **Export = the filtered list, by construction.** The list page and the export
  route share one filter parser and one predicate applier
  (`lib/queries/contacts-list.ts`). The export drops only pagination — it is the
  whole filtered set, not the current page. They cannot disagree about which
  rows match because the WHERE clause has a single source.
- **A GET route handler, not a server action.** A download is a navigation, so a
  plain `<a href>` to `/contacts/export?<filters>` is the right primitive. Being
  under the proxy matcher it inherits the auth gate (verified: anonymous →
  307 /login, in `security.spec.ts`), and it uses the caller's RLS-scoped client,
  so an agent exports only their own scope — never the admin client.
- **BOM + CRLF + RFC-4180.** The leading UTF-8 BOM is not cosmetic: without it
  Excel renders Greek and Cyrillic names as mojibake, and this is a Paphos desk.
  The serializer round-trips through the import-side parser's rules.
- **Formula-injection guard.** Export fields are user-typed (names, notes). A
  value like `=HYPERLINK(...)` or `+1+1` executes on open in Excel/Sheets, so a
  leading `= + - @ \t \r` is prefixed with a single quote (OWASP "CSV Injection").
  This is why the phone column, formatted as `+357 …`, exports as `'+357 …`.
- **10,000-row cap.** PERF-2's rule (no unbounded reads) applies to the export
  too. Far above any realistic single-desk contact book; revisit with streaming
  if a client approaches it.
- **No audit event — for now.** A bulk PII export is arguably worth logging, but
  `events` is entity-scoped and the guardrail reserves it for entity
  create/update. An export event would be a new org-level shape; that is a
  decision for the operator before the pattern spreads, logged in BACKLOG, not
  taken unilaterally here.

Row rendering lives in a pure module (`lib/services/contact-export.ts`) so it is
unit-tested without a request or DB; the E2E only covers the HTTP contract the
running app alone can prove. 16 unit + 3 E2E added.

## 2026-07-23 · T-export-audit — bulk CSV exports are logged

Operator's call (asked after the contacts export shipped): a bulk PII export
moves a lot of KYC/contact data in one action, so it is recorded on the same
append-only event log as mutations.

- **New org-level event.** `entity_type = "export"` (added to `ENTITY_TYPES`),
  `entity_id = null`, one `event_type = "exported"` for every list, distinguished
  by `payload.list`. This is deliberately NOT entity-scoped — an export is not
  about one row. The events INSERT policy (`with check org_id = current_org_id()`)
  already permits it, so **no migration** was needed.
- **Written before the CSV is returned, fail-closed.** `logListExport` runs after
  the rows are fetched (so `count` is exact) and before the response is built;
  `logEvent` throws on failure, which 500s the export. No PII leaves without an
  audit row. Consistent with the guardrail "a feature without its events is not
  done".
- **On a GET.** The download wants a plain `<a href>`, so the audit is a side
  effect of a GET. That is fine here: it is an append to a log, the route is
  auth-gated, and browsers do not prefetch attachment downloads.
- **Visibility follows the events SELECT policy.** Admins see every org export;
  an agent sees their own. That is the right audience for an export audit.
- **Timeline line.** Registered in `describeEvent` + the `events` i18n namespace
  (en/el/ru, ICU plurals) so it reads well on the dashboard "Latest events" and
  passes the `messages.test.ts` parity gate. The `list` slug is interpolated raw
  (stays as stored, like stage names/channels); translating the seven list nouns
  is a possible later refinement, not done now.

Verified on the local DB: two authenticated exports produced two `exported` rows
with `{list, count, filters}`, and `verify_events_chain` stayed `true` across all
orgs — the new event type does not disturb the hash chain. Unit: `export-audit`
row shape + `events` line (fake-translator routing + English plural parity) +
`messages` parity. E2E: the route contract and the anon gate.

## 2026-07-24 · T-csv-export-rollout — the export pattern across the lists

Rolling B10 export to every list after contacts. Each list gets a shared
`lib/queries/<list>.ts` (parse + apply, used by BOTH the page and the export so
they select identical rows) and a `lib/services/<entity>-export.ts` column module,
plus a GET route that logs via `logListExport`. Notes worth pinning:

- **Deals export = the whole deal_type, not the board's window.** The pipeline
  board shows open deals plus a 30-day closed window (so the won/lost columns
  aren't permanently empty). That window is a DISPLAY convenience, not a filter
  the user chose. `/pipeline/export?type=<t>` therefore exports EVERY deal of the
  selected type, all statuses — reporting wants the old won deals, and "export =
  the deal_type tab you're on" honours the filter that is real. The route lives
  under `/pipeline` (where the button is) but the audit `list` is `"deals"`.
- **Money and areas export as raw numbers**, never €-formatted, so a spreadsheet
  can sum them. Dates go through `formatDateTime`. Phones through `formatPhone`
  (and are then formula-guarded because they lead with `+`).
- **Buyer/seller** on deals are aliased contact embeds
  (`buyer:contacts!buyer_contact_id(display_name)`), since both FK to contacts.

## 2026-07-24 · T-retention-expiry — the second half of GDPR erasure (B11)

Migration 0017 stamped `contacts.retention_until` when an erasure had to keep
KYC records under the Cyprus AML five-year duty, and created
`contacts_retention_idx` "for when that view ships". Nothing ever read the
column, so records were marked for expiry and then kept forever — Article 17 was
half-implemented, and holding data past its lawful basis is itself a
storage-limitation breach. Closed at `/settings/retention` (admin-only).
**No migration: the column and its index already existed.**

- **Expired ON the date, not after.** The duty is "five years past the end of
  the relationship", so when the stored date arrives the obligation has been
  served and the records may be purged that day. `days <= 0` → expired.
- **Cyprus wall-clock, not UTC.** `retention_until` is a `date` and the duty is
  a calendar obligation in Cyprus, so "today" comes from
  `zonedParts(...).dayKey` (doc 02 §A11). A UTC-midnight comparison would flip a
  row a few hours early or late depending on the season.
- **Surfaced, never automatic.** No cron purges anything. Destroying AML records
  is a human decision that should be taken deliberately and attributed to an
  actor; a 90-day `due_soon` window gives the operator notice to plan it. A
  nightly *nudge* would be a reasonable follow-up — an automatic *purge* would
  not.
- **The purge destroys the minimum.** Document rows, their storage objects and
  the KYC checklist. `erased_at`/`erased_by` stay (they are the audit record of
  the original erasure), identity fields stay, and events and viewing slips are
  untouched — hash-chained and immutable commission evidence respectively. The
  action re-checks the date server-side, so a stale page cannot purge early.
- **Admin-only in the action**, not just the UI — the contacts UPDATE policy
  also admits the assigned/creating agent, exactly as with erasure itself.

Verified against a seeded fixture pair, one lapsed and one still under duty as
the control: the lapsed row lost its document row, its storage object (confirmed
gone by direct download) and its checklist, and left the surface; the control
kept all three; `erased_at` survived on both; the `retention_purged` event was
written with counts only; `verify_events_chain` stayed true.

## 2026-07-24 · T-calendar-window — the viewings window follows the anchor

PERF-2 replaced the unbounded viewings query with a bounded window plus a
truncation notice. The window was pinned to the server's `now`, but the
calendar's anchor lived in client `useState`, so stepping ~53 weeks forward (or
13 back) left the loaded range and rendered an **empty week**. That is the same
silent lie PERF-2 set out to kill, just relocated: "not fetched" looked exactly
like "nothing booked".

- **The anchor travels in the URL** (`?d=YYYY-MM-DD`), and the window is
  computed around it instead of around `now`. Same precedent as the keys audit,
  which moved filters out of client state for the same reason.
- **`?view=` travels with it.** Without that, any refetch would snap the user
  back to week view — the anchor and the view are one navigational state.
- **Instant inside, refetch outside.** A step whose visible range is still
  within the loaded window is local state (no round trip); only a step that
  leaves it pushes the URL. `isRangeWithinWindow` treats a range that merely
  STRADDLES an edge as outside — half a week of real bookings missing is the
  same bug in miniature.
- **The calendar remounts on a server-driven anchor/view change** (`key` on the
  parent) rather than syncing props into state in an effect, which the
  `react-hooks/set-state-in-effect` lint rule correctly rejects. Local state
  therefore cannot disagree with the window it was rendered for.
- **`parseDayKey` round-trips through the calendar**, so a hand-edited `?d=`
  that looks well-formed but is not a real date (`2026-13-45`) falls back to
  today instead of producing a nonsense window.
- `addDayKey`/`weekStartKey` moved into `lib/services/calendar-window.ts` and
  the component's private copies were deleted — the fetch window and the
  "is this loaded?" check now share one implementation and one test suite.

Verified with a viewing booked four years out: invisible when anchored at today
(correctly outside the window) and visible when anchored at its own week. Before
this change it was invisible from both — permanently unreachable in the UI.

## 2026-07-24 · T-2fa — TOTP two-factor authentication (IMPROVEMENTS C2)

Spec-Essential, deferred since Phase 1 pending the client's call; the operator
asked for it on 2026-07-24. TOTP via Supabase Auth. **No migration.**

- **Opt-in and self-service, not mandatory.** Enforcing enrolment org-wide is one
  bad deploy away from locking every user out of a CRM holding KYC scans and the
  commission evidence chain. A user who has not enrolled signs in exactly as
  before; once they enrol, every later sign-in demands the code. Mandatory
  enrolment stays available as a later decision (the Supabase docs give the
  "enforce for all" and "enforce for new users" variants).
- **`/security`, deliberately NOT `/settings`.** The settings area is admin-only,
  and an agent carries the same client PII in their pocket as an admin — every
  role must be able to protect their own account. Linked from the header.
- **The login action routes to the challenge; the proxy is the gate.** A
  middleware redirect issued in response to a *server-action* redirect renders
  the challenge but leaves the browser URL on `/dashboard` — confusing and
  unlinkable. So `login()` checks the AAL itself and redirects to
  `/login/verify`, while `proxy.ts` still blocks direct navigation for any
  session that owes a factor. Both were verified.
- **An `aal1` session may not unenrol.** Otherwise a stolen password-only session
  could simply switch 2FA off, which would make the feature decorative.
- **Enrolment and removal both write events** (`mfa_enrolled` / `mfa_unenrolled`,
  entity_type `user`). Turning a second factor *off* is exactly what an audit
  needs to see.
- **`listFactors().totp` contains only VERIFIED factors** — unverified ones are
  reachable solely via `.all`. The first cut cleaned up abandoned enrolments
  against `.totp` and was silently dead code; the type checker caught it.
- **Only verified factors gate a login** (`hasVerifiedFactor`): `enroll()` creates
  an `unverified` factor immediately, so counting those would lock out anyone who
  closed the enrolment tab.

**Enforcement is currently at the APPLICATION layer only.** A stolen `aal1` JWT
could still reach PostgREST directly and bypass the challenge. Closing that needs
a `as restrictive` RLS policy per table asserting `auth.jwt()->>'aal' = 'aal2'`
for users who have a verified factor — the "enforce only for users that have
opted-in" template in the Supabase MFA guide, which leaves non-enrolled users
untouched. That is a schema-wide change with real lockout risk and its own RLS
tests, so it is logged in BACKLOG rather than bolted on here. The app-layer gate
already defeats the realistic threat (someone with a stolen password using the
web UI).

Local note: the CLI config ships `[auth.mfa.totp] enroll_enabled = false`, so
`supabase/config.toml` had to enable it and the stack be restarted. Hosted
Supabase enables the TOTP API by default per the MFA guide.

Testing: `lib/testing/totp.ts` implements RFC 6238 and is pinned against the
published RFC 4226/6238 vectors, so the end-to-end test behaves like a real
authenticator: enrol → sign out → password alone lands on the challenge → a
wrong code is refused → `/contacts` stays unreachable → the right code gets in →
remove. The spec force-clears factors before AND after via the GoTrue admin API:
a stranded factor makes `auth.setup.ts` land on the challenge and breaks every
other spec, and a session that failed verification is `aal1` so it cannot undo
its own enrolment through the UI.

## 2026-07-24 · T-csp — Content-Security-Policy, staged report-only (IMPROVEMENTS C1)

SEC-1..4 shipped `frame-ancestors 'none'` but deliberately not a full CSP,
because locking down `script-src` needs a per-request nonce threaded through the
proxy. That is now in place — as **Report-Only**, exactly as the roadmap
prescribed ("a wrong CSP breaks the app silently in production; stage it with
`Content-Security-Policy-Report-Only` first"). **Nothing is enforced by it yet.**

- **The nonce round-trip.** `proxy.ts` mints a per-request nonce, sets it on the
  REQUEST as `Content-Security-Policy` (which is how Next finds it and stamps it
  on its own inline bootstrap scripts) and sets the same policy on the RESPONSE
  as `Content-Security-Policy-Report-Only`. `next.config.ts` keeps enforcing
  `frame-ancestors 'none'` separately, so clickjacking protection is unchanged
  either way.
- **Origins are derived, not hardcoded** (`lib/services/csp.ts`, 10 unit tests):
  Supabase is 127.0.0.1 locally and *.supabase.co in production, and Sentry only
  exists when a DSN is set. Storage serves property renditions, so the Supabase
  origin is needed in `img-src` as well as `connect-src`, plus its `wss://` form
  for Realtime.
- **`'unsafe-eval'` in development only.** `next dev` compiles with eval;
  production does not, and a unit test pins that it never leaks into prod.
- **`style-src` keeps `'unsafe-inline'`.** Tailwind, Radix and Next all write
  inline styles; nonce-ing them would mean threading the nonce through every
  component for far less benefit than `script-src` — inline *style* cannot
  execute code.

**What the staging actually caught — the reason to do it this way.** Against a
production build, five screens reported `script-src / blockedURI: "eval"`.
Tracked to **Zod 4's JIT validator compiler**, which builds schemas with the
`Function` constructor (the bundle contains `compile(){return Function(...)}`
and a `try{Function("")}catch` feature-probe). Dev had hidden it completely,
because dev allows `'unsafe-eval'` anyway.

Zod feature-detects and falls back, so an enforced CSP would not have BROKEN the
app — it would have reported a violation on every page and silently dropped to
the slow path. Since the enforced end-state is jitless regardless, we set
`z.config({ jitless: true })` explicitly (`lib/validators/zod-jitless.ts`, plus a
tiny client component so it applies in the browser bundle, not just on the
server). Deterministic, and it makes the policy provably clean. The cost is nil
here — these are small form and search-param schemas, not hot-loop parsing.

**Evidence for a future decision to enforce:** `tests/e2e/csp.spec.ts` collects
`securitypolicyviolation` events across all 11 modules and 7 deep routes and
asserts zero. Run against a real production build (`next start`, the strict
policy with no `'unsafe-eval'`), it is 22/22 clean. Note the gap: entity DETAIL
pages, the slip-signing canvas and PDF generation are not in that sweep, so
report-only should run in production for a while before anyone promotes the
header. Do not enforce on the strength of local evidence alone.

Housekeeping: eslint now also ignores `tests/.playwright-report/**` and
`tests/.playwright-output/**` — Playwright's bundled trace viewer produced ~2,800
lint warnings once a test had failed. Same class as the `supabase/.temp` ignore.

## 2026-07-24 · T-csp-coverage — the CSP evidence now reaches the detail pages

`T-csp` shipped the report-only policy but flagged a gap: the violation sweep
covered only list/module routes, so the heaviest client code — tabbed detail
forms, the media grid, the signature canvas — was unproven. That was the stated
reason not to enforce. Closed.

- The sweep now drives **property detail, contact detail, viewing detail and the
  slip-signing canvas**, reaching them by clicking through from the lists so it
  uses real record ids rather than fixtures.
- **`img-src` is proven, not assumed.** The Supabase origin is in `img-src`
  purely because Storage serves property renditions; with `property_media` empty
  the directive was never exercised. The test now listens for a
  `/storage/v1/object/public/` response and only trusts the clean result if one
  actually happened. Verified against a temporary media fixture: image served,
  zero violations. The fixture was removed afterwards (a 1×1 cover makes a real
  property look broken locally), so the test self-skips again until a database
  has media.
- **Absent data self-skips with a reason, it does not pass.** Both viewings in
  the local database belong to the RLS fixture org, so the seed admin genuinely
  cannot see one — the first version of this test asserted its way to a green
  run against `/viewings/export`, which is exactly the vacuous pass the repo's
  standing rule warns about. Detail links are now matched on the id SHAPE
  (`^/prefix/<uuid>$`), which cannot collide with `/new` or `/export`.

Result: **27/27 clean against a real `next start` production build.** Still not
grounds to enforce on their own — PDF generation is server-rendered and behind a
signed URL, and a seed database has no media — but the gap that was called out
as the blocker is now evidence rather than an unknown.

## 2026-07-24 · T-backup-drill-run — the restore rehearsal, and what it broke

`T-backup-drill` wrote the runbook; this is the rehearsal actually being run. It
could not be run as written — creating a scratch Supabase project is the
operator's call and the hosted DB password must not pass through an agent — so
it was executed against a scratch database (`restore_drill`) in the local
Postgres 17.6 cluster, built from the 19 migrations and loaded with a 295-event
dataset. Tooling: `scripts/backup/export.mjs` and `scripts/backup/restore.mjs`.

**The finding that matters: a JSON/PostgREST export cannot back up `events`.**

PostgREST hands `jsonb` to JavaScript, and JavaScript numbers carry no scale. A
payload stored as `{"to": 510000.00}` restores as `{"to": 510000}`.
`verify_events_chain` hashes `payload::text`, so the hash breaks — and because
the chain is sequential, ONE corrupted payload invalidates every event after it.

In the rehearsal an organisation whose chain read `true` at the source came back
`false` after a restore with **identical row counts** (36/36). Two other orgs
verified fine, which is what makes it dangerous: it looks like a clean restore
until the one table that matters is checked. A restored database reporting its
own commission evidence chain as FAILED is indistinguishable from a tampered
one — and this product's entire value is that the chain is defensible.

Production is exposed: 1 of 62 hosted events already carries a decimal payload,
and every price change and deal amount adds another.

**Decision: `supabase db dump` (pg_dump) is the primary backup, not a
preference.** `export.mjs` is retained for **Storage** — which no database dump
contains on any plan — and as a readable table snapshot. It now warns on stderr
and records `chainFaithful: false` in its own manifest, so the artefact cannot
be mistaken for a complete backup on the strength of its row counts. There is no
fix within PostgREST: the raw text of a jsonb column cannot be selected over
REST.

**Three further findings, all now handled in `restore.mjs`:**

- **`session_replication_role = replica` is mandatory for the load.** Without
  it, `trg_events_hash` fires on every inserted row and RECOMPUTES prev_hash and
  hash from the new insert order. The chain then verifies — against freshly
  minted values. That one line is the difference between restoring evidence and
  manufacturing it, and it is the single most dangerous omission available here.
- **`OVERRIDING SYSTEM VALUE`**, because `events.id` is GENERATED ALWAYS AS
  IDENTITY and `verify_events_chain` walks in id order; without it Postgres
  renumbers the rows.
- **Generated-stored columns must be excluded from the column list** —
  `contacts.display_name` is one, and Postgres rejects any explicit value
  ("cannot insert a non-DEFAULT value"). The generated SQL therefore builds its
  column list from `pg_attribute` at restore time (`attgenerated = ''`) rather
  than hardcoding it, so it cannot drift from the schema. Sequences are then
  advanced past the restored maximum, or the first write after a restore
  collides on the primary key.

**And a structural one: the restore target must be a Supabase PROJECT.** The
schema will not build on bare Postgres — it needs `auth.uid()` and `auth.users`
(51 references), `storage.buckets`, and the `anon`/`authenticated`/`service_role`
roles; and `pg_cron` can live in only one database per cluster, so a scratch
database beside the live one cannot take the full schema. The rehearsal stubbed
auth/storage and stripped pg_cron to reach the data, which is why it proves data
fidelity and the chain, not the full platform restore. `auth.users` is also
outside the public schema, so a default dump omits it and a restore leaves
nobody able to log in — dump `--schema auth,storage` too.

**Measured** (mechanical steps only): export 0.7s · schema from 19 migrations
9s · load 1s · verification instant. The data is not the slow part at this
scale, which is why the proposed RTO of 4h is dominated by provisioning and
people. RPO/RTO in BACKUP_RESTORE §6 stand, now with the mechanical half
measured rather than assumed.

**Still outstanding, and still the operator's:** a real `pg_dump` (needs the DB
password), the Storage export against hosted (needs the hosted service key —
`.env.local` points at the local stack), off-site copies, and a restore into a
genuine scratch Supabase project. What is no longer outstanding is the question
of whether the method works: the JSON method does not, and now we know before it
mattered.

## 2026-07-24 · T-csp-reporting — the report-only policy had nowhere to report

`T-csp` shipped `Content-Security-Policy-Report-Only` and advised letting it run
in production before enforcing. That advice was unactionable: the policy named
no `report-uri`, so every violation went to the visitor's own browser console
and nowhere the operator could ever look. A report-only policy that collects
nothing is decorative.

Added a collector at **`/api/csp-report`**, advertised via both `report-uri`
(deprecated but still the only directive every current browser honours) and
`report-to` + a `Reporting-Endpoints` header.

The endpoint is necessarily PUBLIC — browsers post reports without credentials,
so `proxy.ts` exempts exactly that one path from the auth gate. Everything about
it follows from that:

- **It never writes to the database, and above all never to `events`.** The log
  is append-only and hash-chained; letting an unauthenticated caller append to
  it would be indefensible. The sink is stdout (Vercel runtime logs) plus Sentry
  when a DSN exists.
- **Body capped at 16 KB**, always answers `204`, never echoes input — a
  reporting endpoint should give a prober nothing to work with.
- **De-duplicated per instance** on `directive|blockedUri|sourceFile`. The
  operator needs the distinct set of things the policy would block; one line per
  page view would drown the rare violation in the common one. The set is
  in-memory and per-instance by design — a flood guard, not a store — so a cold
  start re-reports and the signal stays alive without unbounded state.
- **Document URLs are reduced to their PATH**, dropping query strings so list
  filters never reach a log line. Only http(s) is reduced: `new URL()` happily
  parses `about:blank` and calls its pathname "blank".
- Both report shapes are parsed (`application/csp-report`'s hyphen-cased object
  and the Reporting API's camelCased array), and the parser returns `[]` rather
  than throwing on anything malformed — hostile input is expected here, not
  exceptional.

**What is proven, and what is not.** The policy genuinely catches violations: an
`img-src` probe against a dead local port raises one with disposition `report`,
asserted in `csp.spec.ts`. That matters — without it, "zero violations
everywhere" could equally mean the policy is inert. The endpoint genuinely
accepts reports, including oversized and malformed bodies.

**Not proven: that a real browser delivers reports to it.** No report reached
the dev server even after a 70-second wait, and reports are emitted by the
browser's network stack rather than the page, so Playwright cannot observe them
either. Headless Chromium over plain `http://localhost` appears not to deliver.
This is recorded as an open question rather than papered over: **confirm in
production by grepping the Vercel runtime logs for `[csp]`.** An empty log there
means either "clean" or "not delivering", and the two must not be confused
before anyone decides to enforce.

## 2026-07-29 · T-nudges — automated follow-up nudges (IMPROVEMENTS B7)

Cron-driven follow-up tasks on the 0012 renewal-lifecycle pattern. Migration
**0020**: `deal_no_contact` (an open deal silent for 14 days) and
`viewing_feedback` (a completed viewing still missing feedback 48h after it was
scheduled). The roadmap's third rule, "mandate expiring in 30 days", already
existed via `expire_mandates` and was not rebuilt.

Four design questions were settled with the operator before any code, because
each of them changes the shape of the feature rather than its polish.

- **"Contact" is `deals.last_activity_at`.** The tempting answer — count only
  agent-initiated contact events — turned out to be an empty set: `contacted`,
  `called`, `conversation_logged` and `chat_link_opened` are all written with
  `entity_type='lead'` (or `'contact'`), never `'deal'`. A nudge keyed to them
  would fire on every open deal and be unsilenceable except by converting a
  lead. `last_activity_at` is already bumped by deal edits, the 0011 stage-move
  RPC, offer create/decide, won/lost and `logConversation` on a converted lead,
  and it is the health score's own activity input — whose cliff is **also 14
  days** (doc 02 §C5). So the nudge fires exactly when the health score's
  activity factor reaches zero. One number, one meaning.
  *Accepted weakness:* retyping a deal title counts as contact and buys 14 days
  of silence. Closing that needs a deal-scoped "Log contact" action → BACKLOG.
- **One nudge per silent period**, keyed to the staleness BOUNDARY
  (`(last_activity_at at Cyprus)::date + 14`) stored as the task's Cyprus
  end-of-day due date. This is 0012's cycle key transposed: contact moves
  `last_activity_at`, which moves the boundary, so the open task stops matching
  and a later silence is a genuinely new cycle. A deal nobody ever touches keeps
  exactly one open nudge forever — no pile-up. Escalation (re-nagging every 14
  days) is one `floor()` away if the desk ever asks.
- **The cron auto-completes when the condition clears.** Invariant: an OPEN
  `deal_no_contact` task exists iff its deal is OPEN and its due date is the
  deal's current boundary. Yes, this closes tasks a human did not — but the
  alternative is a list full of "no contact in 14 days" on deals contacted
  yesterday, which is how the whole surface gets ignored. Superseded tasks are
  COMPLETED with a `superseded` event, never deleted.
- **48 hours for viewing feedback.** 24h punishes a Friday-afternoon viewing on
  Saturday morning; 72h is past the point where the detail an owner wants still
  exists. The viewing rule deliberately guards on *"any nudge for this viewing"*
  rather than a cycle — and that is **not** the 0006 one-shot bug, because a
  viewing has one feedback lifecycle and `saveViewingFeedback` can only ever set
  feedback, never clear it.

**Thresholds are hardcoded, not config.** 14 days is the health score's own
cliff; a separately-editable copy could disagree with it silently about what
"stale" means. Changing either is one `create or replace function` — the same
statement this migration already ships. `cyprus_config` is guardrail 5's home
for Cyprus *rates*, not operational thresholds.

**The virtual "Viewings awaiting feedback" section is retired.** `/tasks` and
the agent dashboard already ran a live query for `status='completed' and
feedback is null`, chosen (T4.3/T5.5) so it could never drift out of sync with
the viewings. That property was real, but the surface had no threshold — it
nagged the instant a viewing was completed — and no due date, assignee, admin
visibility, CSV export or event trail. Task rows carry all of those, and the
anti-drift property is restored by the 0020 invariant instead: a trigger
supersedes the task the moment feedback is saved.

**`tasks.kind` is the single discriminator; `kind is null` means a human typed
it.** 0012 had no marker of its own and used `mandate_id is not null` as a
proxy, already read by the /tasks "auto" badge and the CSV "Auto" column. Rather
than teach both to test `mandate_id is not null or kind is not null` forever,
0020 backfills `kind='mandate_renewal'` and re-states `expire_mandates()` to
stamp it — **guard predicate and every other line byte-identical to 0012; only
the INSERT column list changed.** A CHECK constraint keeps `kind` a closed set,
so a typo in a future cron fails loudly instead of minting tasks no surface
recognises as nudges. The CSV column now carries the rule slug, so the three
kinds are distinguishable in a spreadsheet.

**Edit-time supersede is trigger-level, not app-level.** 0012 supersedes from
`saveMandate`/`setMandateStatus` so the list is honest immediately. The app-side
equivalent here would be seven call sites *plus* `move_deal_to_stage` (0011),
which is SQL-side and unreachable from TypeScript. Two `AFTER UPDATE` triggers
do it instead, writing their event with `actor_id = auth.uid()` — the
`trg_price_history` (0005) pattern, chosen there for the same reason ("direct DB
edits and imports are covered too"). `profiles.id references auth.users(id)`, so
`auth.uid()` *is* the profile id. `WHEN` clauses keep the triggers off the
health-score recompute write, which touches neither column. Cron remains the
nightly safety net and writes the same event with `actor_id` null.

**`create_followup_nudges(p_org uuid default null)`.** The parameter exists for
testability only: cron calls it with no arguments, and the RLS suite passes its
fixture org, because RLS test 23 pins that the suite never writes into the
seeded org the dev app uses — an org-wide function would violate that on its
first call. Execute is revoked from `public, anon, authenticated` (it walks
every open deal in every org) and then **re-granted explicitly to
`service_role`**, because a function's `service_role` EXECUTE rides on the
PUBLIC default grant — the collateral 0010 fixed for 0007 and 0019 for 0016.

**Cron at 03:15**, between `expire-mandates` (03:00) and `verify-events-chain`
(03:30), so the night's nudge events are covered by the same run's chain check —
0016's own reason for putting the chain check last.

**Timezone maths in SQL, deliberately.** 0018 says not to re-derive `tz.ts`
logic in SQL, but that rule is about *callers*: 0018 takes its window bounds as
parameters because a caller exists. Cron has no caller, so the Cyprus EOD stamp
is copied verbatim from 0012 rather than reinvented — two cron paths that must
agree should share one expression.

**The agent dashboard's tasks card widened from "overdue" to "due today &
overdue."** Every nudge is stamped Cyprus 23:59 of the day it fires, so an
overdue-only card would not show today's work until tonight — on the screen an
agent runs their day from. The date still turns red only when genuinely past
due. `cards.overdueTasks`/`empty.noOverdue` were renamed to
`cards.tasksDue`/`empty.noTasksDue` and `cards.awaitingFeedback` deleted, in all
three locales.

**Due dates are deterministic functions of the source row, not of when the job
ran** (EOD of the boundary; EOD of `scheduled_at + 48h`). A catch-up run after
cron downtime therefore stamps the date the nudge *should* have carried and the
task appears already overdue — honest — instead of resetting the clock.

**Proof.** A rolled-back psql fixture transaction pinned 18 assertions before
any app code was written: EOD stamps at Cyprus 23:59 (not midnight UTC), the
boundary as cycle key, arm-1 and arm-3 assignee resolution (orphan deal → oldest
active admin, never NULL), the 47h/49h threshold edges, cancelled viewings never
nudged, no same-cycle re-nag on a second run, trigger supersede on contact and
on won, supersede on feedback with no re-create, and `verify_events_chain` true
throughout. RLS **test 24** then pins the same invariants as a regression test
against a real database, including that anon and `authenticated` cannot execute
the job and that `p_org` confines it to the fixture org; **test 17** grew the
system-task rows (a `created_by`-null task is reachable only through its
assignee, and only an admin can delete it — it has no creator) and the CHECK
constraint. `tests/e2e/nudges.spec.ts` proves a cron-created nudge actually
reaches the agent: it renders on /tasks, is badged "auto", links to its deal,
and lands in Overdue.

**Known gap, matching 0012.** Both rules can land a task on a deactivated
profile if it is still the deal's or viewing's agent; 0012 takes
`p.assigned_agent_id` raw in exactly the same way. Fixing one without the other
would make the two cron paths disagree, so both are left for a single later
change → BACKLOG.

**Unrelated finding, logged not fixed.** With a *freshly reset* local database,
`csp.spec.ts`'s "property detail" and "contact detail" tests fail on
`expect(href).toBeTruthy()` — they need a property and a contact to open, and
only `happy-path.spec.ts` creates them, so on run 1 they lose the race and on
run 2 they pass. That is the residue dependency HANDOVER §4 warns about, in a
spec this change never touches; verified by stashing this work and reproducing
both failures on the pre-change tree. It does not reach CI (which runs
`checks` + `rls`, not Playwright). → BACKLOG.

## 2026-07-29 · T-share-links — buyer proposal magic links (IMPROVEMENTS B3)

`share_links` was listed in doc 01 §6.1 from v2 onward but existed in no
migration and no DDL — only the `share_link` slot in `ENTITY_TYPES`. 0023 builds
it. Doc 01 §0.1 is explicit that buyer portal logins were *removed* and replaced
with "no-login magic-link proposal pages (tokenized URL, expiry date, per-open
view tracking)", so this is the sanctioned shape, not new scope.

- **The token is never stored — only `sha256(token)`.** A database leak
  therefore yields no working links, the same reasoning as password hashing.
  The plaintext exists only in `createShareLink`'s return value, so the UI shows
  it once and it is unrecoverable afterwards (the invite-dialog pattern). A unit
  test pins the digest against the value Postgres produces: the app hashes in
  Node and the database looks up by that hash, so a divergence would silently
  orphan every live link.
- **`anon` has no grant on the tables at all.** A buyer reaches data solely
  through `resolve_share_link`, a security-definer RPC whose body enumerates the
  allowlist. The boundary therefore lives in SQL and cannot drift with a
  component edit, and a future mistake in a policy still cannot open the table
  to the public. RLS test 25 asserts the exact returned key set, so adding
  `select *` to the RPC fails the suite rather than production.
- **A bearer token may append to `events`; an anonymous CSP report may not.**
  HANDOFF constraint 1 forbids `/api/csp-report` from ever writing to the
  hash-chained log. The distinction is that a share-link token is a credential
  the agency minted, so the append is authorised by something the org issued —
  and an invalid token appends nothing. The **throttle** is what keeps that
  defensible: `view_count` is exact on every open, but the `opened` event is one
  per link per Cyprus day. A buyer refreshing on a train must not be able to
  grow the evidence chain, and "shown on the 14th" is the granularity a
  commission dispute argues over anyway.
- **Dead links are indistinguishable.** Expired, revoked, unknown and malformed
  all render one neutral page — same reasoning that makes `/api/csp-report`
  always answer 204. A prober learns nothing about which tokens exist.
- **The rate limiter is honest about its job.** Brute-forcing a 32-byte token is
  infeasible, so a limiter does not help there; the real threats are scanning
  and log-flooding, which only ever produce FAILED lookups, so that is what is
  counted. It does not stop a real DDoS — platform-level protection does, and
  that is an operator decision in BACKLOG.
- **An archived property drops out of the payload** rather than 404-ing the
  proposal: retiring one listing must not silently break an unrelated buyer's
  link. The page states how many were withheld instead of quietly showing fewer.
- **Agent picks en/el/ru per link.** This is the one surface that can ship
  multilingual value while B9 stays blocked on the missing locale switcher — the
  marketing text is already multilingual jsonb, and the page's own chrome is
  translated because it is small and self-contained.

**A bug the E2E caught that reading could not:** RLS policies do not imply table
GRANTs. 0002 grants each table to `authenticated` one by one, and a table
created eleven migrations later inherits nothing from that, so the manage page
died with `permission denied for table share_links` despite correct policies.
Same class as 0021. Fixed inside 0023 (it had not yet been applied to hosted).
`anon` is deliberately left with no grant.

Verified: 22 psql fixture assertions (throttle, allowlist, locale, dead links,
limiter budget, chain intact); RLS test 25; 5 E2E including an anonymous visitor
asserting `internal_notes`, `owner_net_price` and `min_acceptable_price` appear
nowhere in the rendered DOM; and a real unauthenticated `curl` of `/p/<token>`
returning 200 with no redirect to `/login`.

## 2026-07-29 · T-pwa — installable agent app, deliberately not offline-first (B8)

CLAUDE.md names three mobile-first screens (slip signing, agent daily dashboard,
lead inbox) and B8 asked for an "installable, offline-tolerant shell". The
operator chose **installable + resilient reads** over a full offline sync queue.

- **Writes are never queued.** Offline slip signing is what the roadmap
  literally asks for, but it would hold commission evidence — signature, SHA-256,
  geolocation — in client-side storage until a network appeared, with replay and
  conflict handling around the hash chain. That chain is this product's
  differentiator in a dispute; putting it behind a queue trades the one thing
  that must never be doubted for convenience on a bad signal. Writes fail
  honestly with a retry instead, and `/offline` says outright that nothing was
  sent and nothing recorded — an agent who just signed a slip needs to know
  whether to redo it.
- **Every cache is purged on sign-out, and the purge is awaited.** The worker
  caches whole rendered pages so a visited screen survives a dead signal. On a
  shared or lost phone that is client PII and KYC at rest, readable with no
  session. `LogoutButton` awaits `purgeOfflineCaches()` before calling `logout()`
  — fire-and-forget would race the redirect and leave behind exactly what
  signing out is meant to remove.
- **Never cache `/api/`, never cache RSC.** A cached auth response would be
  actively dangerous. And Next's RSC payload shares a URL with the HTML
  document, so caching both under one key serves an RSC blob to a document
  request and the page renders as garbage — the worker handles only real
  navigations without an `RSC` header.
- **Registration is production-only.** In dev, a cache-first worker turns
  every edit into stale-module confusion that looks like a build bug.
- **`/offline` is exempt from the auth gate.** The worker precaches it at
  install; behind the gate that fetch stores a redirect to `/login`, so the one
  screen that exists for "you have no network" would itself need the network.
  It is static and renders no data.

Proven against a real production build, not asserted: the worker registers and
activates, a previously visited screen still renders with the network cut, an
unvisited screen shows the fallback, and the purge empties every cache (3 → 0).

**A test-quality fix found on the way.** RLS test 24 (B7, written this morning)
asserted the orphan-deal fallback landed on `adminA` specifically. The fallback
picks the org's OLDEST active admin, and the fixture org accumulates admins
across local reruns, so it passed only on a freshly reset database. CI always
starts fresh, so it stayed green — which is exactly how such a test hides. It
now asserts the invariant that matters (never NULL; an active admin of that org)
and passes both fresh and on a dirty rerun.

## 2026-08-02 · T-nudge-active-assignee — a deactivated assignee is worse than none (0024)

0012 established that a NULL assignee is invisible: `/tasks` and the agent
dashboard both filter `assignee_id = me`. Its answer was a three-armed fallback
— entity agent → creator → the org's oldest **active** admin. Only that third
arm ever checked `is_active`, so the guard stopped exactly where the fallback
started, and all three system task kinds inherited the gap: `deal_no_contact`
and `viewing_feedback` (0020) took `agent_id`/`created_by` raw, `mandate_renewal`
(0012, re-stated in 0020) took `assigned_agent_id`/`created_by` raw.

**A deactivated assignee is strictly worse than a NULL one.** The task is
equally invisible — 0014 makes `is_active = false` kill RLS access, so the
person cannot sign in to see it — but the row no longer *looks* unassigned, so
no orphan-tasks surface can find it either. It is lost in a way the 0012 bug at
least advertised. RLS test 24 had already written the reason down in a comment
("an inactive admin would be invisible too") while asserting it for one arm out
of three.

**Each raw arm became "that profile, if it is active."** Inlined as a scalar
subquery rather than extracted into a helper function, deliberately: a new
`security definer` function in `public` is anon-executable by default (0007, and
the 0021 regression that followed 0020 for exactly this reason), and this needed
no new grant surface at all. `create or replace` preserves the ACL, so 0007's
lockdown and 0022's deliberate *removal* of the `service_role` grant on
`expire_mandates` both survived untouched — confirmed by reading `proacl` before
and after, on hosted and local.

**Fixing the arms was necessary but not sufficient, for two reasons.** Tasks
minted before today are already stranded and the cycle guards ("a nudge exists
for THIS boundary") deliberately refuse to mint a replacement, so nothing would
ever repair them. And deactivation happens *after* assignment far more often
than before it — a user deactivated tomorrow strands every open task they hold,
which no one-time backfill can see. So the re-home is stated as an invariant and
self-healed nightly (0020's own design rule), as step 5 of
`create_followup_nudges`, plus the same statement run once inline at the bottom
of the migration so the database is correct now rather than at 03:15.

**Step 5 covers every system `kind`, mandate_renewal included.** The nudge job
runs at 03:15, fifteen minutes after `expire_mandates` at 03:00, so one place
can own the invariant for all three kinds instead of each cron re-implementing
it. It re-homes to the active-admin arm rather than re-deriving the per-kind
arms — those arms are exactly what went stale — and only where an active admin
exists, so a degenerate org is left alone rather than having its assignee
nulled. NULL is invisible too; silently making it worse is not a repair.

**Scoped to `kind is not null`.** A task one person assigned to another by hand
has the same invisibility problem, but re-homing it silently would overwrite a
deliberate human choice. That wants an admin surface with an explicit reassign,
not a cron rule — logged in BACKLOG.

**A test that would have passed for the wrong reason.** Test 26 first asserted
on `tasks.assignee_id`. But step 5 re-homes stranded tasks in the *same
invocation* that mints them, so the final row cannot distinguish "the arm
skipped the deactivated profile" from "the arm used it and the sweep cleaned up
after". Verified rather than assumed: the arms were reverted with step 5 left
in place, and the test still passed. It now also asserts the assignee **as
minted**, read from the `followup_task_created` event written inside step 1/2
before the sweep — the only witness to what the arms actually chose. Against the
reverted arms that assertion fails; against 0024 it passes.

`expire_mandates()` takes no `p_org` and holds no `service_role` grant (0022),
so it is unreachable from the service-key RLS suite by design. Adding either to
test it would reverse a deliberate decision for the sake of coverage, so it was
not done; its arms are identical to the two that test 26 does pin, and step 5
covers its output. Noted as the residual gap.

Verified: 30 RLS (up from 29) · 437 unit · typecheck · lint · build. Hosted and
local function bodies are byte-identical (matching `md5(prosrc)`), ACLs
unchanged on both, `verify_events_chain` still true, and `get_advisors` returns
the same set as before the change — no new finding, which is the check whose
absence caused 0021. The hosted backfill was a provable no-op (`tasks` = 0);
locally it re-homed 3 rows.

## 2026-08-02 · T-csp-fixture — the CSP detail tests seed rather than skip

`csp.spec.ts`'s "property detail" and "contact detail" tests took the first row
of `/properties` and `/contacts` and asserted it existed. Only
`happy-path.spec.ts` creates those rows, so against a freshly reset database
both FAILED on run 1 and passed on run 2 — a test depending on the *residue* of
another spec, the anti-pattern HANDOVER §4/§5 names. CI runs `checks` + `rls`,
not Playwright, so it never showed there; it only bit after a local
`supabase db reset`.

BACKLOG offered two fixes: seed a fixture, or self-skip the way the
viewing-detail test does. **Seeding was chosen.** The skip is cheaper and has a
precedent in the same file, but these are the heaviest client routes in the app
— tabbed forms, the media grid — and a fresh database would silently lose their
CSP evidence exactly when someone is deciding whether to promote the policy from
Report-Only to enforced. A green run that proves nothing is the failure mode
this whole spec exists to avoid.

**An existing row is still preferred when one is there.** Real data exercises
media and documents that a bare fixture does not, so the seed is a fallback, not
a replacement. Only when the list is empty does the spec create its own property
and contact through the local service key — the same convention `nudges.spec.ts`
already uses, and gated on a localhost base URL, so against a deployed
environment the tests still self-skip rather than assert falsely.

**Cleanup is marker-based, not id-based.** `afterAll` deletes by
`reference like 'CSP-FIXTURE-%'` and `contacts.notes = 'csp-detail-fixture'`, so
a crashed run is swept by the next one instead of leaking rows. `properties` has
no `notes` column — only `contacts` does — which is why the two markers differ;
the property marker rides on `reference`, which is required anyway and is
legible in the UI if a row ever does leak.

**Verified without a `db reset`, which is the point.** Proving the old bug
normally costs a reset-and-repopulate cycle, and disk was down to 9.3 GB. Since
the fix removes the branch on database state, both paths could be exercised
directly instead: the populated path passes using an existing row; the empty
path was forced by stubbing the list lookup to null, and the seeded property
(`CSP-FIXTURE-msc9m2t5`) and contact were confirmed present in Postgres with the
cleanup suppressed, then swept by a normal run. Full spec 30 passed / 3 skipped
(the pre-existing viewing, storage-image and slip-canvas self-skips); full
desktop suite 167 passed / 4 skipped, and `--list` reports 171 tests before and
after, so no test was added or lost.

## 2026-08-03 · T-sb-key-guard — the bundle-leak test would have gone blind at rotation

Pre-flighting the §2b key rotation (legacy `anon`/`service_role` JWTs →
`sb_publishable_…`/`sb_secret_…`) turned up a guard that was about to stop
guarding.

`tests/e2e/security.spec.ts` "no service-role key or private env var reaches the
browser" captured every `.js` served on `/login` and asserted:

    not.toContain('"role":"service_role"')   -- the JWT payload claim
    not.toContain("service_role")

Both key on the literal string `service_role`. A modern secret key is
`sb_secret_<random>` and contains neither it nor a JWT payload. The third
assertion, `/SUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*["']…/`, only matches an
assignment shape, which is not how a leak arrives — Next inlines values into
minified code, and non-`NEXT_PUBLIC_` vars are not inlined at all.

So on the day the operator completes the rotation, this test would have kept
passing while having silently lost the ability to catch the one thing it exists
to catch. That is worse than no test: it is a green light with nothing behind
it, on the surface that protects client PII and the evidence chain.

**Fixed by detecting the key by its own prefix**, not by a claim inside it:
`not.toContain("sb_secret_")`, plus a scan for any `sb_<word>_<10+ chars>` that
is not `sb_publishable_` — defence in depth against a future key type nobody has
told us about yet. The legacy `service_role` assertions stay: the rotation has
not happened, both formats will coexist until it does, and neither check costs
anything.

**Proven rather than asserted.** A fake `sb_secret_…` literal was planted in the
login client bundle. The run showed the two legacy assertions PASSING and the
new one failing — which is the whole finding in one line of output. Probe
removed, `security.spec.ts` 40 passed.

**Also verified, and worth recording because it de-risks the rotation itself:**
no code anywhere assumes the JWT key format — `lib/supabase/{client,server,
admin,public}.ts` and `proxy.ts` each pass the env var straight to
`createClient`, with no decode, claim read or shape check. And the publishable
key was exercised live against hosted: PostgREST accepts it as `anon`
(protected tables answer `42501 permission denied` — RLS refusing, not the key
being rejected), `contacts` yields no PII, and `resolve_share_link` returns
`200 null` for an unknown token, so B3 proposal links survive the swap. Recorded
in HANDOFF §2b so the operator does not have to rediscover it.

## 2026-08-03 · T-2b-verification — §2b step 4 asked for something that cannot exist

While pre-flighting the key rotation, a second problem turned up in the
instructions themselves rather than the code.

HANDOFF §2b step 4 said: verify "the live page ships `sb_publishable_…`". **It
never will, and it never shipped the legacy key either.** The browser receives
no Supabase credential of any kind.

Verified three independent ways:
- `createBrowserClient` is called in exactly one place, `lib/supabase/client.ts`,
  and **no module imports its exported `createClient`**. The app is server
  components and server actions end to end.
- A production `.next/static` build has 63 JS chunks; none contains a JWT-shaped
  string, and none even contains `supabase.co`.
- The same scan against the chunks production actually serves on `/login` found
  neither the legacy key nor a publishable one.

This matters more than a stale doc line. §2b is already the item where **eight
attempts silently did nothing**, and §7 warns that the Vercel dashboard can
swallow actions so verification must be by observed effect. Step 4 handed the
operator a check that returns empty *on success* — so a correct rotation would
have looked exactly like another silent failure, and the natural response is to
redo the steps that already worked.

**Step 4 now drops the impossible sub-check.** Its two remaining halves cover
both keys between them: signing in exercises `NEXT_PUBLIC_SUPABASE_ANON_KEY`
(still load-bearing, but server-side only — `lib/supabase/server.ts`,
`lib/supabase/public.ts`, `proxy.ts`), and `/settings/organization` exercises the
secret key through `createAdminClient()`. A wrong publishable key makes GoTrue
refuse the session, so "I signed in" is real evidence rather than an absence.

**Step 3's cache-off redeploy stays, but its stated reason was wrong.** It said
`NEXT_PUBLIC_*` is baked into the client bundle at build time; for this app
nothing of the sort is in the client bundle. Kept anyway — it costs nothing and
forecloses any server-side build-time inlining — but the reasoning is corrected
so nobody builds on a false premise later.

**`lib/supabase/client.ts` is therefore dead code, and its deadness is load-
bearing for the above.** Logged in BACKLOG rather than deleted: removing it is
tidy, but the point worth preserving is that importing it would start shipping
the anon key to the browser. That is normal and safe for a publishable key — it
is designed to be public — but it changes what step 4 can verify, so it should
be a decision, not an accident.

## 2026-08-03 · T-key-rotation — the exposed service_role key is revoked

The legacy `service_role` key, exposed in a chat transcript on 2026-07-30, is
dead. Supabase disabled the legacy JWT pair at
`2026-08-03T17:40:12.572433+00:00`. Nine earlier attempts had silently failed.

**Why this attempt worked: the Redeploy button was never used.** The Vercel
connector showed six consecutive pushes each producing a `READY` production
deployment, which proved the Git→Vercel pipeline was healthy and localised the
fault to the *dashboard's* env-save and Redeploy controls. So the env change was
picked up by pushing a commit (`aae6dc1`) instead, and the resulting deployment
(`dpl_D3WRnCp…`) was confirmed `READY` and aliased to the production domain
through the API. The failing control was routed around rather than retried.

**Order, which is the part that must not be reordered:** save env → deploy →
verify both keys in production → *then* disable the legacy pair. Vercel injects
env vars at deploy time, so until the new deployment is live the running app is
still authenticating with the OLD keys; disabling first would revoke what
production is actively using. Everything before the toggle is reversible; the
toggle is not. The operator asked to disable immediately after saving the env
vars and was asked to hold until the deploy and both verifications had passed.

**Both keys were proven in production before the irreversible step, by positive
observation rather than absence of errors:**
- publishable — `/p/<unknown token>` returned 200 rendering "This link is no
  longer available", which is only reachable if `resolve_share_link` actually
  round-tripped to Supabase through `lib/supabase/public.ts`. An error boundary
  would have printed "something went wrong"; grep counted zero.
- secret — `/settings/organization` loads, which is the page that exercises
  `createAdminClient()`. Operator-checked, since it needs a session.

**The revocation confirmed itself better than planned.** §2b had expected to
infer the `service_role` key's state from `anon`'s, since both are JWTs signed by
the same secret sharing one `iat`. In the event, a REST call with the legacy key
returned `401 Legacy API keys are disabled` with a hint naming
`(anon, service_role)` explicitly — direct evidence, no inference needed.

Post-revocation production checks all pass: `/login` 200, `/p/…` 200 with the
correct page, `/dashboard` 307→`/login`, `/offline` and `/manifest.webmanifest`
200.

Three findings from the pre-flight that made this safe are recorded separately:
`T-sb-key-guard` (the bundle-leak test would have gone blind), `T-2b-verification`
(step 4 asked for a string that cannot exist), and the confirmation that no code
assumes the JWT key format.

## 2026-08-03 · T-csp-413 — production was collecting CSP reports and throwing them away

Found by reading Vercel runtime logs within the ~1h retention window, right after
the key rotation. `/api/csp-report` had taken three POSTs, and **two returned
413**. Genuine browser violation reports were arriving and being discarded.

This is strictly worse than the gap §6 already described. §6 warned that "no
`[csp]` lines" must not be read as "the policy is clean", because reports might
have expired from the log. The real situation was that reports *were delivered*
and the endpoint *rejected* them — and the 413 path had no log line at all, so
the only trace was a status code in the access log. Nobody would have found it
except by looking directly.

**The cap was 16 KB, on the stated premise "reports are small; anything larger is
not a browser". That premise is wrong for the `report-to` shape.** Browsers batch
violations into a single array, and every envelope repeats `originalPolicy` —
this app's whole CSP string, several hundred bytes each. A page with a dozen
violations clears 16 KB on policy text alone. A representative 24-violation
Chromium-shaped batch measures ~23 KB, which is now pinned by an E2E test built
from the real field shapes rather than padded with filler, so it stays
representative.

Raised to 128 KB. Worth being precise about what the cap does: `request.text()`
has already materialised the body by the time the length is checked, so it bounds
PARSING and LOGGING work, not transfer — the platform's request limit bounds
that. Raising it is therefore cheap, and the guard is retained rather than
removed, because the endpoint is public and unauthenticated.

**The more important half of the fix: the drop is now logged.** The old code
returned a bare 413. It now prints
`[csp] report DROPPED: <n> bytes exceeds <cap>`, which converts an invisible loss
into a visible one and supplies the evidence to re-tune the number instead of
guessing at it a second time. Both behaviours were observed in the test run's
server output, not merely asserted.

This does not change the C1 conclusion that a durable sink is still needed —
Vercel's ~1h retention means stdout alone cannot support "let it run for a
while". It does mean that when `SENTRY_DSN` is finally set, the reports will
actually reach it.

## 2026-08-03 · T-sentry-dsn — diagnosing an env var that never arrives

Setting `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` took several attempts. The
useful part is not the outcome but the diagnostic, which generalises to any
"I set the variable and nothing happened".

**The sibling-variable test.** `proxy.ts` calls `buildCsp` with two adjacent
`NEXT_PUBLIC_*` reads — `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SENTRY_DSN`. When the Supabase origin appears in `connect-src` and
the Sentry origin does not, from the same function in the same build, every
explanation involving the build, the bundler, the cache or the framework is
eliminated at once: one value was present in the environment and the other was
not. That single observation is worth more than any amount of reasoning about
inlining, and it needs no access to the env vars themselves.

**Two wrong turns, recorded because each looked convincing.**
- *Build cache.* The build log said "Restored build cache from previous
  deployment", and that deployment predated the fix, which is a genuinely
  plausible cause for a build-time-inlined value. It was wrong: `proxy.ts` was
  edited, so its module recompiled, and its sibling read inlined correctly in
  that same recompilation. Commit `5fd43fe`'s message asserts the cache was the
  cause — it was not, and the comments it added remain accurate for a different
  reason (`NEXT_PUBLIC_*` really is inlined at build time) but did not fix
  anything.
- *Stale edge cache.* `/login` answers `x-vercel-cache: HIT`, so a cached
  response with stale headers was worth ruling out. Ruled out by the nonce:
  it differs between two consecutive requests, which proves middleware runs
  fresh per request and the CSP header is generated live rather than served
  from cache.

**The actual cause was mundane and is now a documented trap:** the variable was
saved for Preview only. A Vercel env var is per-environment, and "set for
Preview" is indistinguishable from "not set" when you are looking at production.
See HANDOFF §7.

**Corollary that cost a deployment: changing a `NEXT_PUBLIC_*` variable requires
a new BUILD, not merely a new request.** The value is compiled in. So after
correcting the variable, the currently-live deployment still cannot know about
it — checking production immediately will always show the old state and is not
evidence the fix failed.

**Addendum — installing a Vercel integration does NOT trigger a redeploy.** The
Sentry integration was installed at ~18:5x; `list_deployments` confirmed **zero**
deployments after it. Since `NEXT_PUBLIC_*` is compiled into the bundle, whatever
variables an integration provisions are invisible to production until the next
build. Checking production immediately after installing an integration therefore
always shows the old state, exactly as it does after editing a variable by hand.
Push a commit, then check.
