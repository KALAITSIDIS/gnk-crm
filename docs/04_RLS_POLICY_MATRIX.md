# 04 — RLS POLICY MATRIX (Phase 1)

Implement in `supabase/migrations/0002_rls_policies.sql`. Every row below has an automated test in `supabase/tests` / `npm run test:rls`. Roles: **A** = admin, **AG** = agent, **LM** = listing_manager. All access additionally requires `org_id = current_org_id()` — org isolation is the outer condition on every policy. `anon` has **zero** table access in Phase 1.

> ### ⚠️ THIS MATRIX IS NO LONGER THE WHOLE PICTURE — read this first
>
> The table below describes the **permissive** policies from 0002 and its
> successors. Since 2026-08-11 there is a **second, independent gate** that the
> matrix does not show, and a row marked ✅ here can still be denied by it.
>
> **`require_aal2` — a RESTRICTIVE policy on all 29 RLS-enabled tables
> (migration 0029).** Restrictive policies AND with the permissive ones, so this
> can only narrow access. Its predicate is `public.mfa_satisfied()`: true when the
> caller holds an **`aal2`** session. (0029 shipped the Supabase opt-in template,
> which also passed a user with no verified factor; since 0059 the second factor
> is mandatory and that arm is gone.)
>
> **What that means for reading this matrix:** a signed-in user who has enrolled
> TOTP but has only completed the password step sees **nothing on any table**,
> whatever the rows below say. IMPROVEMENTS C2 owns the evidence.
>
> **Also since 2026-08-11 (migration 0030), and NOT a behaviour change:** on the
> 7 paginated list tables — `contacts`, `deals`, `events`, `leads`, `properties`,
> `tasks`, `viewings` — the helper calls are written `(select current_org_id())`
> rather than `current_org_id()`. Same predicate, same meaning; the wrapper makes
> Postgres evaluate it once per statement instead of once per row. **Do not
> "tidy" it away.** The other 62 permissive policies are deliberately still bare.
>
> Both migrations carry guard functions that fail CI if a future policy regresses:
> `rls_aal2_coverage()` and `rls_bare_helper_calls()` / `rls_hoisted_policy_count()`.
>
> **Definer surfaces (migration 0127).** A SECURITY DEFINER function or a view
> without `security_invoker` runs as its owner, so `require_aal2` is not between
> it and the tables — each checks `mfa_satisfied()` itself: every RPC since 0101,
> `close_deal`, and since 0127 `record_key_movement`, `next_reference` (which
> also draws only the caller's OWN organisation's reference; the service role is
> unchanged), `org_mfa_status` and the `mandates_safe` view. The catalogue test in
> `supabase/tests/aal1-definer-boundary.test.ts` fails on any definer function or
> view `authenticated` can reach without the check, bar a reviewed exemption list
> (the identity helpers, `rls_bare_auth_calls`, the anon surface, PostGIS).

Legend: ✅ full · 🔒 restricted (condition in Notes) · ❌ denied

| Table | SELECT | INSERT | UPDATE | DELETE | Notes |
|---|---|---|---|---|---|
| organizations | A AG LM (own org row) | ❌ | A 🔒 (own org) | ❌ | Org created by seed/service role only |
| profiles | A AG LM (all in org) | A | A ✅ · AG/LM 🔒 own row (name, locale, phone only) | ❌ (deactivate via `is_active`) | User creation via admin invite (service role) |
| districts / areas | A AG LM | A | A | A 🔒 (only if unused) | |
| reference_counters | ❌ direct | ❌ | ❌ | ❌ | Accessed only via `next_reference()` (security definer) |
| contacts | A AG LM | A AG LM | A ✅ · AG 🔒 (`assigned_agent_id = uid` OR `created_by = uid`) · LM ❌ | ❌ (archive flag instead; archive = UPDATE rule) | Merge runs server-side (service role) and logs events. 0123: `contacts_org_id_id_key` — `UNIQUE (org_id, id)` — is the referenced side of organisation-bound links onto contacts (`viewings_org_contact_fkey` first; 0126 `reservations_org_contact_fkey` and `tasks_org_contact_fkey`). A contact named by a hold, task or viewing cannot move to another organisation (the keys' ON UPDATE NO ACTION). 0134: the erasure lifecycle is not a session's — `contacts_retain_erasure` (see below the table). |
| properties | A AG LM (all, incl. off_market — internal team) | A LM · AG 🔒 (auto-assigned to self) | A LM ✅ · AG 🔒 (`assigned_agent_id = uid`) | ❌ (status `withdrawn` + visibility `archived`) | |
| property_media | A AG LM | A LM · AG 🔒 (own properties) | A LM | A LM | |
| price_history | A AG LM | ❌ direct | ❌ | ❌ | Written only by trigger |
| price_lists / items / payment_plans | A AG LM | A LM | A LM | A LM 🔒 (not latest version) | |
| mandates | A ✅ · AG 🔒 rows where `assigned_agent` on property = uid OR created_by = uid · LM 🔒 (row visible but **commission_pct, commission_notes** masked via view for LM) | A | A | ❌ (status terminated) | Commission figures = admin + property's assigned agent only. Implement mask with `mandates_safe` view; LM/others select from view. 0122: `mandates_org_property_fkey` — `(org_id, property_id) → properties (org_id, id)`, ON DELETE CASCADE — and `mandates_org_renewed_from_fkey` — `(org_id, renewed_from_id) → mandates (org_id, id)` — replace the single-column keys: a mandate names a property, and renews a mandate, of its OWN organisation (the policies check only the caller's org; the keys bind every writer). `mandates_one_active_per_property` can therefore no longer be held by another organisation's mandate. |
| property_keys / key_movements | A AG LM | movements ❌ direct — only `record_key_movement` (A AG LM) · A LM (keys, born `in_office` with no holder) | A LM (keys meta: code, description, property — never status / holder, 0127 trigger) · movements ❌ | ❌ | Movements are append-only like events. 0127: `key_movements_insert` dropped and `property_keys_movement_fields_guard` added — status and holder change only through the RPC, which writes the movement, the cache and the event together. 0122: `property_keys_org_property_fkey` — `(org_id, property_id) → properties (org_id, id)`, ON DELETE CASCADE, replaces the single-column key: a key opens a property of its OWN organisation, so the key-recall sweep can never count another organisation's key. |
| leads | A AG LM | A AG LM (+ service role for website later) | A ✅ · AG 🔒 (`assigned_agent_id = uid` or unassigned→claim) | ❌ (status spam/lost) | 0124: `leads_org_property_fkey` — `(org_id, property_id) → properties (org_id, id)`, NO ACTION, replaces the single-column key: a lead names a property of its OWN organisation or none (the policies check only the caller's org; the key binds every writer). `raise_lead_sla_tasks` and `preview_lead_escalation` read only the lead's own organisation's property. |
| reservations / reservation_installments | A AG LM | A AG LM | A AG LM | A LM (status `released` is the ordinary undo) | 0044 / 0050: every policy checks only the caller's org. 0124: `reservations_org_property_fkey` — `(org_id, property_id) → properties (org_id, id)`, ON DELETE RESTRICT — and `reservation_installments_org_reservation_fkey` — `(org_id, reservation_id) → reservations (org_id, id)`, ON DELETE CASCADE — replace the single-column keys; `reservations_one_live_per_property` is keyed `(org_id, property_id)` and the schedule's position rule `(org_id, reservation_id, sort_order)`, so another organisation's row can neither occupy a property's live slot nor a schedule position. The expiry-warning and instalment sweeps read only their own organisation's reservations and properties when they MINT; since 0125 their task guards and self-heals match only their own organisation's tasks (`tasks_org_reservation_fkey` / `tasks_org_installment_fkey`, see tasks). 0126: `reservations_org_contact_fkey` — `(org_id, contact_id) → contacts (org_id, id)`, ON DELETE SET NULL (contact_id): deleting a contact clears only the hold's contact, never its organisation — replaces the single-column key, so a hold names a contact of its OWN organisation or none; both sweeps copy the hold's contact into the reminder only through `contacts … and ct.org_id = r.org_id` (a hold without one is still reminded). |
| interaction_notes | A AG LM | A AG LM (`created_by = uid`, through `log_conversation`) | ❌ session — service role only (contact erasure, the retention sweep) | ❌ | 0094 (audit SEC-03): a logged conversation's text. The `conversation_logged` event carries the row's id + SHA-256, never the text. Immutable except to be blanked (trigger); the AFTER INSERT trigger writes the event, so no note exists the chain does not know about. |
| portal_connections | A AG LM | A | A | ❌ | 0095: one row per org per portal — enabled, feed token, non-secret settings, last-pull facts. Disabled, never deleted. `portal_connection_by_token` / `note_portal_pull` are SECURITY DEFINER and anon-callable by token. The org-wide SELECT means any member's PostgREST session reads every feed token — a conscious decision: every member can already read the exact `properties.location` of every listing, so the token adds no datum an insider lacks. What it adds is a handle an insider could pass on; the remedy is Regenerate, whose `portal_token_regenerated` event names the actor. |
| notification_jobs | A AG LM | ❌ session — `submit_public_enquiry` (service role) writes it in the lead's transaction | ❌ session — `claim_notification_jobs` / `complete_notification_job` (service role) and `request_enquiry_alert_retry` (authenticated, SECURITY DEFINER: the caller's org, the leads UPDATE rule — A, or AG on `assigned_agent_id = uid` or unassigned — no live lease, not accepted, not redacted); `request_lead_escalation_recovery` (0111; authenticated, SECURITY DEFINER: **A only**, by job id, the caller's org, kind `lead_escalation` only, the lead open/unanswered/not redacted, the policy on with an eligible recipient, no live lease, not accepted, not queued; `retry` keeps the provider key while it is safe, `resend` rotates it only when it is not — a reason required); `preview_lead_escalation` (0112; authenticated, SECURITY DEFINER, STABLE: **A only**, aal2, the caller's org — READS leads, profiles and this table to say what switching the policy on would do; the engine refuses a write inside it) | ❌ (cascades with the lead) | 0101: the desk-alert outbox, one row per website lead. Ids, a state machine, counters and a lease — no person; the e-mail is rebuilt from the lead at send time, so erasure needs no step here (a trigger cancels a pending job when `leads.message` becomes the erasure literal). The org-wide SELECT is what the inbox chip reads. Tested in `supabase/tests/enquiry-alert-outbox.test.ts` and, for the escalation's recovery, `supabase/tests/lead-escalation-recovery.test.ts`. |
| enquiry_alert_sweep_runs | ❌ — no session may read it (the dashboard reads `enquiry_alert_sweep_health()` through the admin client) | ❌ session — `enquiry_alerts_sweep()` (postgres under pg_cron; service_role) | ❌ session — `reconcile_enquiry_alert_sweeps()` (service_role, SECURITY DEFINER: it reads pg_net's response table) | ❌ session — the reconciler prunes rows older than 30 days | 0105: one row per request the desk-alert sweep queues through pg_net, reconciled into an outcome after pg_net has purged the answer. Counts, statuses and codes only — no header, no bearer, no person. `require_aal2` present and no permissive policy, so a signed-in user reads nothing. Tested in `supabase/tests/enquiry-alert-sweep-runs.test.ts`. |
| portal_listings | A AG LM | A LM, AG on an assigned listing (`selected_by = uid`) | ❌ | A LM, AG on an assigned listing | 0095: a listing chosen for a portal. Same rule as `properties_update`. `portal_supplement` (SECURITY DEFINER, by token) returns selected rows that the site feed would show — the only place coordinates leave, and the SQL itself withholds the point of an approximate listing (null lat/lng, flag kept) because the function is reachable by token over PostgREST; the renderers double-check the flag. |
| deal_stages | A AG LM | A | A | A 🔒 (only if no deals reference) | |
| deals | A ✅ · AG 🔒 (`agent_id = uid` OR created_by = uid) · LM 🔒 read-only all | A AG — born open only (0118 guard) | A ✅ · AG 🔒 own — never the status or the closing details: won / lost only through `close_deal` (0117; SECURITY DEFINER since 0118: A, or AG on `agent_id` / `created_by = uid`, aal2, own org — deals_update restated) | ❌ (status lost) | Admin sees all commission notes; agents only own deals'. `deals_closed_guard` (0117, widened by 0118) binds user sessions: on INSERT a deal is open, with no closing detail, in a non-terminal stage of its own org; on an OPEN row no status change, no change to won_at / lost_at / lost_reason / final_value, no move into a won/lost or foreign stage; on a CLOSED row no flip, reopen or closing-detail change. 0131: on a new or OPEN deal the stage and `deal_type` of a session's write must agree (on INSERT, on a stage change and on a type change — a closed deal's `deal_type` is not compared), a stage CHANGE stamps `stage_entered_at` / `last_activity_at` = now(), and a session may not change a deal's `id`. Every open → open stage change in one org — the kanban's `move_deal_to_stage` (invoker: RLS decides who), a direct PATCH / UPSERT, a maintenance write — is recorded by the AFTER UPDATE trigger `deals_stage_changed_event` (SECURITY DEFINER, callable by nobody) as one `stage_changed` from OLD / NEW, actor `auth.uid()`; a close is not a movement. service_role / postgres / definer bodies are the maintenance path. Test: `supabase/tests/stage-movement-authentic.test.ts`. |
| offers | follows parent deal visibility | A AG (own deals) | A ✅ · AG 🔒 own deals | ❌ (status withdrawn) | |
| viewings | A AG LM | A AG | A ✅ · AG 🔒 (`agent_id = uid`) | ❌ (status cancelled) | 0123: `viewings_org_property_fkey` — `(org_id, property_id) → properties (org_id, id)` — and `viewings_org_contact_fkey` — `(org_id, contact_id) → contacts (org_id, id)` — both NO ACTION, replace the single-column keys: a viewing shows a property, and is for a contact, of its OWN organisation (the policies check only the caller's org; the keys bind every writer, service_role included). The nightly sweep's feedback and no-show reminders read only the viewing's own organisation's property. |
| viewing_slips | A AG (agent of viewing) | A AG 🔒 (agent of the viewing) | ❌ | ❌ | Immutable once created |
| documents | A ✅ · AG LM 🔒 (`visibility = 'internal'`; `admin_only` hidden) | A AG LM | A 🔒 (title/type only) | A 🔒 (never an erased contact's retained document — 0134 `documents_kept_for_retention`; the retention purge destroys those, as the service role) | File bodies via signed URLs only. **Contact KYC docs (id_document / proof_of_address / source_of_funds) are `admin_only` — set at upload, backfilled and CHECK-enforced by 0072 against every path incl. service_role. Test 48** |
| share_links | A AG LM (own org) | A AG LM (`created_by = uid`) | creator or A | ❌ **no policy** | anon: **no grant at all** — buyers reach data only via `resolve_share_link` |
| share_link_properties | A AG LM (via parent link) | A AG LM (via parent link) | ❌ | creator or A | |
| share_link_attempts | ❌ no policy, no grant | ❌ | ❌ | ❌ | written only by security-definer functions |
| tasks | A ✅ · AG LM 🔒 (`assignee_id = uid` OR created_by = uid) | A AG LM | assignee or A | creator or A | 0119: `tasks_org_deal_fkey` — `(org_id, deal_id) → deals (org_id, id)`, NO ACTION, replaces the single-column key: a task names a deal of its OWN organisation or none (the policies check only the caller's org; the key binds every writer, service_role included). `deals_supersede_nudges` (0025) completes only the deal's organisation's `deal_no_contact` reminders and writes their `superseded` events into that organisation's chain. 0120: `tasks_org_viewing_fkey` — `(org_id, viewing_id) → viewings (org_id, id)`, the same shape, and `viewings_supersede_nudges` (0020) completes only the viewing's organisation's `viewing_feedback` reminders. 0121: `tasks_org_mandate_fkey` — `(org_id, mandate_id) → mandates (org_id, id)`, the same shape; `raise_key_recall_tasks` (service_role only) and `expire_mandates` (cron) raise and complete only the mandate's own organisation's `key_recall` / `mandate_renewal` reminders — neither guard can be blocked by, nor either self-heal complete, a row of another organisation. 0125: `tasks_org_reservation_fkey` / `tasks_org_installment_fkey` (ON DELETE CASCADE, kept) and `tasks_org_lead_fkey` (NO ACTION) — `(org_id, x) → reservations / reservation_installments / leads (org_id, id)`, the same shape; `warn_expiring_reservations`, `remind_due_installments`, `raise_lead_sla_tasks` and `expire_reservations` (service_role / cron) look for and complete only the parent's own organisation's reminders. 0126: `tasks_org_contact_fkey` / `tasks_org_property_fkey` — `(org_id, contact_id / property_id) → contacts / properties (org_id, id)`, NO ACTION (kept) — complete the set: every record a task can name (deal, viewing, mandate, hold, instalment line, lead, contact, property) is of its own organisation, and a cross-organisation id and a missing one read the same 23503 (the profile links — `assignee_id`, `created_by` — are not keyed by organisation; BACKLOG); `create_followup_nudges`' retention guard (arm 2c) and self-heal (arm 4c) look for and complete only the contact's own organisation's `retention_expired` reminders. |
| cyprus_config | A AG LM (read) | A | A | ❌ | Edits write `config` events |
| events | A ✅ · AG LM 🔒 (`actor_id = uid` OR entity is a record they can read — implement pragmatically: A + AG/LM where actor_id = uid; timeline pages assemble via server actions with service role for cross-entity reads, still org-scoped) | A AG LM 🔒 (`org_id = current_org_id()` **AND `actor_id = auth.uid()`** since 0071 — a staff session cannot append rows naming another user or "system"; null-actor rows come only from crons/service_role, which bypass RLS. Test 47. Since 0128 **not** a deal's `won` / `lost` / `won_override` (`close_deal` writes them) and `occurred_at = now()`; since 0131 **not** a `stage_changed` either, under any entity_type (the `deals_stage_changed_event` trigger writes a deal's from the row change); since 0134 **not** an `erased` or `retention_purged` either, under any entity_type (the erasure and the retention purge write them as the service role); since 0138 **not** an `enquiry_alert`, `lead_escalation` or `opened` either, under any entity_type (the alert worker, the escalation sweep and the public share page write them as the system — two staff-called definers sign their retry / recovery request lines with the caller, RLS does not bind them) — `session-written-events.test.ts`, `stage-movement-authentic.test.ts`, `erasure-lifecycle.test.ts`, `system-event-types.test.ts`) | ❌ **no policy + revoked** | ❌ **no policy + revoked** | The spine. An event names its author, enforced at the DB |

## Storage policies

| Bucket | anon | authenticated (in org) |
|---|---|---|
| `media` | read (public renditions) | read; write via server actions (service role) |
| `documents` | ❌ | ❌ direct — signed URLs generated server-side after RLS check on the `documents` row |
| `signatures` | ❌ | ❌ direct — signed URLs via server action (admin + viewing agent) |

## Grant model (added at T0.4)

Current Supabase does **not** auto-grant table access to `anon`/`authenticated`.
Migration 0002 therefore revokes everything and issues explicit per-table grants
matching this matrix (❌ cells are enforced at grant level too). `anon` receives
zero grants. Column-level rules (profiles: role changes admin-only; documents:
title/type-only updates) are enforced with triggers, since all app users share
the `authenticated` DB role.

**A primary key is never a session's to change (0132).** Every UPDATE policy
above restricts rows, not columns, and `authenticated` holds UPDATE on each
table's key — so before 0132 an admin, an owning agent or listing manager could
PATCH a record's `id` and detach its events, notes and documents (keyed by
`entity_id`, no foreign key), or re-key another record onto a former id and
adopt them. `trg_primary_key_immutable()` (invoker, callable by no role) runs
`BEFORE UPDATE OF <key>` as `<table>_pk_immutable` on the 25 tables other than
deals whose key an API role may update (26 with deals) — areas, buyer_requirements, contacts, cyprus_config
(`key`), deal_stages, districts, documents, leads, mandates, offers,
organizations, payment_plans, portal_connections, price_list_items
(`price_list_id`, `unit_id`), price_lists, profiles, properties, property_keys,
property_media, reservation_installments, reservations, share_links, tasks,
unit_types, viewings — and refuses a session's change of a key VALUE with 42501
"A record's primary key cannot be changed (<table>.<column>)". Restating the key
(an upsert on it, a PATCH carrying the row's own id) passes; service_role,
postgres and definer bodies are the maintenance path. deals: 0131's
`deals_closed_guard`. A table that later gains an UPDATE grant on its key must
get the guard too — `supabase/tests/primary-key-immutable.test.ts`' catalogue
test fails until it does. Caveat: hosted's default privileges give anon and
authenticated full DML on every new public table (0040's REVOKE-before-GRANT
rule), while CI's pinned CLI revokes them — so a new table that skips the REVOKE
is session-updatable on hosted only, and only the restore pack's 0132 row, run
against hosted, reads it (`1 25 true` instead of `0 25 true`).

**Nor is an id that already has history (0133).** events, interaction notes and
documents are keyed by `(entity_type, entity_id)` with no foreign key, so a row a
trusted path deleted leaves its history behind, and before 0133 a session could
INSERT a new row at that id and adopt it. `trg_insert_id_without_history()`
(SECURITY DEFINER — it must see history an agent's `events_select` hides; callable
by no role) runs AFTER INSERT as `<table>_id_without_history` on the 11 history
subjects a session may insert — profiles (`user`, and any event it is the actor
of), contacts, properties, property_keys (`key`), mandates, deals, leads,
viewings, offers, share_links, tasks — and refuses a session's (role GUC
authenticated / anon) row whose id has history of that entity_type in its own
organisation, 42501 "A record cannot be created at an id that already has history
(<table>.id)". AFTER, so it answers only for a row RLS admitted (no oracle for an
aal1 session, a refused role or another organisation); an upsert that conflicts
never reaches it. A fresh id (the lead convert's deal, the invite's profile) and
the service role / postgres (imports, restores) pass. History keyed by an event
PAYLOAD (documents, deal stages, a note's text, an imported viewing's feedback) is
a BACKLOG entry.

**A contact's erasure is not a session's to undo (0134).** `contacts_update`
restricts rows, not columns, so before 0134 an admin or the contact's owning
agent could PATCH an erased contact's `erased_at`, `erased_by`,
`retention_until`, `is_archived`, `temperature` or `consent_marketing` — clear the
marker and unarchive it, put it back on the hot-buyer card and into its phone's
uniqueness slot, or move the retention date so the purge destroyed AML records
early — and `contacts_insert` admitted a contact born "erased".
`trg_contacts_erasure_lifecycle()` (invoker, callable by no role) runs `BEFORE
INSERT OR UPDATE` on contacts as `contacts_retain_erasure` and refuses, for a
session (authenticated / anon), with 42501: an INSERT carrying any of
`erased_at` / `erased_by` / `retention_until`; an UPDATE changing any of them
(restating passes); and any change to an erased contact but archiving it (the
whole row less `updated_at` and the generated `display_name`). Its documents
are the retention's: `trg_documents_kept_for_retention()` runs `BEFORE DELETE`
on documents as `documents_kept_for_retention` and refuses a session's delete
of an erased contact's document while its retention date is set — only the
retention purge destroys those (a document under no duty stays deletable,
and an evidence report may still be added for an erased contact). The
erasure's document-row delete, contact patch and `erased` event, and the
purge's document-row delete, marker update and `retention_purged` event, run as
the service role from `lib/actions/contact-erasure.ts`, after its admin /
organisation / typed-name / expiry checks and bounded by the organisation and
the contact; `events_insert` refuses a session's `erased` / `retention_purged`,
so the record the erasure trusts cannot be forged. `mergeContacts` (service
role) refuses an erased contact itself, at its read and at its writes. The
restore pack's 0134 row reads both triggers, the guards' session binding and
the policy clause. Deploy-coupled: the application first, then 0134.

## Policy SQL patterns (use these shapes)

```sql
-- org isolation + role, example: properties UPDATE for agents
create policy properties_update_agent on properties
for update using (
  org_id = current_org_id()
  and (
    current_role_gnk() in ('admin','listing_manager')
    or assigned_agent_id = auth.uid()
  )
) with check (org_id = current_org_id());

-- events: insert-only, and the insert names its author (0071); a deal's
-- terminal events (0128) and its stage movement (0131) are written by the
-- database, a contact's erasure and retention purge (0134) by the service
-- role, and the desk alert's, the escalation's and the share page's lines
-- (0138) by the system, never by a session; a session's event occurs at its
-- insert (0128)
create policy events_insert on events
for insert with check (org_id = current_org_id()
  and actor_id = auth.uid()
  and not (entity_type = 'deal' and event_type in ('won', 'lost', 'won_override'))
  and event_type <> 'stage_changed'   -- any entity_type: only the trigger writes it
  and event_type not in ('erased', 'retention_purged')   -- 0134: the erasure's and the purge's, as the system
  and event_type not in ('enquiry_alert', 'lead_escalation', 'opened')   -- 0138: the alert worker's, the escalation's, the share page's
  and occurred_at = now());
create policy events_select_admin on events
for select using (org_id = current_org_id()
  and (current_role_gnk() = 'admin' or actor_id = auth.uid()));
-- (no update/delete policies exist; grants already revoked in doc 03)

-- mandates commission masking
-- NOTE (fixed at T0.4): the view is owner-rights (bypasses base RLS), so it MUST
-- implement org isolation + role row rules itself — the original draft lacked the
-- WHERE clause, which would have leaked cross-org rows. LM has no base-table
-- policy at all (reads only via this view); admin/agent may use either path.
create view mandates_safe as
  select id, org_id, property_id, owner_contact_id, type, status,
         start_date, expiry_date, renewal_reminder_days, notes,
         signed_document_id, created_by, created_at, updated_at,
         case when current_role_gnk() = 'admin'
                or exists (select 1 from properties p
                           where p.id = mandates.property_id
                             and p.assigned_agent_id = auth.uid())
              then commission_pct end as commission_pct,
         case when current_role_gnk() = 'admin'
                or exists (select 1 from properties p
                           where p.id = mandates.property_id
                             and p.assigned_agent_id = auth.uid())
              then commission_notes end as commission_notes
  from mandates
  where org_id = current_org_id()
    and (current_role_gnk() in ('admin','listing_manager')
         or (current_role_gnk() = 'agent'
             and (created_by = auth.uid()
                  or exists (select 1 from properties p
                             where p.id = mandates.property_id
                               and p.assigned_agent_id = auth.uid()))));
grant select on mandates_safe to authenticated;
```

## Mandatory RLS tests (minimum set — one test per line)

1. Cross-org: user of org B selects properties/contacts/deals/events of org A → 0 rows.
2. anon selects any table → denied.
3. Agent updates property not assigned to them → denied; assigned → allowed.
4. Agent reads another agent's deal → denied; admin reads all → allowed.
5. LM reads mandate → `commission_pct` is null via `mandates_safe`; admin sees value.
6. Any role UPDATE/DELETE on `events` → denied (both policy and grant level).
7. Any role UPDATE on `viewing_slips` → denied.
8. Agent updates own profile role field → denied (column-level: role changes admin-only; enforce via separate admin-only policy or trigger).
9. Direct INSERT into `price_history` as any role → denied; price change via property update creates row.
10. Non-admin INSERT/UPDATE on `cyprus_config` → denied.
11. Unassigned lead claimed by agent (update sets `assigned_agent_id = uid`) → allowed; unassigned lead updated by agent without claiming (status only) → allowed; reassigning someone else's lead as agent → denied; agent handing their **own** lead to another agent → denied (WITH CHECK — migration 0009; permissive policies OR their WITH CHECKs independently of USING, so the admin policy must repeat its role check there).
12. `verify_events_chain(org)` true after seeded activity; false after service-role manual tamper (test-only).
13. `key_movements` written only by `record_key_movement`: direct INSERT (0127), UPDATE and DELETE denied for every role.
14. Deals: agent setting both `agent_id` and `created_by` away from themselves → denied (WITH CHECK, 0009); creator changing the working agent while staying `created_by` → allowed (own = `agent_id` OR `created_by`).
15. `property_keys`: agent INSERT (register) → denied, LM → allowed; agent UPDATE (keys meta) → 0 rows, LM → allowed; org B blind. Movements only via `record_key_movement` RPC (0013): cross-org → not found; status transitions guarded (no double checkout, lost blocks checkout until return); movement + cache + event land atomically or not at all.
16. Contacts' erasure lifecycle (0134): an admin's and an owning agent's PATCH / bulk PATCH / upsert of `erased_at`, `erased_by` or `retention_until`, and any change to an erased contact but archiving it → 42501, nothing moves; an INSERT carrying them (admin, agent, LM) → 42501; an admin's DELETE of an erased contact's retained document → 42501; a session's `erased` / `retention_purged` event → 42501; the real erasure and purge (service role) still work — `erasure-lifecycle.test.ts`.
