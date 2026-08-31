# DECISIONS

Running log of implementation decisions made where the docs were ambiguous or
silent. Format: date · task · decision · rationale.

- **2026-09-02 · T-partials-close (no migration) — three PARTIAL chips become
  whole.** The 2026-09-01 verification found six FIXED chips overstating; the
  three code-shaped ones close here. (1) **DB-01**: a reservation converted
  to a sale while the listing read on-market raised nothing — the deal-Won
  leg's mirror now runs in transitionReservation after the proven write:
  same prompt-task idiom (one open per property+kind, assignee through the
  linked deal or the closer, task failure logged loudly but never rolling
  back the committed transition, NEVER a status flip — the 2026-08-26
  boundary). Pinned by reservation-convert.spec.ts, the first reservation
  e2e in the suite. (2) **RPT-2**: the RPC's caveat that demotions count as
  advancement lived only in the payload's `note` — the reports page renders
  it verbatim under the table (0067 self-describing-output: the UI can never
  disagree with the RPC) and the CSV gains an APPENDED Note column (the
  withWindow rule — never inserted, row pins survive). (3) **SEC-06**: the
  CSV importer wrote consent with no consent_changed event and fabricated
  consent_at as import time — it now writes the dedicated event (channel
  csv_import, system actor, direct insert firing the chain trigger), honors
  an optional consent_at CSV column, and FLAGS import-time stamps as
  `consent_at_source: "import_time"` rather than passing them off as
  history; contacts.ts's "only consent surface" comment corrected. Still
  deliberately NOT invented: a consent wording/version — that needs the
  operator's actual form text, and fake provenance is worse than none.

- **2026-09-02 · T-offsite-attested (no migration) — the last unattested hop
  in the backup path closes.** REL-01's residual (2026-09-01 verification):
  the "off-site" copy landed in a OneDrive folder ON THIS MACHINE, locally
  re-hashed, with the actual off-machine hop delegated to the sync client —
  unattested and unalarmed, i.e. the original defect under a green chip.
  `offsite-github.mjs` now ships the same dated archive to the PRIVATE
  `KALAITSIDIS/gnk-backups-offsite` repo as a release asset, RE-DOWNLOADS it
  from GitHub and compares SHA-256 — an off-machine copy proven per night,
  keep 7, pattern-scoped prune, non-private targets refused per run.
  Destination decided under the operator's delegation: a personal cloud
  account that is not Supabase and not the public code repo, same
  test-data-today caveat as OneDrive, re-decided at real-data onboarding.
  Proven three ways on 2026-08-31: interactive run (10.2 MB up,
  re-downloaded, hash-identical), --clobber re-run after the nightly rebuilt
  the archive, and a real scheduler-context task run (the S4U leg logs
  SKIPPED until armed — an unarmed leg must not fail nights). The ONE step
  left is the operator's by design: paste `GH_TOKEN` into backup.env (the
  classifier rightly blocked the agent doing it — credentials land there by
  the operator's hand only, HANDOFF item 1b). After that, a missed GitHub
  upload fails the night into the armed dead-man.

- **2026-09-02 · T-gov1-closeout (no migration) — the three doc drifts, and
  a ruling the operator delegated.** The 2026-09-01 artifact verification
  found GOV-1 three-quarters open. Closed here: (1) **the hard-delete rule
  now carves out what practice already proved** — IMPROVEMENTS §D permits
  hard-deleting operator-created TEST records under four conditions
  (named instruction, test data only, deletion recorded + orphaned events
  accepted as its audit trail, chain verified after), and the exception
  DIES at the first real client record. Ruled by the assistant under the
  operator's explicit "make decisions for me" delegation — the
  alternative, keeping a rule broken twice, was the worst option on the
  table. (2) HANDOFF's "GNK-PAF-0002 still wants archiving" voided — that
  row was hard-deleted 2026-08-28 and the counter reset means the
  reference now names a future property. (3) BACKLOG's "APPLYING an
  uplift is not built" struck — applyPriceUplift shipped the same day the
  line was written (8a39705 vs defdef5, both 2026-08-21); the file's own
  stale-claim warning claimed its fourth victim, and the VERIFY line now
  checks both halves.

- **2026-09-01 · T-test-honesty (no migration) — the review's test-layer
  findings, closed; the review wave ends here.** (1) vat-condition.spec:
  the one regression 0079 existed to prevent — condition in the config,
  silent on the screen — had no test that could catch it; the new spec
  seeds an over-area new-build (the cliff outcome that surfaces the
  transitional block) and pins the warning line verbatim against the LIVE
  config row, dates included. (2) RLS test 51's due-date expectation
  added 24 real hours where the SQL adds one Cyprus CALENDAR day — a
  latent flake on every DST transition; now date-space arithmetic
  matching the SQL. (3) The calculators copy-summary test asserted the
  card while claiming to assert the summary — the summary is built from
  its own literals, so the card proved nothing; the test now grants
  clipboard-read (desktop = Chromium) and asserts the pasted artifact
  itself: the abolition sentence, the law number, no "Total:". Wave
  totals: 994 unit / 81 RLS / 214 desktop E2E across 44 files; all 10
  confirmed findings from T-post-audit-review are closed, 14 lows triaged
  (6 fixed across the wave, the rest recorded there as accepted).

- **2026-09-01 · T-action-hardening (no migration) — the review's
  action-layer mediums, closed.** Three defects from T-post-audit-review's
  confirmed list plus one degenerate test: (1) the wizard's inline
  owner/developer create was the ONE contact entry path without `.email()`
  — "n/a" became contacts.email and poisoned 0077's dedup; the schema now
  lives in lib/validators/party-contacts.ts (testable — the action file
  imports server-only modules) with parity pinned. (2) rescheduleViewing's
  UPDATE was read-then-write with no row proof — a cancellation landing
  between read and write was silently overwritten into a moved, re-live
  viewing; now compare-and-set on status='scheduled' with the returned row
  as proof (the markDealWon idiom). (3) the `listing_status_check` prompt
  raised at deal-win was never completed by anything — obeying it left it
  open forever, and a prompt that survives being obeyed teaches the desk
  to ignore prompts; `completeListingStatusChecks`
  (lib/services/followup-tasks.ts, the supersedeRenewalTasks idiom) now
  runs from both status-save sites, eventing each completion with the
  proved reason. (4) deal-close.spec seeded the deal's agent as the
  closing admin, so "assigned to the deal's agent" could not catch a
  regression to "assigned to the closer" — the deal now belongs to a
  dedicated second profile, and the spec walks the full loop: prompt
  raised → assigned to the REAL agent → status set to sold on the details
  tab → task completed with its superseded event.

- **2026-09-01 · T-post-audit-review (migration 0080 + two fix branches) —
  the post-audit work gets the adversarial read it never had.** Everything
  merged after the 2026-08-29 audit snapshot (0070–0079, the MFA enrolment
  fix, feed/photo, five e2e specs, the repoint script, a stack of doc
  claims) had only ever been reviewed by the sessions that wrote it. A
  six-lens review (SQL / auth / logic / tests / ops / docs) with an
  independent refute-first verify pass produced 27 raw findings → 10
  confirmed (2 high), 3 refuted, 14 lows. The two highs, both real:

  1. `changePassword` crashed for every factor-less user — the exact
     temp-password shedding SEC-03 shipped it for. Same 0059 trap fixed in
     startMfaEnrollment on 08-30; the sibling was missed. Fixed on
     `fix/aal1-password-change`: authenticate from the JWT, profile lookup
     and the `password_changed` event ride the service role (events is
     aal2-gated and by then the password HAS changed — the event must not
     be lost). Pinned by a new mfa.spec e2e running the whole story:
     change at aal1 → event with empty payload → old password dead → new
     one in. The spec's self-heal also stopped depending on listUsers
     page 1 (residue pushes a stranded fixture user off it within days).
  2. repoint-vercel.mjs live-verified the anon key but only SHAPE-checked
     the service-role key — a stale sb_secret_ would bake green and kill
     every admin path (the 2026-08-03 outage class, in the tool built to
     end it). Now both keys are live-probed (rls_aal2_coverage() is
     service-only over PostgREST — 200 proves THIS key against THIS
     project); secrets are scrubbed from every output path; a mid-way
     PATCH failure states exactly which vars are mixed.

  The restore path got the systemic fixes: 0072/0077/0078's ten bare ADD
  CONSTRAINTs each gained drop-if-exists (a replay against an
  already-migrated DB aborted with 42710 mid-restore — all four files now
  proven no-op on re-run); verify-restore.sql's grants check FAILS CLOSED
  (any unpinned public secdef/anon-executable function is a failure — the
  old one-way join was blind to 0074's cron_health eleven minutes after
  the list was generated), and the new check immediately caught
  `set_updated_at` + `protect_property_reference` still anon-executable →
  **migration 0080** revokes them (hygiene, not a hole: trigger-returning
  functions are not PostgREST-callable). The pack's hand pins are now
  locked to the repo by verify-restore.test.ts in CI (migrations count ≡
  file count; every migration-created secdef function ≡ a grants row) —
  the 78-pin went stale twice in 24 hours; it cannot again. Doc drift
  corrected: HANDOFF §0a's state line now defers to the §0 table (it was
  nine migrations behind), properties is 73 columns not 69, the
  RELEASE_CHECKLIST cron gate no longer fails a correctly-amber never-run
  job, §3.1's revoke list names real revoke-bearing migrations (0059 has
  none), §4e's ledger recipe defers to `ls` instead of a number, and this
  file's own T-group1-close figures are corrected in place. Confirmed
  mediums on the action/test layers (party email validation, reschedule
  compare-and-set, listing_status_check completion, VAT condition render
  coverage, plus triaged lows) land in the next branches.

- **2026-08-31 · T-vat-transitional (migration 0079) — the transitional
  deadline gets its condition, before it misleads anyone.** The audit parked
  "VAT transitional note tightening" behind the Tax Department circular; a
  recon found the gate lifted — Law 109(I)/2026 (gazetted 2026-04-24) and
  the Tax Department announcement of 2026-05-04 made the 2026-12-31 deadline
  CONDITIONAL: it holds only where the building permit was issued after
  2025-01-01 or is still unissued; for permits issued by 2024-12-31 the
  filing deadline was 2026-06-15 — which has now PASSED. Our 0058-era note
  ("STILL LIVE until 2026-12-31") was true for one subset of buyers and
  false for another, with no way to tell them apart on screen.

  0079 tightens the config in the 0058/0070 verified-rates idiom (guarded on
  the condition's absence, every figure asserted unchanged, verified_at
  restamped with both sources); the code half carries `condition` through
  `transitionalHint` to the panel as a warning line — a config that names a
  lapse must put it ON THE SCREEN, or the panel quotes a lapsed relief to
  exactly the buyers it lapsed for. Back-compat pinned: a pre-0079 config
  renders with condition null, never dropped. Rolled into the same change:
  the HANDOFF Cron row (listed six of eight jobs) and RELEASE_CHECKLIST
  (listed two) now defer to docs/10's authoritative table, and the desktop
  E2E count was re-measured for the first time since 2026-08-22 (212 listed,
  was 204/206).

- **2026-08-31 · T-repoint-script — the Vercel env swap is a script, and the
  RTO's scriptable lever is closed.** §6b's finding (the 4-hour RTO is ~98%
  people) named three levers; `scripts/backup/repoint-vercel.mjs` closes the
  one code can reach. One command re-points production at a restored
  Supabase project: shape-checks, a LIVE anon-key probe against the target
  BEFORE any write (an unverified key baked into a build is an outage
  wearing a recovery's clothes), atomic per-var REST PATCHes (never the
  CLI's rm-then-add, which leaves a hole if interrupted), rebuild from the
  latest READY production deployment, READY wait, /login + feed probes. A
  failed rebuild leaves the previous deployment serving. Values come from
  `~/.gnk-crm/backup.env` — the file the recovery flow already maintains —
  so no secret crosses a shell argument. Plan mode verified against
  production; the write path has a documented ZERO-CHANGE rehearsal
  (same-value PATCHes + a rebuild identical to any push) awaiting a
  permitted run — the session's permission classifier rightly gates
  production writes, and the rehearsal is a one-liner for the operator.
  BACKUP_RESTORE §6c.

- **2026-08-31 · T-cloud-restore-drill — the backup restores into a REAL
  cloud project, remediates to production's own posture, and the whole path
  is now measured.** Audit REL-08, the last reliability item — executed
  WITHOUT an operator present, which the audit assumed impossible: the
  Supabase CLI token (connected the same day) provisions and deletes
  projects, and psql reaches the scratch through the same docker technique
  as every hosted apply. Full record: BACKUP_RESTORE **§4e**.

  The verdicts: schema 73 s / 0 errors over the wire (the extension preamble
  and the public,events_parts dump scope eliminated every historical error
  class); data 12 s / 2 benign platform-table errors; **the restored chain's
  hash aggregate is byte-identical to LIVE production over 130 events**; and
  after the documented remedies (ledger 78 rows, 8 cron jobs, grant
  lockdown), **verify-restore.sql fails the restored scratch on EXACTLY the
  same 11 rows as live production** — converged, provably.

  Five findings, all recorded in §4e: (1) `supabase_migrations` schema does
  not exist at all on fresh cloud — the pack hard-errors until it is
  recreated; (2) §3.1's "re-apply EVERY migration-defined revoke", taken
  literally, would replay 0002's blanket table revoke WITHOUT its re-grants
  and kill authenticated's table access — corrected; (3) DO-block revokes
  (0065's report loop) escape verbatim extraction — the pack's grants table
  is the residue-catcher, and it caught exactly the six report functions +
  two partition helpers; (4) cloud default privileges grant service_role
  EXECUTE on every function — nine cosmetic pack deltas that production
  itself shares, now documented IN the pack; (5) the pack's baseline had
  gone stale (73/9 vs 78/12 after this week's 0074–0078) — refreshed.

  Scratch project created and DELETED the same hour (Management API — the
  CLI's delete needs a TTY confirm); the generated password lived only in
  the session scratchpad and died with it. Remaining composition gaps are
  unchanged and human by nature: auth.users recreation, storage bytes
  (§4c), the Vercel env swap. The mechanical cloud restore is ~2 minutes
  measured; §6b's "the 4-hour RTO is ~98% people" now stands on a full
  end-to-end run.

- **2026-08-30 · T-coverage-hardening — the skipped MFA spec comes back on a
  dedicated user, and its first run catches a real onboarding-breaking bug.**
  BACKLOG's last outstanding item plus e2e for the Phase-3 surfaces nothing
  pinned. NO MIGRATION.

  **The mfa.spec rework**, exactly as the BACKLOG entry prescribed: a
  dedicated user created and destroyed by the spec in a fresh browser context
  — safe in either MFA mode, no shared session to revoke, no factor history
  to restore. The wrong-code refusal and "password alone stops working" are
  covered again on every run. VERIFY holds: `grep -c MFA_REQUIRED
  tests/e2e/mfa.spec.ts` → 0.

  **THE FIRST RUN FOUND A REAL BUG: under mandatory 2FA, an invited user
  could not enrol.** `startMfaEnrollment` read the profile through RLS, and
  since 0059 an aal1 factor-less session reads NOTHING — so the one path INTO
  compliance threw "Profile not found" behind the error boundary. Invisible
  until now because `auth.setup.ts` enrols through the supabase-js API (not
  the UI) and production's two users both already carry factors; the
  MFA_REQUIRED constant's own "enrolment stays reachable" claim covered the
  PAGE but not the ACTIONS. Fix: `startMfaEnrollment` authenticates from the
  JWT without an RLS read (a deactivated login is already banned at GoTrue,
  so nothing is lost); `confirmMfaEnrollment` fetches the profile for its
  event only AFTER verify() upgrades the session to aal2, where RLS admits
  it. The constant's comment now records the caveat. The fixed path is proven
  by the spec that found it — a factor-less user enrols through /security's
  real UI, wrong code refused, right code in.

  **Three new e2e specs** for surfaces the survey flagged as unpinned:
  `deal-close.spec.ts` (Won dialog prefills the accepted offer's 250000 over
  a deliberately stale 999999 estimate; final_value lands on the row AND in
  the won event; the listing_status_check prompt task is raised while the
  status stays the desk's call), `viewing-reschedule.spec.ts` (the .ics route
  serves a real VCALENDAR with the stable UID; reschedule moves the SAME
  viewing — no cancel+recreate — and events from/to), `entity-tasks.spec.ts`
  (Add task on a property page links the task, keeps it kind-null, and the
  /tasks list renders the reference link). One spec-side lesson kept in the
  file: wait for the dialog to CLOSE before asserting the database — the
  dialog's own "Final value" label satisfied a bare text assert while the
  server action was still in flight.

- **2026-08-30 · T-compliance-loop (migration 0078) — the consent trail, the
  portal tripwire, the retention nudge, and three workflow gaps.** Audit
  SEC-06 + SEC-07 + SEC-08 + WF-5 + WF-8 + WF-3, the final Phase-3 batch —
  and with it, EVERY buildable item from the 2026-08-29 audit is closed.

  **SEC-06**: a marketing-consent flip now writes its own hash-chained
  `consent_changed` event beside the generic diff (the setUserRole →
  role_changed pattern) — Art. 7(1) asks the controller to DEMONSTRATE
  consent, and one diff key inside a section save is a poor exhibit. The
  initial grant at create logs too. Channel is a literal (`crm_form`, the
  only consent surface); deliberately NO invented version field — the
  consent wording is not versioned, and fake provenance is worse than none.

  **SEC-07 (0078)**: `profiles_role_staff_only` CHECK — the portal enum
  values are unbuilt (0043's "considered, not overlooked" deferral) and
  every staff read policy is an org-membership scan, so a portal profile
  seeded out-of-band would read the org at staff level. A CHECK and not a
  trigger, because the profiles trigger exempts null-uid paths and cannot
  catch exactly the seeded-profile threat. SUNSET recorded in the
  constraint comment: the portal-phase migration drops it in the same file
  that introduces real portal RLS. RLS test 53 pins the service_role
  refusal for all three portal values.

  **SEC-08 (0078)**: the retention nudge, inside T-retention-expiry's
  boundary verbatim ("Surfaced, never automatic … a nightly NUDGE would be
  a reasonable follow-up — an automatic purge would not"). A twelfth kind
  `retention_expired` + two arms in the existing 03:15 sweep (the 0075
  no-ninth-job precedent): admin-assigned ONLY (destruction is admin-only,
  an agent/creator fallback would assign unactionable work), cycle-keyed to
  `retention_until`, superseded with `retention_purged_or_changed` when the
  purge nulls the marker. It will mint nothing until 2031 — which is the
  point: it fires when memory has long failed. purgeExpiredRetention stays
  the only destroyer. RLS test 54 pins mint/idempotence/supersede.

  **WF-5 / WF-8 / WF-3**: quick-add tasks link the record they concern
  (verify-then-insert against RLS so a cross-org uuid fails closed; "Add
  task" dialogs on the three detail pages, deliberately NOT on /tasks whose
  spec pins the first add-button; contact-linked tasks finally render a
  link); offers past `valid_until` badge as "lapsed" on READ (per-request
  Cyprus clock, no cron, no status write — the manual Expire stays the
  follow-through); and the viewing↔deal link stops being dead plumbing —
  the create dialog carries `deal_id` (accepted since T4.1, sent by
  nothing), the deal page gains a Viewings card with a prefilled scheduler,
  the contact page a Viewings tab, the viewing page its deal link.

  **Local DB reset mid-batch** (the residue rule): RLS test 41 failed
  locally only because dozens of public MEDIA-* fixtures from repeated
  same-day suite runs crowded the 50-row feed past the new listing. Reset,
  then 81/81 on a FIRST run against a fresh database — which also proves
  all 78 migrations apply cleanly in sequence. dev-fixtures re-applied.

- **2026-08-30 · T-property-identity (migration 0077) — the plot gets its
  legal identity, and the 0001-era schema debt is settled in one deliberate
  pass.** Audit DB-05 + DB-08/09/10 + WF-10, the third Phase-3 batch.

  **DB-05**: four DLS columns (`registration_no`, `plot_no`, `sheet_plan`,
  `registry_municipality`) on the legal tab, the wizard and the importer.
  The registration number is the duplicate signal that works where the
  address check is blind — unaddressed land, the classic open-mandate
  duplicate. Entry-time warn-never-block check, org-wide (a plot's number is
  unique however the listing is districted); the pure matcher treats case
  and spacing as typist noise and everything else as exact. Withheld from
  the public feed by the allowlist, by construction.

  **DB-08 — the class decision, taken**: BACKLOG's recorded stance ("the
  whole 63-finding class is what wants a decision, not this one row") was
  written to stop piecemeal drive-by indexing — so the decision was taken
  ONCE: 13 covering indexes, each annotated in the migration with the hot
  read path that earns it, and the integrity-only tail NAMED as deliberately
  not indexed, so the next advisor run reads as a decision rather than an
  oversight.

  **DB-09**: validated CHECKs on every 0001-era money column — the app
  validators guard the UI, but the service-role importer accepts any finite
  number and a CHECK binds it where RLS cannot (0072's lesson). Never NOT
  VALID (0026's stance); offenders counted before each ADD.

  **DB-10**: `contacts_email_unique (org_id, lower(email))` for ACTIVE rows
  — phone had this since 0001, email had a check-then-act race. Archived
  rows excluded, which is what keeps the merge flow safe. Every 23505
  handler now names phone OR email; `updateContactSection` gains the branch
  it lacked entirely. RLS test 52 pins the case-variant refusal, the
  archived-holder release, and the negative-money 23514s — all against
  service_role.

  **WF-10**: "New owner/developer — create without leaving the wizard."
  `createLead`'s inline dedup-checked pattern minus the redirect that made
  new-owner intake a two-trip flow; `contact_types` set from the source
  because the party picker filters on it — a contact created without the
  type could never be re-found by the picker that just created it.

- **2026-08-30 · T-close-the-books (migration 0076) — Won stamps a real
  number, and four report defects go.** Audit WF-2/DB-03 + DB-01 +
  RPT-1..4 + CALC-2, the second Phase-3 batch.

  **`deals.final_value`**: Won captured no final sale value — dashboards and
  the C4 reports summed `expected_value`, a pre-close estimate, while the
  accepted offer's amount was copied nowhere. The Won dialog now confirms a
  price (defaulted from the accepted offer, editable, optional on
  admin-override closes), the column and the `won` event both carry it, and
  the three won sums read `coalesce(final_value, expected_value)` — pre-0076
  deals keep their estimate, new closes report reality. RLS test 38 pins the
  coalesce with an estimate (999999) that must lose to its confirmed 250000.

  **DB-01, inside the settled boundary**: the reservation↔status coupling
  was DECLINED 2026-08-26 and stays declined — so the Won side got a task
  that ASKS (`listing_status_check`, the eleventh kind: raised when the won
  deal's listing still reads on-market, one open task per property) and the
  regression side got an ADMIN-ONLY gate in both status writers (details
  form + unit grid) with its own `status_regression_override` event.
  sold→available stays possible — a fallen-through sale genuinely relists —
  but named and attributed, never silent. `isStatusRegression` is pure and
  unit-pinned; sold↔rented stays unguarded (both assert a close).

  **RPT-1**: `report_agent_performance` gains 0042's negative-interval guard
  on the average ONLY — `leads_answered` still counts anomalous rows,
  0042's own stated asymmetry ("did the desk reply?" survives a clock
  anomaly). Pinned by a backdated lead that must not drag the average.

  **RPT-2**: `advance_rate` could exceed 100% (pre-window entrants departing
  in-window) and counted demotions invisibly. `advanced` is now the
  intersection cohort — departures by deals that also entered in-window —
  bounding the rate at 1 by construction; demotions still count and the
  `note` says so out loud (the 0067 self-describing-output convention).
  Rebuilt on 0067's body, not 0065's, so stage-id resolution survives.

  **RPT-3/RPT-4/CALC-2**: the report default window now derives from
  `zonedParts().dayKey` (the old UTC-dated default dropped "today" between
  Cyprus midnight and 02:00 under a footer claiming Cyprus time); every
  report CSV carries its window (From/To columns APPENDED so row pins hold,
  window in the filename); both calculator copy summaries date themselves —
  "Rates verified {date} · computed {date}" — because an undated quote in a
  WhatsApp thread outlives every rate change (July's stamp-duty stamp on an
  abolished tax is the live demonstration).

- **2026-08-30 · T-viewings-loop (migration 0075) — the viewing lifecycle
  stops leaking: reschedule, three-diary clash check, no-show nudge, .ics.**
  Audit WF-1 + WF-6 + WF-7 + ICS-1, the first Phase-3 batch.

  **WF-1**: `rescheduleViewing` — before it, a time change meant cancel +
  recreate, severing history and polluting the cancellation stats the nudges
  and dashboard read. Scheduled-only, agent/admin, **refused once a slip is
  signed** (the slip evidences attendance at the printed time; a new time is
  a new viewing), clears the day-route stamp when the Cyprus day changes —
  BACKLOG's own stated requirement for this feature, which also anticipated
  it (`checkViewingConflicts` has taken `excludeId` since T4.1). Evented
  `rescheduled {from,to}` with its own renderer line — NOT `status_changed`,
  whose renderer prints raw strings and would show ISO timestamps.

  **WF-6**: the conflict check now sweeps three diaries — agent, property,
  buyer — labelling each hit's reason. Two agents booking the same property
  at overlapping times was never flagged. Still advisory (T4.1's constraint:
  the create action never blocks); the calendar header's clash count stays
  agent-only by scope, stated in the commit so it reads as a choice.

  **WF-7 (0075)**: a no_show viewing mints a next-day `viewing_no_show`
  rebooking task — the buyer most in need of a call was the one buyer who
  generated nothing. Two arms INSIDE the existing 03:15 sweep, deliberately
  not a ninth cron job (0074 pins the job count in three places for no
  operational gain here). One-shot key, the 0053 rationale (no_show is
  terminal); a later non-cancelled viewing for the same contact+property
  supersedes with reason `viewing_rebooked` — stating only what the
  predicate proved (the 0052 lesson); never minted when the rebooking
  already exists, so no task opens pre-closed. RLS test 51 pins all four
  behaviours.

  **ICS-1**: per-viewing "Add to calendar (.ics)" — pure string generation,
  UTC-basis stamps, stable UID + METHOD:PUBLISH so a reschedule REPLACES
  the entry on re-import. The repo's first dynamic-segment route handler;
  RLS scopes the read; no export event (derived data — the
  getSlipDownloadUrl precedent; logListExport stays reserved for bulk
  lists). A file download, not calendar sync — doc 01 §0.2's Phase-2/3
  deferral is untouched.

- **2026-08-30 · T-group1-close (migration 0074) — the audit's critical tier
  is closed: the sweeps get a witness, accounts get recovery paths, the
  restore pack catches up.** Audit REL-03 + SEC-03 + REL-04, the last three
  Group-1 items.

  **REL-03 — `cron_health()` returns FACTS, the TS layer owns VERDICTS.**
  Eight pg_cron jobs run the desk's nights and nothing read
  `cron.job_run_details`; a stopped scheduler (the KNOWN post-restore state)
  or a persistently failing job was invisible until its work silently didn't
  happen. The split is deliberate: SQL reports (job, schedule, active, last
  run, last SUCCESS) and `lib/services/cron-health.ts` decides health with
  per-schedule allowances — 26h nightly, 8d for the Sunday full walk, 32d
  for the monthly partition job, derived from the cron expression's shape —
  because one flat threshold either false-alarms the quiet jobs weekly or
  leaves the nightly ones un-alarmed for days, and either teaches the admin
  to ignore the panel. The function is service_role-only (the
  anon-default-EXECUTE hazard has shipped twice; RLS test 50 pins the grant
  surface) and the admin dashboard renders the verdict through the admin
  client. The reports chain badge separately gains a STALE state: an OK
  older than 48h goes amber — a green badge with a three-day-old date is a
  lie of omission. FAILING stays red; stale never downgrades it.

  **SEC-03 — the two recovery paths that didn't exist.** Change password on
  /security (until now the only way off the invite-time temp password was
  asking an admin for another one — which the admin then also knew), gated
  exactly like unenrollMfa: a factor-holding account needs an aal2 session,
  so a stolen password can never rotate itself into ownership. Max 72 chars
  because bcrypt truncates there silently. And admin-side **Reset 2FA** on
  Settings → Users — the lockout escape for a lost phone, since self-unenrol
  requires the very phone that's lost. Self-target refused (own removal must
  stay behind the aal2 gate); RLS-scoped existence check before any
  service-role call (the setUserActive lesson); factors deleted via the
  admin API per lib/testing/mfa.ts's clearFactors precedent; evented as
  `mfa_reset`; the dialog tells the admin to verify the request in person
  or on a call THEY placed. docs/10 gains the full lockout runbook,
  including the solo-admin escape through the Supabase dashboard.

  **REL-04 — the restore-verification pack was still proving the 0043
  database.** `verify-restore.sql` checked 13 row-counts, 13 function grants
  and 3 cron jobs (the 26-table list belonged to export.mjs) against a
  database that now has 36 durable tables, 46 functions and 8 jobs
  [figures corrected 2026-09-01 — the original entry overstated the old
  pack's coverage, which understated how much this fix mattered] — a restore could have lost reservations wholesale
  and still stamped "verified". Regenerated FROM the migration-built local
  DB at 0073 with the generation queries kept in the file so the next drift
  is a re-run, not an archaeology dig; counts extended (+8 durable tables;
  the two self-pruning rate-limit tables deliberately excluded);
  `export.mjs` TABLES 26 → 36; baseline refreshed from hosted.

- **2026-08-30 · T-media-import — the ~4.5 MB upload ceiling MEASURED, the
  browser now downscales, and the bulk photo importer ships.** Audit
  REL-05 + REL-06, the last two blockers on onboarding the real portfolio.

  **REL-05 settled empirically, not from docs**: unauthenticated POSTs to
  production (the body must reach the function regardless of auth) — 3 MB →
  200, 5/8/20 MB → **413** at the platform. So the server action's 20 MB
  promise was undeliverable; a phone photo would have failed with an opaque
  413 that reads as a code fault, in production only. Two-part fix, both
  costless to what any surface renders (renditions cap at 1600 px):
  `downscaleForUpload` re-encodes oversized photos in the browser at 2000 px
  (decision logic pure and unit-pinned, incl. that a 9 MB PDF is NOT
  laundered into a fake JPEG), and the media tab now submits ONE FILE PER
  REQUEST with per-file progress — the ceiling is on the whole body, and a
  batch of downscaled photos could crest it together. The stored "original"
  for UI uploads is now the downscaled file; true camera originals travel
  through the importer, which never meets the ceiling. The measured numbers
  live beside MAX_UPLOAD_BYTES so nobody re-derives them from theory.

  **REL-06: `scripts/import/media.mts`** completes doc 09's `photo_folder`
  column using the app's REAL pipeline via relative imports (the
  recompute-scores.mts precedent — media.ts and quality-score.ts have no
  runtime alias imports): EXIF strip, three renditions, watermark by
  visibility, original to the private bucket, a `media_uploaded` event per
  photo (actor null, `source: import_script` — service role bypasses the
  0071 self-attribution policy by design, like the sweeps), quality
  recompute per property. Natural filename sort (photo2 before photo10),
  first photo becomes cover only when none exists, **idempotent by
  default** — a property with photos is skipped so re-running an onboarding
  batch cannot double a gallery; `--append` opts in. Proven end-to-end
  against the local stack: dry-run, live (2 generated images → rows with
  correct sort/cover/dimensions, renditions present, events written, score
  27 → 45), and a re-run that skipped. Buffers go to storage-js raw — the
  UTF-8 corruption binaryBody() guards against is Vercel-runtime behaviour,
  per that helper's own header. `import-media/` is git-ignored: this repo
  is PUBLIC and must never carry client photos.

- **2026-08-29 · T-feed-media (migration 0073) — the public feed carries
  photos, and `published_at` is real.** Audit FEED-1 + DB-02, the two halves
  of "the feed can actually power the marketing site".

  **`images` is the 35th allowlisted column**: a jsonb array, cover first
  then sort order, one `{thumb, card, full, alt, watermarked}` object per
  photo whose rendition pipeline FINISHED — a half-processed photo is
  withheld, floor plans and virtual tours stay internal until deliberately
  wired (audit MEDIA-K). SQL returns bucket-relative paths because it does
  not know the project URL; the route absolutizes them
  (`absolutizeListingImages`, unit-pinned to be double-slash-proof and to
  pass a pre-0073 row through untouched mid-rollout). The migration greps
  its own compiled body to prove the EXIF-bearing original's column is never
  referenced — the 0041 substring-check idiom, which is why that column name
  appears only in the header and the assertion block.

  **`published_at` semantics, decided here**: stamped by `saveProperty` on
  EVERY transition into public (a relisting after months away is genuinely
  news again), never cleared on unpublish, so the column also answers "when
  was this last public". Placed at the end of the publish-gate block, so a
  refused publish stamps nothing and the diff logger records the stamp in
  the update event for free. Backfill prefers the evented visibility flip
  (`payload.changed.visibility.to = 'public'`), falls back to `updated_at`,
  and the migration hard-aborts if any public row is left unstamped.

  **The ETag had a real hole the moment media joined the feed**: it hashed
  (count | max updated_at) of LISTINGS, and no media mutation touches
  `properties.updated_at` — a site would cache a stale gallery until some
  unrelated edit. It now folds in a fingerprint (media id + sort + cover per
  public listing), so add, remove, reorder and re-cover all move it.

- **2026-08-29 · T-sec-audit (migrations 0071/0072) — events name their
  author; KYC contact documents go admin-only.** Audit SEC-01/SEC-02.

  **0071:** the events INSERT policy checked only org membership, so any aal2
  staff session could append rows naming another user — or null, which
  renders as "system". The chain proves nothing was edited; it never proved a
  row was written by the person it names, and that attribution is the
  product's stated USP. The policy now requires `actor_id = auth.uid()`.
  **Compatibility was enumerated, not assumed**, before tightening: every
  authenticated writer (logEvent call sites, move_deal_to_stage, add/reorder
  stage, the price-history and supersede triggers) already writes
  `auth.uid()`; every null-actor writer is either EXECUTE-revoked from
  `authenticated` (the sweeps, 0007/0020/0025) or SECURITY DEFINER
  (record_key_movement, resolve_share_link) or runs as cron/service_role —
  all bypass RLS. `logEvent`'s optional `actorId` defaulting to null was a
  standing footgun; the DB now turns a forgotten actor into a loud insert
  error instead of a silent "system" row. RLS test 47 pins all three
  directions (forged → refused, null-from-staff → refused, self → works,
  service-role system rows → unaffected).

  **0072:** contact KYC uploads (id_document, proof_of_address,
  source_of_funds) never set a visibility, so every passport scan defaulted
  to org-wide 'internal' while the stricter 'admin_only' tier sat unused
  outside evidence PDFs. Three layers now: the upload sets
  `contactDocVisibility(docType)` (unit-pinned as the matched pair of the
  SQL), a backfill flips any existing rows, and a CHECK refuses an internal
  KYC contact row from ANY path — service_role bypasses RLS but not a
  constraint. RLS test 48 pins agent/LM = 0 rows, admin = 1, and the CHECK
  refusing even service_role. **Deploy order is INVERTED for 0072 and stated
  in the file**: pre-0072 code inserts KYC docs without a visibility, so
  applying the CHECK before the deploy would refuse every KYC upload in the
  gap — code first, then the migration (0055/0057 rule). 0071 is ordinary
  additive-first; the two ship with opposite orders on purpose.

  **A local bookkeeping find along the way:** the local DB had 0065's CONTENT
  (the reporting functions) but not its version row — applied by hand during
  C4 with the local insert missed — which made `migration up` refuse
  everything after it. Row inserted; `non_filename_versions` stays a
  hosted-side invariant, but local drift of the same table is what this
  looked like from the inside. 946 unit / 75 RLS after (both measured; +4
  unit are the visibility mapping's pins, +2 RLS are tests 47/48).

- **2026-08-29 · T-offsite — the off-site leg automated, the dead-man's switch
  plumbed, and the first partitioned-events capture caught red.** Audit
  REL-01/REL-02, executed the same day.

  **Destination decision (operator, 2026-08-29): OneDrive.** §3.3's objection
  — sync propagates deletion/encryption — was put to the operator explicitly
  alongside the alternatives (rclone to a new cloud account; USB-only), and
  OneDrive was chosen as the only leg automatable that night with zero new
  credentials. Mitigations recorded in §3.3: dated write-once filenames,
  destination re-hash after every copy, retention only by the dated pattern,
  OneDrive versioning as backstop, USB kept as the offline second copy. The
  historical 18-set archive went off-machine too, renamed
  `gnk-backups-historical-…` so retention can never prune it (it is NOT a
  strict subset — it holds sets `--keep 14` has since pruned locally).

  **The first capture after 0063 failed, and that failure was the system
  working.** Partitioning moved the events rows into `events_parts`, which
  `--schema public` never dumps — the data dump contained ZERO events and the
  verify refused to promote (missing COPY + 0-vs-122 count mismatch).
  `capture.mjs` now dumps `public,events_parts` in BOTH passes and counts
  events across partition COPY blocks (122 across 15 partitions = live 122 on
  the fixed run). Every nightly from 08-30 would otherwise have been red — or
  worse, green-and-empty without the count cross-check. The audit missed this
  (REL-04 caught the verify-pack drift, not the capture drift); only running
  the thing found it.

  **Two smaller traps, both measured:** Git-for-Windows' GNU tar parses the
  colon in `C:\…` as a remote-host spec when it appears in `-f` (fixed with a
  relative `-f` + `cwd`); and `%ERRORLEVEL%` inside a parenthesised cmd block
  expands at parse time, so `run-backup.cmd` uses a `goto` shape for the
  offsite exit code.

  **The task no longer requires a logged-on user:** S4U principal +
  StartWhenAvailable + WakeToRun + runs-on-battery (it was "Interactive only"
  AND battery-blocked — the 08-29 03:45 run was silently skipped). Proven by
  a real scheduler-context run: exit=0 through capture → offsite → notify.
  `notify.mjs` (dead-man ping) always exits 0 — telemetry must never fail a
  backup night — and stayed UNARMED until 2026-08-30, logging a
  SKIPPED line nightly so the gap stayed visible — then the operator signed
  up (the one step account-creation rules reserve for a human) and the check
  went live the same hour: Period 1 day, Grace 2h, email ON, the whole cycle
  proven with real pings — up on rc=0, DOWN plus a real alert email on
  /fail, recovery email on the next rc=0.

- **2026-08-29 · T-tax-2026 (migration 0070) — stamp duty abolished, CGT
  exemptions tripled, VAT area-cliff figure corrected.** The 2026-08-29 audit
  checked the two never-verified `cyprus_config` rows against the Official
  Gazette and both were wrong, because the 31.12.2025 reform package (in force
  1.1.2026) changed the law under them.

  **Stamp duty (Law 239(I)/2025, cylaw.org/nomoi/arith/2025_1_239.pdf):** the
  Stamp Duty Laws 1963–2024 are repealed for documents signed on or after
  2026-01-01 — the calculator had been over-quoting every buyer since January
  (€377.50 on a €300k contract, up to €20,000). The bands are KEPT, because
  they remain the statutory scale for contracts signed on or before
  2025-12-31; 0070 adds an `abolished` block that `parseStampDutyConfig` now
  understands and the panel renders as a notice instead of a figure. A
  MALFORMED abolition block fails the whole config rather than being ignored —
  silently dropping it would quote a repealed tax, the exact failure the field
  exists to prevent. Either deploy order is safe: old code ignores the new
  key; new code without the row falls back to computing.

  **CGT (Law 242(I)/2025 ss.3, 6, 9, same gazette):** lifetime exemptions
  raised €17,086/€25,629/€85,430 → €30,000/€50,000/€150,000, primary-residence
  tax charged only on the gain EXCEEDING €150,000, rate 20% unchanged. No code
  computes from this row (zero references outside the seed) — it misinformed
  rather than miscalculated, but it misinformed in euros, in the seller's
  disfavour. s.6's express treatment of antiparoxi as a CGT exchange (5-year
  completion condition) is recorded in the row's note because the desk runs an
  antiparoxi pipeline.

  **VAT area-cliff cost (audit finding CALC-VAT-1, `lib/services/vat.ts`):**
  `reliefLost` substituted the €475,000 value cap as the price for BOTH cliff
  kinds, so the area-cliff figure priced a hypothetical no eligible dwelling
  could occupy — €45,262 displayed at 191 m²/€300,000 where the true
  under-vs-over delta is €28,736.84 (~57% overstated, in a negotiation-facing
  panel). The hypothetical now sits at the cap actually crossed (value cliff:
  cap price × real area; area cliff: real price × cap area; both crossed: both
  caps). The new test pins the area-cliff cost to the exact difference between
  the 190 m² and 191 m² bills at the same price — the pre-fix formula cannot
  pass it. Unit count 936 → 942.

  0070 follows the 0056/0058 idiom with ONE measured departure from its
  `verified_at is null` guard: hosted's `stamp_duty` row turned out to carry
  **verified_at 2026-07-23** — a Settings verification of the pre-2026 bands
  made seven months AFTER the statute it verified was repealed (bands
  byte-equal to the seed; only the stamp and note differ). The calculator's
  freshness line had been lending "last verified 23 Jul 2026" authority to an
  abolished tax — a sharper instance of the §0 lesson that a dated "verified"
  claim is only as good as the source it was checked against. The guard
  therefore admits any verification dated BEFORE 2026-08-29 (that state is
  what this migration corrects), is idempotent on its own content, asserts
  the bands/rate did NOT move (a migration that shifted a tax rate while
  claiming to verify one would be the worst outcome), and still aborts loudly
  on a verification dated on/after 2026-08-29 — someone re-verified after the
  gazette check and a human must reconcile. Applied to hosted before the
  merge, per the additive rule.

  **CI caught the second-order break, which is the system working:** the e2e
  calculators spec pinned the old ON-SCREEN stamp figures (€507.50 at €300k,
  the €20,000 cap), and the branch run failed with three 240s locator
  timeouts once a fresh-with-0070 database rendered the notice instead. The
  spec now pins the abolition notice and the absence of any stamp total at
  any price; the arithmetic pins stay in the unit suite, where they still
  guard the pre-2026 scale.

- **2026-08-29 · T-stage-ids (migration 0067) + doc 03 reframed** — the two
  follow-ons Phase C left, closed together.

  **`stage_changed` now records stage ids.** `move_deal_to_stage` (0011) logged
  only NAMES, so `report_stage_conversion` (0065) grouped its funnel on a
  mutable string — renaming a stage split that stage's history in two at the
  rename, silently, each spelling holding half the traffic. The payload gains
  `from_stage_id` / `to_stage_id`; the NAMES STAY, because
  `lib/services/events.ts` renders them, RLS test 15 asserts `payload.to` by
  value, and every pre-0067 event has only names. The hash chain is unaffected
  for the same reason 0061 was: the hash covers `payload::text`, so new rows
  hash their new shape and existing rows are untouched.

  **The reader was changed in the SAME migration, and that is the point.** A
  payload field nothing consumes is not an improvement, it is clutter that looks
  like one. The report resolves an id to the stage's CURRENT name and falls back
  to the recorded name when there is none — so new events follow a rename, old
  events behave exactly as before, and a deleted stage falls back to the name
  recorded at the time, which is then all that describes it. It also reports
  `moves_with_ids` against `moves_total`, so a reader can see how rename-proof
  the answer is instead of assuming.

  **A false negative wearing a red X**, worth remembering. The first version of
  test 45 hardcoded `sort_order`, which is UNIQUE per (org, deal_type): it
  passed once and then collided forever against a long-lived local stack. The
  mutation run exposed it — the test failed on a duplicate key rather than on
  the assertion, so it "failed" for the wrong reason and would have "proved" the
  mutation was caught when it had not been. **A mutation test only counts if you
  read WHY it failed.** sort_order is now derived from the existing maximum, and
  the suite passes twice in a row.

  **`docs/03_DATABASE_SCHEMA.sql` reframed, and its sync rule dropped.**
  `CLAUDE.md` called it "Authoritative Phase 1 DDL" and instructed "fix it in
  the migration AND update doc 03 in the same commit"; README and doc 08 T0.3
  said the same. Measured rather than assumed to be a Phase C oversight: the
  rule was honoured through 0023 (0004, 0006, 0011, 0016 and 0023 are all in the
  file) and then stopped, and the file now lacks `admin_dashboard_stats` (0018),
  `mfa_satisfied` (0029), `buyer_requirements` (0043), `reservations` (0044),
  `task_kinds` (0049), `reservation_installments` (0050), `location_approx`
  (0054), `hash_version` (0061), `events_chain_checkpoint` (0062), the
  partitioning of `events` (0063) and `public_listings` (0066).

  **Dropped rather than obeyed, and NOT replaced by a dump.** Syncing forty
  migrations by hand would fix the symptom and re-arm the trap — HANDOFF §0
  already says what to do with a second copy: "a corrected copy is just a copy
  that goes stale later. When you find one, delete it and point at the owner. Do
  not correct it in place." Replacing it with `pg_dump` output would have
  destroyed the design COMMENTARY, which is the file's actual value, and added a
  third claimant to "the schema". It keeps its content and gains a banner
  stating what it is, what it is not, and where the current schema lives:
  `supabase/migrations/` (the authority), a `supabase db dump` snapshot (HANDOFF
  already names one as the schema of record) and
  `lib/supabase/database.types.ts` (generated, and what TypeScript believes).
  Changed in all four places the claim was made, with doc 08's line struck
  through rather than deleted so a reader who remembers the rule learns it was
  retired and why.

- **2026-08-29 · T-c3 (public listing API — migration 0066,
  /api/public/listings)** — Phase C item C3, and the only one that opens a new
  public attack surface.

  **THE BRIEF'S LOAD-BEARING PREMISE IS FALSE.** §4 says "a listing below score
  70 cannot be made public internally (PUBLISH_THRESHOLD), so it must not be
  reachable externally either. One rule, enforced twice, defined once." It can:
  `lib/actions/properties.ts` lets an ADMIN publish below the threshold
  deliberately, writing a `publish_override` audit event, and `properties`
  carries no constraint tying `visibility` to `quality_score` — the gate is
  application-level only. So re-checking the score in the API would not be one
  rule enforced twice; it would be a SECOND rule that silently undoes an audited
  decision, and that also drops any listing whose score later decayed, with
  nobody deciding and nothing telling the marketing site why a listing vanished.

  **OPERATOR DECISION:** the feed is `visibility = 'public' AND status =
  'available'`. The internal publish decision is the single source of truth —
  the score gates the TRANSITION, the column records the OUTCOME.
  `published_below_threshold()` reports published listings scoring under 70 so
  that drift is visible rather than silent, and is staff-only because it
  exposes scores the feed withholds.

  **AN ALLOWLIST, NOT A DENYLIST, AND THAT IS THE WHOLE MECHANISM.**
  `properties` has 69 columns; the brief names five to withhold. A denylist
  cannot satisfy the brief's own acceptance criterion ("a test asserts the
  withheld column list by name, so adding a column to `properties` cannot
  silently publish it") — a new column is published by default under a
  denylist. The feed enumerates 34 columns in SQL. Withheld beyond the brief's
  five: `address`, `postal_code`, the exact `location` point (0054 added
  `location_approx` precisely because a coordinate can be an address),
  `unit_number`, `block`, `quality_score`, `assigned_agent_id`, `created_by`,
  `org_id`, `parent_id`, `encumbrances_notes`, `constraints_notes`,
  `amenities_notes`, `sold_at`, `share_of_land`, `permit_status`,
  `inherited_fields`. RLS test 41 asserts the withheld names AND that no
  withheld VALUE appears under any key, so aliasing one into the feed under a
  different name fails too.

  **A SECURITY DEFINER FUNCTION, NOT THE VIEW §4 NAMES.** Three options weighed
  against what this database does. (1) A plain view granted to `anon` filters
  rows only by its own WHERE clause — a non-`security_invoker` view runs with
  the owner's row security, i.e. bypassed — which is the `mandates_safe`
  pattern the advisor already flags as an ERROR; a second one makes the advisor
  harder to read for no gain. (2) A `security_invoker` view plus an `anon`
  SELECT policy on `properties` makes `/rest/v1/properties` itself public with
  PostgREST's whole filter and embed surface attached, when the brief asks for
  "one published, cacheable, read-only collection". (3) An anon-executable
  SECURITY DEFINER function — which is the precedent the brief itself cites,
  `resolve_share_link`. Option 3: one door, the allowlist IS the select list,
  and it costs WARNs beside its siblings rather than a new ERROR.

  **A BUG THAT WOULD HAVE SHIPPED, found by calling the endpoint.**
  `Number(null)` is `0`, not `NaN` — finite and non-negative — so the guard
  `if (!Number.isFinite(n) || n < 0) return fallback` never fired for an ABSENT
  parameter, and `GET /api/public/listings?org=gnk`, the plainest call a
  marketing site can make, answered 200 with an EMPTY feed. No type checker
  could catch it and no SQL test would have: the SQL was correct. Extracted to
  `lib/services/public-listings.ts` with seven unit tests.

  **Other decisions worth carrying.** Rate limiting reuses the 0023 idiom with
  its OWN counter table — sharing `share_link_attempts` would let marketing-site
  polling exhaust a buyer's proposal-link budget, two unrelated limits coupled
  through one counter. The ETag hashes the row COUNT as well as
  `max(updated_at)`, because unpublishing lowers the count without moving the
  maximum and a max()-only validator would keep serving a listing that is no
  longer for sale; the limit and offset are in the ETag too, or a cache could
  answer page 2 with page 1. `/api/public/` is a third public prefix in
  `proxy.ts` rather than a widening of `/p/`, so a reader of the auth gate can
  see every public surface in one condition. `callerIpHash` was hoisted out of
  `app/p/[token]/page.tsx` rather than copied — two hashes that could disagree
  would silently stop limiting anything.

  **`mfa-enforcement.test.ts` caught `public_listing_attempts` missing
  `require_aal2`** on the first run. Redundant in practice (the table already
  denies everyone) but the invariant is "every RLS-enabled public table carries
  it", and an invariant with one reasonable-looking exception is not one.

  **Verified against production, unauthenticated:** 200 with
  `Cache-Control: public, max-age=60` and a weak ETag, 304 on `If-None-Match`,
  204 on the OPTIONS preflight, 400 with no `org`, an empty feed for an unknown
  org rather than an error or another org's data, and `/dashboard`,
  `/properties`, `/reports/performance` and `/api/public/../../dashboard` all
  still 307 to login. The live feed returns `count: 0` because nothing in
  production is published — the surface is real and currently empty.

- **2026-08-29 · T-c4 (reporting engine — migration 0065, /reports/performance)**
  — Phase C item C4. Five SECURITY INVOKER aggregates (agent performance,
  source ROI, time to close, stage conversion, price reductions), a citation, a
  page and a CSV export per report. `admin_dashboard_stats` (0018) is the
  pattern throughout: group-bys in SQL, window bounds passed IN from
  `lib/utils/tz.ts` rather than re-derived, ids returned and names joined by the
  app.

  **NO MATERIALISED VIEW, AND THE BRIEF UNDERSTATED WHY.** `docs/PHASE_C_BRIEF.md`
  §3 calls C4 "a materialised-view problem" and warns an MV over an RLS table is
  computed once for everyone. Measured before writing a line — two rows, one per
  org, read from a session scoped to org 1111:

      MV read directly                    -> BOTH rows (100 and 999)
      MV read via a SECURITY INVOKER fn   -> BOTH rows (100 and 999)
      the same aggregate computed live    -> one row (100)

  And the obvious repair does not exist:

      alter materialized view probe_mv enable row level security;
      ERROR:  ALTER action ENABLE ROW SECURITY cannot be performed on relation
              "probe_mv" (42809)

  So an MV cannot be made safe by policy AT ALL — only by never granting it and
  filtering in a reading wrapper. At 120 events that trade buys nothing, so
  there is no MV. If a query is ever measurably slow, one can be introduced
  behind these signatures without a caller moving.

  **THE FIRST DRAFT OF STAGE CONVERSION WOULD HAVE RETURNED ZEROS FOREVER**, and
  the reason generalises: it read `payload->>'from_stage_id'`, which does not
  exist. Checking the writer rather than assuming its shape,
  `move_deal_to_stage` (0011) logs
  `jsonb_build_object('from', coalesce(v_from_name, v_deal.stage_id::text), 'to', v_to.name)`
  — NAMES. So the report joins on a mutable string, and DECLARES it in its own
  output (`stage_key: "name"`) rather than hiding it: renaming a stage splits
  its history at the rename. Fixing that properly means adding ids to a guarded
  write path's payload, which is a one-line additive change but not a reporting
  migration's business. Second finding from the same check: won and lost are
  NOT `stage_changed` — they are separate event types from
  `lib/actions/deals.ts` whose payloads carry the DESTINATION stage and not the
  one left — so outcomes are counted but deliberately not attributed to a source
  stage. A funnel that guessed would be worse than one that says it cannot.

  **WHAT THE CITATION PROVES, STATED PRECISELY.** The brief's upgrade is to make
  reports citable so a dispute can re-derive a figure and prove the inputs had
  not changed. Half of that is achievable and half is not, and overclaiming in
  an evidence product would be the worst available outcome. ACHIEVED: the report
  records the VERIFIED `(last_id, last_hash)` of the org's chain from 0062 — a
  point some walk actually proved, not a bare high-water mark. NOT ACHIEVED:
  most metrics read MUTABLE entity tables (`deals.expected_value`,
  `leads.source`, `viewings.status`) which are not hash-chained, so the citation
  cannot prove they were unchanged and a later re-run may legitimately differ.
  Only stage conversion is genuinely re-derivable, and it says so with
  `derived_from: "events"` rather than relying on a comment nobody reads.

  **A BUG 0065's OWN VERIFICATION BLOCK CAUGHT.** `report_citation`'s subqueries
  relied on RLS to narrow `events_chain_checkpoint`, which holds ONE ROW PER
  ORG. Correct in the app; SQLSTATE 21000 "more than one row returned by a
  subquery used as an expression" for anything bypassing RLS — scripts, the test
  suite, an incident. Every subquery is now org-scoped explicitly. A related
  correction to my own test: a `service_role` caller gets 42501, not a citation,
  because `current_org_id()` is authenticated-only (0007) — a caller with no org
  has nothing to be scoped to. That is correct behaviour, and the first version
  of the test asserted otherwise.

  **TESTED AGAINST A FIXTURE WITH KNOWN ANSWERS, not production zeros**, which
  the brief insists on and production (1 property, 1 deal) cannot provide: 3
  leads with 2 answered at 30 and 90 minutes (avg exactly 60), 2 deals won at 10
  and 20 days (avg and median 15), 1 lost, 2 completed viewings and 1 cancelled
  that must not count, two 10% price cuts and a RISE that must be excluded.
  Every figure asserted exactly. The window is March 2024 so the rest of the
  suite cannot mix in, and it is CLEARED first — a fixed window with absolute
  assertions is only correct if it starts empty, and a rerun against a
  long-lived local stack otherwise reads 6 leads where it asserts 3.
  Cross-org isolation is asserted and mutation-tested: flipping one report to
  SECURITY DEFINER makes org B read `{won: 1, leads: 3}` of org A's and the test
  fails. The migration itself refuses to apply if any `report_*` is DEFINER or
  executable by anon.

  **The page and export were verified against a running app**, not assumed: all
  five exports return 200 `text/csv`, an unknown `report` param is rejected 400,
  each wrote its `exported` audit event with list, count and window, and every
  rendered figure was recomputed by hand. Two pieces of my own slop removed on
  review — a variable that existed only to be rendered into a meaningless
  `sr-only` span, and an unused `getCurrentProfile` call — plus "1 deals" turned
  into a proper ICU plural. `lib/services/messages.test.ts` caught the new
  `{id}`, `{won}` and `{lost}` placeholders missing from its superset, in all
  three locales; the guard was doing its job and was extended rather than
  worked around.

- **2026-08-28 · T-c5 (event log: diagnostics, hash_version, checkpoints,
  partitioning — migrations 0060–0064)** — Phase C item C5, built in the four
  steps `docs/PHASE_C_BRIEF.md` §2 sets out. What is worth carrying forward is
  mostly what was MEASURED, because five things turned out differently from the
  brief or from the obvious guess.

  **0060 — `verify_events_chain` names the failing row.** It returned a bare
  boolean, so `false` told you the chain was broken and nothing about where, at
  exactly the moment someone is under pressure. Now an overload
  `verify_events_chain(p_org, p_from_id)` returns `(ok, failed_id, reason)` and
  the one-argument boolean survives as a wrapper, so the four callers
  (`evidence.ts`, `run_chain_checks()`, 13 RLS assertions, the demo scripts) did
  not move. **`p_from_id` deliberately has NO default, and the brief's
  `default null` is a latent outage**: with the wrapper present Postgres accepts
  both CREATEs and then fails at CALL time with `function is not unique`, so the
  migration would have applied green and broken the 03:30 cron. Overloading was
  probed first on three axes (SQL resolution, `supabase gen types`, PostgREST
  argument-name resolution) because nothing in this schema was overloaded before.
  It also fixed an off-by-one the return type made visible: the old body used
  `hash <> …`, so a NULL hash made the branch NULL and the failure surfaced one
  row late — measured, the old body blamed 8 for a corruption at 7.

  **0061 — `hash_version`, and the timezone landmine.** Reproduced before
  writing anything: the SAME INTACT DATA verified under UTC and FAILED under
  `Asia/Nicosia` and `America/New_York`. Nicosia is this desk's own timezone, so
  this was not exotic. `occurred_at::text` renders through the session `TimeZone`
  GUC and is the ONLY such term — `payload::text` (floats, numerics, unicode),
  and the three uuid casts are byte-stable under DateStyle, lc_numeric,
  extra_float_digits and TimeZone. Two fixes: v1 rows keep their formula forever
  (their hashes ARE the evidence), v2 hashes ISO-8601 UTC with a `v2|` domain
  separator, and **`verify_events_chain` now pins `TimeZone = 'UTC'`, which
  fixes the symptom for the v1 rows too**. ISO-8601 rather than the brief's
  epoch microseconds because the hash is evidence and the material should be
  legible to a third party re-deriving it years later — RLS test 12c proves that
  claim by re-deriving the hash in Node from the row alone. `trg_events_hash`
  deliberately does NOT pin UTC, so the migration's own probe (a v2 row written
  under UTC+14, verified under UTC, rolled back) is not vacuous; it runs on
  every CI database. Also fixed a gap this change would otherwise have opened:
  `scripts/backup/export-events.sql` has a HARDCODED column list, and without
  `hash_version` every restored row would take the default of 1 — v2 evidence
  checked with the v1 formula, i.e. the same failure through the back door.
  Measured both ways on a 492-row round trip.

  **0062 — checkpoints, and the thing incremental verification cannot do.** A
  resumed walk does NOT re-prove the prefix: with a tamper at id 8 and the anchor
  at 647, the incremental pass returns `ok` and only the full walk finds it. That
  is inherent — each row's hash covers the STORED hash of its predecessor, so
  editing a payload and leaving `hash` alone does not propagate. So `last_hash`
  is a trust anchor that is re-checked on every resume (with a WARNING and a
  fallback to a full walk if it has moved, because `run_chain_checks` records
  only `ok` and would otherwise swallow the signal); the resume starts AT the
  anchor so the anchor's own payload is recomputed; `full_walk_at` records how
  stale the prefix proof is and an incremental pass must never restamp it; and a
  FAILED walk does not advance the checkpoint. Nightly 03:30 is incremental,
  full walk Sundays 03:35. `run_chain_checks_full()` is a separate NAME rather
  than a defaulted argument, for the same reason as 0060.

  **0063/0064 — partitioning.** Monthly RANGE on `occurred_at`, PK
  `(id, occurred_at)`. The safety net is a chain fingerprint —
  `md5(string_agg(hash order by id))` before and after — not a row count, because
  the C6 drill produced an org that read `true` at source and `false` after a
  restore with identical counts. The rollback copy was kept as
  `events_pre_partition` until the deploy was confirmed, then dropped by 0064,
  which refuses unless the fingerprint is reproduced exactly (proven by feeding
  it a tampered copy).

  **Partitions live in `events_parts`, not `public`, and the reason is not the
  one I first wrote.** `pg_default_acl` grants `anon=Dxtm` and
  `authenticated=Dxtm` on every table `postgres` creates in `public`; `D` is
  TRUNCATE, and RLS does not gate TRUNCATE — so a partition in `public` would
  hand anon the ability to truncate a month of the audit log, monthly, forever.
  The first draft ALSO claimed PostgREST would expose them. **It does not**: a
  partition moved into `public` and explicitly granted `select` to `anon` is
  still refused with `PGRST205` after a full restart, because PostgREST excludes
  partitions from its schema cache. The RLS test that asserted "a partition is
  unreachable over the API" was therefore vacuous — it passed whether or not the
  partition was protected — and was replaced with a check on the GRANT, which is
  the real exposure. Three further things were measured because a partition
  inherits none of the parent's protection: the parent's policies DO cover rows
  in partitions; a policy on a partition does NOT govern parent-routed access
  (the 64-test suite is green with `using (false)` on every partition, which is
  what makes the explicit `deny_direct_access` safe and keeps `get_advisors` at
  its 21 pre-existing lints instead of gaining one per month); and a DEFAULT
  partition turns a missing month from an outage into a notice — events are
  written on the same code path as every mutation, so a routing failure would
  fail the user's save, not just the log.

  **What the new PK gives up, which the brief does not mention:** `id` is no
  longer unique on its own, and `verify_events_chain` walks by `id`. Nothing can
  produce a duplicate in practice (`generated always`, and PostgREST never sends
  `OVERRIDING SYSTEM VALUE`), so `events_partition_health()` detects it rather
  than the schema preventing it. Monotonicity is asserted at migration time and
  reported ongoing, but deliberately NOT enforced: a trigger rejecting a
  back-dated `occurred_at` would refuse a legitimate write, and the chain still
  verifies when they diverge because it orders by id only. The brief's claim that
  the instalment and reservation sweeps write computed timestamps into
  `occurred_at` is wrong — every writer takes `default now()`; the computed dates
  go in the payload and in `tasks.due_at`.

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

> **Superseded 2026-08-08 (`T-client-dead-code`).** The file was deleted, and the
> property stopped depending on nobody importing it: `security.spec.ts` now
> asserts that no Supabase key of any format reaches the browser, verified with a
> negative control. Read the paragraph above as the reasoning that led there, not
> as current state.

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

**Outcome — working, verified 2026-08-03 on `dpl_2MoMJrB…`.** `connect-src`
carries `https://o4511848269479936.ingest.de.sentry.io`; the browser SDK
initialises (`window.__SENTRY__`, v10.65.0), which also proves the DSN parses;
and a probe report to `/api/csp-report` returned 204 with the runtime log showing
the handler processing it — the same line passed to `Sentry.captureMessage`.

The root cause was the per-environment trap: the variable existed, but for
**Preview** only. Every check after that was corrected still read the old state,
because `NEXT_PUBLIC_*` is compiled in and no new build had run — including after
the Sentry integration was installed, which provisions variables but triggers no
deployment. Six deployments went into rediscovering that "check production
immediately" is never valid for a build-time value.

With this, **C1's durable sink exists**: CSP reports now leave stdout (~1h
retention) and reach a store that outlives it, which is what "let report-only run
for a while and then decide whether to enforce" always required.

**Confirmed end to end 2026-08-03:** the operator sees the probe message in
Sentry. That closes the last unproven link — the SERVER-side `SENTRY_DSN`, which
is the half C1 actually depends on, since `/api/csp-report` runs server-side.
**C1 is complete: the policy has a durable sink, and promoting it from
Report-Only to enforced is now a decision backed by evidence rather than a
guess.** It still wants real traffic first: the accumulated violations are the
input to that decision, and there is no rush to enforce before they exist.

## 2026-08-04 · T-share-links-eval — a client component pulled `node:crypto` into the browser

Adding Playwright to CI (`T-e2e-ci`) found a real defect on its first run:
`/share-links` reported `script-src / blockedURI: "eval"`, meaning the Proposals
page **would have broken the day the CSP was enforced**.

**It was not Zod.** IMPROVEMENTS C1 had recorded exactly this symptom on five
screens in 2026-07-24, traced to Zod 4's JIT validator compiler and fixed with
`z.config({ jitless: true })`, so that was the obvious suspect. Checking the
offending chunk instead of assuming showed **zero Zod fingerprints** — and three
Node polyfills: `vm-browserify` (`Script.prototype.runInThisContext = eval(…)`),
`function-bind` (`Function("binder", …)`) and `is-generator-function`.

**Root cause.** `components/features/share-links/share-links-client.tsx` is a
client component and imported `SHARE_LOCALES`, `daysUntilExpiry`,
`shareLinkState` and the expiry constants from `lib/services/share-links.ts` —
a module whose first line was `import { createHash, randomBytes } from
"node:crypto"`. That single import dragged Node crypto into the browser bundle,
where the bundler polyfills it, and those shims call the `Function` constructor.

**Fix: split the module.** Token minting and hashing moved to
`lib/services/share-links-token.ts`, which opens with `import "server-only"` —
so a repeat is a **build error**, not a silent regression. That is the same
guard `lib/supabase/admin.ts` already uses. The pure constants and helpers stay
in `share-links.ts`, which now carries a header saying it must remain free of
`node:*` imports and why.

Only three non-test call sites needed updating, all server-side
(`lib/actions/share-links.ts`, `app/p/[token]/page.tsx`, and the unit test).

**Why it hid for six days.** B3 shipped 2026-07-29; C1's production-build CSP
sweep ran 2026-07-24, so `/share-links` was never in it. And the violation only
reproduces against a **production build** — `lib/services/csp.ts` deliberately
ships `'unsafe-eval'` under `next dev`, so local runs were clean. It took a CI
job running `next start` to see it at all.

**Verified:** `Proposals reports no CSP violations` failed before the split and
passes after; full desktop suite **168 passed / 4 skipped** on a freshly reset
database against a clean production build; typecheck, lint and 437 unit tests
clean.

**A self-inflicted detour worth recording.** Mid-verification I rebuilt `.next`
while `next start` was still serving, so the second server never bound
(`EADDRINUSE`) and the stale process served a half-replaced build — which
surfaced as a *different* test failing and briefly looked like the fix had broken
the page. HANDOFF §7 already says "do not build while a dev server is running";
it applies to `next start` too. The rebuild then hit `EPERM` on a locked
`.next/static` file (the OneDrive handle issue) and needed a PowerShell
`Remove-Item -Recurse -Force`.

## 2026-08-07 · T-deal-contact — the no-contact nudge could be silenced by a typo

B7's `deal_no_contact` nudge measured silence with `deals.last_activity_at`.
`lib/actions/deals.ts` stamps that column on **every** field change, and
`deals_supersede_nudges` fired on exactly that column — so renaming a deal
closed its open chase-up on the spot and recorded

```json
{"kind": "deal_no_contact", "reason": "deal_contacted_or_closed"}
```

attributed via `auth.uid()` to whoever happened to be editing. The nightly job
then declined to re-mint it, because the 14-day boundary had moved too. **A deal
could be edited every week and never once be chased**, and the event log would
say contact was made each time.

That last part is what makes it more than a scheduling bug. The log asserted
something about the world that nobody had claimed.

**Fix (migration 0025): contact gets its own column.** `last_contact_at` is
written only by `logDealContact` (and by `logConversation` on a converted lead,
where the call genuinely is contact with the buyer). `last_activity_at` is
untouched and still drives the health score's activity decay (doc 02 §C5) — the
two columns answer different questions and both stay true.

Deals with no contact ever logged fall back to `created_at`, so a deal nobody
touches is still chased 14 days after it opens. Existing rows were backfilled
from `last_activity_at`, so nothing lurched the morning this shipped.

**The trigger's `WHEN` clause was the trap, and a test caught it.** Changing the
function to read `last_contact_at` was not enough: 0020's trigger fired on
`last_activity_at or status`, so after the change it would never have fired for
the one event that should close a nudge. The function would have been correct
and the feature still broken — logging contact would have left the chase-up
open. RLS test 27's second half caught it in the same cycle that introduced it,
which is the argument for writing the "and the good path still works" assertion
rather than only the regression one.

Also split the supersede reason: `deal_closed` and `deal_contacted` are now
distinct, where 0020 wrote `deal_contacted_or_closed` for both and so recorded a
closure that may not have happened.

**Verified** by RLS test 27 (edit does not silence; contact does, with the right
reason), the reworked E2E nudge spec (an edit leaves the nudge on the screen the
agent reads, contact removes it), and end to end in the running app: a title
edit through the deal form moved `last_activity_at` to today, left
`last_contact_at` at 20 days ago, and the chase-up stayed open.

## 2026-08-08 · T-csp-reset-proof — taking the verification that disk space had made unaffordable

The 2026-08-02 `T-csp-fixture` entry above ends with **"Verified without a
`db reset`, which is the point"** — the empty-list branch was forced by stubbing
the list lookup to null, because a reset-and-repopulate cycle was too expensive
with disk down to 9.3 GB.

That substitute was sound as far as it went, and it is worth being precise about
what it did not cover. The bug being fixed was defined by a condition the
substitute never entered: *against a freshly reset database both FAILED on run 1
and passed on run 2*. Stubbing proves the seeding branch executes. It does not
prove the spec survives a real first run, which is the only scenario the fix
exists for. The evidence and the claim were one step apart.

Moving the workspace and Docker's disk image to `D:` (see HANDOFF §8) made the
cycle affordable, so it was taken. `supabase db reset` applied all 25 migrations
from scratch — incidentally confirming 0025 builds a fresh database and not just
an incremental patch — leaving `properties=0 contacts=0`. Then **run 1** of
`csp.spec.ts`: **31 passed / 3 skipped**, with `property detail` (11.6s) and
`contact detail` (25.9s) — the exact two that used to fail — green through the
seeding path. `CSP-FIXTURE-%` and `csp-detail-fixture` both back to 0 after
`afterAll`, so the marker sweep works on a real run and not only a forced one.

**The full desktop suite was run locally in the same cycle: 168 passed / 4
skipped in 6.4 minutes** — the first complete local run since the disk-full that
truncated `HANDOFF.md`. It is also the measurement that justifies the move:
`.next` came out at **2.29 GB**, and `C:` never moved off ~22 GB free. That run
is what used to fill the disk.

No code changed here. The entry exists because "verified" meant something weaker
than it read, and the gap was caused by a machine constraint rather than a
judgement about the code — exactly the kind of thing that quietly stays true
forever unless someone goes back once the constraint lifts.

## 2026-08-08 · T-jwt-skew — the retry that was written, tested, and deleted

BACKLOG had carried two options for `JWT issued at future` since 2026-07-19: a
one-shot retry on that PostgREST message, or widening clock-skew tolerance. The
retry was picked, built at the transport layer (`global.fetch` on the server
client, so one change covers all 47 `unwrapRows` call sites rather than the
route where it happened to be seen), given 16 unit tests, and typechecked clean.

Then it was measured against a real PostgREST instead of shipped, and the
measurement killed it. A hand-signed token swept across `iat` offsets is
accepted at +0/+5/+10/+20s and rejected from +31s with `401 PGRST303`. **PostgREST
already has roughly 30 seconds of future-`iat` leeway of its own.**

That single fact inverts the design. The retry assumed a sub-second blip it could
sleep through; in reality anything that gets rejected is >30s ahead, so the
retry would have to sleep 30+ seconds to help. Capped at 2s — the most a page can
absorb — it returns "don't retry" on every real occurrence. The wrapper was
correct, tested, and incapable of ever firing. It was deleted rather than
committed: dead code that looks like a fix is worse than an open backlog item,
because it closes the item in the reader's mind.

**The reason this is written down is the order of operations.** The unit tests
passed because they asserted against my assumption of what PostgREST returns —
a 401 with that message, which is true — and told me nothing about whether the
branch could be reached. Sixteen green tests, a clean typecheck, and a dead
feature. The probe that settled it took one script and two minutes, and it also
handed over the details the next attempt needs: the code is `PGRST303`, no
message matching required.

Also recorded: Next redacts server-component error messages before
`app/(app)/error.tsx` sees them, so that branch has to be server-side — which is
not obvious and would have been the second wasted attempt.

### What shipped instead: `/session-clock`

`unwrapRows` — the chokepoint for all 47 call sites — routes `PGRST303` to a
recovery page rather than throwing. The page explains that the device clock is
ahead, that reloading will not clear it, and offers one button.

Three constraints shaped it, each verified rather than assumed:

- **It does not sign the user out on arrival.** That would need a GET endpoint
  with a side effect, which is a logout-CSRF surface this app does not otherwise
  have. The button submits the existing `logout()` server action — a POST Next
  protects — so the user is one click from the fix and nobody can trigger it for
  them.
- **It lives OUTSIDE the `(app)` group.** That layout builds a Supabase client of
  its own, so a page inside it would re-enter the failing session and bounce back
  here forever. The root layout does no data access. `proxy.ts` bounces
  authenticated visitors off `/login` specifically, so `/session-clock` needed to
  be neither.
- **`getUser()` in the layout is a GoTrue call, not PostgREST**, which is why the
  layout renders normally while every page query fails — and why the symptom
  looks like a broken page rather than a broken login.

**Verified by observation, because the retry above proves unit tests do not
establish reachability.** A real session cookie was re-signed at increasing `iat`
offsets and replayed against the running app:

| `iat` offset | result |
|---|---|
| +0s, +20s | 200, page renders — PostgREST tolerates it |
| +31s … +120s | 307 → `/session-clock` |

**There are two tolerances, and the whole bug lives between them.** PostgREST
refuses from ~31s; GoTrue still reports the user as authenticated at +120s. That
gap is why the production symptom exists at all — the session is valid enough to
pass the middleware and too skewed to read data.

Two process notes worth more than the feature:

1. **The controls earned their keep.** A first sweep showed every offset
   redirecting to `/login`, which reads as "the page is unreachable, same dead end
   as the retry". The untouched-cookie control failed too, which proved the
   harness was broken rather than the app. Without it the correct conclusion was
   indistinguishable from the wrong one.
2. **The first draft of the E2E spec poisoned the suite.** It clicked "Sign in
   again", and Supabase `signOut()` defaults to GLOBAL scope, so it revoked every
   session for that user — including `tests/.auth/admin.json`, which every other
   spec shares. That is the `csp.spec.ts` residue anti-pattern pointing the other
   way: damaging shared state rather than depending on it. The assertion was
   dropped rather than isolated, because `logout()` is pre-existing and already
   covered by the header's `LogoutButton`; re-testing it destructively was a net
   negative.

## 2026-08-08 · T-slip-pdf-hash — the strongest artefact this system makes was the one it could not prove

`viewing_slips` recorded `signature_sha256` for the signature PNG and event 60's
payload carried the same value, so a substituted signature IMAGE was detectable.
The slip **PDF** had no hash in the row and none in the event. Nothing could
prove a restored slip PDF was byte-identical to the one that was signed — found
by the 2026-08-05 Storage restore drill (BACKUP_RESTORE §4c).

The asymmetry is what makes it worth fixing rather than noting: evidence reports
already carry `pdf_sha256` in their generation event, and that is exactly what
let the drill prove a PDF pulled through the app's own Download button still
hashed to the value in the chain. The signed viewing slip — doc 01 §4's "single
strongest commission-dispute weapon" — could not be checked the same way.

Migration 0026 adds `viewing_slips.pdf_sha256`, and `signViewingSlip` hashes the
exact bytes it uploads, before uploading, so the recorded value describes what
was sent rather than what came back. **The same value also goes into the
`viewing_slip_signed` payload, and that is the half that matters:** `events` is
hash-chained, so a hash recorded there cannot be edited later without breaking
`verify_events_chain`. A column on its own would be as forgeable as the file it
describes.

**The one existing slip was deliberately left NULL.** Backfilling from the bytes
sitting in Storage today would write an assertion nobody is in a position to
make — that those are the bytes that were signed — and once written it would be
indistinguishable from a hash taken at signing time. A null says "unknown", which
is true, and an integrity column that sometimes means "trust me" is worse than one
that admits a gap. For the same reason there is no CHECK tying `pdf_sha256` to
`pdf_path`: that row has a path and no hash, so any such constraint would either
fail on it or be carried `NOT VALID` forever.

**Verified against the stored file, not at the unit level.** `sha256Hex(pdf)`
returning the hash of its argument is trivially true and says nothing about
whether the value stored beside the file describes the file. So
`tests/e2e/slip-pdf-hash.spec.ts` signs a real slip through the real
pointer-event canvas, then re-downloads the PDF with the service key and
re-hashes it, and also asserts the value is not simply the PNG hash reused —
which would look right in the row and prove nothing. Two things it caught in the
writing:

- The first assertion waited for the client's "Slip signed" panel and timed out
  while the slip had in fact been written correctly. `revalidatePath` re-renders
  the sign page into its server-rendered "Already signed" branch, which races the
  client state. The test now polls for the ROW, which is what it is about.
- The first cleanup reconstructed Storage keys as `<viewing_id>.pdf`. They are
  `<org_id>/<viewing_id>.<ext>`, so it deleted nothing and leaked two objects into
  the signatures bucket while reporting success. Paths now come from the row.
  Worth remembering generally: **a wrong Storage key is not an error, it is a
  no-op.**

Applied to hosted BEFORE pushing the code that writes the column — the ordering
0025 got wrong the day before.

## 2026-08-09 · T-prod-day — three silent failures, one shared cause

Three separate things were found broken in production on the same day. Each is
worth reading for its own mechanism, but the shared cause is the point.

**1. Nobody could sign in for ~6 days.** Supabase disabled the legacy JWT keys on
2026-08-03. `NEXT_PUBLIC_*` is inlined at BUILD time and the production build log
said `Restored build cache from previous deployment`, so the old anon key stayed
compiled in: every auth call returned `401 Legacy API keys are disabled`,
`getUser()` saw no user, every route bounced to `/login`. 38 requests to `/login`,
zero to `/dashboard`. Fixed by setting the publishable key and redeploying with
**build cache off** — a plain redeploy is not enough.

**Both keys were stale, not one.** Fixing the anon key restored sign-in and made
the outage look over; `SUPABASE_SERVICE_ROLE_KEY` was still legacy, so slip
downloads, evidence reports, uploads, invites, merge and erasure were all broken
with no visible error. `lib/supabase/key-health.ts` was written that morning and
named it on the first render after deploy.

**2. The CSP could never have been enforced.** `/login`, `/login/verify` and
`/session-clock` were statically prerendered, so they carried no nonce while
`proxy.ts` minted one per request. Under `'strict-dynamic'` — which makes
browsers ignore `'self'` — enforcing would have refused **every** script:
`/login` served 26 script tags and 0 nonces. Fixed with `force-dynamic`;
guarded by `scripts/check-static-routes.mjs` in CI after the build, because
neither existing suite can see it (E2E runs against `npm run dev` where every
page is dynamic; unit tests run before the build).

**3. Sentry had never received a server event.** `instrumentation.ts` gates on
`SENTRY_DSN`, and the Sentry Vercel integration had provisioned
`SENTRY_PUBLIC_KEY`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` and
`NEXT_PUBLIC_SENTRY_DSN` — but not that one. So the three error boundaries, the
sign-in failure report, the dead-key guard and every `[csp]` violation fell back
to `console.error` and ~1h of Vercel retention. Alerting was a second gap on top:
the default rule fired only on HIGH-priority issues and had `Last Triggered:
Never`.

### The shared cause, which outlives all three

**Every one was an undated "verified" claim in HANDOFF that nobody re-checked,
and every one was contradicted by evidence already sitting in a log.**

- §2b said "Production runs on `sb_publishable_…` and is healthy". A production
  `AuthApiError: Legacy API keys are disabled` on `/middleware` was visible on
  2026-08-07 and was **dismissed because the document said otherwise**.
- §0 said "Sentry is wired and confirmed receiving". True for the browser, never
  true for the server, and never re-tested.
- C1 said the policy swept "22/22 clean". True, and silent about the property
  that mattered, because Report-Only blocks nothing and the local server renders
  every page dynamically.

So: **date every claim, and re-check rather than re-read.** A green test proves
only what it asserts; a passing sweep in one environment says nothing about
another. Each of these was found by exercising the real thing — replaying a
re-signed session, POSTing a real report, clicking a real download.

## 2026-08-10 · T-aal2-rls — 2FA enforcement moves into the database (IMPROVEMENTS C2)

**Built and verified locally on branch `c2-aal2-rls`; NOT applied to hosted.**
Production still enforces 2FA in the app only. Design spec and plan live under
`docs/superpowers/`.

`T-2fa` (2026-07-24) shipped TOTP but named its own gap: enforcement is at the
application layer, so a stolen `aal1` JWT can bypass the challenge by talking to
PostgREST directly. Migration `0029_require_aal2.sql` closes it — `mfa_satisfied()`
plus a `require_aal2` restrictive policy on all 29 RLS-enabled tables.

**Opt-in, not universal — and that is the safety net, not a compromise.** The
predicate passes anyone with **no verified factor**, so they are untouched. That
is deliberate: BACKLOG's 2026-08-09 decision kept an admin who has no factor, and
recorded the consequence — *"C2 must not assume every admin has a factor."* He is
who gets back in if the policy misfires. `status = 'verified'` and not mere
presence, because `enroll()` mints an `unverified` factor immediately and counting
those would lock out anyone who closed the enrolment tab.

**Explicit per-table policies beat gating inside `current_org_id()`.** The helper
route is ten lines and inherits everywhere, which is genuinely tempting. It was
rejected for two reasons: `cyprus_config`'s SELECT keys on `auth.uid() IS NOT
NULL` and would have stayed readable, and the gate would be invisible — reading a
policy would tell you nothing about 2FA. The cost of being explicit is that a
future table gets forgotten, which is exactly what 0021 did with grants, so the
guard below is what makes the explicit choice safe.

**Three things measured rather than assumed, each of which would have sunk it:**

1. **The `aal` claim exists.** The whole design rests on `auth.jwt() ->> 'aal'`
   being present; if it were not, `coalesce` reads `aal1` and *every enrolled
   user* is denied everything. Proven against a real TOTP challenge before a
   single policy was written, and the plan made that a hard stop.
2. **Gating `profiles` does not deadlock.** Every other policy depends on
   `current_org_id()`, which reads `profiles` — but it is `security definer` owned
   by `postgres`, which has `bypassrls`.
3. **The challenge screen survives.** `/login/verify` is in the `(auth)` group and
   reads no public table, so denying all 29 does not break the one screen a
   blocked user needs.

**The predicate is wrapped in a scalar subquery, and that wrapper is
load-bearing.** Bare, it plans as `Filter: mfa_satisfied()` on the scan node —
evaluated **once per row**. Wrapped as `(select public.mfa_satisfied())` it plans
as `InitPlan 1 -> Result … loops=1` — once per statement. Same predicate, same
semantics; only the evaluation strategy differs. Measured both ways on 50 rows.
**The same finding applies to `current_org_id()` across all 86 existing policies,
which is pre-existing and now in BACKLOG.**

**Two guards were proven by breaking them.** A guard nobody has watched fail is
not a guard. Weakening the predicate to `status is not null` made *only* the
abandoned-enrolment test fail; replacing one policy with a permissive
`using (true)` of the same name made the coverage function report that table. The
second experiment is why `rls_aal2_coverage()` checks the policy's **shape** —
restrictive, `ALL`, `authenticated`, both clauses — and not merely its name: a
name-only check would have blessed a policy offering zero protection.

**Known red, pre-existing, and deliberately not fixed here.**
`tests/e2e/mfa.spec.ts` fails at *enrolment* — the QR dialog never renders — and
it fails identically on `main` with 0029 absent, so it is not a regression. It is
tracked separately, and it gates the hosted apply rather than this branch: a
broken enrolment flow plus database-level lockout means a user who loses a device
cannot re-enrol, and re-enrolment is precisely the recovery path this design
assumed works.

**RESOLVED 2026-08-11 — see `T-e2e-cold-server`. Enrolment was never broken.**
The QR dialog never rendered because the page never hydrated, on a server that
was serving a build that no longer existed on disk.


## 2026-08-11 · T-e2e-cold-server — six tests failed and not one of them was broken

**No application code changed.** `tests/e2e/mfa.spec.ts` was red, was reported as
a broken enrolment flow, and gated the hosted apply of `0029` (`T-aal2-rls`).
Enrolment was fine. So were the five other tests that failed on the way to
proving it. Two separate environment faults, neither in the app.

### 1. The suite was testing a server nobody had checked

The process on `:3000` was not a dev server. It was `next start -p 3000`, begun
the previous evening for a production check and never stopped. `next start`
caches its build manifests at boot; `.next` was rebuilt the next morning, which
rewrote the content-hashed chunk filenames. The old server went on emitting HTML
that referenced chunk names no longer on disk, so **6 of 22 chunks answered `500`
with `content-type: text/plain` — including the Turbopack runtime.**

Consequence: every page server-rendered perfectly and **nothing hydrated**. A
click on "Set up two-factor authentication" reached no handler, `enrollment`
stayed `null`, the QR dialog never appeared. Not specific to `/security` — the
same five chunks 500'd on `/dashboard`, `/contacts`, `/settings` and `/login`.
`playwright.config.ts` has `reuseExistingServer: true` and only checks that
*something* answers the base URL, so the suite adopted it and `npm run dev`
never started.

**The disproof was inside the bug report's own artefact.** The accessibility
snapshot in `error-context.md` showed `button "Set up two-factor
authentication"` — not the `"…"` disabled pending label — and carried no
`role="alert"` paragraph. So `pending` was false and `error` was null: the
error branch at `security-panel.tsx:38` had never executed and the server action
had never been called. The suspected cause was excluded by the file filed with
the suspicion. Confirmation took one command: the served HTML contained no path
matching `.next/BUILD_ID`.

### 2. Underneath it, compile-on-demand against fixed budgets

With a real dev server the suite went green except for a class of failure that
had been masked by the first fault. A local run is `next dev`, which compiles a
route on first request and charges it to whichever test asks first. From the dev
server's own log, cold:

```
GET /login/verify        43s   (next.js: 43s, application-code: 328ms)
GET /viewings/<id>/sign  44s
GET /viewings/<id>     31.2s
GET /contacts/export   28.8s
```

Six tests across three specs failed on that, every one reading like a product
defect: `csp.spec.ts` reported `net::ERR_ABORTED; maybe frame was detached?` on
the second of two cold navigations — the test timeout guillotining a navigation
mid-flight; `mfa.spec.ts` watched `/login` while the post-login redirect
compiled; `slip-pdf-hash.spec.ts` gave up waiting for a slip row while the
signing route compiled.

### What shipped

- **`auth.setup.ts` warms 27 routes** after storing the session, so the compile
  is paid once outside any timed assertion. It can never fail the run — every
  request is caught and reported, because a throwing warm-up would take 175
  tests with it. `page.request`, not `page.goto`: the expensive half is the
  server-side compile, and a plain GET avoids driving a browser into the
  `/export` routes. Ids come from the admin's own org where one exists, with an
  any-org fallback for viewings, which local seed data has none of — that
  fallback still compiles the route on the way to its 404, and `/sign` going
  cold is what broke `slip-pdf-hash.spec.ts`.
- **Scaled local budgets** in `playwright.config.ts` (240s test, 90s expect),
  because `/login/verify` is reachable only when the session owes a factor and
  so cannot be warmed.
- **`opTimeout()` in `helpers.ts`** for the twelve budgets hardcoded inside
  specs, which no config can reach. `mfa.spec.ts:115` missed by 200ms: a
  `POST /login/verify` taking 20.2s against a hardcoded 20s.
- ~~**`failOnFlakyTests` in CI**, so a fail-then-pass can never decide the exit
  code.~~ **REVERTED the same day, and the revert is the more useful finding.**
  Pushed, it turned `main` red on a docs-only commit: `security.spec.ts`'s
  anonymous-visitor loop hits a chrome-headless-shell `SIGSEGV` inside
  `browser.newContext`, and run `31483891162` — the C2 merge, hours earlier —
  had **the same 2 flaky tests and was reported green**. So the suite is flaky in
  MOST CI runs — 3 of the 5 on 2026-08-11, with 0, 0, 2, 2 and 1 flaky tests —
  `retries: 1` has been absorbing it silently the whole time, and the option
  would have failed most pushes on runner noise. That teaches people to ignore
  CI, which hides more than a quiet retry ever did. The rate is tracked in
  HANDOFF §6, which is where a fix belongs — not in the exit code.

  **What the option did achieve was the measurement.** Two minutes of
  `gh run view --log | grep flaky` over previous runs turned "CI is green" into a
  number, and the number was not 100%. The revert's own run then came back with
  1 flaky under a green tick, which is the whole problem in one line. Same move
  as the rest of this entry: the claim was checked instead of read.

  The crash behind that number was chased down and fixed the same day —
  `T-headless-shell-segv` below, including the two wrong fixes that shipped en
  route.

Verified by running the full desktop suite against a server started from an
emptied `.next/dev`: **177 passed, 0 failed, 14.1m** — faster than the 16.6m run
it replaced, because the compiles moved rather than multiplied.

### Three lessons, one of them a repeat

**Establish what is answering the port before reading the code.** The reported
symptom was a component bug; the cause was an OS process. One `Get-CimInstance`
on the PID holding `:3000` would have ended it before any source file was opened.

**Do not calibrate against a number you have not measured — especially an
unstable one.** This fix took three attempts because the budgets were guessed.
The same four tests took 66–78s in one cold run and 18–55s in the next, and a
single `/properties/<id>` warm-up swung between 21s and 130s, on identical code
and an identically emptied cache. Every budget here is deliberately generous
rather than tuned, and the comments say so.

**The `T-prod-day` lesson, repeated in the same shape.** A committed comment
asserted that these failures had been hiding in CI behind a retry, and that
HANDOFF's "CI green" was concealing them. CI **builds and serves `next start`**
(`.github/workflows/ci.yml`), so it never compiles on demand and never had this
problem. The claim was invented about a system whose config had not been read —
which is exactly what `T-prod-day` concluded, three days earlier, and wrote down
as *date every claim and re-check rather than re-read*. Corrected in `ddfed85`.
`failOnFlakyTests` is still worth having, for a reason that survives being true.

### A constraint worth not tripping over

`ci.yml` **depends** on `reuseExistingServer: true`: it starts `next start`
itself and expects Playwright to reuse it. The same option is what let a stale
server be adopted silently in §1. Anything that hardens this must keep the reuse
and check *what* is being reused — dropping the option breaks CI.

### Guarded 2026-08-11 — `tests/e2e/server-health.ts`

The reuse stays; the suite now checks what it is reusing. First test of the
`setup` project, ahead of `login()`: fetch `/login`, take the `<script src>`
values that page asks for itself, request every one, and fail unless all are
`200` with a JavaScript content-type. Measured on one machine the same day —
healthy `next start` **16 of 16**, healthy `next dev` **28 of 28**, stale
`next start` **2 of 16 → `500 text/plain`**. It costs 122–394ms.

**Two things this proving exercise turned up that this entry got wrong.**

**The BUILD_ID signal does not survive being made dev/prod-agnostic.** §1 offers
"the served HTML contained no path matching `.next/BUILD_ID`" as confirmation. It
confirmed correctly *that day*, against `next start`. But `next dev` writes no
`BUILD_ID` at all — dev output lives in `.next/dev`, and the id left in
`.next/BUILD_ID` belongs to whatever production build ran last. Measured on a
**healthy** dev server: 0 occurrences in the HTML. A check gating on it would
have failed every local run. It is reported as a detail line, explicitly
captioned so nobody promotes it to a criterion. (On `next start` it does appear
— as `"b":"<id>"` in the flight payload, not as a path.)

**`authenticate as admin` cannot detect this fault, so the guard could not be an
assertion inside it.** Against the stale server the guard failed in 268ms and the
auth step then ran anyway and **passed in 18.6s**, warming 27 routes on a server
whose build did not exist — logging in is a server-action POST plus a redirect,
and neither needs a hydrated page. `setup.describe.configure({ mode: "serial" })`
is what makes the failure stop the run rather than sit beside a green tick.

Proven by breaking it, per `T-aal2-rls`: built, started `next start -p 3401`,
rebuilt underneath it, watched the Turbopack runtime turn into `500 text/plain`,
and watched the guard abort the run and skip the dependent `desktop` project. The
rebuild also stranded the healthy `next start` that was still on `:3000` from
earlier the same evening, which the guard then caught independently — the trap
re-set itself inside one session, which is how routine it is. A plain rebuild of unchanged sources moved
only **2 of 61** chunk filenames — but one of them was the runtime, which is
sufficient: nothing hydrates without it. So the blast radius of a stale server is
not proportional to how much the build changed. The failing path is held by
`tests/unit/e2e-server-health.test.ts` so nobody has to stage this again.

## 2026-08-11 · T-headless-shell-segv — two wrong fixes, and the bar that found the right one

**`chrome-headless-shell` was segfaulting in CI, `retries: 1` had been absorbing
it silently, and `security.spec.ts` took the blame for two days.** Fixed by
`channel: "chromium"` — a workaround, not a root cause. The interesting part is
not the fix; it is that two plausible, well-evidenced fixes shipped first and both
were wrong in the same way.

### How it surfaced

Only because `failOnFlakyTests` was briefly switched on (`T-e2e-cold-server`) and
turned `main` red on a docs-only push. That option was itself reverted, but it
produced the first real measurement: `gh run view --log | grep flaky` over recent
runs turned "CI is green" into a number, and the number was not 100%. The C2 merge
run hours earlier had the same 2 flaky tests and had been reported green.

### The symptom lied about its location

`browser.newContext: Target page, context or browser has been closed`, reported
against `security.spec.ts`'s anonymous-visitor loop — ~20 fresh contexts in a row,
which reads exactly like a resource-exhaustion bug in that loop. It was not.
chrome-headless-shell died mid-run with `Received signal 11 SEGV_MAPERR
0000000001b0`, and the *next* test to request a context inherited the failure.
That test was `security.spec.ts` purely because `pwa` sorts before `security`.

### Two wrong fixes, both shipped

**1. GPU init** (`3761b89`, reverted). The crash is immediately preceded, every
time, by `drmGetDevices2() has not found any devices` and `InitializeSandbox()
called with multiple threads in process gpu-process`. A GPU-less runner
initialising a GPU process, seconds after `<launched>`. `--disable-gpu
--disable-software-rasterizer` was added for CI, and the app was checked first for
WebGL (none — the only `getContext` calls are `"2d"`). The flags provably applied:
present in the launch args, and the GPU warnings stopped. **3 of 5 sampled runs
still crashed.**

**2. The `/offline` CSP violation burst** (`e24e452`, kept). `/offline` was
`force-static`, so it carried no per-request nonce, and `'strict-dynamic'` makes
the browser ignore `'self'` — every script on it refused, ~20 violations at once.
**In 4 of 4 crashes, all 20 console lines before the signal came from
`http://localhost:3000/offline`.** Giving the page a nonce took violations to
**0**. **4 of 5 sampled runs still crashed.**

### What both had in common

**"X appears immediately before the signal in N of N crashes" was read as
causation, when it only ever showed what sat in the log buffer at the moment of
death.** Twice. The second time it was 4-for-4 and felt conclusive. A fixed fault
address inside a vendored binary was the signal that mattered all along:
identical across every run and pid, which is a deterministic code path in code
this repo does not control.

### What actually worked was procedural

Treat the next idea as an **experiment with a bar to clear**, on a branch, and
measure it: `channel: "chromium"` runs full Chromium in new headless mode instead
of the shell binary Playwright has used for headless launches since 1.49.

|  | runs crashed |
|---|---|
| baseline | 3 of 6 |
| GPU flags | 3 of 5 |
| `/offline` nonce | 4 of 5 |
| **`channel: "chromium"`** | **0 of 5**, plus a clean merge run |

Zero flaky in every one — the first time all 177 passed on first attempt.

**The reusable technique:** `gh run rerun` re-runs a commit without a new push, so
an intermittent failure can be sampled 5 times for the cost of ~30 minutes and no
production deploys. Before that, every "fix" was being judged on a single run, at
a base rate where a coin flip looks like success.

**The reusable rule, now in HANDOFF §6: anything that does not come with a sample
count is not an answer.**

### Two notes on what was kept and what it cost

`e24e452` stays even though its stated reason is dead: a page whose every script
is refused is a defect regardless of what crashes, nonce coverage is now uniform
across every route, and it removes ~20 pointless `Sentry.captureMessage` calls per
view. Reverting would restore a real defect to fix nothing. Its production impact
was near zero, though — Vercel runtime logs held **2 lines in 24h**, both from
that afternoon's own smoke check, so nobody was reaching `/offline` to generate
reports. The per-view cost was real; the view count was the factor not checked
before implying a flood.

And this is a **workaround**. It establishes that the shell binary crashes and the
full one does not. Nobody has explained why `chrome-headless-shell` dereferences
null at `0x1b0`, so a Playwright upgrade could make the line unnecessary or move
the crash somewhere new. Re-measure; do not assume.

## 2026-08-11 · T-rls-hoist — the helpers were called once per row, and two instruments said otherwise

**Built and merged as migration 0030; NOT applied to hosted.** Production still
evaluates the helpers per row. Spec and plan under `docs/superpowers/`.

`current_org_id()` and `current_role_gnk()` are `stable security definer` SQL
functions. `security definer` blocks inlining, so every reference in an RLS
predicate is a real call — and a bare call is evaluated **once per row**.
Wrapping it as `(select current_org_id())` lets Postgres hoist it to an
`InitPlan` evaluated once per statement. 24 policies on the 7 paginated list
tables were rewritten; 62 permissive policies were deliberately left bare.

**The number was 21 versus 1** — a probe table scanned at 20 rows, with a
`stable security definer plpgsql` function of the same shape raising a `NOTICE`
per invocation.

**Getting that number took three attempts, and the first two both returned a
confident zero.**

1. `pg_stat_user_functions` reports nothing in this stack. Three explicit calls
   moved the counter by 0. **A counter that has not been seen moving cannot
   distinguish "never called" from "not counting".**
2. The first probe ran as `postgres`. `set local role authenticated` outside a
   transaction block is a no-op *warning*, not an error, so RLS was bypassed and
   no policy was evaluated at all — which also reads as zero.

The entry that started this work said "once per ROW (measured)". It was not
measured; it was inferred from one `EXPLAIN`. **Plan shape does not settle it**:
the same function appears as an `Index Cond` — evaluated once, as a scan key — in
one plan and a `Filter` in another. Count calls; do not read shapes.

**Meaning had to be provably unchanged, and one proof was not enough.** Each
rewrite is a drop-and-recreate of a live security policy, since Postgres has no
`create or replace policy`. Two independent proofs:

- The migration captures every predicate into a temp table first and, after the
  rewrite, asserts that normalising the wrapper away reproduces the original text
  exactly. A migration is one transaction, so a mismatch aborts everything.
  Falsified rather than assumed: 0 changed on an untouched database, exactly 1
  when a policy was deliberately weakened.
- Independently, stripping the wrappers back out of the finished migration and
  diffing against the generated rollback script — byte-identical for all 24.

The 24 statements were **generated from `pg_policies`, never hand-transcribed**.
Copying live security predicates by hand is how one quietly changes meaning.

**The trap worth carrying beyond this migration:** `pg_policies.qual` is
deparsed by `pg_get_expr()` against the **caller's** `search_path`. A
`security definer` guard with `search_path = pg_catalog` pinned therefore sees
`public.current_org_id()`, and a literal written unqualified never matches — the
first version of the guard reported all 24 policies as un-hoisted while the hoist
was demonstrably working. The fix normalises the qualification away rather than
depending on any path; it is verified identical under three different
`search_path` settings.

**A second-order version of the same bug:** the equivalence check must normalise
*both* sides. With only the "after" side stripped, re-running the migration
against an already-hoisted database reports "changed 24 predicates" when nothing
changed — a false alarm arriving exactly when someone retries a hosted apply.

**None of this was urgent.** At tens of rows the saving is microseconds. It is
groundwork for volume, and it is recorded here mainly because the measurement was
wrong twice before it was right.

---

## T-A1 — one event type, two share-link kinds (2026-08-23)

`share_link.opened` is written by two different resolvers. 0023's proposal branch
writes `property_count`; 0041's availability branch writes `kind: 'availability'`
with `unit_count`/`available_count` and deliberately **no** `property_count`. The
renderer in `lib/services/events.ts` assumed one kind and formatted every open
with the proposal sentence, so `Number(p.property_count) || 0` fell through to
zero and a working availability link logged **"Proposal link opened — 0
properties"**.

**A correct feature reported as broken** — and it worked exactly as designed on
a reader. An outside review of the app read that line, concluded empty proposals
could be created, and recommended blocking them. They cannot be: `createProposal`
deletes the link outright if the property insert fails ("a proposal with no
properties is not a proposal"). The recommended fix would have changed nothing
and left the real defect in place.

Fixed by branching on `payload.kind`, the same shape `followup_task_created` and
`stages_updated` already use. `revoked` needs no branch — `revokeShareLink` is
shared by both kinds and always writes `views_at_revocation`.

**Rejected: writing `property_count: 0` into the availability payload** so the
old string would render. That stores a misleading number in an append-only log
to fix a display bug, and `events` has no UPDATE to take it back.

**Neither share-link kind had a renderer test before this.** That is how it
shipped. Both are covered now, and the proposal assertion is the regression guard
for the branch — it was confirmed passing *before* the fix, so it is pinning
existing behaviour rather than describing the new code.

`SAMPLE_PARAMS` in `lib/services/messages.test.ts` needed `available`/`total`
added: that test interpolates every leaf key in all three locales and fails on a
leftover brace, so a new placeholder is not optional there. `total` must be a
number or the plural arm never resolves.

---

## T-A2 — median and p90 first response (2026-08-23, migration 0042)

The admin dashboard reported the MEAN first-response time only. Raised by the
2026-08-23 outside review, correctly: a mean hides the tail that matters.
Measured on a local probe — ten leads answered in 1–9 minutes plus one at ten
hours renders as **mean 1h 5m, median 6m**. The old tile said 1h 5m and there
was nothing on screen to say that nine of the ten were answered inside ten
minutes.

**Extended `admin_dashboard_stats` rather than adding a function.** The
execution plan proposed a standalone `lead_response_percentiles`; that was wrong
and was changed during the build. 0018 exists to collapse round trips (9 → 4),
and the `leads_7` CTE is already sitting on the rows the percentiles need — a
second function would have bought a fifth round trip for nothing.

**One behaviour change, deliberate:** all three duration figures now exclude
rows where `first_response_at < received_at`. That interval means a corrected
clock or a backdated import, not an answer before the question. It was already
meaningless in the mean; it just had nothing to be inconsistent with. Leaving
the guard off the mean would have put three numbers side by side computed over
different row sets. The migration's assertion block raises a NOTICE with the
affected row count so the change is observed rather than assumed — **0 rows on
local at apply time**, so no displayed number moved.

`answered` is deliberately NOT filtered that way: it answers "did the desk
reply?", which a clock anomaly does not change.

**The never-answered count is on the p90 tile**, and only when it is above zero.
A lead nobody answered appears in no percentile, so percentiles shown without it
flatter the desk exactly when it least deserves it — and "0 never answered" on
every screen is noise that trains people to stop reading the line.

The KPI grid went 4 columns to 3 so the three response figures share one row.
A mean three times its own median has to be visible at a glance or nobody looks.

**Verified on the rendered page, not only in tests** — the 0041 lesson. Doing so
caught that the first seeding attempt had written to the RLS **fixture** org
(`aaaaaaaa-…`), not the admin's (`00000000-…-0001`): the dashboard correctly
showed zeros because the aggregate is SECURITY INVOKER and RLS scoped it out.
The fixture rows were restored to exactly as found and `npm run test:rls` passes
49/49 on a first run against them, per A8's byte-identical rule.

**NOT done here, deliberately:** replacing "top agents by activity". The review
is right that it is a vanity metric, but choosing its replacement is an operator
decision, so it is a BACKLOG line and the aggregate carries a note pointing at
it. Dashboard filters by agent/office/period are refused by guardrail 6 and are
not going to BACKLOG at all.

---

## T-B5 — the matching rules (2026-08-23)

Phase B of `IMPROVEMENTS_EXECUTION.md`. `lib/services/matching.ts` is pure —
no Supabase, no next-intl — so the rules are exhaustively testable without a
database, and so both directions (buyer→properties, property→buyers) share one
implementation instead of drifting into two.

**Hard vs soft is the whole design.** A hard filter disqualifies and is
reserved for what a buyer would refuse outright: wrong transaction type, wrong
property type, wrong district, off-market status, a bedroom band miss, no
separate title deed when one was demanded, or a price past the tolerance.
Everything else is soft — it costs score and is NAMED.

**The budget tolerance is 10%, and the boundary is inclusive.** Zero tolerance
was rejected: a €5.000 overshoot on €300.000 is a negotiation, and a matcher
that silently drops it is worse than none, because the desk never learns the
property existed. Inside the tolerance the candidate is eligible *and* carries
a `budget` miss stating the overage. **The float boundary was probed, not
assumed** — across 390 budgets from €50k to €2M there is no value where an
exactly-10%-over price is wrongly blocked.

**Score normalises over APPLICABLE weight, not total.** A requirement stating
only a transaction type scores 100, because vagueness in the buyer is not a
defect in the property. A criterion the requirement leaves null is excluded
from both numerator and denominator.

**`reserved` and `under_offer` still match.** A Cyprus chain falls through often
enough that hiding them costs real options. They rank below `available` through
the `availableNow` weight — a ranking problem solved by ranking, not filtering.

**An unpriced property is not rejected**, it loses the budget-comfort points and
returns a `price_unknown` miss. 0041's availability demo ships an unpriced unit
on purpose; excluding them from every budgeted search would hide live inventory.

**A rental requirement prices off `rent_price_month`.** Reading `asking_price`
would compare €250.000 against a €1.500 budget and reject every rental in the
database — a whole transaction type silently returning nothing. Pinned by a test.

**No score column, and do not add one.** `quality_score` is stored and needs
`scripts/recompute-scores.mts` whenever a weight moves. Computing on read costs
a little CPU per page and removes that failure mode permanently, so the weights
in `MATCH_WEIGHTS` can be tuned freely.

---

## T-B — Phase B: buyer requirements and matching (2026-08-23)

Migration **0043**. The full reasoning for the rules is in `T-B5` above; this
records the surrounding decisions.

**Events are written against the CONTACT, not the requirement.** `ENTITY_TYPES`
has no `buyer_requirement` member, and adding one would put a requirement's
history on a timeline nobody opens. "They started looking for a bigger plot"
belongs on the buyer's timeline.

**DELETE is narrower than UPDATE.** Archiving (`is_active = false`) is the
normal retirement and any agent may do it; a hard delete destroys the record
that a buyer ever wanted this, so it stays with admin and listing manager. The
action detects a denied delete by ROW COUNT, because RLS filters it to zero rows
rather than erroring — a null error would otherwise report success while nothing
happened, which is the shape of audit finding 1.

**An unknown feature key is dropped at validation.** The property side only ever
holds keys from `features.ts`, so an unknown key on a requirement is a criterion
that can never be satisfied and would silently lower the score forever.

**`contacts.preferences` is retained and shown, labelled as unused.** The
column is deliberately not dropped by 0043, and the Preferences tab renders the
old blob read-only while a contact has no requirement rows. A silently ignored
blob is data loss nobody notices. Dropping the column is a BACKLOG line and
needs the conversion reviewed against real data first.

**Hard filters are pushed into SQL, the score is computed in TypeScript**, and
the engine re-checks every row SQL let through — the pre-filter is deliberately
coarser (`.in()` on a nullable column, a null-tolerant budget clause). Fetching
everything and scoring in memory is the PERF-3 mistake; capping at the page size
in SQL would rank 20 arbitrary rows instead of the best 20, so the cap is 400
and `capped` is surfaced in the UI.

**The PostgREST `or()` array clause was proven against a running database**, not
assumed: a requirement scoped to the district returns, one with an empty array
(no opinion) returns, one scoped to a different district does not. Getting it
wrong would have silently dropped every unconstrained buyer from property-side
matching — a failure with no error and no empty state.

**Verified end to end with the verdict predicted first.** A seeded search against
PAF0001 was hand-computed to score 69 (applicable 80, earned 55); both pages then
rendered 69 with exactly the two predicted misses, and identically on each side,
which is what proves the engine is shared rather than duplicated.

**What Phase B does NOT do**, so nobody assumes it: no price-drop campaign, no
new-listing alert, no saved-search notification. Those are BACKLOG lines. This
ships the data model, the rules and the two views that read them.

---

## T-C — Phase C: reservations (2026-08-23, migration 0044)

**The invariant lives in the database, and that is the whole design.** At most
one LIVE hold per property, via a partial unique index on `property_id where
status in ('held','confirmed')`. Not in the action: two agents reserving the
same unit in the same second both read "no live hold" and both write one. An
action can be raced; an index cannot.

It is **partial** on purpose. A plain unique index would forbid a property from
ever being reserved twice in its life, which is not the rule — the rule is one
live hold at a time. Proved in all three directions on a rolled-back probe and
again in RLS test 31: a first hold inserts, a second live hold is refused by
constraint name, and after a release a new hold IS allowed.

**Expiry is idempotent by construction, not by a guard.** The nightly sweep
matches only rows still live AND past their expiry, so the second run of a
night matches nothing. That is 0006's one-shot bug avoided rather than
re-fixed, and it needs no maintenance.

**Nothing is deleted.** An expired hold keeps its row: "this was held and
lapsed" is exactly what a commission dispute needs later, and it is the same
reasoning that makes `events` append-only. `property_id` is `ON DELETE
RESTRICT` for that reason; `contact_id` is `SET NULL` so a GDPR erasure (0017)
does not destroy the record that the property was held.

**The property's own `status` is deliberately NOT synced.** Auto-flipping a
listing to `reserved` on hold and back on expiry couples two entities through a
cron job, and the revert is where that class of bug lives. The desk sets the
listing status; this table records the hold.

> **SETTLED 2026-08-26 — the operator decided it stays independent.** This was
> left open here as "BACKLOG carries the sync as an operator decision rather
> than an assumption"; the answer is that `properties.status` is not to be
> coupled to holds, now or later. **Do not build the trigger.** The shape the
> BACKLOG sketched — a trigger on `reservations` plus a rule for a status
> changed by hand in between — is explicitly declined, and that middle case is
> exactly why: it has no non-surprising answer, because the desk's manual edit
> and the cron's revert are both legitimate and neither can know about the
> other.
>
> Verified independent at every layer on the day of the decision, so this is a
> confirmation of the status quo and no code changed: no trigger exists on
> `reservations` or `reservation_installments`, `expire_reservations()` does not
> reference `properties` at all, and no reservation flow writes a property row —
> the only writers of `properties` are the property form, the archive action,
> and two contact-id repointers in `mandates.ts` and `merge-contacts.ts`.

**Cyprus end-of-day, delegated not re-derived.** `cyprusEndOfDay` calls
`zonedWallClockToUtc` from `tz.ts`. The first version hardcoded `+03:00`, which
is correct in summer and an hour wrong every winter — Cyprus is EET (UTC+2)
outside DST, so a hold "until 15 January" would have lapsed at 22:59 local. A
test now pins both sides of the year. HANDOFF's rule that this boundary has
exactly one home earned itself again.

**Terminal states are enforced server-side**, not only by hiding buttons: a
form can post any target, and reopening a hold would have to dodge the unique
index on a property that may have been re-reserved meanwhile. The transition
update is also conditional on the status that was read, so a concurrent
transition loses rather than both appearing to succeed.

**The unique violation gets a sentence**, not a driver message — it is the most
likely error a user will hit, and "release or confirm the existing one first"
is the actual answer.

## T-top-agents — the vanity metric is gone and nothing replaced it (2026-08-26, migration 0057)

**Operator decision: drop "top agents by activity", replace with nothing.**

0042 predicted this migration in a comment it left inside the function body —
"the 2026-08-23 review called this a vanity metric and it is right — clicks are
not conversion. Replacing it needs an operator decision on which metrics take
its place, so it is a BACKLOG line and deliberately NOT changed here." The
answer came back: nothing takes its place. Not lead-to-viewing, not win rate,
not commission. The card is gone and the grid is one card shorter.

**Replace-with-nothing means the query goes too.** Deleting only the card would
have left every admin dashboard load paying for a 30-day group-by over `events`
that nobody reads, so 0057 removes `top_actors30` from
`admin_dashboard_stats`. What was removed is real work: 0042 had made the
aggregate EXACT (it previously ranked a 5000-row sample), so this is not a stub
being tidied away.

**The shared fetch was the trap, and the code said so before I touched it.** The
component had a comment reading "one profiles fetch covers the top-agents bars
AND the event-feed bylines". Removing the bars must NOT remove that fetch — the
Latest events feed still needs a name for every actor. `profileIds` narrowed
from the union of ranked actors and feed actors down to the feed actors alone;
the fetch, the `actorName` map and the feed annotation all stay. Verified in the
browser: the feed still renders "· Gerasimos Kalaitsidis" and "· system" after
the change.

**Three i18n keys were orphaned and went with it** — `dashboard.admin.cards.topAgents`,
`dashboard.admin.empty.noActivity` and `dashboard.admin.events` (the "{count}
events" bar label), in all three locales. `dashboard.agent.noActivity` and
`events.noActivity` are DIFFERENT keys that are still used; a scan by short name
alone would have deleted them, and nearly did.

**The RLS test was inverted rather than deleted.** Test 22 asserted
`top_actors30` was present and capped at 5. It now asserts the key is ABSENT.
That is deliberate: this is a decision that is settled, not a feature that is
merely unbuilt, and a decision with nothing checking it is the kind that gets
quietly undone by a later session reading the 0042 comment as a to-do.

**DEPLOY ORDER: the destructive one.** Removing a key from the function's jsonb
breaks pre-removal code, which does `stats.top_actors30.map(...)` and would
throw on `undefined`, taking the whole admin dashboard to its error boundary.
Code merged and deployed FIRST, hosted migration applied after. The reverse
direction is safe — a deployed component simply ignores a key that is still
there — and that asymmetry is exactly why code-first is correct here, mirroring
the note 0042 left on the OPTIONAL `p50/p90` fields for the additive case.

## T-vat — VAT derived, and what it refuses to say (2026-08-27)

**No migration.** 0058 verified `cyprus_config.vat_property` the day before;
this reads it and derives. `properties.vat_status` is untouched and still
saved — the panel does not write, override, or shadow it.

**Every number comes from the config row.** BACKLOG's constraint was that a CRM
must not invent tax law, so `lib/services/vat.ts` contains no rate, cap or
threshold. A missing row, a malformed one, or one missing a single key returns
`cannot_derive` listing what is absent. The alternative — a hardcoded 19% that
silently disagrees with Settings — is the failure this design exists to refuse.

**The cliff is why the panel earns its place.** Crossing €475.000 or 190 m²
standard-rates the WHOLE purchase rather than the excess, so the marginal euro
at the boundary costs about €49.000 of relief. An agent negotiating €470k→€480k
has no way to see that from the fields alone. Pinned by a test that asserts the
jump between 475.000 and 475.001, and confirmed in the browser.

**It contradicts the record on purpose.** `vat_status` is a declaration that
`matching.ts` scores buyers against, and nothing had ever checked a
`reduced_rate_eligible` claim against the caps. Where the figures refuse it the
panel says so and names the consequence — the property may be offered to buyers
on a rate it cannot have. It does NOT auto-correct the field: the declaration
may reflect something the record does not hold, and silently rewriting a
human's entry from an approximation would be worse than flagging it.

**Three things it explicitly cannot know, all stated in the UI rather than
buried here.** The buyer half (natural person, first and primary residence, 10
years, one per couple) — so every reduced-rate figure is conditional. The area
basis: the law means buildable area, `covered_area_sqm` is the closest field,
and veranda/roof garden/basement are stored separately. The transitional
regime: live to 2026-12-31 and often better, but it needs a permit date by
2023-10-31 that this system does not record, so it is raised as a question and
only where the old rule would actually help.

**It wraps two form sections, which is not an accident.** The derivation needs
price (Pricing) and covered area (Areas & rooms). Reads go through
`target.form` so any named field is reachable, but a re-render only happens for
input events that BUBBLE to the wrapper — wrapping Pricing alone would leave
the panel showing a stale answer after an area edit. It also handles
`HTMLSelectElement`, which PricingBreakdown does not need to: narrowing to
`HTMLInputElement` would read "" for `vat_status` and treat every property as
`unknown`.

**A formatting bug caught by reading the rendered page, not the code.** The
service built its reasons with `toLocaleString("en-GB")` while the app formats
money as `de-DE`, so one sentence read "€375,000 over the cap — that costs
€36.020,83". Both formats, four words apart. The service now uses the shared
`formatMoney`.

## T-mfa-mandatory — mandatory 2FA, and the harness that made it a one-word change (2026-08-28, migration 0059)

**Both halves shipped together, and a test now forces them to stay together.**
`MFA_REQUIRED = true` gates the browser; 0059 drops the opt-in arm from
`mfa_satisfied()` and gates the data. `mfa-enforcement.test.ts` asserts the
database against the constant, so shipping one alone goes red.

**Why that coupling is worth a test rather than a comment.** DB mandatory with
the app not: a factor-less user is never prompted to enrol and simply sees an
empty CRM — `require_aal2` is RESTRICTIVE, so a blocked read returns no rows
rather than an error. Silent, and indistinguishable from "there is no data".
App mandatory with the DB not: the browser gate is the only thing between an
aal1 token and the data, which is the gap this change existed to close.

**THE HARNESS WAS THE ACTUAL WORK.** Two measured cliffs: the RLS suite fell
from 58 passing to 4 failed / 16 passed / 38 skipped, and all 204 E2E tests
fell with `auth.setup.ts`. Both were fixed at the source. `createTestUser`
enrols a TOTP factor by default, so fixtures arrive at **aal2** and pass under
either rule — the suite stopped being mode-specific instead of being taught
the new mode. The three tests that genuinely cannot hold under both are keyed
to `MFA_REQUIRED` and assert whichever rule is in force.

**The E2E chicken-and-egg, which is the subtle part.** `enroll()` returns the
shared secret exactly once. A harness that enrolled and stopped would meet, on
the next run, a user owing a factor whose secret nobody kept — an unanswerable
challenge, locked out of its own fixture. Unenrolling needs aal2, which needs
that secret, so the escape has to come from OUTSIDE the user: the service role
clears factors first (`clearFactors`). Proven by consecutive runs logging
`0 old factor(s) removed` then `1 old factor(s) removed`.

**It is not a bypass.** The seed admin genuinely carries a verified factor and
the setup answers a real challenge on the app's own /login/verify page, so
under mandatory mode enrolment and challenge are exercised on every single
run — more often than the dedicated spec ever ran them.

**Why 0059's precondition REPORTS instead of aborting.** The obvious guard —
refuse to apply while any user lacks a verified factor — is false on exactly
the databases that must accept it: CI builds a fresh stack whose seed admin
has no factor, and a developer's local database accumulates factor-less
fixtures from `mfa-enforcement.test.ts` by design. A guard that aborts on both
would be deleted by whoever hit it first, which is worse than one that counts
and warns. Production was checked by hand instead: 2 users, both with a
verified factor.

**Deploy order was code-first, not the additive rule.** Between the two steps
someone may be invited, and a new account is factor-less: with 0059 applied
and the code not yet deployed they would be blocked by RLS with no /security
redirect to explain it. Code first means the worst intermediate state is a
user prompted to enrol slightly before the database insists.

**Known regression, recorded rather than hidden:** `mfa.spec.ts` is skipped
under mandatory mode, losing the wrong-code path and the "password alone stops
working" assertion. It needs a dedicated user rather than the shared seed
admin; BACKLOG carries it with a VERIFY line.

**A self-inflicted false failure worth remembering.** The first full E2E run
appeared to fail with `mfa.enroll: {}`. The auth log said what it really was:
`POST /factors → 504, context deadline exceeded, 11.1s`. Two Playwright suites
were running at once, because a `ps aux | grep playwright` check in Git Bash
cannot see Windows processes and reported zero. **On Windows, check for stray
processes with PowerShell `Get-Process`, not `ps`** — the Unix check is not
merely unreliable here, it is blind.
