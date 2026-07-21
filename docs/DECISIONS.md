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
