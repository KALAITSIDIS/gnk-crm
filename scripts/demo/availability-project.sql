-- availability-project.sql — build a phased demo project with units
-- Teardown: scripts/demo/availability-project-teardown.sql
--
-- WHAT THIS IS FOR. The project availability share link (migration 0041) shows
-- a live unit matrix for a project, grouped by phase. Demonstrating it needs a
-- PHASED project with units, mixed statuses and a price list — and a database
-- that has none renders an honest but useless empty page. This builds one.
--
-- **DEMO DATA, NOT SEED DATA.** `supabase/seed.sql` is what every database
-- should have; this is a disposable prop for showing the feature or for
-- reproducing a bug in it. Every property it creates writes an event carrying
-- `payload->>'fixture' = 'availability-demo'`, which is how you find it later
-- and how you know it is not real.
--
-- RUNS ON LOCAL OR HOSTED, UNCHANGED. Every id is looked up by natural key —
-- org slug, district code, area name, admin by role — because those uuids
-- differ between the two environments. Hardcoding one is how a script becomes
-- local-only without anyone noticing.
--
--   local:  docker exec -i supabase_db_gnk-crm psql -U postgres -d postgres \
--             -v ON_ERROR_STOP=1 -f - < scripts/demo/availability-project.sql
--   hosted: paste through the Supabase connector's execute_sql, which wraps a
--           multi-statement script in ONE transaction (HANDOFF §3) — so a
--           failure anywhere rolls the whole thing back, which is what you want
--
-- THE REFERENCE IS MINTED, NOT CHOSEN. `next_reference()` advances
-- `reference_counters`, so each run takes the next number and the teardown does
-- NOT give it back. A deleted reference is never reused (0033,
-- `properties_reference_immutable`), so expect gaps and do not try to close
-- them.
--
-- WHY THE EVENTS GO IN AS ONE MULTI-ROW INSERT. `trg_events_hash` reads the
-- previous event for the org to build the chain. Several data-modifying CTEs in
-- ONE statement share a snapshot and could hand two rows the same `prev_hash`;
-- a single multi-row insert is the shape the app's own `logEvents` uses and is
-- proven safe. Do not "tidy" step 4 into the statements above it.

-- ---------- 0. refuse to build a second one -------------------------------
-- The steps below key off the title, which is only unambiguous while exactly
-- one such project exists. Running twice would leave step 2 attaching phases to
-- both. Tear down first.
do $$
begin
  if exists (
    select 1 from properties
     where title ->> 'en' = 'Kissonerga Bay Residences' and kind = 'project'
  ) then
    raise exception
      'demo project already exists — run scripts/demo/availability-project-teardown.sql first';
  end if;
end $$;

-- ---------- 1. the project -------------------------------------------------
with org as (
  select id from organizations where slug = 'gnk'
), who as (
  select p.id from profiles p, org
   where p.org_id = org.id and p.role = 'admin' and p.is_active
   order by p.created_at limit 1
), dist as (
  select d.id from districts d, org where d.org_id = org.id and d.code = 'PAF'
), ar as (
  select a.id from areas a, dist
   where a.district_id = dist.id and a.name ->> 'en' = 'Chloraka'
)
insert into properties (
  org_id, reference, kind, property_type, transaction_type, status, visibility,
  title, short_description, public_description,
  district_id, area_id, currency, vat_status, energy_class,
  features, title_deed_status, permit_status,
  construction_status, delivery_date, created_by
)
select
  org.id,
  next_reference(org.id, 'PAF'),
  'project', 'apartment', 'sale', 'available', 'private',
  '{"en":"Kissonerga Bay Residences"}'::jsonb,
  '{"en":"Two- and three-bedroom apartments in two phases, five minutes from Chloraka beach."}'::jsonb,
  '{"en":"A gated development of sixteen apartments over two phases, with communal pool, landscaped gardens and covered parking. Phase 1 hands over in June 2028; Phase 2 follows in December 2029."}'::jsonb,
  dist.id, ar.id, 'EUR', 'new_vat', 'B',
  '{pool,parking,storage,lift,garden}'::text[],
  'pending', 'full',
  'under construction', date '2028-06-30',
  who.id
from org, who, dist, ar;

-- ---------- 2. two phases, each with its OWN delivery date ------------------
-- The severing is the point: `inherited_fields` drops delivery_date so a
-- project-side sync cannot overwrite a staged handover. Staged handover is what
-- phases ARE, and it is what the share link groups by.
insert into properties (
  org_id, reference, kind, parent_id, property_type, transaction_type,
  status, visibility, title,
  district_id, area_id, currency, vat_status, energy_class, features,
  title_deed_status, permit_status, construction_status, delivery_date,
  inherited_fields, created_by
)
select
  p.org_id,
  p.reference || '-' || v.code,
  'phase', p.id, p.property_type, p.transaction_type,
  'available', 'private', jsonb_build_object('en', v.name),
  p.district_id, p.area_id, p.currency, p.vat_status, p.energy_class, p.features,
  p.title_deed_status, p.permit_status, v.construction, v.delivery,
  array['transaction_type','district_id','area_id','address','postal_code','location',
        'sea_distance_m','amenities_notes','currency','vat_status','energy_class','features',
        'title_deed_status','permit_status','construction_status',
        'developer_contact_id','owner_contact_id','assigned_agent_id']::text[],
  p.created_by
from properties p,
     (values ('P1', 'Phase 1 — sea view block', 'structure complete', date '2028-06-30'),
             ('P2', 'Phase 2 — garden block',   'foundations',        date '2029-12-31'))
       as v(code, name, construction, delivery)
where p.title ->> 'en' = 'Kissonerga Bay Residences' and p.kind = 'project';

-- ---------- 3. sixteen units, hanging off the PHASES ------------------------
-- Which is the trap the availability link exists to survive: `parent_id =
-- <project>` finds NONE of these, and the staff units page correctly shows
-- "0 units" for this project because it lists direct children only.
--
-- The statuses are spread on purpose — 10 available · 2 reserved · 1 under
-- offer · 3 sold — so the page's headline summary has something to say.
insert into properties (
  org_id, reference, kind, parent_id, property_type, transaction_type,
  status, visibility, unit_number, block, floor_number,
  bedrooms, bathrooms, covered_area_sqm, veranda_sqm, asking_price,
  district_id, area_id, currency, vat_status, energy_class, features,
  title_deed_status, permit_status, construction_status, delivery_date,
  inherited_fields, created_by
)
select
  ph.org_id,
  ph.reference || '-' || u.label,
  'unit', ph.id, ph.property_type, ph.transaction_type,
  u.status::property_status, 'private', u.unit_number, u.block, u.floor,
  u.beds, u.baths, u.covered, u.veranda, u.price,
  ph.district_id, ph.area_id, ph.currency, ph.vat_status, ph.energy_class, ph.features,
  ph.title_deed_status, ph.permit_status, ph.construction_status, ph.delivery_date,
  array['transaction_type','district_id','area_id','address','postal_code','location',
        'sea_distance_m','amenities_notes','currency','vat_status','energy_class','features',
        'title_deed_status','permit_status','construction_status','delivery_date',
        'developer_contact_id','owner_contact_id','assigned_agent_id']::text[],
  ph.created_by
from properties ph
join properties pr on pr.id = ph.parent_id
join (values
    ('P1','A101','A','101',1,2,1,85 ,20,295000,'sold'),
    ('P1','A102','A','102',1,2,1,85 ,20,295000,'sold'),
    ('P1','A103','A','103',1,2,1,88 ,22,302000,'reserved'),
    ('P1','A201','A','201',2,2,1,85 ,20,308000,'available'),
    ('P1','A202','A','202',2,2,1,85 ,20,308000,'under_offer'),
    ('P1','A203','A','203',2,2,1,88 ,22,315000,'available'),
    ('P1','A301','A','301',3,3,2,120,45,465000,'sold'),
    ('P1','A302','A','302',3,3,2,120,45,465000,'available'),
    ('P2','B101','B','101',1,2,1,85 ,20,305000,'reserved'),
    ('P2','B102','B','102',1,2,1,85 ,20,305000,'available'),
    ('P2','B103','B','103',1,2,1,88 ,22,312000,'available'),
    ('P2','B201','B','201',2,2,1,85 ,20,318000,'available'),
    ('P2','B202','B','202',2,2,1,85 ,20,318000,'available'),
    ('P2','B203','B','203',2,2,1,88 ,22,325000,'available'),
    ('P2','B301','B','301',3,3,2,120,45,485000,'available'),
    ('P2','B302','B','302',3,3,2,120,45,485000,'available')
  ) as u(phase, label, block, unit_number, floor, beds, baths, covered, veranda, price, status)
  on ph.reference = pr.reference || '-' || u.phase
where pr.title ->> 'en' = 'Kissonerga Bay Residences' and ph.kind = 'phase';

-- ---------- 4. one `created` event per property, in ONE insert --------------
-- Guardrail 1: a feature without its events is not done, and neither is a row.
-- See the header for why this is one statement and must stay one.
insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
select
  x.org_id, x.created_by, 'property', x.id, 'created',
  case x.kind
    when 'project' then jsonb_build_object(
      'reference', x.reference, 'kind', 'project', 'property_type', x.property_type,
      'fixture', 'availability-demo')
    when 'phase' then jsonb_build_object(
      'reference', x.reference, 'kind', 'phase', 'parent', x.parent_ref,
      'fixture', 'availability-demo')
    else jsonb_build_object(
      'reference', x.reference, 'kind', 'unit', 'parent', x.parent_ref,
      'generated', true, 'fixture', 'availability-demo')
  end
from (
  select p.id, p.org_id, p.created_by, p.kind::text as kind, p.reference,
         p.property_type::text as property_type, par.reference as parent_ref,
         -- project, then phases, then units: the order it happened in, so the
         -- timeline reads correctly
         case p.kind when 'project' then 0 when 'phase' then 1 else 2 end as tier
    from properties p
    left join properties par on par.id = p.parent_id
    left join properties gp  on gp.id  = par.parent_id
   where coalesce(gp.title ->> 'en', par.title ->> 'en', p.title ->> 'en')
         = 'Kissonerga Bay Residences'
) x
order by x.tier, x.reference;

-- ---------- 5. a price list, so the PINNED price mode has something ---------
-- Version 1 is an EARLIER quote — 3% under today's asking price — and it
-- deliberately omits B302, which was "released after the list went out". A link
-- pinned to this version therefore shows the quoted numbers, not the live ones,
-- and reports one unit with no price at all. Both halves of "pinned means
-- pinned" demonstrate themselves without anyone setting them up.
insert into price_lists (org_id, project_id, version, effective_date, notes, created_by)
select p.org_id, p.id, 1, current_date - interval '2 months',
       'Launch pricing, issued to agents. B302 was released later and is not in this version.',
       p.created_by
from properties p
where p.title ->> 'en' = 'Kissonerga Bay Residences' and p.kind = 'project';

insert into price_list_items (price_list_id, unit_id, list_price)
select pl.id, u.id, round(u.asking_price * 0.97 / 500) * 500
from price_lists pl
join properties pr on pr.id = pl.project_id
join properties ph on ph.parent_id = pr.id and ph.kind = 'phase'
join properties u  on u.parent_id  = ph.id and u.kind = 'unit'
where pr.title ->> 'en' = 'Kissonerga Bay Residences'
  and u.reference not like '%-B302';

insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
select pl.org_id, pl.created_by, 'property', pl.project_id, 'price_list_created',
       jsonb_build_object('version', pl.version,
                          'units', (select count(*) from price_list_items i
                                     where i.price_list_id = pl.id),
                          'fixture', 'availability-demo')
from price_lists pl
join properties pr on pr.id = pl.project_id
where pr.title ->> 'en' = 'Kissonerga Bay Residences';

-- ---------- 6. say what was built, and prove the chain survived -------------
select
  (select reference from properties
    where title ->> 'en' = 'Kissonerga Bay Residences' and kind = 'project')      as project,
  (select count(*) from properties p
     join properties ph on ph.id = p.parent_id
     join properties pr on pr.id = ph.parent_id
    where pr.title ->> 'en' = 'Kissonerga Bay Residences')                        as units,
  (select count(*) from properties p
     join properties ph on ph.id = p.parent_id
     join properties pr on pr.id = ph.parent_id
    where pr.title ->> 'en' = 'Kissonerga Bay Residences'
      and p.status = 'available')                                                 as available,
  (select count(*) from price_list_items i join price_lists pl on pl.id = i.price_list_id
     join properties pr on pr.id = pl.project_id
    where pr.title ->> 'en' = 'Kissonerga Bay Residences')                        as priced_units,
  (select verify_events_chain(id) from organizations where slug = 'gnk')          as chain_ok;
