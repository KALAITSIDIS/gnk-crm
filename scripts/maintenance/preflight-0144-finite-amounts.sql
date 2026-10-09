-- =============================================================================
-- Preflight for migration 0144 (offer and deal amounts are finite numbers).
-- READ-ONLY: two SELECTs inside a read-only transaction that is rolled back.
--
-- Run it against the database 0144 is about to be applied to, BEFORE the
-- apply, and again right before if time has passed:
--
--   local:   docker exec -i supabase_db_gnk-crm psql -U postgres -d postgres \
--              -v ON_ERROR_STOP=1 < scripts/maintenance/preflight-0144-finite-amounts.sql
--   hosted:  paste each SELECT (without begin/rollback) into the Supabase
--            connector's execute_sql, or the dashboard SQL editor — only with
--            the operator's approval for that read
--
-- 1. Counts per column — the numbers 0144's own preflight aborts on. All zero
--    means 0144 applies cleanly. ±Infinity cannot be stored in numeric(14,2)
--    (the type refuses it, 22003), so those counts can only ever read 0; they
--    are here because the migration's CHECKs name them.
-- 2. The offending rows, one line per column, with enough to find each record
--    in the CRM (id, organisation, the deal's status, when it was written) and
--    nothing else — no amount (it is NaN), no title, no party. Correct each
--    THROUGH THE CRM where it can be (the deal's Details save and the offer's
--    edit are evented; a raw UPDATE is not); a final_value can only be written
--    by close_deal, so a NaN one on a closed deal is a decision for the
--    operator, never a guess. Nothing here changes anything, and the migration
--    never rewrites an amount on its own.
--
-- Measured 2026-10-09 ~10:00Z on production (yjgirvzgoiywdojnpkpd, ledger 142
-- rows, latest 0143, PostgreSQL 17.6), read-only, on the operator's word: 0
-- offers, 1 deal; every count 0; the row listing empty. The three existing
-- non-negative CHECKs are validated with exactly the definitions 0144's
-- postflight expects, and the columns are numeric(14,2) (amount not null,
-- the two deal values nullable). 0144 applies cleanly there.
-- =============================================================================

begin transaction read only;

-- 1. counts per column
select
  (select count(*) from public.offers)                                        as offers,
  (select count(*) from public.offers where amount = 'NaN')                   as offer_amount_nan,
  (select count(*) from public.offers where amount in ('Infinity', '-Infinity')) as offer_amount_infinite,
  (select count(*) from public.deals)                                         as deals,
  (select count(*) from public.deals where expected_value = 'NaN')            as deal_expected_value_nan,
  (select count(*) from public.deals where expected_value in ('Infinity', '-Infinity')) as deal_expected_value_infinite,
  (select count(*) from public.deals where final_value = 'NaN')               as deal_final_value_nan,
  (select count(*) from public.deals where final_value in ('Infinity', '-Infinity')) as deal_final_value_infinite;

-- 2. the rows each CHECK would refuse
select 'offers.amount' as col, o.id, o.org_id, d.status::text as deal_status, o.status::text as offer_status, o.created_at
  from public.offers o
  join public.deals d on d.id = o.deal_id
 where o.amount in ('NaN', 'Infinity', '-Infinity')
union all
select 'deals.expected_value', d.id, d.org_id, d.status::text, null, d.created_at
  from public.deals d
 where d.expected_value in ('NaN', 'Infinity', '-Infinity')
union all
select 'deals.final_value', d.id, d.org_id, d.status::text, null, d.created_at
  from public.deals d
 where d.final_value in ('NaN', 'Infinity', '-Infinity')
 order by 1, 6;

rollback;
