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
> caller holds an **`aal2`** session, **or has no verified second factor at all**
> (the Supabase opt-in template, so users who have not enrolled are unaffected).
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

Legend: ✅ full · 🔒 restricted (condition in Notes) · ❌ denied

| Table | SELECT | INSERT | UPDATE | DELETE | Notes |
|---|---|---|---|---|---|
| organizations | A AG LM (own org row) | ❌ | A 🔒 (own org) | ❌ | Org created by seed/service role only |
| profiles | A AG LM (all in org) | A | A ✅ · AG/LM 🔒 own row (name, locale, phone only) | ❌ (deactivate via `is_active`) | User creation via admin invite (service role) |
| districts / areas | A AG LM | A | A | A 🔒 (only if unused) | |
| reference_counters | ❌ direct | ❌ | ❌ | ❌ | Accessed only via `next_reference()` (security definer) |
| contacts | A AG LM | A AG LM | A ✅ · AG 🔒 (`assigned_agent_id = uid` OR `created_by = uid`) · LM ❌ | ❌ (archive flag instead; archive = UPDATE rule) | Merge runs server-side (service role) and logs events |
| properties | A AG LM (all, incl. off_market — internal team) | A LM · AG 🔒 (auto-assigned to self) | A LM ✅ · AG 🔒 (`assigned_agent_id = uid`) | ❌ (status `withdrawn` + visibility `archived`) | |
| property_media | A AG LM | A LM · AG 🔒 (own properties) | A LM | A LM | |
| price_history | A AG LM | ❌ direct | ❌ | ❌ | Written only by trigger |
| price_lists / items / payment_plans | A AG LM | A LM | A LM | A LM 🔒 (not latest version) | |
| mandates | A ✅ · AG 🔒 rows where `assigned_agent` on property = uid OR created_by = uid · LM 🔒 (row visible but **commission_pct, commission_notes** masked via view for LM) | A | A | ❌ (status terminated) | Commission figures = admin + property's assigned agent only. Implement mask with `mandates_safe` view; LM/others select from view. |
| property_keys / key_movements | A AG LM | A AG LM (movements) · A LM (keys) | A LM (keys meta) · movements ❌ | ❌ | Movements are append-only like events |
| leads | A AG LM | A AG LM (+ service role for website later) | A ✅ · AG 🔒 (`assigned_agent_id = uid` or unassigned→claim) | ❌ (status spam/lost) | |
| deal_stages | A AG LM | A | A | A 🔒 (only if no deals reference) | |
| deals | A ✅ · AG 🔒 (`agent_id = uid` OR created_by = uid) · LM 🔒 read-only all | A AG | A ✅ · AG 🔒 own | ❌ (status lost) | Admin sees all commission notes; agents only own deals' |
| offers | follows parent deal visibility | A AG (own deals) | A ✅ · AG 🔒 own deals | ❌ (status withdrawn) | |
| viewings | A AG LM | A AG | A ✅ · AG 🔒 (`agent_id = uid`) | ❌ (status cancelled) | |
| viewing_slips | A AG (agent of viewing) | A AG 🔒 (agent of the viewing) | ❌ | ❌ | Immutable once created |
| documents | A ✅ · AG LM 🔒 (`visibility = 'internal'`; `admin_only` hidden) | A AG LM | A 🔒 (title/type only) | A | File bodies via signed URLs only. **Contact KYC docs (id_document / proof_of_address / source_of_funds) are `admin_only` — set at upload, backfilled and CHECK-enforced by 0072 against every path incl. service_role. Test 48** |
| share_links | A AG LM (own org) | A AG LM (`created_by = uid`) | creator or A | ❌ **no policy** | anon: **no grant at all** — buyers reach data only via `resolve_share_link` |
| share_link_properties | A AG LM (via parent link) | A AG LM (via parent link) | ❌ | creator or A | |
| share_link_attempts | ❌ no policy, no grant | ❌ | ❌ | ❌ | written only by security-definer functions |
| tasks | A ✅ · AG LM 🔒 (`assignee_id = uid` OR created_by = uid) | A AG LM | assignee or A | creator or A | |
| cyprus_config | A AG LM (read) | A | A | ❌ | Edits write `config` events |
| events | A ✅ · AG LM 🔒 (`actor_id = uid` OR entity is a record they can read — implement pragmatically: A + AG/LM where actor_id = uid; timeline pages assemble via server actions with service role for cross-entity reads, still org-scoped) | A AG LM 🔒 (`org_id = current_org_id()` **AND `actor_id = auth.uid()`** since 0071 — a staff session cannot append rows naming another user or "system"; null-actor rows come only from crons/service_role, which bypass RLS. Test 47) | ❌ **no policy + revoked** | ❌ **no policy + revoked** | The spine. An event names its author, enforced at the DB |

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

-- events: insert-only, and the insert names its author (0071)
create policy events_insert on events
for insert with check (org_id = current_org_id()
  and actor_id = auth.uid());
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
13. `key_movements` append-only: staff INSERT allowed; UPDATE/DELETE denied for every role.
14. Deals: agent setting both `agent_id` and `created_by` away from themselves → denied (WITH CHECK, 0009); creator changing the working agent while staying `created_by` → allowed (own = `agent_id` OR `created_by`).
15. `property_keys`: agent INSERT (register) → denied, LM → allowed; agent UPDATE (keys meta) → 0 rows, LM → allowed; org B blind. Movements only via `record_key_movement` RPC (0013): cross-org → not found; status transitions guarded (no double checkout, lost blocks checkout until return); movement + cache + event land atomically or not at all.
