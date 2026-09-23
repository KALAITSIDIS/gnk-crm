-- =============================================================================
-- Preflight for migration 0113 (property areas positive; floor within total).
-- READ-ONLY: two SELECTs inside a read-only transaction that is rolled back.
--
-- Run it against the database 0113 is about to be applied to, BEFORE the
-- apply, and again right before if time has passed:
--
--   local:   docker exec -i supabase_db_gnk-crm psql -U postgres -d postgres \
--              -v ON_ERROR_STOP=1 < scripts/maintenance/preflight-0113-floor-area.sql
--   hosted:  paste each SELECT (without begin/rollback) into the Supabase
--            connector's execute_sql, or the dashboard SQL editor
--
-- 1. Counts per rule — the numbers 0113's own preflight aborts on. All zero
--    means 0113 applies cleanly.
-- 2. The offending rows, one line per broken rule, with enough to find each
--    record in the CRM (reference, kind, type, status, visibility) and the
--    values involved. Correct each THROUGH THE CRM — the Details save is
--    evented; a raw UPDATE is not. Nothing here changes anything, and the
--    migration never rewrites a property fact on its own.
--
-- Measured 2026-09-23 on production (yjgirvzgoiywdojnpkpd, ledger 0112):
-- 17 properties, 0 unit types; every count 0. One row (PAF0001, a villa)
-- holds floor 2 of 2 — admitted by the `<=` rule, which is why it is `<=`.
-- =============================================================================

begin transaction read only;

-- 1. counts per rule
select
  (select count(*) from public.properties)                                  as properties,
  (select count(*) from public.properties where covered_area_sqm <= 0)      as covered_area_not_positive,
  (select count(*) from public.properties where plot_area_sqm <= 0)         as plot_area_not_positive,
  (select count(*) from public.properties where floor_number > total_floors) as floor_above_total,
  (select count(*) from public.properties where floor_number = total_floors) as floor_equals_total_admitted,
  (select count(*) from public.unit_types)                                  as unit_types,
  (select count(*) from public.unit_types where covered_area_sqm <= 0)      as unit_type_area_not_positive;

-- 2. the rows each rule would refuse
select 'properties' as tbl, p.id, p.reference, p.kind::text, p.property_type::text,
       p.status::text, p.visibility::text, v.rule,
       p.covered_area_sqm, p.plot_area_sqm, p.floor_number, p.total_floors, p.updated_at
  from public.properties p
  cross join lateral (values
    ('covered_area_sqm <= 0',        p.covered_area_sqm <= 0),
    ('plot_area_sqm <= 0',           p.plot_area_sqm <= 0),
    ('floor_number > total_floors',  p.floor_number > p.total_floors)
  ) as v(rule, broken)
 where v.broken
union all
select 'unit_types', t.id, t.code, 'unit_type', null, null, null, 'covered_area_sqm <= 0',
       t.covered_area_sqm, null, null, null, t.created_at
  from public.unit_types t
 where t.covered_area_sqm <= 0
 order by 1, 3, 8;

rollback;
