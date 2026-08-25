-- 0054 — let a listing take its area's centre as a coordinate, and record that
-- it did.
--
-- 0031 gave every district and area a centroid, and the MAP already falls back
-- to them: `resolvePosition` returns the exact point if there is one, else the
-- area centroid, else the district centroid, marking the last two
-- `approximate`. So a property with no coordinates is already ON the map.
--
-- ============================================================================
-- WHY THIS NEEDS A COLUMN AND NOT JUST A BUTTON.
--
-- The obvious implementation — a button that writes the area centroid into
-- `properties.location` — would break two things that currently work, and
-- break them SILENTLY:
--
--   1. THE QUALITY SCORE WOULD START LYING. `computeQualityScore` awards 10
--      points for "Exact map location", and the input is literally
--      `location !== null` (in TWO places: quality-score.ts and the recompute
--      inside saveProperty). Writing a centroid there earns every property ten
--      points for a coordinate nobody surveyed. The desk reads that score.
--
--   2. THE MAP WOULD LOSE THE DISTINCTION IT WAS BUILT WITH. `resolvePosition`
--      infers precision from WHICH source it fell back to. Once a centroid is
--      stored in `location`, that inference says "exact", and 0031's own
--      comment — "approximate pins render differently from exact ones so nobody
--      reads a centroid as a surveyed point" — stops being true.
--
-- So the flag is the feature. `location_approx` says the stored point is a
-- centroid, and both readers are taught to respect it.
-- ============================================================================
--
-- THE CHECK MATTERS. A row claiming an approximate location while holding no
-- location at all is a flag qualifying nothing — it would read as "we know
-- roughly where this is" when we know nothing. The constraint makes that state
-- unrepresentable rather than merely discouraged.
--
-- EXISTING ROWS ARE UNTOUCHED, deliberately: every one gets `false`, so every
-- coordinate already entered stays exact and no quality score moves. This
-- migration cannot change a single existing number, which is the property that
-- makes it safe to apply to production with real listings on it.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

alter table public.properties
  add column if not exists location_approx boolean not null default false;

comment on column public.properties.location_approx is
  'TRUE when `location` holds an area or district centroid taken as a stand-in '
  'rather than a surveyed point. The quality score does not count it as an '
  'exact location and the map draws it as an approximate pin. Cleared '
  'automatically when a real coordinate is entered.';

alter table public.properties drop constraint if exists properties_location_approx_needs_point;

alter table public.properties
  add constraint properties_location_approx_needs_point
  check (not location_approx or location is not null);

do $$
declare
  n_flagged  int;
  probe_prop uuid;
  refused    boolean := false;
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'properties'
                    and column_name = 'location_approx') then
    raise exception '0054 aborted: properties.location_approx is missing';
  end if;

  -- NOTHING may have been flagged by this migration. If a row came out true,
  -- the default is wrong and existing quality scores are about to move.
  select count(*) into n_flagged from properties where location_approx;
  if n_flagged <> 0 then
    raise exception '0054 aborted: % row(s) were flagged approximate on apply', n_flagged;
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.properties'::regclass
                    and conname = 'properties_location_approx_needs_point') then
    raise exception '0054 aborted: the coherence constraint was not created';
  end if;

  -- PROVE the constraint bites rather than trusting it. A flag with no point is
  -- the shape that would read as knowledge we do not have.
  select id into probe_prop from properties where location is null limit 1;
  if probe_prop is not null then
    begin
      update properties set location_approx = true where id = probe_prop;
    exception when check_violation then
      refused := true;
    end;
    if not refused then
      raise exception '0054 aborted: a location-less row accepted location_approx = true';
    end if;
    raise notice '0054: column added, 0 rows flagged, constraint PROVEN to refuse a flag with no point';
  else
    -- SAY WHICH IT WAS. On a database where every property already has
    -- coordinates there is nothing to probe with, and claiming a pass would be
    -- a claim with nothing behind it.
    raise notice '0054: column added, 0 rows flagged; constraint probe SKIPPED (no location-less property on this database)';
  end if;
end $$;
