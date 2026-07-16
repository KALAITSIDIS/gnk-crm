-- =============================================================================
-- 0009 — Tighten UPDATE WITH CHECK on leads & deals (audit fix, 2026-07-16)
--
-- Postgres combines permissive policies with OR *independently* for USING and
-- WITH CHECK: an UPDATE passes if the old row satisfies ANY policy's USING and
-- the new row satisfies ANY policy's WITH CHECK. The *_update_admin policies
-- carried role checks only in USING, so their org-only WITH CHECK was
-- reachable by agents whose update passed the agent policy's USING — letting
-- an agent hand their own lead/deal to another agent, bypassing the intended
-- lockdown (doc 04: leads AG 🔒 `assigned_agent_id = uid` or unassigned→claim;
-- deals AG 🔒 own).
--
-- Fix:
--   * admin policies: repeat the role check in WITH CHECK.
--   * leads agent policy: new row may stay unassigned or be self-assigned
--     (agents act on inbox leads without claiming — mark contacted/called,
--     link contact — and claiming sets uid), but never a third party.
--   * deals agent policy: new row must keep the deal "own" (agent_id = uid OR
--     created_by = uid), mirroring the doc 04 ownership definition.
--
-- Same-shaped policies on contacts/properties/viewings/tasks intentionally
-- allow row hand-off between org members (collaboration); reviewed and left
-- as-is — see docs/DECISIONS.md.
-- =============================================================================

alter policy leads_update_admin on leads
  with check (org_id = current_org_id() and current_role_gnk() = 'admin');

alter policy leads_update_agent on leads
  with check (org_id = current_org_id()
              and (assigned_agent_id = auth.uid() or assigned_agent_id is null));

alter policy deals_update_admin on deals
  with check (org_id = current_org_id() and current_role_gnk() = 'admin');

alter policy deals_update_agent on deals
  with check (org_id = current_org_id()
              and (agent_id = auth.uid() or created_by = auth.uid()));
