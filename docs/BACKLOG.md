# BACKLOG

Nice-to-haves and deferred items noticed during the build. Nothing here gets
built without explicit direction.

- Forgot-password flow on `/login` (doc 05): Supabase `resetPasswordForEmail` +
  reset page + email template. Natural fit with Phase 2 Resend integration.
- Dark mode (doc 06 lists it as backlog).
- Restore `app/(app)/properties/loading.tsx` skeleton once Next.js fixes the
  queued-suspense-reveal hydration bug (see DECISIONS 2026-07-12 · T3.5).
  Re-test: property detail tabs must stay clickable with the file present.
- Keys i18n: register/movement dialog strings are hardcoded English (Phase 1
  ships English; the transfer/mark_lost/edit/history UI landed in the
  2026-07-20 keys audit, T-audit).
- Settings/users: invite emails, self-service password reset and "reset 2FA"
  (doc 05) — all ride the Phase 2-3 email integration; Phase 1 invites hand
  over a one-time password (DECISIONS 2026-07-14 · T5.4).

- Audit remaining `z.string().uuid()` usages (leads.ts, units.ts,
  properties.ts required ids) for the Zod 4 strict-RFC-4122 trap: Postgres
  accepts any 32-hex uuid but Zod 4 `.uuid()` rejects e.g. the seeded
  `11111111-…` fixture ids. `optionalUuid` in deals/properties validators
  already fixed to `z.guid()` (T3.2); the rest only ever see
  `gen_random_uuid()` values today so they are safe in practice.
- ~~Dashboard SQL-side aggregates~~ — **DONE 2026-07-23** (audit PERF-3,
  migration 0018 `admin_dashboard_stats`). The SUMS no longer undercount past
  the caps; proven with a rolled-back 2,100-deal probe (old capped sum was
  €122,000 light). 9 dashboard round trips became 4. RLS test 22 pins the
  SECURITY INVOKER org scoping.
- Dashboard KPI deltas vs the previous period (7d vs prior 7d, month vs last
  month) — same queries with a shifted window.
- "Lost this month" counter beside "Won this month" for honest pipeline health.
- Admin visibility into org-wide overdue tasks and unassigned leads (agents
  see only their own).
- "View all →" footer links on the admin Latest-events and Mandates-expiring
  cards once a canonical events/mandates list page exists to link to.
- Property importer `photo_folder` support (doc 09): ingest photos from
  `import-media/<folder>/` through the T1.4 media pipeline. T5.6 imports all
  other columns; photo ingestion deferred.
- `/leads/[id]` lead detail page (doc 05): lead summary + editable fields +
  conversation/event history (EventTimeline) + convert panel. The inbox now
  covers link contact / assign / correct / reopen / convert / close inline
  (2026-07-15), so the standalone page is deferred as a nice-to-have. A
  converted lead links out to its deal via "View deal →".
- Leads inbox: pagination past the current 100-row slice (header counts are
  already exact DB counts, 2026-07-16). The status filter half of this line
  shipped 2026-07-21 — see DECISIONS T-list-scope.
- List scope follow-ups (T-list-scope): deals/viewings/offers lists should get
  the same scope treatment their terminal statuses already imply. (The
  property Archive/Restore button half of this line shipped 2026-07-21 — see
  DECISIONS T-property-archive.)
- `JWT issued at future` resilience (seen on prod 2026-07-19 and again
  2026-07-21, count 1 each, route `/properties/[id]`; also hit locally on
  2026-07-21 where the Docker VM clock had drifted while the host clock was
  fine). A slightly future-dated access token makes PostgREST reject the query
  and the user gets the "Couldn't load properties" boundary until they reload
  or re-login. Not a code defect and rare, but it is user-visible and
  self-inflicted-looking. ~~Options: a one-shot retry on that specific PostgREST
  message, or nudging GoTrue/Supabase clock-skew tolerance.~~ **Both measured out
  2026-08-08 — see the third-sighting entry below for the numbers.** Diagnosis
  note: the local fix is clearing cookies + re-login to mint a fresh token, NOT
  restarting the Supabase stack.
- Retention-expiry view (T-contact-erasure follow-up): erasure stamps
  `contacts.retention_until` (erasure date + 5y AML duty) but nothing yet acts
  on it, so retained KYC documents would sit in the bucket forever — which is
  the GDPR storage-limitation problem in slow motion. Needs an admin view
  listing contacts whose `retention_until` has passed (the partial index
  `contacts_retention_idx` from 0017 already supports the query) plus a
  "purge retained documents" action reusing the erasure action's guarded
  delete + storage-removal path. Deliberately deferred: the earliest real
  expiry is 2031.
- Erasure coverage gaps (T-contact-erasure): `deals.commission_notes` and
  `viewings.notes` are free text that may name the data subject; both are
  retained today under the legal-claims basis. If a data subject disputes that,
  they need a review path. Also `leads.lost_reason` is left intact.
- Add-lead dialog: optional property link (schema + createLead already accept
  `property_id`; the form never sends it) and an optional backdated
  `received_at` for leads entered after the fact, so the response-time KPI
  reflects reality.
- RLS follow-up: read the contacts/properties/viewings/tasks UPDATE policies
  with the client and decide whether cross-member hand-off should be locked
  down like leads/deals (0009) or stays intentional collaboration.
- Event log durability: logEvent runs after its mutation commits, so a failed
  event insert surfaces as an action error the user retries (risking a
  duplicate mutation). Long-term: write event + mutation in one transaction
  via RPC or trigger.
- Pipeline board: filter bar (agent, expected-value range) and a board-level
  open-value total in the header.
- Pipeline board: stale-deal highlighting — tint cards whose
  `stage_entered_at` tenure exceeds a per-stage threshold (column is in place
  since 0011).
- Properties list: column sorting (price, score, updated) — currently fixed
  `created_at desc` only — plus a `?tab=` param on the detail page so
  Media/Documents tabs are deep-linkable.
- Property media: drag-and-drop photo reorder with dnd-kit (pin `DndContext
  id`, see pipeline board) replacing the up/down arrows; re-watermark
  renditions when visibility changes (watermark currently applies only at
  upload time, so a private→public flip publishes unwatermarked images).
- Rent price history: the 0005 trigger only tracks `asking_price`; tracking
  `rent_price_month` needs a `price_type` discriminator column on
  `price_history` (schema change, not just a trigger edit).
- Properties module i18n (en/el/ru) for consistency with the dashboard pass —
  the module ships hardcoded English per the Phase 1 spec.
- Search index follow-up: `properties_ref_trgm` covers `reference` only;
  `address` / `title->>en` ilike scans are unindexed (fine at internal scale).
- Bulk list actions (multi-select → status/visibility change) and CSV export,
  if the team asks for them.
- Contacts follow-ups (T-audit-contacts): merge as a SECURITY DEFINER RPC for
  true atomicity (current app-side merge is archive-first + idempotent-resume);
  additional_phones add/remove UI (today they only originate from merges);
  contacts module i18n (en/el/ru); CSV export of the filtered list; filter
  inputs don't re-sync on browser back/forward (applied filters do); email
  uniqueness is advisory-only (no partial unique index like phone — add one if
  duplicate emails start appearing); `/contacts?tab=` deep-links.
- Viewings follow-ups (T-audit-viewings): reschedule/edit action
  (`checkViewingConflicts` already takes `excludeId` for it; must clear the
  route stamp when the day changes); optional deal picker in the create dialog
  (`deal_id` is accepted by the schema/validator but no UI sends it); admin-only
  "reopen to scheduled" recovery for mis-clicked terminal statuses; decide the
  fate of the unused `viewings.owner_notified` column (Phase 2 owner
  notifications?); calendar hint when paging past the 90-day/500-row fetch
  window; route save as a single RPC for atomicity (currently N sequential
  updates); "Mark completed" one-tap on the slip-signed success panel.
- Tasks follow-ups (T-audit-tasks): edit / delete / reschedule-due-date UI
  (delete RLS exists but nothing uses it; auto renewal tasks can only be
  completed, never dismissed or snoozed); entity-linked tasks — `contact_id` /
  `deal_id` columns exist (contact-merge even repoints them) but no UI sets or
  displays them; "Add task" buttons on property/contact/deal detail pages;
  admin section on /tasks for org-wide overdue + unassigned tasks with a
  claim/assign control (0012's admin fallback prevents new orphans, but an
  explicit surface beats a fallback); tasks module i18n (en/el/ru); feedback
  nudge rows could show the contact name next to the property ref.
- Settings follow-ups (T-audit-settings): admin "Reset password" button on the
  users table (regenerate a temp password via the existing admin API + the
  credentials-shown-once dialog — closes the no-SMTP lockout gap until Phase 2
  email); force password change on first login (user_metadata flag + redirect);
  delete-unused-area button (the areas_delete RLS policy exists but no UI calls
  it); per-stage deal counts in the stages editor so delete refusals are
  predictable; "verified N months ago / never verified" staleness badge on
  cyprus-config cards; settings module i18n (en/el/ru); org-scoped branding
  paths if multi-org ever ships (branding/logo.png is global today).
- ~~Reports follow-ups (T-audit-reports)~~ — ALL SHIPPED: deal filter,
  generated-reports list, verify-a-report and the nightly chain cache as
  T-audit-reports-2 (migrations 0015/0016); module i18n as T-audit-reports-3.
- ~~Event-line vocabulary i18n (`describeEvent`)~~ — SHIPPED as
  T-audit-events-i18n: `describeEvent` takes a translator; `EventTimeline`
  passes the request-locale one so every general timeline translates; the
  evidence record passes a pinned English one so preview + PDF stay English.
  `events` namespace in en/el/ru. The event PAYLOAD values (names, section
  keys, channels, stage names, user-typed reasons, file names) deliberately
  stay as-stored — only the template text translates.

- **CSV export — remaining lists.** Contacts CSV export shipped 2026-07-23 (IMPROVEMENTS B10). Repeat for properties, leads, deals, viewings, keys, tasks: extract each list's filter parse/apply into `lib/queries/<list>.ts`, add a GET export route reusing it, define columns via `lib/services/csv.ts` `toCsv`. ~0.5 day each.
- ~~**Export audit logging (decision needed).**~~ **Resolved 2026-07-23: yes, log exports.** Built in `lib/services/export-audit.ts` (org-level `export`/`exported` event, written before the CSV is returned). Contacts export logs; the remaining lists inherit it via `logListExport`. See DECISIONS `T-export-audit`.
- **Database-level 2FA enforcement (security, follow-up to C2).** 2FA shipped 2026-07-24 but is enforced only in the app (`login()` + `proxy.ts`). A stolen `aal1` JWT can still reach PostgREST directly and bypass the challenge. Fix: add `as restrictive` RLS policies asserting `auth.jwt()->>'aal' = 'aal2'` for users who have a verified factor — use the "enforce only for users that have opted-in" template from the Supabase MFA guide so non-enrolled users are unaffected. Touches every business table, carries real lockout risk, and needs its own RLS suite coverage (doc 04 guardrail 3), so it is its own piece of work. See DECISIONS `T-2fa`.
- **Mandatory 2FA (decision, follow-up to C2).** Enrolment is currently opt-in. If the client wants it required, the Supabase guide gives "enforce for all users" and "enforce for new users only" variants. Do the DB-level enforcement above first, and plan a recovery path — Supabase issues no recovery codes, so the practical answer is a second enrolled factor per user plus an admin who can delete a factor via the GoTrue admin API.
- ~~**Deal-scoped "Log contact" action (follow-up to B7).**~~ **SHIPPED
  2026-08-07 (migration 0025).** It was worse than this entry described: the
  edit did not merely buy 14 days of quiet, it CLOSED the open chase-up
  immediately via `deals_supersede_nudges` and logged
  `reason: deal_contacted_or_closed` against the editing user — the log asserted
  contact nobody had claimed. Silence now has its own column, `last_contact_at`,
  written only by `logDealContact` and by `logConversation` on a converted lead;
  `last_activity_at` still drives the health score and is still bumped by edits.
  The trigger's `WHEN` clause had to move with the predicate — it fired on
  `last_activity_at or status`, so the function alone would have been correct
  while the feature stayed broken. RLS test 27 and the reworked E2E nudge spec
  pin both directions. See DECISIONS `T-deal-contact`.
- **Configurable nudge thresholds (decision, follow-up to B7).** 14 days and 48
  hours are hardcoded in `create_followup_nudges()`. 14 is deliberately the
  health score's own activity cliff (doc 02 §C5), so making it independently
  editable risks the two disagreeing silently about what "stale" means. If the
  desk wants to tune them, put them in `cyprus_config` with a `coalesce` default
  so the cron survives a missing key, add the settings row + validation + its
  event, and decide explicitly whether the health score follows.
- ~~**Nudges can land on a deactivated assignee (B7 + 0012).**~~ **RESOLVED
  2026-08-02 (migration 0024).** Every arm of the three-armed fallback is now
  active-only in all three system kinds (`deal_no_contact`, `viewing_feedback`,
  `mandate_renewal`) — previously only arm 3 checked `is_active`, so the guard
  stopped exactly where the fallback started. Fixing the arms alone was not
  enough: the cycle guards refuse to re-mint a task for a boundary that already
  has one, and deactivation usually happens *after* assignment, so the re-home
  is stated as an invariant and self-healed nightly as step 5 of
  `create_followup_nudges` (which runs 03:15, after expire-mandates at 03:00, so
  one place owns it for all three kinds) plus a one-time backfill. RLS test 26
  pins it. Note the test asserts the assignee **as minted**, read from the
  `followup_task_created` event: step 5 re-homes within the same invocation, so
  asserting on `tasks.assignee_id` alone passes even with the arms reverted —
  verified by reverting them and watching it still pass.
- **Human-assigned tasks are still stranded by deactivation.** 0024's sweep is
  deliberately scoped to system-generated rows (`kind is not null`); a task one
  person assigned to another by hand still sits invisible if the assignee is
  deactivated. Re-homing those silently would overwrite a human's deliberate
  choice, so it wants a surface (an admin "tasks held by deactivated users" list
  with an explicit reassign) rather than a cron rule. Pairs naturally with the
  org-wide overdue/unassigned admin view already in this file.
- ~~**`csp.spec.ts` depends on test residue.**~~ **RESOLVED 2026-08-02.** The
  two detail tests asserted `expect(href).toBeTruthy()` on the first row of
  `/properties` and `/contacts`, which only `happy-path.spec.ts` creates — so
  against a freshly reset database both FAILED on run 1 and passed on run 2.
  Of the two fixes offered here, **seeding** was chosen over self-skipping:
  these are the heaviest client routes in the app (tabbed forms, media grid),
  and dropping their CSP evidence silently on a fresh database is the worse
  trade. The spec now prefers a real row when one exists — real data exercises
  media and documents a bare fixture does not — and seeds its own property and
  contact when the list is empty, removing them in `afterAll`. Cleanup is
  marker-based (`reference like 'CSP-FIXTURE-%'`; `contacts.notes`, since
  `properties` has no `notes` column) so a crashed run is swept by the next one
  rather than leaking rows. Seeding needs the service key, so against a
  non-local base URL the tests still self-skip rather than assert falsely.
  Verified without a `db reset` by forcing the empty-list branch, confirming
  both rows were really created, and watching the marker sweep remove them.
  **The real proof was finally taken 2026-08-08** — the substitute was only ever
  used because disk was down to 9.3 GB, and after the workspace and Docker moved
  to `D:` the reset cycle became affordable. `supabase db reset` (all 25
  migrations from scratch, leaving `properties=0 contacts=0`) then **run 1** of
  `csp.spec.ts`: 31 passed / 3 skipped, with `property detail` and `contact
  detail` — the two that used to fail on run 1 — both green via the seeding
  path, and `CSP-FIXTURE-%` / `csp-detail-fixture` counts back to 0 afterwards.
- **CSP report delivery cannot be confirmed "later" — Vercel log retention is
  ~1 hour on this plan (C1).** `/api/csp-report` sinks to stdout, and HANDOFF
  told the operator to browse production and then grep the runtime logs for
  `[csp]`. A 7-day query returns *"the requested window likely exceeds your
  plan's runtime-log retention (Hobby 1h, Pro 1 day…)"*, so any check made more
  than an hour after browsing will find nothing — and "no `[csp]` lines" would
  be misread as "the policy is clean" when it may mean "reports were never
  delivered, or expired". Those two must not be confused before anyone promotes
  the policy from Report-Only to enforced. Fix: browse and grep inside the same
  hour, or give the endpoint a durable sink (configure the Sentry DSN, which the
  handler already writes to, or add a Vercel Log Drain). Found 2026-07-29.
- ~~**Hosted has `service_role` EXECUTE grants that no migration produces (schema
  drift).**~~ **RESOLVED 2026-07-29 (migration 0022).** Diagnosed from the ACLs:
  hosted carried explicit `service_role=X/postgres` entries on `current_org_id`,
  `current_role_gnk` and `expire_mandates` — hand-applied, not role inheritance
  and not a platform default. Revoked rather than captured as a migration,
  because nothing needs them: the first two are RLS helpers and `service_role`
  bypasses RLS, and `expire_mandates` is pg_cron-only, run as `postgres`, which
  keeps its own grant (0007 §1 said exactly that). Verified no caller exists in
  app code, scripts or tests. `verify-restore.sql`'s expectations, which had
  encoded the drift, were corrected — a migration-built database now passes all
  25 invariants, where four failed before.
- **`lib/supabase/client.ts` is dead code — and that is currently a security
  asset.** `createBrowserClient` is called there and nowhere else; no module
  imports the exported `createClient`. Verified 2026-08-03: no JWT-shaped string
  and no `supabase.co` appears in any of the 63 chunks of a production
  `.next/static` build, so the browser receives no Supabase credential at all.
  Deleting it is the tidy answer, but note the consequence of the opposite
  choice: the day someone imports it, `NEXT_PUBLIC_SUPABASE_ANON_KEY` starts
  shipping to the browser. That is normal and safe for an anon/publishable key —
  it is *designed* to be public — but it should be a conscious decision rather
  than a side effect, and it changes what HANDOFF §2b step 4 can verify. Keep or
  delete deliberately; do not let it happen by accident.
- **`JWT issued at future` — third sighting, now with a deployment stamp.** Seen
  again on prod 2026-08-03T17:07:18Z, route `/properties`, count 1, users 1, on
  deployment `dpl_D3WRnCp…`. Same shape as 2026-07-19 and 2026-07-21: a
  slightly future-dated access token makes PostgREST reject the query and the
  user gets the "Couldn't load properties" boundary until they reload or
  re-login. Unrelated to the key rotation — this is the session JWT's `iat`, not
  the API key. It is now the only recurring runtime error in production, and
  `get_runtime_errors` on the Vercel connector makes it cheap to keep counting.

  **MEASURED 2026-08-08, and it rules the retry option OUT.** PostgREST already
  carries its own future-`iat` leeway, so the two options this entry had been
  carrying since 2026-07-19 are not equivalent — one of them cannot work.
  Swept a hand-signed token against the local stack at increasing offsets:

  | `iat` offset | result |
  |---|---|
  | +0s, +5s, +10s, +20s | **HTTP 200** — accepted |
  | +31s, +60s, +120s, +300s, +3600s | **HTTP 401** `PGRST303` `JWT issued at future` |

  The tolerance is ~30s. **So every rejection we have actually seen means the
  token was more than 30 seconds ahead** — which is a broken clock, not the
  sub-second blip the "one-shot retry" idea assumed. A retry would have to sleep
  30+ seconds to land past the boundary, which hangs the page for far longer than
  the error costs; capped at anything sane it never fires at all. A retry wrapper
  was written, unit-tested, and then **deleted rather than committed**, because
  it could only ever have been dead code (DECISIONS 2026-08-08).

  Also now known precisely: the code is **`PGRST303`** at **401**, so detection
  needs no message matching. And note Next redacts server-component error
  messages before they reach `app/(app)/error.tsx` — the browser gets a `digest`,
  not the text — so anything that branches on this must do so **server-side**.

  **Graceful degradation SHIPPED 2026-08-08.** `unwrapRows` routes `PGRST303` to
  a new `/session-clock` page instead of the boundary — it says the clock is
  ahead, that reloading will not help, and offers one button wired to the
  existing `logout()` server action. No auto sign-out (that needs a GET endpoint
  with a side effect, i.e. a logout-CSRF surface) and the page sits outside the
  `(app)` group, because that layout builds its own client and would loop.

  Confirmed by replaying a re-signed session against the running app: +0s/+20s
  render normally, **+31s through +120s land on `/session-clock`**. Which
  incidentally explains why this bug exists — **there are two tolerances.**
  PostgREST refuses from ~31s while GoTrue still calls the user authenticated at
  +120s, so the session passes `proxy.ts` and fails every query. Widening
  tolerance is not available: PostgREST's JWT settings are not exposed on
  Supabase.

  Still open, and now the only part: the underlying clock. This page makes the
  failure legible and one click from recovery; it does not stop a machine whose
  clock drifts half a minute.
- **The signed slip PDF has no recorded hash anywhere.** Found during the
  2026-08-05 Storage restore drill (BACKUP_RESTORE §4c). `viewing_slips` stores
  `signature_sha256` for the signature PNG, and event 60's payload carries that
  same hash — so a corrupted or substituted signature image is detectable. The
  slip **PDF** (`viewing_slips.pdf_path`) has no hash in the row and none in the
  event, so nothing can prove a restored slip PDF is byte-identical to the one
  that was signed. Evidence reports do not share the gap: their generation event
  carries `pdf_sha256`, and that is what made the drill's end-to-end proof
  possible. Fix is small — hash the PDF at generation and put it in the row and
  the `viewing_slip_signed` payload — but it is only forward-looking: the one
  existing slip stays unhashable, so the change wants a decision about whether to
  backfill from the current bytes (which asserts they are the right bytes) or
  leave it null.
