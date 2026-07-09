# 08 — BUILD PLAYBOOK (Phase 1)

Execution order for Claude Code. **One task at a time: implement → run verification → paste command output → commit `T<sprint>.<n>: <summary>` → next.** If blocked by real ambiguity: decide per docs 01–02, record in `docs/DECISIONS.md`, continue. Scope ideas → `docs/BACKLOG.md`, never built now.

---

## Sprint 0 — Foundations

**T0.1 Scaffold.** Next.js 14+ (App Router, TS strict, Tailwind, ESLint), shadcn/ui init, next-intl (`en` active; `el`,`ru` files present), folder structure per doc 02 §B, Vitest configured, GitHub Action: typecheck+lint+test on push.
✔ `npm run dev` renders shell page; CI green on first push.

**T0.2 Supabase local + envs.** `supabase init`, local stack, `.env.local` from `.env.example`, `lib/supabase/{client,server,admin}.ts` (admin = service role, server-only).
✔ App connects locally; `supabase status` healthy.

**T0.3 Migration 0001 (schema).** Copy `docs/03_DATABASE_SCHEMA.sql` → `supabase/migrations/0001_foundations.sql`. `supabase db reset`; fix any syntax/order errors **and sync the fix back into doc 03** in the same commit.
✔ Reset completes clean; all tables/enums/functions/triggers/buckets exist.

**T0.4 Migration 0002 (RLS).** Implement every row of doc 04 as policies + the `mandates_safe` view.
✔ Reset clean; `select * from pg_policies` count matches a checklist committed in the migration header comment.

**T0.5 Migration 0003 (seed).** Copy doc 07. Create first admin auth user locally; attach profile row.
✔ Districts, areas, stages, config rows present; login works locally.

**T0.6 RLS test harness.** `npm run test:rls`: helper creates test users per role (service role), mints sessions, runs the 12 mandatory tests in doc 04 (org-B fixtures included).
✔ All 12 green; deliberately breaking one policy makes the matching test fail (prove once, revert).

**T0.7 Types + core services.** `npm run db:types` wired; implement `lib/services/events.ts` (`logEvent()`), `reference.ts` (calls `next_reference` RPC), `phone.ts` (E.164, CY default) with unit tests.
✔ Unit tests green; `logEvent` inserts verified in local DB.

---

## Sprint 1 — Properties & Media (M1)

**T1.1 Properties list + filters + fuzzy search** per doc 05.
✔ Filters combine; search matches partial reference/title; pagination.

**T1.2 Create wizard + reference generation.** Kind/type/district → server action generates immutable reference.
✔ Two creations in PAF yield sequential refs; reference field read-only afterwards; `property.created` event.

**T1.3 Detail page: Overview/Details/Legal/Marketing tabs.** All fields per schema incl. land panel (shown only when `property_type='land'`), MultilangTabs on jsonb texts, internal notes.
✔ Saves persist; every update writes `property.updated` event with changed-field payload.

**T1.4 Media pipeline.** Upload (multi), Sharp: EXIF strip → thumb/card/full WebP → optional watermark (org setting) → buckets per doc 02 A7; gallery reorder + cover.
✔ Uploaded JPEG with GPS EXIF → stored renditions have no EXIF (assert with sharp metadata in a test); cover renders in list card.

**T1.5 Quality score service + publish gate.** Weights per doc 02 C1; ring component with missing-items tooltip; publish to `public` blocked <70 with admin override (event `property.publish_override`).
✔ Unit tests on weight table; gate behaves; override logged.

**T1.6 Project → units.** Units matrix page, add-unit (inherits location), inline status change, price list versions + payment plans.
✔ Matrix reflects changes instantly; unit status change = event; new price list version snapshots all unit prices.

**T1.7 Price history.** Sparkline + table on Overview from `price_history`.
✔ Editing price creates row (trigger) + timeline entry.

---

## Sprint 2 — Contacts & Leads (M3, M4)

**T2.1 Contacts list/create with dedup.** Live phone/email check; block duplicate with link; PhoneInput.
✔ `99 123456` → `+35799123456`; duplicate blocked; `contact.created` event.

**T2.2 Contact detail tabs.** Profile, Preferences, Psychology, KYC & Banking checklists (% complete), Notes, Documents.
✔ Checklist edits persist + events; consent stores timestamp.

**T2.3 Merge (admin).** Server-side merge: repoint leads/deals/viewings/offers/documents/events entity refs, archive duplicate with `merged_into_id`, event `contact.merged`.
✔ Timeline of merged contact shows full combined history; archived contact hidden from lists.

**T2.4 Lead inbox.** ResponseClock, claim/assign, mark contacted/called, log conversation (channel+note), lost/spam with reason.
✔ Clock boundaries (4:59 green / 59:59 amber) unit-tested; every action = event; `first_response_at` set once.

**T2.5 Convert lead → deal.** Creates deal at first stage of chosen type, links contact/property, stamps `converted_deal_id`.
✔ Events on lead and deal; lead status `converted`.

**T2.6 Click-to-chat.** WA/TG buttons on contact & lead; click logs `conversation.link_opened` event.
✔ Links correct for E.164/username; event written.

---

## Sprint 3 — Pipeline, Deals, Events surface (M5, M6 core)

**T3.1 Kanban.** dnd-kit board per deal type; drag = stage change server action.
✔ Event `deal.stage_changed {from,to}`; counts/totals per column update.

**T3.2 Deal page.** Parties (EntityPicker), expected value, commission_split_notes textarea, offers CRUD, activity feed.
✔ Offer accept → prompts move to won-eligible; all mutations evented.

**T3.3 Health score service.** Factors per doc 02 C5; recompute on relevant events (in-action, not cron); HealthDot breakdown tooltip.
✔ Unit tests: activity decay at 7/14 days; logging a conversation raises score.

**T3.4 Won/lost flow.** Won requires accepted offer or admin override (event); lost requires reason.
✔ Guards enforced server-side; dashboard "won this month" reflects.

**T3.5 EventTimeline component** used on property/contact/deal pages (server-action reads, org-scoped).
✔ Human-readable lines per event_type registry in `lib/services/events.ts`.

---

## Sprint 4 — Viewings, Slips, Mandates, Keys (M7, M2)

**T4.1 Viewings calendar/list + create.** Week/day views; conflicts warning for agent double-booking.
✔ `viewing.created` event; property page shows upcoming viewings.

**T4.2 Slip signing 📱.** `/viewings/[id]/sign` flow per doc 02 C7: SignaturePad → PNG to `signatures` → SHA-256 → geolocation optional → event → slip PDF (react-pdf) stored.
✔ Recorded hash equals recomputed file hash (test); slip PDF downloads; second signing attempt blocked (unique).

**T4.3 Feedback + statuses.** Complete/cancel/no-show; feedback form; nudge on agent dashboard for missing feedback.
✔ Events per status; feedback visible on property activity.

**T4.4 Route builder.** Assign viewings to a date, drag order, printable day sheet.
✔ Order persists; sheet lists refs/addresses/times.

**T4.5 Mandates.** CRUD, signed doc upload, badge on property, expiry task generation (function + cron already scheduled), `mandates_safe` masking in UI.
✔ Manual `select expire_mandates()` flips a fixture; task appears for assigned agent; LM sees masked commission.

**T4.6 Keys.** Register + checkout/return dialogs; movements feed.
✔ Movements append-only (RLS test exists); holder shown on property Overview.

---

## Sprint 5 — Compliance core, Evidence, Dashboards, Settings (M8, M6, M18)

**T5.1 Calculators.** Transfer fees (bands, relief toggle default-on, VAT-paid zeroing) + stamp duty (bands, cap) reading `cyprus_config`; copy-summary; freshness line.
✔ Boundary unit tests: 85,000 / 170,000 / 300,000 / 5,000 / cap-hit case; config edit changes results without deploy.

**T5.2 Commission evidence report.** Builder + react-pdf output per doc 02 C6 incl. slip thumbnails + hashes + chain check footer.
✔ Seeded scenario renders expected chronological rows; `verify_events_chain` shown true; stored in documents + event.

**T5.3 Dashboards.** Admin + Agent per doc 05, each metric backed by a commented SQL/query.
✔ Numbers match manual queries on seeded data; agent view usable at 380px width.

**T5.4 Settings suite.** Org (logo/watermark), Users (invite/deactivate/role — admin-only, role change evented), Stages editor, Locations, Cyprus config editor (edits evented).
✔ Non-admin blocked (RLS + UI); invited user can log in with assigned role.

**T5.5 Tasks.** My-tasks page, quick-add, done toggle; auto-tasks (mandate expiry, feedback nudge) appear here.
✔ Done writes event; overdue count on dashboards correct.

**T5.6 Import scripts.** `scripts/import/{contacts,properties}.ts` per doc 09 (service role, dry-run flag, report file).
✔ Sample CSVs in `docs/samples/` import cleanly; dedup respected; events written as `imported`.

**T5.7 Hardening & release.** Sentry wired; empty/loading/error states audit; mobile audit of 📱 screens; full `verify_events_chain` on staging data; deploy to Vercel with EU Supabase; smoke checklist.
✔ CI green; production login + create-property + sign-slip smoke test passes. **Phase 1 done.**

---

## After Phase 1

Stop. Produce `docs/PHASE_1_REVIEW.md` (what shipped, deviations, DECISIONS log summary, backlog) and await direction before any Phase 2 work.
