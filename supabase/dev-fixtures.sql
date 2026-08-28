-- Local development fixtures. NOT applied automatically — run it yourself
-- after `supabase db reset`:
--
--   docker exec -i supabase_db_gnk-crm psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/dev-fixtures.sql
--
-- ============================================================================
-- WHY THIS IS A FILE NOW, AND WHY IT IS NOT IN seed.sql.
--
-- `seed.sql` creates one user and nothing else, so every reset has meant
-- rebuilding this inventory BY HAND. That happened on 2026-08-21 and again on
-- 2026-08-28; the second time the only record of what to rebuild was a note
-- outside the repo. A third hand-rebuild would be a choice, not an accident.
--
-- It is deliberately NOT in `seed.sql`, which CI applies on every run: eight
-- properties and three contacts appearing in every fresh CI database would
-- change what the suites see, and several of them count rows. Local
-- convenience must not become a CI fixture by the back door.
--
-- Idempotent — every insert is `on conflict do nothing`, so re-running it after
-- a partial failure is safe.
-- ============================================================================
--
-- TWO SCHEMA TRAPS THIS FILE ALREADY PAYS FOR:
--   * `contacts.display_name` is GENERATED — inserting into it errors.
--   * `properties.title` and `areas.name` are jsonb multilingual objects, not
--     text. `'Some title'` fails with "invalid input syntax for type json".
--
-- AND THE LOOKUP TRAP: districts legitimately duplicate by code — `PAF` exists
-- once per org, because the RLS specs create their own orgs. The unique index
-- is (org_id, code). An unscoped `where code='PAF'` starts returning several
-- uuids the moment the RLS suite has run, and fails with a confusing cast
-- error. On a freshly reset database it works, which is exactly what makes it
-- a trap worth naming here.

-- ---------------------------------------------------------------- agent ----
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at, confirmation_token, recovery_token,
  email_change_token_new, email_change
) values (
  '00000000-0000-0000-0000-000000000000',
  '22222222-2222-2222-2222-222222222222',
  'authenticated', 'authenticated',
  'agent@gnk.local',
  crypt('agent1234', gen_salt('bf')),
  now(),
  '{"provider":"email","providers":["email"]}',
  '{}',
  now(), now(), '', '', '', ''
) on conflict (id) do nothing;

insert into auth.identities (
  id, user_id, provider_id, identity_data, provider,
  last_sign_in_at, created_at, updated_at
) values (
  gen_random_uuid(),
  '22222222-2222-2222-2222-222222222222',
  '22222222-2222-2222-2222-222222222222',
  '{"sub":"22222222-2222-2222-2222-222222222222","email":"agent@gnk.local","email_verified":true}',
  'email',
  now(), now(), now()
) on conflict (provider_id, provider) do nothing;

insert into profiles (id, org_id, role, full_name, email)
values (
  '22222222-2222-2222-2222-222222222222',
  '00000000-0000-0000-0000-000000000001',
  'agent', 'Maria Christodoulou', 'agent@gnk.local'
) on conflict (id) do nothing;

-- ------------------------------------------------------------- contacts ----
-- The contact_types arrays are the point: they are what the typed
-- EntityPicker filters on, so a developer/owner/buyer of each must exist.
insert into contacts (id, org_id, contact_kind, company_name, email, contact_types)
values (
  '33333333-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  'company', 'Leptos Estates', 'info@leptos.example',
  array['developer']
) on conflict (id) do nothing;

insert into contacts (id, org_id, contact_kind, first_name, last_name, email, phone_raw, contact_types)
values (
  '33333333-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000001',
  'person', 'Andreas', 'Georgiou', 'andreas@example.com', '+35799123456',
  array['owner','seller']
), (
  '33333333-0000-0000-0000-000000000003',
  '00000000-0000-0000-0000-000000000001',
  'person', 'Elena', 'Petrova', 'elena@example.com', '+35799654321',
  array['buyer']
) on conflict (id) do nothing;

-- ----------------------------------------------------------- properties ----
-- District lookup is scoped by org_id ON PURPOSE: PAF exists once per org
-- (the RLS specs create their own), and an unscoped lookup returns several
-- uuids and fails with a confusing cast error.
insert into properties (
  id, org_id, reference, kind, property_type, transaction_type, status, visibility,
  title, district_id, owner_contact_id, assigned_agent_id,
  asking_price, covered_area_sqm, bedrooms, bathrooms
) values (
  '44444444-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  'PAF0001', 'standalone', 'villa', 'sale', 'available', 'private',
  '{"en":"Seafront villa with pool"}'::jsonb,
  (select id from districts where code='PAF'),
  '33333333-0000-0000-0000-000000000002',
  '22222222-2222-2222-2222-222222222222',
  850000, 240, 4, 3
) on conflict (id) do nothing;

insert into properties (
  id, org_id, reference, kind, property_type, transaction_type, status, visibility,
  title, district_id, developer_contact_id, assigned_agent_id
) values (
  '44444444-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000001',
  'PAF0002', 'project', 'apartment', 'sale', 'available', 'private',
  '{"en":"Coral Bay Residences"}'::jsonb,
  (select id from districts where code='PAF'),
  '33333333-0000-0000-0000-000000000001',
  '22222222-2222-2222-2222-222222222222'
) on conflict (id) do nothing;

-- Five units, so the hide-units-by-default filter has something real to hide.
insert into properties (
  id, org_id, reference, kind, parent_id, unit_number, property_type,
  transaction_type, status, visibility, district_id, developer_contact_id,
  assigned_agent_id, asking_price, covered_area_sqm, bedrooms, bathrooms
)
select
  ('44444444-0000-0000-0001-00000000000' || row_number() over (order by u.ref))::uuid,
  '00000000-0000-0000-0000-000000000001',
  'PAF0002-' || u.ref, 'unit',
  '44444444-0000-0000-0000-000000000002', u.ref, 'apartment',
  'sale', 'available', 'private',
  (select id from districts where code='PAF'),
  '33333333-0000-0000-0000-000000000001',
  '22222222-2222-2222-2222-222222222222',
  u.price, u.sqm, u.beds, 2
from (values
  ('A101', 285000, 85, 2),
  ('A102', 295000, 88, 2),
  ('A103', 310000, 92, 2),
  ('A201', 330000, 95, 3),
  ('A202', 345000, 98, 3)
) as u(ref, price, sqm, beds)
on conflict (id) do nothing;

insert into properties (
  id, org_id, reference, kind, property_type, transaction_type, status, visibility,
  title, district_id, owner_contact_id, assigned_agent_id,
  asking_price, covered_area_sqm, bedrooms, bathrooms
) values (
  '44444444-0000-0000-0000-000000000003',
  '00000000-0000-0000-0000-000000000001',
  'PAF0003', 'standalone', 'townhouse', 'sale', 'available', 'private',
  '{"en":"Townhouse near the old town"}'::jsonb,
  (select id from districts where code='PAF'),
  '33333333-0000-0000-0000-000000000002',
  '22222222-2222-2222-2222-222222222222',
  395000, 150, 3, 2
) on conflict (id) do nothing;

-- PAF0003 carries an ACTIVE mandate — the fixture that makes commission,
-- the pricing panel and the renewal sweep have something to act on.
insert into mandates (
  id, org_id, property_id, type, status, owner_contact_id,
  commission_pct, start_date, expiry_date
) values (
  '55555555-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  '44444444-0000-0000-0000-000000000003',
  'exclusive', 'active',
  '33333333-0000-0000-0000-000000000002',
  3, current_date - 30, current_date + 150
) on conflict (id) do nothing;
