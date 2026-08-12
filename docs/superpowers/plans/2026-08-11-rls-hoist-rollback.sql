-- ROLLBACK SCRIPT for migration 0030_hoist_rls_helpers.sql.
--
-- These are the 24 policy definitions EXACTLY as they stood before 0030, with
-- the helper calls bare. Running this file restores the pre-0030 state.
--
-- Generated from pg_policies on 2026-08-11, not hand-written, so it cannot
-- differ from what was actually deployed by a transcription slip.
--
-- Postgres has no `create or replace policy`, so each entry drops first.

drop policy contacts_insert on public.contacts;
create policy contacts_insert on public.contacts
  for insert to public
  with check (((org_id = current_org_id()) AND (current_role_gnk() = ANY (ARRAY['admin'::user_role, 'agent'::user_role, 'listing_manager'::user_role]))));

drop policy contacts_select on public.contacts;
create policy contacts_select on public.contacts
  for select to public
  using ((org_id = current_org_id()));

drop policy contacts_update_admin on public.contacts;
create policy contacts_update_admin on public.contacts
  for update to public
  using (((org_id = current_org_id()) AND (current_role_gnk() = 'admin'::user_role)))
  with check ((org_id = current_org_id()));

drop policy contacts_update_agent on public.contacts;
create policy contacts_update_agent on public.contacts
  for update to public
  using (((org_id = current_org_id()) AND (current_role_gnk() = 'agent'::user_role) AND ((assigned_agent_id = auth.uid()) OR (created_by = auth.uid()))))
  with check ((org_id = current_org_id()));

drop policy deals_insert on public.deals;
create policy deals_insert on public.deals
  for insert to public
  with check (((org_id = current_org_id()) AND (current_role_gnk() = ANY (ARRAY['admin'::user_role, 'agent'::user_role]))));

drop policy deals_select on public.deals;
create policy deals_select on public.deals
  for select to public
  using (((org_id = current_org_id()) AND ((current_role_gnk() = ANY (ARRAY['admin'::user_role, 'listing_manager'::user_role])) OR (agent_id = auth.uid()) OR (created_by = auth.uid()))));

drop policy deals_update_admin on public.deals;
create policy deals_update_admin on public.deals
  for update to public
  using (((org_id = current_org_id()) AND (current_role_gnk() = 'admin'::user_role)))
  with check (((org_id = current_org_id()) AND (current_role_gnk() = 'admin'::user_role)));

drop policy deals_update_agent on public.deals;
create policy deals_update_agent on public.deals
  for update to public
  using (((org_id = current_org_id()) AND (current_role_gnk() = 'agent'::user_role) AND ((agent_id = auth.uid()) OR (created_by = auth.uid()))))
  with check (((org_id = current_org_id()) AND ((agent_id = auth.uid()) OR (created_by = auth.uid()))));

drop policy events_insert on public.events;
create policy events_insert on public.events
  for insert to public
  with check ((org_id = current_org_id()));

drop policy events_select on public.events;
create policy events_select on public.events
  for select to public
  using (((org_id = current_org_id()) AND ((current_role_gnk() = 'admin'::user_role) OR (actor_id = auth.uid()))));

drop policy leads_insert on public.leads;
create policy leads_insert on public.leads
  for insert to public
  with check (((org_id = current_org_id()) AND (current_role_gnk() = ANY (ARRAY['admin'::user_role, 'agent'::user_role, 'listing_manager'::user_role]))));

drop policy leads_select on public.leads;
create policy leads_select on public.leads
  for select to public
  using ((org_id = current_org_id()));

drop policy leads_update_admin on public.leads;
create policy leads_update_admin on public.leads
  for update to public
  using (((org_id = current_org_id()) AND (current_role_gnk() = 'admin'::user_role)))
  with check (((org_id = current_org_id()) AND (current_role_gnk() = 'admin'::user_role)));

drop policy leads_update_agent on public.leads;
create policy leads_update_agent on public.leads
  for update to public
  using (((org_id = current_org_id()) AND (current_role_gnk() = 'agent'::user_role) AND ((assigned_agent_id = auth.uid()) OR (assigned_agent_id IS NULL))))
  with check (((org_id = current_org_id()) AND ((assigned_agent_id = auth.uid()) OR (assigned_agent_id IS NULL))));

drop policy properties_insert on public.properties;
create policy properties_insert on public.properties
  for insert to public
  with check (((org_id = current_org_id()) AND ((current_role_gnk() = ANY (ARRAY['admin'::user_role, 'listing_manager'::user_role])) OR ((current_role_gnk() = 'agent'::user_role) AND (assigned_agent_id = auth.uid())))));

drop policy properties_select on public.properties;
create policy properties_select on public.properties
  for select to public
  using ((org_id = current_org_id()));

drop policy properties_update on public.properties;
create policy properties_update on public.properties
  for update to public
  using (((org_id = current_org_id()) AND ((current_role_gnk() = ANY (ARRAY['admin'::user_role, 'listing_manager'::user_role])) OR ((current_role_gnk() = 'agent'::user_role) AND (assigned_agent_id = auth.uid())))))
  with check ((org_id = current_org_id()));

drop policy tasks_delete on public.tasks;
create policy tasks_delete on public.tasks
  for delete to public
  using (((org_id = current_org_id()) AND ((current_role_gnk() = 'admin'::user_role) OR (created_by = auth.uid()))));

drop policy tasks_insert on public.tasks;
create policy tasks_insert on public.tasks
  for insert to public
  with check (((org_id = current_org_id()) AND (current_role_gnk() = ANY (ARRAY['admin'::user_role, 'agent'::user_role, 'listing_manager'::user_role]))));

drop policy tasks_select on public.tasks;
create policy tasks_select on public.tasks
  for select to public
  using (((org_id = current_org_id()) AND ((current_role_gnk() = 'admin'::user_role) OR (assignee_id = auth.uid()) OR (created_by = auth.uid()))));

drop policy tasks_update on public.tasks;
create policy tasks_update on public.tasks
  for update to public
  using (((org_id = current_org_id()) AND ((current_role_gnk() = 'admin'::user_role) OR (assignee_id = auth.uid()))))
  with check ((org_id = current_org_id()));

drop policy viewings_insert on public.viewings;
create policy viewings_insert on public.viewings
  for insert to public
  with check (((org_id = current_org_id()) AND (current_role_gnk() = ANY (ARRAY['admin'::user_role, 'agent'::user_role]))));

drop policy viewings_select on public.viewings;
create policy viewings_select on public.viewings
  for select to public
  using ((org_id = current_org_id()));

drop policy viewings_update on public.viewings;
create policy viewings_update on public.viewings
  for update to public
  using (((org_id = current_org_id()) AND ((current_role_gnk() = 'admin'::user_role) OR ((current_role_gnk() = 'agent'::user_role) AND (agent_id = auth.uid())))))
  with check ((org_id = current_org_id()));
