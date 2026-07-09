# 04 — RLS POLICY MATRIX (Phase 1)

Implement in `supabase/migrations/0002_rls_policies.sql`. Every row below has an automated test in `supabase/tests` / `npm run test:rls`. Roles: **A** = admin, **AG** = agent, **LM** = listing_manager. All access additionally requires `org_id = current_org_id()` — org isolation is the outer condition on every policy. `anon` has **zero** table access in Phase 1.

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
| documents | A ✅ · AG LM 🔒 (`visibility = 'internal'`; `admin_only` hidden) | A AG LM | A 🔒 (title/type only) | A | File bodies via signed URLs only |
| tasks | A ✅ · AG LM 🔒 (`assignee_id = uid` OR created_by = uid) | A AG LM | assignee or A | creator or A | |
| cyprus_config | A AG LM (read) | A | A | ❌ | Edits write `config` events |
| events | A ✅ · AG LM 🔒 (`actor_id = uid` OR entity is a record they can read — implement pragmatically: A + AG/LM where actor_id = uid; timeline pages assemble via server actions with service role for cross-entity reads, still org-scoped) | A AG LM (org check only) | ❌ **no policy + revoked** | ❌ **no policy + revoked** | The spine. Insert check: `org_id = current_org_id()` |

## Storage policies

| Bucket | anon | authenticated (in org) |
|---|---|---|
| `media` | read (public renditions) | read; write via server actions (service role) |
| `documents` | ❌ | ❌ direct — signed URLs generated server-side after RLS check on the `documents` row |
| `signatures` | ❌ | ❌ direct — signed URLs via server action (admin + viewing agent) |

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

-- events: insert-only
create policy events_insert on events
for insert with check (org_id = current_org_id());
create policy events_select_admin on events
for select using (org_id = current_org_id()
  and (current_role_gnk() = 'admin' or actor_id = auth.uid()));
-- (no update/delete policies exist; grants already revoked in doc 03)

-- mandates commission masking
create view mandates_safe as
  select id, org_id, property_id, owner_contact_id, type, status,
         start_date, expiry_date, renewal_reminder_days, notes,
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
  from mandates;
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
11. Unassigned lead claimed by agent (update sets `assigned_agent_id = uid`) → allowed; reassigning someone else's lead as agent → denied.
12. `verify_events_chain(org)` true after seeded activity; false after service-role manual tamper (test-only).
