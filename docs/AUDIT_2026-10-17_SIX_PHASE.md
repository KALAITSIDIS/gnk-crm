# Six-phase audit — 2026-10-17 (full stack, Supabase, Sentry, PropTech)

**Status.** Read-only audit of gnk-crm `99c3bad` (origin/main, hosted at
migration 0147) and gnk-web `08b508b`, run 2026-10-17 against the operator's
pasted "Master system prompt" (six phases). Nothing in either repository, on
hosted Supabase, on Vercel or in Sentry was changed by the audit. The fixes
below are proposals; each lands only as its own verified change. DECISIONS
`T-six-phase-audit-2026-10-17`; findings recorded in BACKLOG "Six-phase audit —
2026-10-17".

**Method.**
- **124 agents.** 14 dimension auditors, one per prompt phase or checklist
  group, plus two free hunts outside the checklist (the CRM's anonymous
  surface; the whole of gnk-web).
  - Every finding was then attacked by independent skeptics, each reading the
    same lines: an evidence lens (does the code at that line do it, and does
    another layer guard it?), a consequence lens (who can reach it, and what
    happens on Postgres 17 / PostgREST v14.5 / Next 16 / Vercel?) and a history
    lens (is it already decided, open, or fixed in DECISIONS / BACKLOG?).
  - HIGH and CRITICAL findings got three lenses, MEDIUM two, and
    already-recorded items and OPTIMIZATION one. A finding survived only with
    fewer than half its lenses refuting it.
  - A completeness critic re-checked the six riskiest PASS verdicts (all six
    held). It named four uncovered areas, which became a second round of four
    auditors with the same verification: sign-in and account lifecycle; the 12
    pg_cron sweeps; outbound notification amplification; erasure completeness.
- **Hosted, read-only.** SELECT-only catalog queries through the Supabase
  connector, plus the advisors. GitHub branch-protection and repository
  settings were read with GET only.
  - One aggregate count (2026-10-17) supports the HIGH fixes: 0
    `property_media` rows, 0 evidence-report documents, 1 erased contact.
  - No production HTTP request was made: in particular, nothing under `/p/`.
- **Every finding cites `file:line` at the snapshot.** The per-agent journal
  (prompts, quotes, votes) is kept with the session, not in the repo.

**Verdict.**
- **64 findings raised, 63 survived verification, 1 refuted.**
  - 0 CRITICAL, 2 HIGH, 44 MEDIUM and 17 OPTIMIZATION; two pairs are
    duplicates across dimensions, so there are 61 distinct issues.
  - **31 distinct issues are NEW**: 1 HIGH, 30 MEDIUM. **14 extend or restate
    an open BACKLOG entry.** The rest are OPTIMIZATION.
- **The prompt's own checklist mostly comes back PASS.** Every tenant table
  holds the org boundary in USING and WITH CHECK. All 357 policy helper calls
  are hoisted. Every SECURITY DEFINER sets a search_path. Anonymous EXECUTE is
  exactly the nine pinned functions. Hosted equals the repo, 147/147. The
  4.5 MB upload limit is gated on every file input. JSON-LD is escaped, source
  maps are deleted after upload, and the PDF fonts cover Greek and Cyrillic.
- **The real defects sit where the 2026-10-14 audit's did: beside the
  checklist.**
  - Erasure destroys the commission-evidence reports it promises to keep.
  - Free-text storage paths are trusted by service-role removals and signers.
  - A stored token digest works as the bearer credential.
  - Public endpoints can spend the Sentry and Resend quotas the alarms depend
    on.
  - Nothing requires CI to pass before Vercel promotes `main`.

---

## 0. What the prompt assumes that is not there

Each was searched for. Absence was confirmed with the evidence given, and is
answered N/A rather than as a finding.

| Prompt item | Reality |
|---|---|
| gnk-web `next-intl` EN/RU/EL, `middleware.ts` locale dedupe, `alternates.languages` / `x-default` | gnk-web is English-only. Its dependencies are `@sentry/nextjs`, `next`, `react`, `react-dom` and `zod` (package.json:14-20). It has no `proxy.ts` / `middleware.ts` and no `[locale]` segment, and `layout.tsx:85` sets `<html lang="en">`. The feed already carries `{en,el,ru}`, which the site discards (`lib/format.ts:3-6`). That is a product gap, not a bug. |
| gnk-web Supabase client, RLS, migrations, `/s/[token]` | gnk-web has none. It reads `/api/public/listings` and posts `/api/public/enquiries` over HTTP; the CRM serves share links at `/p/[token]`. |
| Tables `units`, `routes`, `route_stops` | Units are `properties` with `kind = 'unit'` (0001:16,164). Routes are `viewings.route_date` / `route_order` (0001:449-450). |
| RPC `merge_deal_health` | It does not exist and was deliberately not built (DECISIONS `T-external-audit-2026-10-14`, item 2). |
| `sentry.{client,server,edge}.config.ts`, `hideSourceMaps` | Sentry is configured in `instrumentation.ts` / `instrumentation-client.ts`. `hideSourceMaps` is absent from @sentry/nextjs 10.65 (removed in v9); the repo uses `sourcemaps.deleteSourcemapsAfterUpload: true` (next.config.ts:117-125). |
| Upstash / in-memory `Map` rate limiter | The CRM meters in the database (`note_public_enquiry_hit`, 0084), which survives cold starts. gnk-web meters nothing itself. |
| Framer Motion, maps, lightboxes or calculators on gnk-web | None in the dependencies. |
| pgTAP | The DB suite is vitest against a fresh local stack: 1,839 tests on CI's `rls` job. |

**Remedies re-checked and still rejected.** Each was re-confirmed at
`99c3bad` and is not re-proposed (DECISIONS `T-external-audit-2026-10-14`):
- `security_invoker` on `mandates_safe` (0127:365-390, a definer view by
  design);
- `protect_profile_columns` rewrites (it already uses IS DISTINCT FROM,
  0002:102-115);
- strict `z.uuid()`;
- kanban `structuredClone`, JSON.stringify comparisons and client stage guards;
- `createSignedUrls` for the PDFs;
- a content-derived enquiry idempotency key;
- extra `(org_id, id)` indexes;
- `org_id` asserted inside EXISTS.

---

## 1. Executive health scorecard

Judgement scores, each grounded in the verified ledger below. 100 means nothing
open at this severity scale; the cell says what the deduction is for.

| Area | gnk-crm | gnk-web |
|---|---|---|
| **Database / RLS** | **90%**. Every RLS check in the prompt passes (155 policies, 0 bare helpers, 60 definers with search_path, anon EXECUTE pinned at 9, hosted = repo 147/147, advisors unchanged). Deductions: the stored digest works as the credential (ANON-1); anon counters take any key (ANON-2); service_role can still UPDATE/DELETE events (P22-1); free-text storage paths are trusted (MEDIA-1, RLS-2, RLS-3); partition catch-up deadlocks (CRON-1). | **n/a**: no database. |
| **Full-stack code** | **78%**. Strong idioms: compare-and-set on most status flips, one-time secrets, settled drops, a gated upload limit. Deductions: erasure completeness (ERA-1…5); three lost-update shapes (RACE-1/2, plus the known RACE-3/4/5); deletes that report success over a failed removal (MEDIA-2); watermark fail-open (MEDIA-3); signature-pad resize (SIG-1); non-LGC scripts in PDFs (FONT-1). | **84%**. Small and disciplined: one JSON-LD sink, allowlisted revalidate, timing-safe keys. Deductions: an outage render cached over the last good copy (WEB-2); the enquiry route's e-mail cap and formData guard (P3B1-3); the container "from" price (CONTRACT-1, known). |
| **Sentry / Vercel / CI observability** | **60%**. Scrubbing is exemplary (allowlisted headers, path-token redaction), `onRequestError` is wired and source maps are deleted. Deductions: 130 raw-error returns with no report, and 28 of 32 action files never page (OBS-1); erasure, purge and evidence records not paged (OBS-2/3); public doors console-only (OBS-4); csp-report can flood Sentry (NOTIF-1); no required CI checks before Vercel promotes main (CICD-1); ignoreCommand can cancel a production deploy (CICD-2). | **55%**. Server-only Sentry by design. Deductions: a 6-name header denylist sends the visitor IP, geo and OIDC token to Sentry (WEB-1); crafted posts fire the lost-client alarm unmetered (P3B1-3); CI has no required checks and no smoke test (CICD-1). |
| **SEO / performance** | n/a (internal app); list pages page over unique orders with bounded counts (PASS). | **80%**. PASS: canonical, sitemap, robots, `<` escaped in JSON-LD, security headers, LCP image `priority`. Deductions: 281 KB of font preloads on every page (CWV-1); the full feed row shipped to the client (CWV-2); raw-reference URLs and sitemap XML (SEO-1 / CONTRACT-2); no i18n despite `{en,el,ru}` content. |
| **Test coverage** | **88%**. 3,945 unit tests, 1,839 DB tests on a fresh stack, 243 e2e tests, mutation-tested fixes, catalogue guards. Gaps: no test drives an evidence report through erasure; no viewport-change test for the signature pad; no migration lint in CI (CICD-4). | **62%**. Unit tests plus build only: no e2e or smoke test of the built site, and the contract test reads the PRODUCTION feed (CICD-3, known). |

---

## 2. Verified bug and regression ledger

`NEW` means nothing in DECISIONS or BACKLOG records it. `KNOWN` means an
outstanding BACKLOG entry already describes it (named). Votes are surviving /
total lenses. Paths are repo-relative at the snapshot.

### 2a. HIGH

| ID | Status | Where | Finding | Root cause |
|---|---|---|---|---|
| **ERA-1** | NEW (3/3; the consequence lens rated it MEDIUM) | gnk-crm `lib/actions/contact-erasure.ts:199-205` (erasure) and `:369` (purge) | An erasure with no AML basis, and every retention purge, deletes the contact's **commission-evidence report PDFs**: the row and the object. Meanwhile the dialog (`erase-dialog.tsx:87`), the contact banner (`page.tsx:345`) and the `erased` event (`erasure.ts:204`, `untouched: [... "evidence_reports" ...]`) all say reports are never altered. | `generateEvidenceReport` stores the PDF as an ordinary contact document (`reports.ts:99-111`: `entity_type: "contact"`, `doc_type: "evidence_report"`, path `<org>/reports/evidence-…`). Both destructive listings take every contact document. The erasure spec says the opposite ("generated evidence PDFs … **no** — the hash is the point", `docs/superpowers/specs/2026-07-21-gdpr-contact-erasure-design.md:25`). No test drives a report through erasure or the purge. Latent: hosted holds 0 evidence-report rows. |
| **MEDIA-1** | KNOWN (it widens BACKLOG "Service-role storage removals trust a session-written path") | gnk-crm `lib/actions/media.ts:583-595` | `deleteMediaBulk` removes, **as the service role**, whatever paths the deleted rows' five free-text path columns hold. A planted or edited `property_media` row can destroy a signed mandate PDF, a retained KYC scan or another listing's photographs. A listing manager can do it alone: rewrite `storage_path_original` (0147:442-444), then delete the row. | The path columns are plain text (0001:254-255) with no CHECK or trigger. `property_media_insert` admits the assigned agent and checks only org and property (0100:116-120). The removal is not bound to `propertyId`. The existing entry names only the documents bucket, not the media-bucket renditions or the listing-manager variant. Latent: hosted holds 0 `property_media` rows. |

### 2b. MEDIUM — NEW (30 distinct)

**Security and public surface**

| ID | Where | Finding | Root cause |
|---|---|---|---|
| ANON-1 | crm `supabase/migrations/0146_share_link_tenant_binding.sql:358`, `0097:65,104,120` | Any copy of `share_links` / `portal_connections` (the nightly export, a restore drill, a dashboard read) opens every live proposal and portal feed through the anon RPCs. The stored sha256 **is** the credential. | Next hashes the token; the definers compare their argument straight to the stored column. That contradicts `share-links-token.ts:40-41` ("a database leak yields no working links"). The fix is a double hash: the stored value becomes sha256 of the digest's bytes, done in SQL (see BACKLOG). |
| ANON-2 | crm `0023_share_links.sql:265-283`, `0066:119-137` | The anon-executable rate counters (`note_share_link_miss`, `note_public_listing_hit`) accept any `p_ip_hash`, up to the btree row limit, and prune with a full scan on every call: table-bloat DoS on the Free-plan database. | No shape check on the argument and no CHECK on the tables. The only index is the PK `(ip_hash, window_start)`. |
| ANON-3 (= P3B1-2) | crm `app/api/public/enquiries/route.ts:184-196`, `lib/services/enquiry-ack.ts:42-55` | The visitor acknowledgement echoes the caller's first name-token (up to 200 chars, so a URL fits) and the TYPED property reference into the subject and body. It goes from the firm's verified domain to any unverified address: a phishing relay. **Latent** until `ENQUIRY_ALERT_FROM` is set. | The ack is built from raw input, not the reference the door resolved (`0136:229-236`). There is no per-recipient cap. |
| P3B1-1 | crm `app/api/public/enquiries/route.ts:91-120`, `lib/services/enquiry-budget.ts:65-68` | The 60-per-15-minute origin ceiling for the proven site forwarder is **one unscoped counter row**. Honeypot hits spend it, and a stranger at the same egress spends it. When it fills, every genuine buyer on the site gets 429, and nothing pages. | The honeypot is answered after both budgets are metered, and the origin budget uses the unscoped `callerIpHash()`, unlike the feed's `site:` scope. |
| NOTIF-1 | crm `app/api/csp-report/route.ts:80-96` | Public, sessionless: one Sentry event per distinct directive / URL / source key, with no per-request cap and attacker-chosen issue titles. About 80 crafted requests make 5,000 events, using up the quota that alert rule 738321 relies on. | The dedupe Set only suppresses log lines and is cleared at 200 entries. There is no per-request or per-window cap and no fixed fingerprint. |
| NOTIF-2 | crm `app/api/public/enquiries/route.ts:168`, `proposals/interest/route.ts:125-148` | Junk enquiries can use up Resend's free-tier daily quota, so that day's genuine desk alerts and escalations fail. The 429 is retried as transient for about 2 h, then dropped, and quota exhaustion is never named. | The only bound is 5 per IP per 15 minutes. There is no per-organisation daily outbound counter and no quota-specific classification. |
| AUTH-1 | crm `lib/actions/mfa.ts:191-223` | TOTP guessing has no per-account bound and no signal. `verifyMfaLogin` reports neither a wrong code nor a 429, and app-made GoTrue calls are rate-limited against Vercel's IPs. | The app keeps no counter, sends no Sentry event and writes no log line; no `sb-forwarded-for` is sent. GoTrue's per-account MFA hook is Teams-plan only. |
| ACCT-1 | crm `lib/actions/settings.ts:359-378` | Deactivating a user: the flag commits, then the GoTrue ban fails and the flag revert fails too. The admin's retry then short-circuits to "User deactivated" with **no ban and no event**. | The flag is written before the ban, the revert's answer is unread, and the no-op check trusts the flag alone. |
| P22-1 | crm `0063_partition_events.sql:309` | `service_role` keeps UPDATE / DELETE / TRUNCATE on `events`. A suffix delete leaves a prefix that verifies, and the nightly chain check re-anchors with only a WARNING, so the "chain OK" badge stays green. | The revoke names `authenticated, anon` only, and there is no BEFORE UPDATE/DELETE trigger. The test suites themselves tamper as service_role (`rls.test.ts:448…`; known e2e entry). |
| RLS-3 | crm `app/(app)/properties/[id]/page.tsx:138` | The property page signs a **session-written** `path_card` out of the private `documents` bucket for every viewer. A listing manager or the assigned agent can point a floor-plan row at an admin-only KYC object, and anyone who opens the listing gets a one-hour URL to it. | The same free-text path class as MEDIA-1. Signing is not bound to `properties/<id>/`. |

**Data integrity**

| ID | Where | Finding | Root cause |
|---|---|---|---|
| RACE-1 | crm `lib/actions/contacts.ts:359` (also deal details, mandate edit) | A contact section save writes the render-time form over the row, so **a withdrawn marketing consent can be silently re-granted** by a colleague's later phone-number edit, and it is recorded as a deliberate change. | The A06 `expected_updated_at` idiom exists only on the property SectionForm (`section-form.tsx:105`). |
| RACE-2 | crm `lib/actions/mandates.ts:373`; `reservations.ts:180-184` | `setMandateStatus` checks the transition on a read but updates by id alone, so a terminated mandate can be revived by a concurrent Activate. `extendReservation` has the same shape. | No `.eq("status", read)` and no row-count proof, unlike viewings, leads, tasks and reservations elsewhere. |
| MEDIA-2 | crm `lib/actions/media.ts:589,595`; `contact-documents.ts:164`; `property-documents.ts:131` | User-initiated photo and document deletes report success when the file removal failed. A deleted public photo stays world-readable, and a deleted KYC scan survives with nothing to find it. | `removeObjectsBestEffort` (built for cleanup after a failed insert) is used as the primary removal; it only calls console.error. |
| MEDIA-3 | crm `lib/actions/media.ts:139-144` | A failed watermark download is read as "no watermark configured", so a public listing's photo is published unwatermarked and the toast says saved. | The download's `error` is never read (and the comment "optional until Settings ships it" is stale). |
| CRON-1 | crm `0063_partition_events.sql:193-239` | Once `events_default` holds a row for a month the job must create, `ensure_events_partitions` raises 23514 every month and **never catches up**. Every later event lands in DEFAULT too. | Postgres refuses to attach over default-partition rows. The loop has no per-month exception and walks oldest first. Precondition: a lapse longer than the look-ahead, for example after a restore with the scheduler absent. |
| CRON-2 | crm `0126:703-708, 807-812`; `0125:542-545` | The reservation-lapse, instalment-due and lead-SLA sweeps assign tasks to **deactivated** profiles. The tasks are invisible until the next day's 03:15 re-home. | Raw creator/agent arms reintroduced after DECISIONS `T-nudge-active-assignee` (0024) required "that profile, if it is active". |

**GDPR erasure**

| ID | Where | Finding | Root cause |
|---|---|---|---|
| ERA-2 | crm `lib/actions/contact-erasure.ts:142-185` | Erasure reaches only leads linked by `contact_id`. The person's unlinked website enquiries and the "I'm interested" leads sent through their own proposal links keep their name, e-mail, phone, message and notes. | A website lead's identity lives in `leads.message` (0092), and both doors write `contact_id null`. |
| ERA-3 | crm `lib/actions/contact-erasure.ts:245-251` | Erasing a contact leaves the profile of every duplicate merged into it on the archived duplicate's row (notes, psychology, telegram, nationality, KYC notes, banking readiness, consent). | The merge archives the row whole (`merge-contacts.ts:123-125`); erasure patches one row and never follows `merged_into_id`. |
| ERA-4 | crm `lib/actions/contact-erasure.ts:164-181` | Conversation notes logged on the contact's **deals** (`interaction_notes.entity_type = 'deal'`) are not blanked. | `redactNotes` covers only `contact` and `lead`. It needs an operator scope decision, because a deal note may concern the counterparty. |

**PDFs and field tools**

| ID | Where | Finding | Root cause |
|---|---|---|---|
| FONT-1 | crm `lib/services/pdf-fonts.ts:22-28` | Greek and Cyrillic are covered: Noto Sans, measured with fontTools (Greek 121/144, every assigned modern letter; Cyrillic 256/256), and a probe render drew them in Noto. But **Hebrew, Arabic, CJK and arrows render as wrong Latin-1 characters, silently** ("דוד כהן" → "ßÔÛ ÓÕÓ"). | react-pdf appends Helvetica to every font stack, and textkit hands any missing code point to that WinAnsi font. Nothing detects the fallback. |
| SIG-1 | crm `components/features/viewings/signature-pad.tsx:18-34, 67-76` | The canvas is sized once at mount (DPR applied), so after a phone rotation or resize the ink lands away from the finger and Clear leaves old strokes in the exported PNG: on the **signed viewing slip**. | The effect is mount-only, with no ResizeObserver or orientation handling; `clear()` paints only the current rect at the old scale. |

**Observability**

| ID | Where | Finding | Root cause |
|---|---|---|---|
| OBS-1 | crm `lib/actions/*` (e.g. `reservation-schedule.ts:151`) | 130 `return` sites hand a raw DB/storage `error.message` to the user and **none is reported**. 28 of 32 action files never call Sentry. A migration or RLS drift that fails one write for every user would be invisible. | "Server Actions RETURN errors" is right (DECIDED), but no shared reporter exists, and `onRequestError` sees only throws. |
| OBS-2 | crm `lib/actions/contact-erasure.ts:439-494`; `lib/services/erasure-run.ts:260-265` | An irreversible erasure or purge commits, then its hash-chained record fails. The only trace is a 4-second toast; nothing is paged. | `contact-erasure.ts` has no Sentry import. |
| OBS-3 | crm `lib/actions/reports.ts:153-161`; `viewing-documents.ts:178-182` | A stored evidence report or viewing confirmation whose ledger line is unconfirmed is not paged, though media's identical case is. The rollback delete's answer is unchecked. | No reporter in either file. |
| OBS-4 | crm `app/api/public/proposals/interest/route.ts:84-110`; `enquiries/route.ts:113-115` | A failed `submit_proposal_interest` (the buyer is told to retry, the lead rolled back) and both doors' fail-open rate counters are console-only. Vercel keeps runtime logs about an hour. | Of the six route handlers, only csp-report imports Sentry. |

**CI/CD**

| ID | Where | Finding | Root cause |
|---|---|---|---|
| CICD-1 | both repos, branch protection; crm `ci.yml:115-117` | **Neither repo requires a green CI run to land on `main`**, and Vercel promotes every push to main within about a minute. "CI green before merge" is discipline only. | Read 2026-10-17: protection holds `enforce_admins`, no force-push and no deletion, but no `required_status_checks`; rulesets `[]`. The operator's 2026-09-18 choice not to require PRs is not in DECISIONS. |
| CICD-2 | crm `vercel.json:4` | `ignoreCommand` judges a push by its last commit. Rebase merges are enabled and fast-forward / direct pushes are allowed, so a branch ending in a docs commit can land code with the production deploy CANCELED, while the hosted DB has already moved. | `T-vercel-ignored-build-step` assumes every production commit is a merge commit; nothing enforces it. |

**gnk-web**

| ID | Where | Finding | Root cause |
|---|---|---|---|
| P3B1-3 | web `app/api/enquiry/route.ts:70, 172` | No 320-character cap on the e-mail (the CRM has one), and `request.formData()` is not guarded. Crafted posts fire the "lost client" Sentry alarm twice each, unmetered. | DECISIONS `T-enquiry-identity-single-line` noted the cap gap as "still open" and it never reached BACKLOG. |
| WEB-1 | web `lib/scrub-event.ts:38-45` | The scrub is a 6-name denylist, so the visitor's IP (`x-vercel-proxied-for`), city, latitude/longitude, JA4 fingerprint and the OIDC token reach Sentry on every in-request event. | The CRM fixed the same class with an allowlist (DECISIONS `T-sentry-span-header-scrub`); gnk-web never got it. |
| WEB-2 | web `app/page.tsx:30`, `app/properties/page.tsx` | An ISR regeneration (or a build) during a feed failure **caches "Our listings are briefly unavailable" over the last good copy** of `/` and `/properties` until the next successful regeneration. | `getListings()` reports failure without throwing; the listing page and sitemap already throw on purpose to keep their last copy. |

### 2c. MEDIUM — already on BACKLOG (13)

The code was re-confirmed at `99c3bad`. The BACKLOG entry title is in
quotation marks.

| ID | Where | BACKLOG entry |
|---|---|---|
| CONTRACT-1 | web `app/properties/[reference]/page.tsx:250`; crm 0088 | "Phase 3 — review state, hierarchy, feed grouping" (F3: `units_from_price`). The site calls a typed "From" price "the lowest of its units"; repricing or selling units never moves it. **Quick mitigation:** reword the sentence now. |
| CONTRACT-2 + SEO-1 | crm `lib/actions/units.ts:122`; web `sitemap.ts:64` | "References outside the site's path shape, S." New symptoms: a published unit whose label carries `&` makes the whole `sitemap.xml` malformed; references over 40 characters fail the enquiry door; case-variant twins redirect to each other. |
| ERA-6 | crm `lib/services/erasure-run.ts:206` | "Erasure leaves a lost deal's or lead's typed reason, a reservation's release reason and notes, a viewing's feedback…" (operator decision) |
| RACE-3 | crm `lib/actions/deals.ts:413` | "Offers stay editable on a closed deal, S." / "An offer can be born accepted…" |
| RACE-4 | crm `lib/actions/reservation-schedule.ts:133` | "Applying a plan is delete → insert → link, three requests, S." |
| RACE-5 | crm `lib/actions/merge-contacts.ts:123` | "Two concurrent merges of one duplicate both succeed and split its rows, S." |
| DOC-1 | crm `lib/actions/property-documents.ts:77` | "Five document actions delete their just-uploaded file on ANY failed `documents` insert…" (with T-document-insert-outcome, still uncommitted) |
| PDF-1 | crm `lib/services/evidence.ts:361` | "The commission-evidence report ignores the error and a missing answer on about ten reads…" |
| RLS-1 | crm `0147:298` | "`cyprus_config` is one table for every organisation…" |
| RLS-2 | crm `0147:337` | "A slip row's stored file paths are free text, S" / "Service-role storage removals trust a session-written path" |
| RLS-5 | crm `0100:87` | "An agent who CREATED a mandate but is not the property's assigned agent can read its commission from the base table, S (latent)" |
| OBS-5 | crm `lib/actions/viewing-slips.ts:291` | "A slip whose insert lands after its answer was lost…" / "A slip's PDF missing from Storage…" |

### 2d. OPTIMIZATION (16 distinct)

- **Already known:**
  - `mandates_safe` calls its helpers once per row (P2-2 = RLS-6, BACKLOG).
  - gnk-web CI reads the PRODUCTION feed (CICD-3, BACKLOG; extend it to the build's `generateStaticParams`).
  - Six more raw-id actions beyond the BACKLOG list (VAL-2).
- **Pipeline and repo settings:**
  - CICD-4: no migration lint (`supabase db lint` / advisors) in CI.
  - CICD-5: no `permissions:` or `timeout-minutes`; actions pinned by major tag.
- **CRM:**
  - CONTRACT-3: an unknown org slug answers 200 with an empty book, and the site shows "no properties".
  - P22-2: 53 of 60 definers pin `search_path = public` without `pg_temp`.
  - ERA-5: erasure leaves live proposal links serving the agent's typed title and message.
  - P2-1: three hosted function bodies lack their migration's comments.
  - SIG-2: the slip signature's bytes are not checked to be a PNG.
  - VAL-1: `checkViewingConflicts` puts unchecked ids in `.or()`.
  - RLS-7: docs/04 says 29 tables, and there are 43.
  - ENV-1: the `RESEND_API_KEY` readers lack `import "server-only"` and sit in three client graphs (not inlined; hygiene).
  - OBS-6: a stale source-map comment in `instrumentation-client.ts`.
- **gnk-web performance:**
  - CWV-1: 8 font preloads (281 KB), 6 of them faces English pages never render.
  - CWV-2: the full feed row, `{en,el,ru}` descriptions included, is shipped to a client component that never reads it.

**Recommendation from Phase 4.2 (tenant context):** tag Sentry events with
`org_id` and `role` only. Not `user.id`: under GDPR it is pseudonymous
personal data, and the CRM's scrub posture is deliberate. At one organisation
the tag is cosmetic today, so it is not a finding.

### 2e. Refuted

- **RLS-4** "`offers_update` lets an agent re-point an offer onto a deal they
  do not own". Refuted: the residual is the known "An offer can be born
  accepted…" entry, inside the agent's own deals.

### 2f. Verified safe (PASS), by prompt phase

| Phase | Checked | Evidence |
|---|---|---|
| 1 | Sync boundary | The CRM knocks gnk-web `/api/revalidate` in `after()` with a key compared as sha256 digests (`timingSafeEqual`, web `lib/revalidate.ts:49-51`). The site refuses to expire while the feed is down (503). ISR 60 s, `expireTime` 3600. Enquiries: forward key compared in constant time (crm `forwarder.ts:29-37`); caps aligned across both repos and 0136. |
| 1 | Secret hygiene | `tests/unit/env-names-documented.test.ts` binds every read to `.env.example` both ways. `admin.ts` is `server-only` and unreachable from client graphs. No secret in `NEXT_PUBLIC_*`. Log lines name variables, never values. |
| 2.1 | RLS | All 43 tables have RLS. All 26 UPDATE policies pin the org in WITH CHECK, and every INSERT checks the org. EXISTS parents are RLS tables. The only RLS-off table is PostGIS `spatial_ref_sys` (DECIDED, write-blocked by 0099). No anon table grant. |
| 2 (hosted) | Catalog | Ledger 147/147 with no gaps. 0 bare helper calls in 357. Advisors equal the documented baseline (2 ERROR, 37 WARN, all by design; 47 unindexed-FK INFO = the decided baseline). |
| 2.2 | Functions | All 60 definers set a search_path at their latest CREATE. Per-signature REVOKE (no blanket revoke was ever relied on). No legacy `request.jwt.claim.*` read anywhere. Definers re-derive org and role from the session (`next_reference` 0127:319-325, `close_deal` 0118:187-257). |
| 2.3 | Integrity | Multilingual property fields are written behind A06. References come from an atomic `next_reference()`. No authenticated hard delete of properties, contacts, deals, viewings, mandates, slips or events. CASCADEs (slips→viewings, mandates→properties) are unreachable. Count-exact pages are 25 rows over a unique order, fine at this scale; add keyset `(org_id, created_at desc, id desc)` only past ~50k rows. |
| 3A | Board, uploads | `useOptimistic` + `settleDrop`; `move_deal_to_stage` is an invoker under `deals_update`. All six file inputs are gated at ≤3,500,000 bytes, pinned by a tripwire test. |
| 3A | PDFs | Noto Sans covers Greek and Cyrillic (measured). Slip PNGs are downloaded by row-derived path. `createSignedUrls` is not needed (DECIDED). |
| 3B | Leads | Both mails are plain text; line breaks are refused at the route and in the DB. All CSV exports are formula-guarded (`csv.ts:15,29-31`). The idempotency key is minted once per form mount; the server retries once, keyed. The DB counter persists across cold starts. |
| 3B | SEO | One JSON-LD sink escapes `<` (`json-ld.tsx:22-24`, tested with `</script>` and `<!--`). Canonicals on every page. The sitemap lists public, available rows only. `robots.ts` disallows nothing. Security headers are pinned by test. |
| 4 | Source maps | `deleteSourcemapsAfterUpload: true`; a `.js.map` request measured 403 (BACKLOG). |
| 4 | Crons | 12 pg_cron jobs plus 1 Vercel cron, all on the `cron_health()` card. There is no push alert, a recorded choice (REL-03); Sentry Crons is optional (plan-metered). |

---

## 3. Drop-in fixes for the HIGH findings

Each lands as its own change with this repo's verification:
- RED on the unchanged code, then GREEN;
- mutants;
- unit and DB suites, typecheck, lint;
- branch CI;
- for a migration, hosted first with the md5-guarded `execute_sql` recipe.

The patches below are the shape of the change, not yet run.

### 3.1 ERA-1 — erasure keeps the commission-evidence reports

**Rule.** A report is identified by its **path**, `%/reports/evidence-%`. The
path is NOT NULL and immutable for a session (0002's
`protect_document_columns`), whereas `doc_type` is admin-editable. This is the
identity `T-audit-reports-2` already chose ("survives title edits",
`app/(app)/reports/page.tsx:32`).

`lib/services/evidence-report-path.ts` (new):

```ts
/**
 * A commission-evidence report is a contact document whose storage path is
 * `<org>/reports/evidence-<contact>-<stamp>.pdf` (lib/actions/reports.ts).
 * Identified by PATH, never by doc_type: storage_path is immutable for a
 * session and NOT NULL (0001, 0002 protect_document_columns), while an admin
 * may relabel doc_type. Same rule as app/(app)/reports/page.tsx and 0016.
 * Erasure and the retention purge never destroy one (the erasure spec:
 * "generated evidence PDFs … no — the hash is the point").
 */
export const EVIDENCE_REPORT_PATH_LIKE = "%/reports/evidence-%";

export function isEvidenceReportPath(path: string | null | undefined): boolean {
  return typeof path === "string" && path.includes("/reports/evidence-");
}
```

`lib/services/erasure-run.ts`, step 2. The listing is unchanged; the split
happens in the pure runner, so it is unit-testable with fake steps. Declare
`let evidenceReportsKept = 0;` beside the other counters.

```ts
    const listed = await attempt("listing documents", () => steps.listDocuments());
    // Evidence reports are kept, whatever the AML basis (isEvidenceReportPath)
    const docs = listed.filter((d) => !isEvidenceReportPath(d.storage_path));
    evidenceReportsKept = listed.length - docs.length;
    if (plan.deleteDocuments && docs.length > 0) {
      const paths = docs.map((d) => d.storage_path).filter((p): p is string => Boolean(p));
      await attempt("removing document files", () => steps.removeObjects(paths));
      documentsDeleted = await attempt("deleting document rows", () => steps.deleteDocumentRows(docs.map((d) => d.id)));
      documentsRetained = docs.length - documentsDeleted;
    } else {
      documentsRetained = docs.length;
    }
```

The payload then carries `evidenceReportsKept`. `buildErasureEventPayload`
gains `evidence_reports_kept: input.evidenceReportsKept`, so `untouched:
["…evidence_reports…"]` becomes true and is counted.

`lib/actions/contact-erasure.ts`, the purge (`:368-371`): the same filter
before `removeObjectsOrFail`:

```ts
  const listed = rowsOf(
    await supabase.from("documents").select("id, storage_path").eq("entity_type", "contact").eq("entity_id", contactId),
    "the retained documents",
  );
  const docs = listed.filter((d) => !isEvidenceReportPath(d.storage_path));
  const evidenceReportsKept = listed.length - docs.length;
```

`retention_purged` gains `evidence_reports_kept`.

**Tests.**
- Unit (`erasure-run.test.ts`): a no-basis run with one KYC document and one
  report removes and deletes only the KYC path and id; the payload says
  `documents_deleted: 1`, `evidence_reports_kept: 1`.
- DB (beside `supabase/tests/erasure-lifecycle.test.ts`):
  - a contact with a report at the real path and no AML basis is erased, and
    keeps the report's row and object;
  - an expired purge keeps the report;
  - the KYC document is destroyed in both cases (control).
- Mutant: drop the filter, and both DB tests go RED.

**Operator decision, the purge half.** DECISIONS `T-retention-expiry` says the
purge destroys "document rows, their storage objects and the KYC checklist",
written with KYC files in mind. The patch keeps reports through the purge too,
which is what the spec and every UI string promise. If the operator wants
reports destroyed at the end of the AML duty instead, drop the purge filter,
change `retention-panel.tsx:127` to say "documents, including evidence
reports", and record that in DECISIONS.

**Known limit.** A session could insert a KYC row whose path matches the
report pattern and so exempt it from erasure. That fails toward keeping, and
it belongs to the existing class "Service-role storage removals trust a
session-written path" (fixed in 3.2's CHECK for media; documents need the same
treatment, RLS-2).

### 3.2 MEDIA-1 — media removals and signers bound to the row's own property

**Database: migration 0148 (drop-in core; wrap it in the house
preflight/postflight).** Hosted holds 0 `property_media` rows (counted
2026-10-17), so VALIDATE is instant. Every writer in the app and scripts
already uses `properties/<property_id>/…`: `media.ts:167-169`,
`scripts/import/media.mts:202-204`, `backfill-jpeg`, `move-floor-plans`.

```sql
-- 0148 — a property_media row can only name objects under its own property
--        (T-media-path-bound). BACKLOG "Service-role storage removals trust a
--        session-written path" (the media half); RLS-3's signer, MEDIA-1's remover.
set local lock_timeout = '5s';

do $$
begin
  if current_setting('lock_timeout') <> '5s' then
    raise exception '0148 aborted: must run as ONE transaction — nothing was changed';
  end if;
  if exists (
    select 1 from public.property_media m
     where exists (
       select 1 from unnest(array[m.storage_path_original, m.path_thumb, m.path_card, m.path_full, m.path_jpeg]) p(path)
        where p.path is not null
          and (p.path not like 'properties/' || m.property_id::text || '/%' or position('..' in p.path) > 0)
     )
  ) then
    raise exception '0148 aborted: a property_media row names a path outside properties/<its property>/ — list them read-only first; nothing was changed';
  end if;
end $$;

alter table public.property_media
  add constraint property_media_paths_own_property check (
        (storage_path_original is null or (storage_path_original like 'properties/' || property_id::text || '/%' and position('..' in storage_path_original) = 0))
    and (path_thumb  is null or (path_thumb  like 'properties/' || property_id::text || '/%' and position('..' in path_thumb)  = 0))
    and (path_card   is null or (path_card   like 'properties/' || property_id::text || '/%' and position('..' in path_card)   = 0))
    and (path_full   is null or (path_full   like 'properties/' || property_id::text || '/%' and position('..' in path_full)   = 0))
    and (path_jpeg   is null or (path_jpeg   like 'properties/' || property_id::text || '/%' and position('..' in path_jpeg)   = 0))
  ) not valid;
alter table public.property_media validate constraint property_media_paths_own_property;

comment on constraint property_media_paths_own_property on public.property_media is
  '0148: every stored path is under properties/<property_id>/ — the service-role delete (deleteMediaBulk) and the '
  'property page''s signer trust these columns, so a session may not aim them at another record''s object.';
```

A CHECK, not a trigger: it binds every writer, the service role included. It
re-evaluates when `property_id` changes, and it costs nothing to read.

**Application: `deleteMediaBulk` (`lib/actions/media.ts:580-595`), in the same
change.** This is defence in depth for rows written before 0148, plus the
same-property case the CHECK cannot see:

```ts
  const admin = createAdminClient();
  // T-media-path-bound: remove only what THIS property's rows can own, and
  // never an object another surviving row of the property still names (a
  // planted row on L must not take L's live photographs with it).
  const ownPrefix = `properties/${propertyId}/`;
  const { data: survivors, error: survivorsErr } = await supabase
    .from("property_media")
    .select("storage_path_original, path_thumb, path_card, path_full, path_jpeg")
    .eq("property_id", propertyId);
  if (survivorsErr || !Array.isArray(survivors)) {
    // fail toward keeping: rows are gone, files stay, the orphan query finds them
    reportMediaUpload("[media delete] survivor read failed — no files removed", "delete_survivors", { propertyId });
  } else {
    const stillNamed = new Set(
      survivors.flatMap((s) => [s.storage_path_original, s.path_thumb, s.path_card, s.path_full, s.path_jpeg]).filter(Boolean),
    );
    const removable = (p: string | null): p is string =>
      typeof p === "string" && p.startsWith(ownPrefix) && !p.includes("..") && !stillNamed.has(p);
    for (const bucket of ["media", "documents"] as const) {
      const paths = deletedRows
        .filter((m) => mediaBucketFor(m.kind) === bucket)
        .flatMap((m) => [m.path_thumb, m.path_card, m.path_full, m.path_jpeg])
        .filter(removable);
      if (paths.length > 0) await removeObjectsBestEffort(admin.storage, bucket, paths, "media bulk delete: renditions");
    }
    const originalPaths = deletedRows.map((m) => m.storage_path_original).filter(removable);
    await removeObjectsBestEffort(admin.storage, "documents", originalPaths, "media bulk delete: originals");
  }
```

(Use the repo's own reporter for the survivor-read failure. MEDIA-2 then
replaces `removeObjectsBestEffort` here with a reported, warned removal.)

**And the signer (RLS-3), `app/(app)/properties/[id]/page.tsx:138`:** sign
only `m.path_card?.startsWith(`properties/${id}/`)`; otherwise `card_url:
null`.

**Tests.**
- DB: a session INSERT or PATCH naming `<org>/mandates/…`, another property's
  prefix, or a `..` path answers 23514 for an admin, a listing manager and the
  assigned agent; an own-prefix path is accepted.
- Unit: `deleteMediaBulk` with a deleted row naming a foreign path removes
  nothing outside the prefix, and with a surviving row naming the same path
  removes nothing.
- **Fixtures move with it:** `supabase/tests/rls.test.ts:4819,5450` write
  originals as `${ORG_A}/originals/…`, and every such fixture takes the
  `properties/<id>/` shape.
- The restore pack (`verify-restore.sql`) gains the constraint row.
- **Order:** additive and not deploy-coupled. Hosted 0148 first, then merge.

---

## 4. PropTech add-ons — ranked against what already exists

**The usage reality decides this section.**
- HANDOFF: "Build nothing new — stabilise and let the desk use it"
  (2026-07-29, re-affirmed since).
- Every production row is operator test data: 0 buyer_requirements, 0
  viewings, 0 tasks, 2 share links.
- CLAUDE.md: "Never invent scope … add a line to docs/BACKLOG.md instead."

So each add-on below is **a BACKLOG proposal, not work**, until the operator
names it. About half of what the prompt proposes is already built.

| Rank | Add-on | Already built (evidence) | Real gap | Do-Not-Build / guardrail conflicts | Effort | Impact |
|---|---|---|---|---|---|---|
| **1** | Reverse lead-to-property matching | `buyer_requirements` (0043); `matchProperty` engine (`lib/services/matching.ts:194`); ranked buyer↔property views (`lib/queries/matches.ts:83,171`); price-drop, new-listing and bulk-reprice alert **tasks** with events (`lib/services/match-alerts.ts`), hooked into `saveProperty` and the bulk reprice | The last mile: no "pitch" action on the matching-buyers card, no prefilled wa.me text, no record of who was pitched | WhatsApp **API** is Do-Not-Build (doc 01 §10), so click-to-chat only. The ">5% drop" rule contradicts `match-alerts.ts:62-65` ("deliberately no minimum drop"). The "mandate goes active" trigger contradicts `becameMatchable` (status-keyed). An AI-drafted pitch is Phase 3 M12 and needs human approval (§12.6). | **S** (no-migration version) / **M** (with the pitch ledger) | MEDIUM. It is the core brokerage loop, but it does nothing until the desk records buyer searches. |
| 2 | Mandate expiry and commission radar | `expire_mandates()` plus renewal tasks (0122:344-397, lead time per mandate); a 30-day dashboard card; listing health with a 90-day price review; no-contact / feedback / no-show nudges with configurable thresholds (0052); key recall (0053); deal health; `cron_health()` card | A stale-listing nudge (zero viewings in N days); a 30/14/7 countdown (today one reminder per expiry cycle); a "slip signed, no offer in N days" arm; a pushed alert when a sweep fails | None with §10. Respect the matched pair `nudge_threshold()` ↔ `readThreshold()` and the Cyprus-day rule. A zero-viewings arm would fire on every listing today (0 viewings). | M (each arm replaces a definer through the md5 ritual) | MEDIUM (commission protection is USP #2; the core already runs) |
| 3 | AI multilingual copywriter | `{en,el,ru}` jsonb fields with EN/EL/RU tabs; per-link proposal locale; the Kyero feed emits en/ru; the feed carries all three | No LLM anywhere; no draft-then-approve dialog; gnk-web renders English only | Phase 3 M12: "Nothing AI-drafted is sent or published automatically", so it must be draft → human review → `saveProperty` (event). Send property fields only, never owner or contact data, `internal_notes` or price floors. Needs a processor agreement. | M (CRM only) → L (meta columns, `public_listings` DROP+CREATE) → XL (gnk-web `/el`, `/ru`, hreflang) | MEDIUM (RU/EL buyers are Paphos' market; limited until the site has i18n) |
| 4 | "Whisper link" micro-brochure | Expiring, revocable, hashed share links of two kinds (0023, 0041); per-link locale; exact view count plus one throttled `opened` event per Cyprus day, tenant-bound (0137, 0146); a neutral `/p/[token]` page that leaks nothing to previews; "I'm interested" leads (0106); copy-once minting | Price masking until a slip is signed; WhatsApp share with prefilled text; real-time open push; per-photo dwell | Buyer logins are banned (magic links only: met). Photo-dwell tracking of an identifiable buyer is behavioural profiling (consent, notice, retention), and it contradicts gnk-web's legal page ("no analytics … not profiled") and the throttle rationale (`T-share-links`). Rich previews contradict `/p/` neutrality. | L | LOW (80% exists; masking makes little sense where portals show prices) |
| 5 | Route optimiser and buyer live-tracker | Route day and order on viewings; a drag-and-drop route builder with a `route_updated` event; a printable day sheet; PostGIS coordinates with an approximate flag; a geotagged signed slip with a second attendee; confirmation PDF and ICS | Drive-time ordering, buffers, a buyer itinerary link, live tracking | Needs a paid routing-matrix API (metered) or self-hosted OSRM. Live location is personal data (consent, retention). The itinerary needs a new share-link kind and an anon definer (another advisor WARN). | XL | LOW (0 viewings ever on hosted; agents know Paphos roads) |

### 4.1 Blueprint for #1 — `T-match-pitch` (slice 1)

The full, reviewed text is in
[`docs/blueprints/T-match-pitch-0148.md`](blueprints/T-match-pitch-0148.md). It
contains:
- migration **0148 `match_pitches`**, in the house shape (one transaction,
  preflight, postflight);
- `pitchMatchedBuyer`, the server action skeleton;
- the RLS test list.

It is numbered 0148 as drafted; if T-media-path-bound (3.2) lands first, it
becomes 0149.

**What slice 1 does.**
- The matching-buyers card gets a **Pitch** action per row: WhatsApp or
  e-mail.
- `pitchMatchedBuyer`:
  - re-reads the listing, the buyer and their saved searches under RLS;
  - re-runs `matchProperty` and refuses if nothing still matches;
  - mints a 14-day proposal link through the existing `createShareLink` (it
    returns `linkId`);
  - writes one `match_pitches` row. Its AFTER INSERT **invoker** trigger writes
    `match_pitched` on the contact in the same transaction: ids and an enum
    only.
- It returns the one-time link plus a `https://wa.me/<digits>?text=<template +
  URL>` or `mailto:` anchor. The agent sends from their own phone. That is
  click-to-chat, not the API.
- The card shows "Pitch prepared <date> · <channel> · link views N (include
  link previews)".

**What it does not do.**
- No API send.
- No AI text.
- No ">5%" threshold.
- No mandate trigger.
- No masking.
- No score column (0043, T-B5).

**Schema in one paragraph.**
- `match_pitches(id, org_id, property_id, contact_id, channel comm_channel,
  share_link_id, created_by, created_at)`.
- Composite keys onto `properties (org_id,id)` and `contacts (org_id,id)`, ON
  DELETE CASCADE. `share_link_id` is a single-column key, ON DELETE SET NULL,
  bound by policy.
- SELECT org-wide under `require_aal2`.
- INSERT of six columns only, so a session cannot choose `id` or `created_at`.
  It is bound to `created_by = auth.uid()`, a live (not archived, not erased)
  contact of the caller's org, and, when a link is named, that buyer's own
  live proposal link **that shows this property**.
- No session UPDATE or DELETE. service_role may SELECT, and UPDATE
  `contact_id` only (the merge repoint).
- Event wording says **"prepared"**, never "sent". Contact events render in
  the commission evidence report.

**Decisions it needs from the operator before anything is built.**
1. The go-ahead itself: it is new scope.
2. The no-migration slice (prefilled text plus the link only), or the ledger
   (who was already pitched is visible to the whole desk)?
3. Whether `consent_marketing` gates a pitch (at least for e-mail).
4. EL and RU templates need a reader of each language.

**Reviewer corrections already folded in.**
- The INSERT policy binds the link to the property.
- "Prepared", not "sent".
- Column-level INSERT grants.
- Three catalogue tests (`contact-links-org-isolation` KEYS, the merge link
  list, the `merge-contacts-org-scope` REPOINTS count) that the first draft
  said would stay green: they will not, and they move in the same PR.
- `merge-repoints-every-fk.test.ts` reads only inline `references contacts`,
  so table-constraint keys are invisible to it. That is a pre-existing guard
  gap, recorded on BACKLOG.
