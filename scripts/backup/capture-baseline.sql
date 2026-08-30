-- capture-baseline.sql — emit a fresh `expected` block for verify-restore.sql
--
--   Run against the SOURCE (the database being backed up), immediately before
--   a drill, then paste the single output row into verify-restore.sql.
--
-- Why this exists: verify-restore.sql's row counts were hardcoded from a
-- snapshot, and the moment production moved on they reported FALSE FAILURES —
-- a restored database that is actually fine looks broken, which is the worst
-- possible outcome in the middle of a real recovery. Re-capturing is now one
-- command instead of counting 21 tables by hand.
--
-- Read-only.

select format(
$fmt$  select
    %s::bigint as orgs,      %s::bigint as profiles,   %s::bigint as events,
    %s::bigint as contacts,  %s::bigint as properties, %s::bigint as deals,
    %s::bigint as leads,     %s::bigint as viewings,   %s::bigint as slips,
    %s::bigint as documents, %s::bigint as keys,       %s::bigint as mandates,
    %s::bigint as tasks,     %s::bigint as cyprus_config,
    %s::bigint as deal_stages, %s::bigint as districts,
    %s::bigint as auth_users, %s::bigint as migrations,
    %s::bigint as obj_documents, %s::bigint as obj_signatures, %s::bigint as obj_media,
    %s::bigint as share_links, %s::bigint as share_link_properties,
    %s::bigint as unit_types, %s::bigint as buyer_requirements,
    %s::bigint as reservations, %s::bigint as reservation_installments,
    %s::bigint as task_kinds, %s::bigint as chain_checkpoints
    -- captured %s$fmt$,
  (select count(*) from organizations),
  (select count(*) from profiles),
  (select count(*) from events),
  (select count(*) from contacts),
  (select count(*) from properties),
  (select count(*) from deals),
  (select count(*) from leads),
  (select count(*) from viewings),
  (select count(*) from viewing_slips),
  (select count(*) from documents),
  (select count(*) from property_keys),
  (select count(*) from mandates),
  (select count(*) from tasks),
  (select count(*) from cyprus_config),
  (select count(*) from deal_stages),
  (select count(*) from districts),
  (select count(*) from auth.users),
  (select count(*) from supabase_migrations.schema_migrations),
  (select count(*) from storage.objects where bucket_id = 'documents'),
  (select count(*) from storage.objects where bucket_id = 'signatures'),
  (select count(*) from storage.objects where bucket_id = 'media'),
  (select count(*) from share_links),
  (select count(*) from share_link_properties),
  (select count(*) from unit_types),
  (select count(*) from buyer_requirements),
  (select count(*) from reservations),
  (select count(*) from reservation_installments),
  (select count(*) from task_kinds),
  (select count(*) from events_chain_checkpoint),
  now()::date
) as expected_block;
