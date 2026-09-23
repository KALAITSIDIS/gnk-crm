-- =============================================================================
-- 0113 — a property's areas are positive and its floor is inside its building
--        (audit 2026-09-23, property validation; the floors-and-areas slice
--        of the 2026-09-15 data-integrity audit's LST-07, BACKLOG "Phase 1 —
--        the constraint migration")
--
-- THE DEFECT. Reproduced against a321de5 with the real schemas: the details
-- form accepted floor 9 of a 3-floor building and a 0 m² covered or plot
-- area, while the create wizard refused a 0 m² area — the same fact valid or
-- invalid depending on which form typed it. Behind both, nothing: the four
-- columns have carried no constraint since 0001, and the service-role CSV
-- importer writes any finite number (0077's own reason for value CHECKs).
-- A 0 area is not harmless: the quality score and the publish gate count it
-- as "area set", and the site renders "0 m²".
--
-- THE RULES (one definition in the app: lib/validators/property-measurements.ts).
--   * covered_area_sqm, plot_area_sqm: NULL (unknown, or not applicable — a
--     flat has no plot of its own, land has no covered area) or > 0. Never 0:
--     unknown is null. The columns are numeric(10,2)/(12,2), which round
--     0.004 to 0.00 BEFORE a CHECK sees it, so the check is on the value as
--     stored; the app refuses anything under 0.01 with its own message.
--   * floor_number <= total_floors when BOTH are known. The ground floor is
--     0 (the unit generator's convention) and a basement is negative — both
--     stay legal. Whether total_floors counts the ground storey is recorded
--     nowhere, so the rule refuses only what no reading admits (floor N+1 of
--     N) and admits the top floor either way; production holds one 2-of-2
--     row (read-only, 2026-09-23), which `<` would have refused.
--   * unit_types.covered_area_sqm: NULL or > 0 — applyUnitType stamps it onto
--     units, and a zero there would otherwise surface half-way through that
--     non-atomic loop instead of at the type.
-- Deliberately NOT constrained: bedrooms, bathrooms, wc, parking, veranda,
-- roof garden and basement areas (zero is a real answer for each), and
-- total_floors' sign (the app's rule since T1.3; no finding asked for it).
--
-- WHAT THIS FILE DOES.
--   1. Preflight — counts the rows each rule would refuse and ABORTS naming
--      every number (the 0077/0087 shape). It repairs nothing: a property
--      fact is corrected by a person, through the CRM, where the save is
--      evented. scripts/maintenance/preflight-0113-floor-area.sql lists the
--      offending rows read-only, for review.
--   2. Four CHECKs, validated immediately — never NOT VALID (the 0026
--      stance). A NOT VALID CHECK still binds every later UPDATE of a legacy
--      row, and the details form re-posts all four columns on every save, so
--      a staged constraint would lock such a listing's Details tab (status,
--      price, publish) until someone found the field: worse than refusing to
--      apply.
--   3. Column comments that write the convention down.
--   4. Assertions: the four constraints exist and are convalidated.
--
-- NOT DONE HERE: no data change of any kind; no cross-row rule (a unit's
-- floor against its project's height — units never carry total_floors); no
-- "villas carry no floor_number" rule (the audit asks for a worklist warning,
-- not a CHECK); no bounds on floor_number beyond int4; no trigger, function,
-- grant or policy.
--
-- DEPLOY ORDER. The CRM change that ships with this file is compatible with
-- the database either side of it, so the code goes FIRST (the 0072 order):
-- the still-deployed editor accepts a 0 m² area and floor 9 of 3, and with
-- these CHECKs in place such a save would fail closed with a raw 23514 —
-- nothing written, no event, but an unreadable message. Merge and deploy,
-- confirm the deployed SHA, re-run the preflight, then apply this file.
-- Rollback, should it ever be wanted, is a forward migration of its own (the
-- house stance, DECISIONS T-audit-2026-09-21-evening): `alter table … drop
-- constraint if exists …` for the four names below plus `comment on column …
-- is null` for the four comments, with its own ledger row and pins. No data
-- moves in either direction; the application needs none of it to work.
--
-- Pins that move with this file: the migrations count in
-- scripts/backup/verify-restore.sql (113). database.types.ts is unaffected
-- (a CHECK changes no type).
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).
-- =============================================================================

-- ADD CONSTRAINT takes an ACCESS EXCLUSIVE lock on the table it scans. Queued
-- behind a long transaction it would block every read of `properties` — the
-- public feed included — for as long as it waited; give up instead, and apply
-- again. (No effect outside a transaction block, where it only warns.)
set local lock_timeout = '5s';

-- ---------- 1. preflight ------------------------------------------------------

do $$
declare
  n_covered int;
  n_plot    int;
  n_floor   int;
  n_types   int;
begin
  select count(*) filter (where covered_area_sqm <= 0),
         count(*) filter (where plot_area_sqm <= 0),
         count(*) filter (where floor_number > total_floors)
    into n_covered, n_plot, n_floor
    from public.properties;
  select count(*) into n_types from public.unit_types where covered_area_sqm <= 0;

  if n_covered + n_plot + n_floor + n_types > 0 then
    raise exception
      '0113 aborted: % propert(ies) with covered_area_sqm <= 0, % with plot_area_sqm <= 0, % with floor_number > total_floors, % unit type(s) with covered_area_sqm <= 0 — review them with scripts/maintenance/preflight-0113-floor-area.sql and correct each through the CRM (the save is evented); this migration repairs nothing',
      n_covered, n_plot, n_floor, n_types;
  end if;
end $$;

-- ---------- 2. the CHECKs -----------------------------------------------------

-- Re-run guard (the 0045/0049/0054/0077 idiom): inert on first apply; makes a
-- replay against an already-migrated database a no-op instead of a 42710.
alter table public.properties
  drop constraint if exists properties_covered_area_positive,
  drop constraint if exists properties_plot_area_positive,
  drop constraint if exists properties_floor_within_total;
alter table public.properties
  add constraint properties_covered_area_positive
  check (covered_area_sqm is null or covered_area_sqm > 0),
  add constraint properties_plot_area_positive
  check (plot_area_sqm is null or plot_area_sqm > 0),
  add constraint properties_floor_within_total
  check (floor_number is null or total_floors is null or floor_number <= total_floors);

alter table public.unit_types
  drop constraint if exists unit_types_covered_area_positive;
alter table public.unit_types
  add constraint unit_types_covered_area_positive
  check (covered_area_sqm is null or covered_area_sqm > 0);

-- ---------- 3. the convention, written down -----------------------------------

comment on column public.properties.covered_area_sqm is
  'Covered (internal) area in m². NULL = not known, or not applicable (land; a '
  'development, whose units carry it). Never 0: a known area is > 0 (0113).';
comment on column public.properties.plot_area_sqm is
  'Plot in m² — the site plot for a development. NULL = not known, or none of its '
  'own (a flat in a block). Never 0: a known plot is > 0 (0113).';
comment on column public.properties.floor_number is
  'The floor the property is on: 0 = ground floor (the unit generator''s '
  'convention), negative = basement. NULL = not known or not applicable. Never '
  'above total_floors when both are known (0113).';
comment on column public.properties.total_floors is
  'Floors in the building (for a whole dwelling, its storeys). Whether the ground '
  'storey is counted is not fixed, so 0113 refuses only floor_number > '
  'total_floors, which no reading admits.';

-- ---------- 4. assertions -----------------------------------------------------

do $$
declare
  n int;
begin
  -- all four in, and VALIDATED — never NOT VALID (the 0026 stance)
  select count(*) into n from pg_constraint
   where contype = 'c'
     and convalidated
     and (conrelid, conname) in (
       ('public.properties'::regclass, 'properties_covered_area_positive'),
       ('public.properties'::regclass, 'properties_plot_area_positive'),
       ('public.properties'::regclass, 'properties_floor_within_total'),
       ('public.unit_types'::regclass, 'unit_types_covered_area_positive'));
  if n <> 4 then
    raise exception '0113 aborted: expected 4 validated CHECKs, found %', n;
  end if;

  raise notice '0113: areas positive (properties + unit_types) and floor_number <= total_floors, validated; no row changed';
end $$;
