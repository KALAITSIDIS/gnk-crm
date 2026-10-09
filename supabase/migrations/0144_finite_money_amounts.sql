-- =============================================================================
-- 0144 — a deal or offer amount is a NUMBER: 'NaN' is refused by the table
-- (T-finite-money-amounts, 2026-10-09; an operator-supplied audit finding,
-- verified first on a disposable stack).
--
-- THE DEFECT. offers.amount, deals.expected_value and deals.final_value are
-- numeric(14,2). PostgreSQL's numeric has a NaN value and a numeric(14,2)
-- column stores it: the typmod refuses ±Infinity and anything that rounds to
-- 10^12 (22003, measured on 17.6), never NaN. The CHECKs the three columns
-- carry — offers_amount_non_negative and deals_expected_value_non_negative
-- (0077), deals_final_value_non_negative (0076) — test `>= 0`, and NaN >= 0 is
-- TRUE: numeric sorts NaN above every number so that it can be indexed. So the
-- text 'NaN' (any case, spaces around it) is a value all three accepted. One
-- such row makes every sum() over its column NaN: admin_dashboard_stats'
-- open_pipeline.total and won_month.total for the whole organisation, and the
-- figure for the stage, agent or source holding the row in its per-stage
-- totals and in report_agent_performance's / report_source_roi's won_value —
-- each came back as the JSON string "NaN" (PostgREST reads a stored NaN back
-- as "NaN" too).
--
-- WHO COULD WRITE IT (measured at 0143 — money-amounts-finite.test.ts):
--   - an admin, or the deal's agent, straight through PostgREST: INSERT,
--     PATCH, upsert or a text/csv bulk POST of offers.amount or
--     deals.expected_value with the string "NaN" (a bare NaN token is not
--     JSON — PostgREST refuses the body, PGRST102 — and supabase-js serialises
--     a JS NaN as null). expected_value stays writable on a CLOSED deal (the
--     closed-deal guard does not freeze it), so won_month was reachable too.
--     The application's forms never send it: their validators refuse
--     non-finite input (lib/validators/deals.ts, Number.isFinite), and stay.
--   - service_role (the importer's and the restore's client), postgres and
--     postgres-owned SECURITY DEFINER bodies, in all three columns. A SESSION
--     writes deals.final_value only through close_deal, which refuses NaN
--     itself (0117 / 0118), because the closed-deal guard (0118; its body is
--     0131's) refuses a session's direct write of it; that guard binds user
--     sessions only, by design, so for every other writer the column had no
--     value rule beyond `>= 0`. A restore runs with session_replication_role
--     = replica, which fires no trigger at all.
--
-- THE FIX. Three CHECKs, one per column, naming the invariant — a finite
-- number — in the table, where it binds every writer: sessions, service_role,
-- postgres, definer bodies, imports, restores (a CHECK is not a trigger;
-- replica mode does not switch it off). `x not in ('NaN', 'Infinity',
-- '-Infinity')`: NaN = NaN is TRUE for numeric, so NOT IN refuses it, and a
-- NULL passes (the `is null or` is spelt out for the two nullable columns —
-- 0076 / 0077's house form). The infinity arms refuse nothing today — the
-- typmod refuses ±Infinity before any CHECK runs (22003) — and are there so
-- the invariant does not rest on the columns keeping their typmod. NOTHING
-- ELSE MOVES: types, nullability, defaults, the three non-negative CHECKs (an
-- offer of 0 and a deal value of 0 stay valid to the database; the app's own
-- "an offer is more than 0" stays the app's), the 10^12 limit, two-place
-- rounding, policies, grants, triggers, close_deal and every function body —
-- the postflight proves the constraints and the column types. Reports are NOT
-- taught to skip or zero a NaN: once none can be stored there is nothing to
-- hide. Other numeric columns with the same `>= 0` / `> 0` shape (asking
-- prices, areas, instalments …) are NOT changed here (BACKLOG).
--
-- EXISTING DATA. The preflight counts the rows holding NaN or ±Infinity in any
-- of the three columns and ABORTS THE WHOLE FILE, before any DDL, naming only
-- the three counts. Nothing is deleted, zeroed, nulled or guessed here: a NaN
-- amount records a bad write, and what the figure should have been is a
-- business question. List them read-only with
-- scripts/maintenance/preflight-0144-finite-amounts.sql, or with
--   select 'offers.amount' as col, id, org_id from public.offers
--    where amount in ('NaN', 'Infinity', '-Infinity')
--   union all
--   select 'deals.expected_value', id, org_id from public.deals
--    where expected_value in ('NaN', 'Infinity', '-Infinity')
--   union all
--   select 'deals.final_value', id, org_id from public.deals
--    where final_value in ('NaN', 'Infinity', '-Infinity');
-- correct each one, with its event, then apply this file again. The
-- constraints are validated IMMEDIATELY, never NOT VALID (0026 / 0077).
--
-- LOCKS. ADD CONSTRAINT ... CHECK takes ACCESS EXCLUSIVE. The preflight takes
-- it on deals, then offers, in ONE statement, BEFORE its counts, so no write
-- can land between the count and the constraints, and no lock is upgraded
-- later — the parent first, the order close_deal takes them (the deal FOR NO
-- KEY UPDATE, then its accepted offer FOR SHARE), so a close in flight makes
-- this file WAIT for it. A session's offer write reads deals through its RLS
-- policy as it starts, so one in flight also makes this file wait. What can
-- deadlock is a statement that holds offers and only then reaches deals — a
-- service_role or postgres offer write's key check at the end of its
-- statement, or a session statement on offers that begins in the instant
-- between the two locks: 40P01, one of the two rolled back whole, cleanly.
-- lock_timeout bounds each table's wait (5 s), so the LOCK waits at most
-- about 10 s, during which deals and offers are unreadable. No cron job writes
-- either table. A collision costs that wait and a clean 55P03 / 40P01 — apply
-- again, and do NOT write the ledger row. Run twice, the file drops and
-- re-adds the same three constraints (0077's replay idiom) and changes nothing.
--
-- DEPLOY ORDER: ADDITIVE, and no application change rides with it — hosted
-- whenever the operator approves. No request the deployed application sends
-- is refused (its validators refuse non-finite input before sending). No
-- function signature, return shape or grant changes — no release-compat
-- entry. lib/supabase/database.types.ts does not change (a CHECK is not part
-- of the generated types — regenerated and diffed). A backup holding a NaN
-- amount (one taken before this file, if any such row existed) no longer
-- restores into a database at 0144: its load is refused whole by these CHECKs
-- — correct the row in the dump.
--
-- ROLLBACK (DECISIONS T-finite-money-amounts): a FORWARD migration that drops
-- deals_expected_value_finite, deals_final_value_finite and
-- offers_amount_finite under the same bounded lock (supabase/tests/
-- revert-0144.ts holds the text), moves the verify-restore migrations pin
-- FORWARD and removes its 0144 row. No data moves either way: every row valid
-- at 0144 is valid at 0143.
--
-- NUMBERING: 0140 stays claimed by the unmerged fix/dashboard-won-value; the
-- ledger tolerates the gap (0141's header).
--
-- Pins that move with this file: the migrations count (142 -> 143) and one
-- 0144 invariant row in scripts/backup/verify-restore.sql. NO EXPLICIT
-- begin/commit — the CLI wraps the file (HANDOFF §3), as does one
-- execute_sql call. The file's LAST result is a read-only summary.
-- =============================================================================

-- Bounded lock waits (0113's lesson); see LOCKS above.
set local lock_timeout = '5s';

-- The file must run as ONE transaction (the CLI's wrapper, or one
-- execute_sql call): otherwise SET LOCAL is a no-op, the preflight's LOCK is
-- released as soon as its statement ends, and a failed assertion would not
-- undo the DDL before it.
do $$
begin
  if current_setting('lock_timeout') <> '5s' then
    raise exception '0144 aborted: this file must run as ONE transaction (SET LOCAL lock_timeout did not take effect) — nothing was changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 0. Preflight — abort, whole, over any stored amount that is not a finite
--    number
-- ---------------------------------------------------------------------------
do $$
declare
  n_offer int;
  n_expected int;
  n_final int;
begin
  -- the lock the DDL below needs, at its strongest, BEFORE the counts;
  -- the parent first (see LOCKS in the header)
  lock table public.deals, public.offers in access exclusive mode;

  select count(*) into n_offer
    from public.offers where amount in ('NaN', 'Infinity', '-Infinity');
  select count(*) into n_expected
    from public.deals where expected_value in ('NaN', 'Infinity', '-Infinity');
  select count(*) into n_final
    from public.deals where final_value in ('NaN', 'Infinity', '-Infinity');
  if n_offer + n_expected + n_final > 0 then
    raise exception '0144 aborted: % offer amount(s), % deal expected value(s) and % deal final value(s) are NaN or infinite — nothing was changed. '
                    'List them with the read-only query in this file''s header, correct each one, then apply again',
                    n_offer, n_expected, n_final;
  end if;

  raise notice '0144: preflight passed — no stored offer amount, expected value or final value is NaN or infinite';
end $$;

-- ---------------------------------------------------------------------------
-- 1. The three CHECKs — validated now, never NOT VALID
-- ---------------------------------------------------------------------------
-- Replay guard (0077's idiom): drop-if-exists before each add, so a replay
-- against an already-migrated database re-validates instead of aborting 42710.
alter table public.offers
  drop constraint if exists offers_amount_finite;
alter table public.offers
  add constraint offers_amount_finite
  check (amount not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric));

alter table public.deals
  drop constraint if exists deals_expected_value_finite,
  drop constraint if exists deals_final_value_finite;
alter table public.deals
  add constraint deals_expected_value_finite
  check (expected_value is null
         or expected_value not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)),
  add constraint deals_final_value_finite
  check (final_value is null
         or final_value not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric));

comment on constraint offers_amount_finite on public.offers is
  'An offer amount is a finite number, for every writer (0144). NaN passes '
  '>= 0 — numeric sorts it above every number — so offers_amount_non_negative '
  'alone admitted it; ±Infinity is refused by the numeric(14,2) type as well.';
comment on constraint deals_expected_value_finite on public.deals is
  'A deal''s expected value, when present, is a finite number, for every '
  'writer (0144). NaN passes >= 0, so deals_expected_value_non_negative alone '
  'admitted it and one such row turned the dashboard pipeline total NaN.';
comment on constraint deals_final_value_finite on public.deals is
  'A deal''s final value, when present, is a finite number, for every writer '
  '(0144). close_deal refuses NaN itself, but the closed-deal guard binds '
  'user sessions only — service_role, postgres, definer bodies and restores '
  'reached this column with no rule beyond >= 0.';

-- ---------------------------------------------------------------------------
-- 2. Postflight — the three CHECKs as written and validated; what this file
--    leaves alone is still as 0001 / 0076 / 0077 left it
-- ---------------------------------------------------------------------------
do $$
declare
  k record;
begin
  for k in
    select * from (values
      ('public.offers'::regclass, 'offers_amount_finite',
       'CHECK ((amount <> ALL (ARRAY[''NaN''::numeric, ''Infinity''::numeric, ''-Infinity''::numeric])))'),
      ('public.deals'::regclass, 'deals_expected_value_finite',
       'CHECK (((expected_value IS NULL) OR (expected_value <> ALL (ARRAY[''NaN''::numeric, ''Infinity''::numeric, ''-Infinity''::numeric]))))'),
      ('public.deals'::regclass, 'deals_final_value_finite',
       'CHECK (((final_value IS NULL) OR (final_value <> ALL (ARRAY[''NaN''::numeric, ''Infinity''::numeric, ''-Infinity''::numeric]))))'),
      ('public.offers'::regclass, 'offers_amount_non_negative',
       'CHECK ((amount >= (0)::numeric))'),
      ('public.deals'::regclass, 'deals_expected_value_non_negative',
       'CHECK (((expected_value IS NULL) OR (expected_value >= (0)::numeric)))'),
      ('public.deals'::regclass, 'deals_final_value_non_negative',
       'CHECK (((final_value IS NULL) OR (final_value >= (0)::numeric)))')
    ) as t(rel, name, def)
  loop
    if (select count(*) from pg_constraint
         where conrelid = k.rel and conname = k.name and contype = 'c'
           and convalidated and pg_get_constraintdef(oid) = k.def) <> 1 then
      raise exception '0144 postflight: % on % is not the validated CHECK % — nothing was changed', k.name, k.rel, k.def;
    end if;
  end loop;

  -- the columns keep their type and nullability: numeric(14,2), the amount
  -- required, the two deal values optional
  if (select count(*) from pg_attribute
       where not attisdropped
         and format_type(atttypid, atttypmod) = 'numeric(14,2)'
         and ((attrelid = 'public.offers'::regclass and attname = 'amount' and attnotnull)
           or (attrelid = 'public.deals'::regclass and attname in ('expected_value', 'final_value') and not attnotnull))) <> 3 then
    raise exception '0144 postflight: offers.amount, deals.expected_value or deals.final_value is no longer numeric(14,2) with its nullability — nothing was changed';
  end if;

  raise notice '0144: postflight passed — three validated CHECKs refuse NaN and ±Infinity in offers.amount, deals.expected_value and deals.final_value; the non-negative CHECKs and the column types unchanged';
end $$;

-- diagnostic: how many rows the validation read. The CLI and a raw
-- execute_sql return it; the md5-guarded apply (DECISIONS
-- T-unit-type-apply-atomic) EXECUTEs the file inside a DO block, which
-- discards it — read the counts in the separate verification call.
select '0144' as migration,
       (select count(*) from public.offers) as offers_checked,
       (select count(*) from public.deals)  as deals_checked;
