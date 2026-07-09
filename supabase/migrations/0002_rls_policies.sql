-- =============================================================================
-- 0002_rls_policies.sql — RLS policies per docs/04_RLS_POLICY_MATRIX.md
--
-- POLICY CHECKLIST (pg_policies count per table — verified against pg_policies,
-- total OURS = 80: 79 in public + 1 on storage.objects; pg_cron adds 2 of its own):
--   organizations    2  (select, update)
--   profiles         4  (select, insert, update_admin, update_own)
--   districts        4  (select, insert, update, delete-if-unused)
--   areas            4  (select, insert, update, delete-if-unused)
--   contacts         4  (select, insert, update_admin, update_agent)
--   properties       3  (select, insert, update)
--   property_media   4  (select, insert, update, delete)
--   price_history    1  (select)
--   price_lists      4  (select, insert, update, delete-not-latest)
--   price_list_items 4  (select, insert, update, delete-not-latest)
--   payment_plans    4  (select, insert, update, delete)
--   mandates         3  (select, insert, update)
--   property_keys    3  (select, insert, update)
--   key_movements    2  (select, insert)
--   leads            4  (select, insert, update_admin, update_agent)
--   deal_stages      4  (select, insert, update, delete-if-unreferenced)
--   deals            4  (select, insert, update_admin, update_agent)
--   offers           3  (select, insert, update)
--   viewings         3  (select, insert, update)
--   viewing_slips    2  (select, insert)
--   documents        4  (select, insert, update, delete)
--   tasks            4  (select, insert, update, delete)
--   cyprus_config    3  (select, insert, update)
--   events           2  (select, insert)
--   storage.objects  1  (media public read)
--   reference_counters 0 (no direct access — security definer fn only)
--
-- Grant model: this CLI/cloud generation does NOT auto-grant table access to
-- anon/authenticated. We revoke everything anyway (belt and braces), then grant
-- exactly what the matrix allows. anon gets ZERO table access in Phase 1.
-- Column-level rules (profiles role-change, documents title/type-only) are
-- enforced with triggers, since all app users share the `authenticated` DB role.
-- =============================================================================

-- ---------- grant hygiene ----------
revoke all on all tables in schema public from anon, authenticated;

-- service_role: this Supabase generation does not auto-grant new tables to any
-- role, service_role included. It has BYPASSRLS but still needs table grants.
-- (Server-only admin client + import scripts + test harness run as service_role.)
grant all on all tables in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;

-- authenticated: per-table grants (rows/roles then constrained by policies)
grant select, update                 on organizations      to authenticated;
grant select, insert, update         on profiles           to authenticated;
grant select, insert, update, delete on districts          to authenticated;
grant select, insert, update, delete on areas              to authenticated;
grant select, insert, update         on contacts           to authenticated;
grant select, insert, update         on properties         to authenticated;
grant select, insert, update, delete on property_media     to authenticated;
grant select                         on price_history      to authenticated;
grant select, insert, update, delete on price_lists        to authenticated;
grant select, insert, update, delete on price_list_items   to authenticated;
grant select, insert, update, delete on payment_plans      to authenticated;
grant select, insert, update         on mandates           to authenticated;
grant select, insert, update         on property_keys      to authenticated;
grant select, insert                 on key_movements      to authenticated;
grant select, insert, update         on leads              to authenticated;
grant select, insert, update, delete on deal_stages        to authenticated;
grant select, insert, update         on deals              to authenticated;
grant select, insert, update         on offers             to authenticated;
grant select, insert, update         on viewings           to authenticated;
grant select, insert                 on viewing_slips      to authenticated;
grant select, insert, update, delete on documents          to authenticated;
grant select, insert, update, delete on tasks              to authenticated;
grant select, insert, update         on cyprus_config      to authenticated;
grant select, insert                 on events              to authenticated;
-- reference_counters: no grants (next_reference() is security definer)

-- append-only tables: make immutability explicit at grant level too
revoke update, delete, truncate on key_movements  from anon, authenticated;
revoke update, delete, truncate on viewing_slips  from anon, authenticated;
revoke insert, update, delete, truncate on price_history from anon, authenticated;
grant select on price_history to authenticated;

-- ---------- organizations ----------
create policy organizations_select on organizations for select
  using (id = current_org_id());
create policy organizations_update on organizations for update
  using (id = current_org_id() and current_role_gnk() = 'admin')
  with check (id = current_org_id());

-- ---------- profiles ----------
create policy profiles_select on profiles for select
  using (org_id = current_org_id());
create policy profiles_insert on profiles for insert
  with check (org_id = current_org_id() and current_role_gnk() = 'admin');
create policy profiles_update_admin on profiles for update
  using (org_id = current_org_id() and current_role_gnk() = 'admin')
  with check (org_id = current_org_id());
create policy profiles_update_own on profiles for update
  using (id = auth.uid())
  with check (id = auth.uid() and org_id = current_org_id());

-- non-admins may only change name/locale/phone on their own row (matrix test 8)
create or replace function protect_profile_columns() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and coalesce(current_role_gnk()::text,'') <> 'admin' then
    if new.id         is distinct from old.id
       or new.org_id  is distinct from old.org_id
       or new.role    is distinct from old.role
       or new.email   is distinct from old.email
       or new.is_active is distinct from old.is_active then
      raise exception 'only admin may change role, org, email or active flag';
    end if;
  end if;
  return new;
end $$;
create trigger profiles_protect before update on profiles
  for each row execute function protect_profile_columns();

-- ---------- districts / areas ----------
create policy districts_select on districts for select
  using (org_id = current_org_id());
create policy districts_insert on districts for insert
  with check (org_id = current_org_id() and current_role_gnk() = 'admin');
create policy districts_update on districts for update
  using (org_id = current_org_id() and current_role_gnk() = 'admin')
  with check (org_id = current_org_id());
create policy districts_delete on districts for delete
  using (org_id = current_org_id() and current_role_gnk() = 'admin'
         and not exists (select 1 from properties p where p.district_id = districts.id)
         and not exists (select 1 from areas a where a.district_id = districts.id));

create policy areas_select on areas for select
  using (org_id = current_org_id());
create policy areas_insert on areas for insert
  with check (org_id = current_org_id() and current_role_gnk() = 'admin');
create policy areas_update on areas for update
  using (org_id = current_org_id() and current_role_gnk() = 'admin')
  with check (org_id = current_org_id());
create policy areas_delete on areas for delete
  using (org_id = current_org_id() and current_role_gnk() = 'admin'
         and not exists (select 1 from properties p where p.area_id = areas.id));

-- ---------- contacts ----------
create policy contacts_select on contacts for select
  using (org_id = current_org_id());
create policy contacts_insert on contacts for insert
  with check (org_id = current_org_id()
              and current_role_gnk() in ('admin','agent','listing_manager'));
create policy contacts_update_admin on contacts for update
  using (org_id = current_org_id() and current_role_gnk() = 'admin')
  with check (org_id = current_org_id());
create policy contacts_update_agent on contacts for update
  using (org_id = current_org_id() and current_role_gnk() = 'agent'
         and (assigned_agent_id = auth.uid() or created_by = auth.uid()))
  with check (org_id = current_org_id());

-- ---------- properties ----------
create policy properties_select on properties for select
  using (org_id = current_org_id());
create policy properties_insert on properties for insert
  with check (org_id = current_org_id()
              and (current_role_gnk() in ('admin','listing_manager')
                   or (current_role_gnk() = 'agent' and assigned_agent_id = auth.uid())));
create policy properties_update on properties for update
  using (org_id = current_org_id()
         and (current_role_gnk() in ('admin','listing_manager')
              or (current_role_gnk() = 'agent' and assigned_agent_id = auth.uid())))
  with check (org_id = current_org_id());

-- ---------- property_media ----------
create policy property_media_select on property_media for select
  using (org_id = current_org_id());
create policy property_media_insert on property_media for insert
  with check (org_id = current_org_id()
              and (current_role_gnk() in ('admin','listing_manager')
                   or (current_role_gnk() = 'agent' and exists (
                        select 1 from properties p
                        where p.id = property_id and p.assigned_agent_id = auth.uid()))));
create policy property_media_update on property_media for update
  using (org_id = current_org_id() and current_role_gnk() in ('admin','listing_manager'))
  with check (org_id = current_org_id());
create policy property_media_delete on property_media for delete
  using (org_id = current_org_id() and current_role_gnk() in ('admin','listing_manager'));

-- ---------- price_history (trigger-written; read-only for users) ----------
create policy price_history_select on price_history for select
  using (org_id = current_org_id());

-- ---------- price_lists / items / payment_plans ----------
create policy price_lists_select on price_lists for select
  using (org_id = current_org_id());
create policy price_lists_insert on price_lists for insert
  with check (org_id = current_org_id() and current_role_gnk() in ('admin','listing_manager'));
create policy price_lists_update on price_lists for update
  using (org_id = current_org_id() and current_role_gnk() in ('admin','listing_manager'))
  with check (org_id = current_org_id());
create policy price_lists_delete on price_lists for delete
  using (org_id = current_org_id() and current_role_gnk() in ('admin','listing_manager')
         and version < (select max(pl.version) from price_lists pl
                        where pl.project_id = price_lists.project_id));

create policy price_list_items_select on price_list_items for select
  using (exists (select 1 from price_lists pl
                 where pl.id = price_list_id and pl.org_id = current_org_id()));
create policy price_list_items_insert on price_list_items for insert
  with check (current_role_gnk() in ('admin','listing_manager')
              and exists (select 1 from price_lists pl
                          where pl.id = price_list_id and pl.org_id = current_org_id()));
create policy price_list_items_update on price_list_items for update
  using (current_role_gnk() in ('admin','listing_manager')
         and exists (select 1 from price_lists pl
                     where pl.id = price_list_id and pl.org_id = current_org_id()))
  with check (exists (select 1 from price_lists pl
                      where pl.id = price_list_id and pl.org_id = current_org_id()));
create policy price_list_items_delete on price_list_items for delete
  using (current_role_gnk() in ('admin','listing_manager')
         and exists (select 1 from price_lists pl
                     where pl.id = price_list_id and pl.org_id = current_org_id()
                       and pl.version < (select max(pl2.version) from price_lists pl2
                                         where pl2.project_id = pl.project_id)));

create policy payment_plans_select on payment_plans for select
  using (org_id = current_org_id());
create policy payment_plans_insert on payment_plans for insert
  with check (org_id = current_org_id() and current_role_gnk() in ('admin','listing_manager'));
create policy payment_plans_update on payment_plans for update
  using (org_id = current_org_id() and current_role_gnk() in ('admin','listing_manager'))
  with check (org_id = current_org_id());
create policy payment_plans_delete on payment_plans for delete
  using (org_id = current_org_id() and current_role_gnk() in ('admin','listing_manager'));

-- ---------- mandates ----------
-- Base table: admin all; agent = own (assigned on property, or creator).
-- LM has NO base-table access — LM reads via mandates_safe (masked columns).
create policy mandates_select on mandates for select
  using (org_id = current_org_id()
         and (current_role_gnk() = 'admin'
              or (current_role_gnk() = 'agent'
                  and (created_by = auth.uid()
                       or exists (select 1 from properties p
                                  where p.id = mandates.property_id
                                    and p.assigned_agent_id = auth.uid())))));
create policy mandates_insert on mandates for insert
  with check (org_id = current_org_id() and current_role_gnk() = 'admin');
create policy mandates_update on mandates for update
  using (org_id = current_org_id() and current_role_gnk() = 'admin')
  with check (org_id = current_org_id());

-- Masked view. Deliberately NOT security_invoker: it implements its own org +
-- role row rules (matching the matrix) and masks commission for everyone except
-- admin and the property's assigned agent. Doc 04 pattern updated accordingly.
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

-- ---------- property_keys / key_movements ----------
create policy property_keys_select on property_keys for select
  using (org_id = current_org_id());
create policy property_keys_insert on property_keys for insert
  with check (org_id = current_org_id() and current_role_gnk() in ('admin','listing_manager'));
create policy property_keys_update on property_keys for update
  using (org_id = current_org_id() and current_role_gnk() in ('admin','listing_manager'))
  with check (org_id = current_org_id());

create policy key_movements_select on key_movements for select
  using (org_id = current_org_id());
create policy key_movements_insert on key_movements for insert
  with check (org_id = current_org_id()
              and current_role_gnk() in ('admin','agent','listing_manager'));

-- ---------- leads ----------
create policy leads_select on leads for select
  using (org_id = current_org_id());
create policy leads_insert on leads for insert
  with check (org_id = current_org_id()
              and current_role_gnk() in ('admin','agent','listing_manager'));
create policy leads_update_admin on leads for update
  using (org_id = current_org_id() and current_role_gnk() = 'admin')
  with check (org_id = current_org_id());
-- agent: own leads, or claim an unassigned one; may never hand a lead to someone else
create policy leads_update_agent on leads for update
  using (org_id = current_org_id() and current_role_gnk() = 'agent'
         and (assigned_agent_id = auth.uid() or assigned_agent_id is null))
  with check (org_id = current_org_id() and assigned_agent_id = auth.uid());

-- ---------- deal_stages ----------
create policy deal_stages_select on deal_stages for select
  using (org_id = current_org_id());
create policy deal_stages_insert on deal_stages for insert
  with check (org_id = current_org_id() and current_role_gnk() = 'admin');
create policy deal_stages_update on deal_stages for update
  using (org_id = current_org_id() and current_role_gnk() = 'admin')
  with check (org_id = current_org_id());
create policy deal_stages_delete on deal_stages for delete
  using (org_id = current_org_id() and current_role_gnk() = 'admin'
         and not exists (select 1 from deals d where d.stage_id = deal_stages.id));

-- ---------- deals ----------
create policy deals_select on deals for select
  using (org_id = current_org_id()
         and (current_role_gnk() in ('admin','listing_manager')
              or agent_id = auth.uid() or created_by = auth.uid()));
create policy deals_insert on deals for insert
  with check (org_id = current_org_id() and current_role_gnk() in ('admin','agent'));
create policy deals_update_admin on deals for update
  using (org_id = current_org_id() and current_role_gnk() = 'admin')
  with check (org_id = current_org_id());
create policy deals_update_agent on deals for update
  using (org_id = current_org_id() and current_role_gnk() = 'agent'
         and (agent_id = auth.uid() or created_by = auth.uid()))
  with check (org_id = current_org_id());

-- ---------- offers (follow parent deal visibility) ----------
create policy offers_select on offers for select
  using (org_id = current_org_id()
         and (current_role_gnk() in ('admin','listing_manager')
              or exists (select 1 from deals d
                         where d.id = offers.deal_id
                           and (d.agent_id = auth.uid() or d.created_by = auth.uid()))));
create policy offers_insert on offers for insert
  with check (org_id = current_org_id()
              and (current_role_gnk() = 'admin'
                   or (current_role_gnk() = 'agent'
                       and exists (select 1 from deals d
                                   where d.id = deal_id
                                     and (d.agent_id = auth.uid() or d.created_by = auth.uid())))));
create policy offers_update on offers for update
  using (org_id = current_org_id()
         and (current_role_gnk() = 'admin'
              or (current_role_gnk() = 'agent'
                  and exists (select 1 from deals d
                              where d.id = offers.deal_id
                                and (d.agent_id = auth.uid() or d.created_by = auth.uid())))))
  with check (org_id = current_org_id());

-- ---------- viewings ----------
create policy viewings_select on viewings for select
  using (org_id = current_org_id());
create policy viewings_insert on viewings for insert
  with check (org_id = current_org_id() and current_role_gnk() in ('admin','agent'));
create policy viewings_update on viewings for update
  using (org_id = current_org_id()
         and (current_role_gnk() = 'admin'
              or (current_role_gnk() = 'agent' and agent_id = auth.uid())))
  with check (org_id = current_org_id());

-- ---------- viewing_slips (immutable once created) ----------
create policy viewing_slips_select on viewing_slips for select
  using (org_id = current_org_id()
         and (current_role_gnk() = 'admin'
              or exists (select 1 from viewings v
                         where v.id = viewing_slips.viewing_id
                           and v.agent_id = auth.uid())));
create policy viewing_slips_insert on viewing_slips for insert
  with check (org_id = current_org_id()
              and (current_role_gnk() = 'admin'
                   or exists (select 1 from viewings v
                              where v.id = viewing_id and v.agent_id = auth.uid())));

-- ---------- documents ----------
create policy documents_select on documents for select
  using (org_id = current_org_id()
         and (current_role_gnk() = 'admin' or visibility = 'internal'));
create policy documents_insert on documents for insert
  with check (org_id = current_org_id()
              and current_role_gnk() in ('admin','agent','listing_manager'));
create policy documents_update on documents for update
  using (org_id = current_org_id() and current_role_gnk() = 'admin')
  with check (org_id = current_org_id());
create policy documents_delete on documents for delete
  using (org_id = current_org_id() and current_role_gnk() = 'admin');

-- admin updates may only change title and doc_type (matrix: UPDATE A 🔒 title/type only)
create or replace function protect_document_columns() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then
    if new.storage_path is distinct from old.storage_path
       or new.entity_type is distinct from old.entity_type
       or new.entity_id   is distinct from old.entity_id
       or new.org_id      is distinct from old.org_id
       or new.visibility  is distinct from old.visibility
       or new.uploaded_by is distinct from old.uploaded_by
       or new.created_at  is distinct from old.created_at then
      raise exception 'documents: only title and doc_type may be updated';
    end if;
  end if;
  return new;
end $$;
create trigger documents_protect before update on documents
  for each row execute function protect_document_columns();

-- ---------- tasks ----------
create policy tasks_select on tasks for select
  using (org_id = current_org_id()
         and (current_role_gnk() = 'admin'
              or assignee_id = auth.uid() or created_by = auth.uid()));
create policy tasks_insert on tasks for insert
  with check (org_id = current_org_id()
              and current_role_gnk() in ('admin','agent','listing_manager'));
create policy tasks_update on tasks for update
  using (org_id = current_org_id()
         and (current_role_gnk() = 'admin' or assignee_id = auth.uid()))
  with check (org_id = current_org_id());
create policy tasks_delete on tasks for delete
  using (org_id = current_org_id()
         and (current_role_gnk() = 'admin' or created_by = auth.uid()));

-- ---------- cyprus_config (global, no org_id) ----------
create policy cyprus_config_select on cyprus_config for select
  using (auth.uid() is not null);
create policy cyprus_config_insert on cyprus_config for insert
  with check (current_role_gnk() = 'admin');
create policy cyprus_config_update on cyprus_config for update
  using (current_role_gnk() = 'admin')
  with check (current_role_gnk() = 'admin');

-- ---------- events (append-only spine; grants already revoked in 0001) ----------
create policy events_select on events for select
  using (org_id = current_org_id()
         and (current_role_gnk() = 'admin' or actor_id = auth.uid()));
create policy events_insert on events for insert
  with check (org_id = current_org_id());
-- no update/delete policies exist, and grants are revoked (incl. truncate)

-- ---------- storage policies (doc 04) ----------
-- media: public renditions readable by anyone; writes via service role only
create policy storage_media_public_read on storage.objects for select
  using (bucket_id = 'media');
-- documents / signatures: NO policies — direct access denied; signed URLs are
-- generated server-side (service role) after an RLS check on the documents row.
