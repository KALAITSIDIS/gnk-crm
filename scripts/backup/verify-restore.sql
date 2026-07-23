-- verify-restore.sql — post-restore verification pack
-- See docs/BACKUP_RESTORE.md §4 step 5 and §5.
--
-- Run against the RESTORED project. Every row must read pass = true.
-- Read-only: it asserts, it never writes.
--
-- BEFORE A DRILL: re-capture the baseline from hosted and update the `expected`
-- CTE below. The values shipped here are hosted as at 2026-07-23 (main bd00809)
-- and WILL be stale once anyone touches production.
--
-- (`check` is a reserved word in Postgres, hence `check_name`.)

with expected as (
  select
    1::bigint  as orgs,      2::bigint  as profiles,   60::bigint as events,
    2::bigint  as contacts,  2::bigint  as properties,  1::bigint as deals,
    3::bigint  as leads,     1::bigint  as viewings,    1::bigint as slips,
    3::bigint  as documents, 1::bigint  as keys,        1::bigint as mandates,
    0::bigint  as tasks,     6::bigint  as cyprus_config,
    26::bigint as deal_stages, 5::bigint as districts,
    2::bigint  as auth_users, 19::bigint as migrations,
    9::bigint  as obj_documents, 2::bigint as obj_signatures, 15::bigint as obj_media
),

-- ---------- row counts ----------
counts as (
  select 'rows: organizations' as check_name, e.orgs as expected, (select count(*) from organizations) as actual from expected e
  union all select 'rows: profiles',      e.profiles,      (select count(*) from profiles) from expected e
  union all select 'rows: events',        e.events,        (select count(*) from events) from expected e
  union all select 'rows: contacts',      e.contacts,      (select count(*) from contacts) from expected e
  union all select 'rows: properties',    e.properties,    (select count(*) from properties) from expected e
  union all select 'rows: deals',         e.deals,         (select count(*) from deals) from expected e
  union all select 'rows: leads',         e.leads,         (select count(*) from leads) from expected e
  union all select 'rows: viewings',      e.viewings,      (select count(*) from viewings) from expected e
  union all select 'rows: viewing_slips', e.slips,         (select count(*) from viewing_slips) from expected e
  union all select 'rows: documents',     e.documents,     (select count(*) from documents) from expected e
  union all select 'rows: property_keys', e.keys,          (select count(*) from property_keys) from expected e
  union all select 'rows: mandates',      e.mandates,      (select count(*) from mandates) from expected e
  union all select 'rows: tasks',         e.tasks,         (select count(*) from tasks) from expected e
  union all select 'seed: cyprus_config', e.cyprus_config, (select count(*) from cyprus_config) from expected e
  union all select 'seed: deal_stages',   e.deal_stages,   (select count(*) from deal_stages) from expected e
  union all select 'seed: districts',     e.districts,     (select count(*) from districts) from expected e
  union all select 'auth: users',         e.auth_users,    (select count(*) from auth.users) from expected e
  union all select 'migrations: rows',    e.migrations,    (select count(*) from supabase_migrations.schema_migrations) from expected e
  union all select 'storage: documents objects',  e.obj_documents,  (select count(*) from storage.objects where bucket_id = 'documents') from expected e
  union all select 'storage: signatures objects', e.obj_signatures, (select count(*) from storage.objects where bucket_id = 'signatures') from expected e
  union all select 'storage: media objects',      e.obj_media,      (select count(*) from storage.objects where bucket_id = 'media') from expected e
),

-- ---------- function grants: the TEST-2 surface ----------
-- A restore that silently drops one of these looks perfectly healthy on screen.
grants_expected(fn, secdef, anon, auth, service) as (values
  ('verify_events_chain',  true,  false, false, true),
  ('run_chain_checks',     true,  false, false, true),
  ('expire_mandates',      true,  false, false, true),
  ('next_reference',       true,  false, true,  true),
  ('current_org_id',       true,  false, true,  true),
  ('current_role_gnk',     true,  false, true,  true),
  ('record_key_movement',  true,  false, true,  true),
  ('move_deal_to_stage',   false, false, true,  true),
  ('add_deal_stage',       false, false, true,  true),
  ('reorder_stage',        false, false, true,  true),
  ('admin_dashboard_stats',false, false, true,  true)
),
grants_actual as (
  select p.proname::text as fn, p.prosecdef as secdef,
         has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
         has_function_privilege('service_role', p.oid, 'EXECUTE') as service
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
),
grant_checks as (
  select 'grants: ' || ge.fn as check_name,
         ge.secdef::text || '/' || ge.anon::text || '/' || ge.auth::text || '/' || ge.service::text as expected,
         coalesce(ga.secdef::text || '/' || ga.anon::text || '/' || ga.auth::text || '/' || ga.service::text, 'FUNCTION MISSING') as actual
  from grants_expected ge left join grants_actual ga on ga.fn = ge.fn
),

-- ---------- everything else ----------
misc as (
  select 'timezone is UTC (see BACKUP_RESTORE 1.3)' as check_name,
         'UTC' as expected, current_setting('TimeZone') as actual
  union all
  select 'migrations: non_filename_versions', '0',
         (select count(*)::text from supabase_migrations.schema_migrations where version !~ '^[0-9]{4}$')
  union all
  select 'cron: expire-mandates active', 'true',
         coalesce((select active::text from cron.job where jobname = 'expire-mandates'), 'JOB MISSING')
  union all
  select 'cron: verify-events-chain active', 'true',
         coalesce((select active::text from cron.job where jobname = 'verify-events-chain'), 'JOB MISSING')
  union all
  select 'storage: media bucket is public (migration 0008)', 'true',
         coalesce((select public::text from storage.buckets where id = 'media'), 'BUCKET MISSING')
  union all
  select 'storage: documents bucket is private', 'false',
         coalesce((select public::text from storage.buckets where id = 'documents'), 'BUCKET MISSING')
  union all
  select 'storage: signatures bucket is private', 'false',
         coalesce((select public::text from storage.buckets where id = 'signatures'), 'BUCKET MISSING')
  union all
  -- The one that matters most. False here means re-read §1.3 BEFORE assuming corruption:
  -- a non-UTC session TimeZone breaks verification on perfectly intact data.
  select 'INTEGRITY: event chain verifies for every org', 'true',
         (select coalesce(bool_and(verify_events_chain(id)), true)::text from organizations)
  union all
  -- Every slip row must still have BOTH its files. Catches a DB-only restore (§1.2),
  -- where the row survives and asserts a signature whose bytes no longer exist.
  -- signature_path / pdf_path equal storage.objects.name exactly (no bucket prefix).
  select 'INTEGRITY: every viewing_slip signature PNG exists', '0 missing',
         (select count(*)::text || ' missing' from viewing_slips vs
          where not exists (select 1 from storage.objects o
                            where o.bucket_id = 'signatures' and o.name = vs.signature_path))
  union all
  select 'INTEGRITY: every viewing_slip PDF exists', '0 missing',
         (select count(*)::text || ' missing' from viewing_slips vs
          where vs.pdf_path is not null
            and not exists (select 1 from storage.objects o
                            where o.bucket_id = 'signatures' and o.name = vs.pdf_path))
  union all
  -- Evidence report PDFs live in `documents` under <org>/reports/evidence-*.
  -- Their bytes are what a commission claim is checked against.
  select 'INTEGRITY: every stored evidence report file exists', '0 missing',
         (select count(*)::text || ' missing' from documents d
          where d.storage_path like '%/reports/evidence-%'
            and not exists (select 1 from storage.objects o
                            where o.bucket_id = 'documents' and o.name = d.storage_path))
)

select check_name, expected, actual, (expected = actual) as pass
from (
  select check_name, expected::text, actual::text from counts
  union all select check_name, expected, actual from grant_checks
  union all select check_name, expected, actual from misc
) all_checks
order by pass, check_name;
