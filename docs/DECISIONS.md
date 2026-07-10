# DECISIONS

Running log of implementation decisions made where the docs were ambiguous or
silent. Format: date · task · decision · rationale.

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
