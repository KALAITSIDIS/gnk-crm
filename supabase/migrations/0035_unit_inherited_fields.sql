-- 0035 — record which of a unit's columns are still its project's opinion.
--
-- BACKLOG audit finding 5, the drift half. 0034's sibling change widened what a
-- unit copies at creation from 5 columns to 19, and the bulk generator now mints
-- a 60-unit block in one submit. Both make the same latent problem worse:
-- copy-on-create means changing the project's VAT status next month leaves 60
-- units on the old one, SILENTLY, and nothing in the app can tell the difference
-- between "nobody has touched this" and "somebody set it deliberately".
--
-- This column is what tells them apart. A field listed here is still the
-- project's answer; editing it on the unit removes it from the list and the unit
-- stops following. That is what lets a project-side sync say "update the 58
-- units that still inherit this" and leave the 2 that were deliberately changed.
--
-- ONLY MEANINGFUL FOR kind = 'unit'. A standalone or a project inherits from
-- nothing, so its list stays empty — no constraint enforces that, because a
-- check constraint here would fire on every property write to protect a column
-- nothing else reads for those kinds.
--
-- BACKFILL IS A RECONSTRUCTION AND SAYS SO. Units that pre-date this column have
-- no record of what they inherited, so it is inferred, on two grounds:
--
--   * the unit's value EQUALS the parent's — it is already the project's answer,
--     so a later sync writes what is there and changes nothing; and
--   * the unit's value is NULL while the parent has one — which is what every
--     unit created before the inheritance widening looks like. A blank means
--     nobody expressed an opinion, not that somebody decided "unknown".
--
-- The second ground is the one that matters. Without it, every unit created by
-- the old five-column createUnit is permanently opted out of ever being
-- corrected — which is exactly the data this feature exists to fix. Both
-- grounds are conservative: neither can overwrite a value somebody chose,
-- because a chosen value that differs from the parent matches neither test.
--
-- NO EXPLICIT begin/commit — the CLI wraps each file in one transaction, and a
-- nested one would end it early (HANDOFF §3).

alter table public.properties
  add column if not exists inherited_fields text[] not null default '{}';

comment on column public.properties.inherited_fields is
  'Unit-only. Columns still derived from parent_id rather than set on this row. '
  'Editing one of these on the unit removes it from the list; a project-side '
  'sync only touches units that still list the field. See 0035.';

-- Reconstruct for units that pre-date the column, on the two grounds above:
-- the value already equals the parent's, or the unit has no value at all.
-- Three of these columns cannot be null and say "nobody has said" with a
-- placeholder instead: `vat_status`, `title_deed_status` and `permit_status`
-- default to 'unknown', and `features` to an empty array. Those placeholders
-- are the no-opinion case in a different shape, and missing them is what made
-- the first draft of this migration leave every pre-widening unit stuck on
-- 'unknown' forever. `currency` ('EUR') and `transaction_type` ('sale') are
-- deliberately NOT in that group — those defaults are real answers.
update public.properties u
   set inherited_fields = (
     select coalesce(array_agg(f order by f), '{}')
       from (
         select 'transaction_type'    as f where u.transaction_type is not distinct from p.transaction_type or u.transaction_type is null
         union all select 'district_id' where u.district_id is not distinct from p.district_id or u.district_id is null
         union all select 'area_id' where u.area_id is not distinct from p.area_id or u.area_id is null
         union all select 'address' where u.address is not distinct from p.address or u.address is null
         union all select 'postal_code' where u.postal_code is not distinct from p.postal_code or u.postal_code is null
         union all select 'location' where u.location is not distinct from p.location or u.location is null
         union all select 'sea_distance_m' where u.sea_distance_m is not distinct from p.sea_distance_m or u.sea_distance_m is null
         union all select 'amenities_notes' where u.amenities_notes is not distinct from p.amenities_notes or u.amenities_notes is null
         union all select 'currency' where u.currency is not distinct from p.currency or u.currency is null
         union all select 'vat_status' where u.vat_status is not distinct from p.vat_status or u.vat_status = 'unknown'
         union all select 'energy_class' where u.energy_class is not distinct from p.energy_class or u.energy_class is null
         union all select 'features' where u.features is not distinct from p.features or u.features = '{}'
         union all select 'title_deed_status' where u.title_deed_status is not distinct from p.title_deed_status or u.title_deed_status = 'unknown'
         union all select 'permit_status' where u.permit_status is not distinct from p.permit_status or u.permit_status = 'unknown'
         union all select 'construction_status' where u.construction_status is not distinct from p.construction_status or u.construction_status is null
         union all select 'delivery_date' where u.delivery_date is not distinct from p.delivery_date or u.delivery_date is null
         union all select 'developer_contact_id' where u.developer_contact_id is not distinct from p.developer_contact_id or u.developer_contact_id is null
         union all select 'owner_contact_id' where u.owner_contact_id is not distinct from p.owner_contact_id or u.owner_contact_id is null
         union all select 'assigned_agent_id' where u.assigned_agent_id is not distinct from p.assigned_agent_id or u.assigned_agent_id is null
       ) matched
   )
  from public.properties p
 where u.kind = 'unit'
   and u.parent_id = p.id
   and u.inherited_fields = '{}';

do $$
declare
  orphans int;
  wrong_kind int;
begin
  -- A unit whose parent shares none of its values is possible and fine, but a
  -- unit that ended up with a field NOT in the 19 would mean a typo above.
  select count(*) into wrong_kind
    from public.properties
   where kind <> 'unit'
     and array_length(inherited_fields, 1) is not null;
  if wrong_kind <> 0 then
    raise exception '0035 aborted: % non-unit row(s) carry inherited_fields', wrong_kind;
  end if;

  select count(*) into orphans
    from public.properties
   where kind = 'unit' and parent_id is null;
  if orphans <> 0 then
    raise exception '0035 aborted: % unit(s) have no parent', orphans;
  end if;

  raise notice '0035 ok: inherited_fields added and reconstructed for existing units';
end $$;
