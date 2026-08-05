-- verify-restore.sql — post-restore verification pack
-- See docs/BACKUP_RESTORE.md §4 step 5 and §5.
--
-- Run against the RESTORED project. Every row must read pass = true.
-- Read-only: it asserts, it never writes.
--
-- The output has TWO kinds of check, and the difference matters when you are
-- reading it under pressure:
--
--   invariant  — true of a correct restore regardless of how much data exists:
--                the event chain, the function grants (the TEST-2 surface),
--                cron, bucket visibility, migration history, session timezone.
--                A failure here is REAL.
--   metadata    — rows agreeing with rows. Cannot see bucket contents, so it
--                 CANNOT prove a file survived. Green here is not evidence.
--   row count  — compared against the `expected` block below, which is a
--                SNAPSHOT. If production moved on since it was captured, these
--                fail while the restore is perfectly fine.
--
-- So: **re-capture the baseline immediately before a drill** by running
-- scripts/backup/capture-baseline.sql against the SOURCE and pasting its single
-- output row over the `expected` block. Hardcoded counts previously went stale
-- and reported false failures, which is the worst possible signal mid-recovery.
--
-- (`check` is a reserved word in Postgres, hence `check_name`.)

with expected as (
  -- BASELINE — replace via scripts/backup/capture-baseline.sql before a drill.
  select
    1::bigint as orgs,      2::bigint as profiles,   73::bigint as events,
    2::bigint as contacts,  2::bigint as properties, 1::bigint as deals,
    3::bigint as leads,     1::bigint as viewings,   1::bigint as slips,
    3::bigint as documents, 1::bigint as keys,       1::bigint as mandates,
    0::bigint as tasks,     6::bigint as cyprus_config,
    26::bigint as deal_stages, 5::bigint as districts,
    2::bigint as auth_users, 24::bigint as migrations,
    9::bigint as obj_documents, 2::bigint as obj_signatures, 15::bigint as obj_media
    -- captured 2026-08-04 from hosted (yjgirvzgoiywdojnpkpd) via
    -- capture-baseline.sql. Previous capture was 2026-07-29 (events 62).
    --
    -- `events` IS THE ONE THAT GOES STALE. It is append-only, so it drifts
    -- upward on every single use of the app and never returns — 62 -> 73 came
    -- from one afternoon of exercising B3/B7, and re-running the pack then
    -- reported that single row as a FALSE FAILURE while all 20 other counts
    -- still matched exactly. Check `events` first when this block looks wrong,
    -- and re-capture rather than assuming a bad restore.
    --
    -- The others are stable between schema changes: `migrations` moves only
    -- when one is applied (19 -> 23 across 0020-0023, then 24 with 0024), and
    -- the rest only when the desk creates or deletes real rows.
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
  -- service_role = false on these three since 0022. They had UNDOCUMENTED
  -- hosted grants that no migration produced, so this table encoded drift and
  -- reported three failures against any migration-built restore. Nothing calls
  -- them via service_role: the two are RLS helpers (service_role bypasses RLS)
  -- and expire_mandates is pg_cron-only, run as `postgres`.
  ('expire_mandates',      true,  false, false, false),
  ('next_reference',       true,  false, true,  true),
  ('current_org_id',       true,  false, true,  false),
  ('current_role_gnk',     true,  false, true,  false),
  ('record_key_movement',  true,  false, true,  true),
  ('move_deal_to_stage',   false, false, true,  true),
  ('add_deal_stage',       false, false, true,  true),
  ('reorder_stage',        false, false, true,  true),
  ('admin_dashboard_stats',false, false, true,  true),
  -- B3 (0023). anon = TRUE here is DELIBERATE and unique in this table: this is
  -- the buyer entry point, the only function a public visitor may call. The
  -- Supabase advisor flags it by design; a restore that DROPS this grant breaks
  -- every live proposal link silently, which is why it is pinned.
  ('resolve_share_link',   true,  true,  true,  true),
  ('note_share_link_miss', true,  true,  true,  true)
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
  select 'cron: followup-nudges active (migration 0020)', 'true',
         coalesce((select active::text from cron.job where jobname = 'followup-nudges'), 'JOB MISSING')
  union all
  -- 0021: trigger functions must not be callable over PostgREST (0007 §1). A
  -- restore that re-creates them without the revoke silently re-opens
  -- advisors 0028/0029, which is invisible in row counts.
  select 'grants: nudge triggers not executable by authenticated', 'false',
         has_function_privilege('authenticated','trg_supersede_deal_nudges()','EXECUTE')::text
  union all
  select 'grants: create_followup_nudges executable by service_role', 'true',
         has_function_privilege('service_role','create_followup_nudges(uuid)','EXECUTE')::text
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
  --
  -- ⚠️ THESE THREE CHECK METADATA, NOT BYTES — AND THAT IS A KNOWN FALSE PASS.
  -- Proven in the 2026-08-05 drill: `data.sql` restores `storage.objects` ROWS,
  -- so on a restore where no file was ever copied all three still report
  -- "0 missing" while every byte is absent. They catch a DB-only restore that
  -- also skipped storage.objects; they do NOT catch one that restored the
  -- metadata and not the files, which is the likelier accident.
  --
  -- SQL cannot see bucket contents, so this cannot be fixed here. The byte-level
  -- proof is BACKUP_RESTORE §4 step 7: open the app against the restored project
  -- and download a slip PDF. Treat a green result below as "the rows agree with
  -- each other", never as "the evidence survived".
  select 'METADATA ONLY (see note): viewing_slip signature rows', '0 missing',
         (select count(*)::text || ' missing' from viewing_slips vs
          where not exists (select 1 from storage.objects o
                            where o.bucket_id = 'signatures' and o.name = vs.signature_path))
  union all
  select 'METADATA ONLY (see note): viewing_slip PDF rows', '0 missing',
         (select count(*)::text || ' missing' from viewing_slips vs
          where vs.pdf_path is not null
            and not exists (select 1 from storage.objects o
                            where o.bucket_id = 'signatures' and o.name = vs.pdf_path))
  union all
  -- Evidence report PDFs live in `documents` under <org>/reports/evidence-*.
  -- Their bytes are what a commission claim is checked against.
  select 'METADATA ONLY (see note): evidence report rows', '0 missing',
         (select count(*)::text || ' missing' from documents d
          where d.storage_path like '%/reports/evidence-%'
            and not exists (select 1 from storage.objects o
                            where o.bucket_id = 'documents' and o.name = d.storage_path))
)

select kind, check_name, expected, actual, (expected = actual) as pass
from (
  -- a mismatch here may just mean the baseline snapshot is out of date
  select 'row count'::text as kind, check_name, expected::text, actual::text from counts
  -- these hold for ANY correct restore; a failure here is real
  union all select 'invariant', check_name, expected, actual from grant_checks
  union all select 'invariant', check_name, expected, actual from misc
) all_checks
-- failures first, and within them invariants before baseline counts
order by pass, kind, check_name;
