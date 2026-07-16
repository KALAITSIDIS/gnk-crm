# BACKLOG

Nice-to-haves and deferred items noticed during the build. Nothing here gets
built without explicit direction.

- Forgot-password flow on `/login` (doc 05): Supabase `resetPasswordForEmail` +
  reset page + email template. Natural fit with Phase 2 Resend integration.
- Dark mode (doc 06 lists it as backlog).
- Restore `app/(app)/properties/loading.tsx` skeleton once Next.js fixes the
  queued-suspense-reveal hydration bug (see DECISIONS 2026-07-12 · T3.5).
  Re-test: property detail tabs must stay clickable with the file present.
- Key register: UI for `transfer` and `mark_lost` movements and the
  `with_owner`/`lost` statuses (enums + append-only log already support them;
  T4.6 shipped checkout/return only).
- Settings/users: invite emails, self-service password reset and "reset 2FA"
  (doc 05) — all ride the Phase 2-3 email integration; Phase 1 invites hand
  over a one-time password (DECISIONS 2026-07-14 · T5.4).

- Audit remaining `z.string().uuid()` usages (leads.ts, units.ts,
  properties.ts required ids) for the Zod 4 strict-RFC-4122 trap: Postgres
  accepts any 32-hex uuid but Zod 4 `.uuid()` rejects e.g. the seeded
  `11111111-…` fixture ids. `optionalUuid` in deals/properties validators
  already fixed to `z.guid()` (T3.2); the rest only ever see
  `gen_random_uuid()` values today so they are safe in practice.
- Dashboard SQL-side aggregates: KPI sums (open pipeline €, won €, top-agent
  event counts) still aggregate in TS over row-capped fetches (2000/5000).
  Counts are exact since 2026-07-16, but past the caps the SUMS undercount.
  Fix = `SECURITY INVOKER` RPC doing the group-bys in SQL (RLS still applies),
  which also collapses ~11 dashboard round trips into 1–2.
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
