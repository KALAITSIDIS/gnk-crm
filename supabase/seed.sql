-- =============================================================================
-- supabase/seed.sql — LOCAL DEVELOPMENT ONLY (runs on `supabase db reset`)
-- Creates the first admin auth user + profile so login works after every reset.
-- Production: create the admin via Supabase dashboard, then insert the profile
-- row per the comment in docs/07_SEED_DATA.sql. Never run this file in prod.
-- Credentials (local only): admin@gnk.local / admin1234
-- =============================================================================

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at, confirmation_token, recovery_token,
  email_change_token_new, email_change
) values (
  '00000000-0000-0000-0000-000000000000',
  '11111111-1111-1111-1111-111111111111',
  'authenticated', 'authenticated',
  'admin@gnk.local',
  crypt('admin1234', gen_salt('bf')),
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
  '11111111-1111-1111-1111-111111111111',
  '11111111-1111-1111-1111-111111111111',
  '{"sub":"11111111-1111-1111-1111-111111111111","email":"admin@gnk.local","email_verified":true}',
  'email',
  now(), now(), now()
) on conflict (provider_id, provider) do nothing;

insert into profiles (id, org_id, role, full_name, email)
values (
  '11111111-1111-1111-1111-111111111111',
  '00000000-0000-0000-0000-000000000001',
  'admin',
  'Gerasimos Kalaitsidis',
  'admin@gnk.local'
) on conflict (id) do nothing;

-- -----------------------------------------------------------------------------
-- 0103: the `enquiry-alerts` cron job reads two Vault secrets at RUN time
-- (docs/10 §2) and FAILS loudly every two minutes when either is absent.
-- LOCAL PLACEHOLDERS ONLY — hosted holds the real values, and this file never
-- runs there. The bearer is deliberately not a real CRON_SECRET: the local
-- sweep answers 401 unless .env.local's CRON_SECRET is set to the same string.
-- `where not exists` keeps a real value someone already put in Vault.
-- -----------------------------------------------------------------------------
select vault.create_secret(
  'http://host.docker.internal:3000', 'crm_url',
  'LOCAL seed placeholder (0103): the CRM origin the enquiry-alerts job posts to')
 where not exists (select 1 from vault.secrets where name = 'crm_url');

select vault.create_secret(
  'local-seed-placeholder-not-a-secret', 'cron_secret',
  'LOCAL seed placeholder (0103): set .env.local CRON_SECRET to this string to exercise the sweep locally')
 where not exists (select 1 from vault.secrets where name = 'cron_secret');
