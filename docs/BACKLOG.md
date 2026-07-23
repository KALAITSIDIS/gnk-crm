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
  self-inflicted-looking. Options: a one-shot retry on that specific PostgREST
  message, or nudging GoTrue/Supabase clock-skew tolerance. Diagnosis note: the
  local fix is clearing cookies + re-login to mint a fresh token, NOT
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
