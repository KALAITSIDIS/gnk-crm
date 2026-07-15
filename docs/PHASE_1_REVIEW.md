# PHASE 1 REVIEW — GN Real Estate OS

Status: **code-complete, deployed to Vercel + hosted Supabase (eu-central-1,
project `yjgirvzgoiywdojnpkpd`).** One item outstanding: the **manual
production smoke test** (see `docs/RELEASE_CHECKLIST.md` §5).

This is the mandated stop-point per `docs/08_BUILD_PLAYBOOK.md` ("After Phase
1"). No Phase 2 work should begin without explicit direction.

---

## 1. What shipped

All 38 playbook tasks (T0.1 → T5.7), one commit each, on `main`:

- **Sprint 0** — Next.js 16 / TS-strict scaffold, Supabase local+hosted, schema
  (migrations 0001–0006), RLS policies + `mandates_safe`, seed, the 12+ RLS
  test harness, core services (events hash-chain, reference, phone).
- **Sprint 1 — Properties (M1)** — list (filters/fuzzy/table+card/pagination),
  create wizard + immutable `GNK-XXX-####` references, detail tabs with evented
  saves, media pipeline (EXIF strip → WebP renditions → watermark), quality
  score + publish gate, project→units matrix + price lists + payment plans,
  price history via DB trigger.
- **Sprint 2 — Contacts & Leads (M3/M4)** — phone-first dedup, detail tabs
  (profile/preferences/KYC+banking), admin merge with combined timeline, lead
  inbox + response clocks, convert→deal, WA/TG click-to-chat with logged opens.
- **Sprint 3 — Pipeline & Deals (M5)** — dnd-kit kanban, deal detail + offers
  CRUD, health score service, guarded won/lost, EventTimeline + line registry.
- **Sprint 4 — Viewings, Mandates, Keys (M7/M2)** — calendar+list+route views
  with double-booking warnings, signed slip (canvas→PNG→SHA-256→react-pdf),
  statuses+feedback, printable day sheet, mandates (CRUD, signed docs, renewal
  cron tasks, LM commission masking), key register + movements.
- **Sprint 5 — Compliance, Evidence, Dashboards, Settings (M8/M6/M18)** —
  Cyprus calculators from `cyprus_config`, commission evidence PDF with chain
  check, admin + mobile agent dashboards, full settings suite (org/users/
  stages/locations/config), tasks, CSV importers, Sentry + error hardening.

Quality gates at close: **typecheck ✓ · lint ✓ · 93 unit tests · 17 RLS tests ·
production build ✓**. Hosted `verify_events_chain` = true.

## 2. Deviations from spec (read before Phase 2)

- **2FA NOT built.** The MVP "Essential" table (doc 01 §10) lists 2FA under M21
  for Phase 1; it was deferred (no 2FA primitive exists; invites hand over a
  one-time password). GDPR consent and the tested RLS half of M21 ARE done.
  **This is the one genuine gap against the stated Phase-1 MVP** — confirm with
  the client whether 2FA is a go-live blocker.
- **Merge keeps events immutable.** Doc 02 §C3 says "move events references";
  events are append-only + hash-chained, so merge repoints operational tables
  and unions the timeline instead (DECISIONS 2026-07-10 · T2.3).
- **No email yet.** Invites, forgot-password, and invite emails all wait on the
  Phase-2 Resend integration; Phase-1 invites use a one-time password.
- **No `loading.tsx` anywhere.** Next 16.2.10 has a queued-suspense-reveal bug
  that freezes hydration (DECISIONS T3.5); restore skeletons once Next fixes it.
- **Viewing feedback is a property-scoped event** so it lands on property
  activity (DECISIONS T4.3).
- **Import scripts run outside the app build** (standalone `.mts`, type-stripped
  by Node; excluded from tsc/eslint; validated by running).

## 3. DECISIONS log

26 entries in `docs/DECISIONS.md` — every non-obvious call with its rationale.
The load-bearing ones: `mandates_safe` owner-rights view (T0.4), reference
immutability trigger (T1.2), merge/event immutability (T2.3), offers soft-delete
(T3.2), health/quality recompute writes no event (T3.3/T4.5), evidence report
hash ≠ PDF hash (T5.2), Sentry env-gating + no loading.tsx (T5.7).

## 4. Backlog (deferred, need direction)

See `docs/BACKLOG.md`. Summary: forgot-password/invite emails, dark mode,
restore `loading.tsx` post-Next-fix, key `transfer`/`mark_lost` UI, 2FA reset,
`z.uuid()`→`z.guid()` audit, property importer `photo_folder` media ingestion.

## 5. Phase 2+ candidates (per doc 01 §9 roadmap — NOT yet scoped)

Phase 2 is a **separate repo/app** sharing this Supabase project (doc 02 A1):
public website + listing engine (M16), SEO/area pages, inquiry capture,
magic-link proposal pages, expiring lawyer/bank document links (M14), and the
email/calendar sync that unblocks several backlog items. **The playbook stops
here and awaits direction — do not start Phase 2 without it.**

## 6. Handover notes for the next session

- **Method:** `docs/08_BUILD_PLAYBOOK.md` one task at a time → verify
  (typecheck/lint/test/RLS + browser) → commit `TX.Y: …` → push (auto-deploys).
  Read docs 01–09 + `DECISIONS.md` + `BACKLOG.md` before extending a module.
- **Local dev:** `admin@gnk.local` / `admin1234` (seed). Supabase local stack
  is fragile on this Windows/WSL box — it dropped several times during Phase 1;
  recover with Docker Desktop restart → `npx supabase start`. Disk runs tight.
- **Hosted:** apply each new migration to `yjgirvzgoiywdojnpkpd` via the
  Supabase connector after adding it locally.
- **Browser verification gotchas:** Radix Select/Tabs need `mousedown` dispatch
  (not `.click()`); the in-app preview pane occasionally wedges screenshots and
  drifts to `/dashboard` — re-navigate. See memory `gnk-crm-dev-env-quirks`.
