-- 0042 — median and p90 first-response, beside the existing mean.
--
-- The admin dashboard reported the MEAN only. Nine leads answered in four
-- minutes and one abandoned for three days averages to about seven hours and
-- reads as healthy; the median says four minutes and the p90 says three days,
-- which is the actual story. Raised by the 2026-08-23 outside review. Nothing
-- new is recorded — `received_at` and `first_response_at` have been collected
-- since 0001.
--
-- EXTENDS `admin_dashboard_stats` RATHER THAN ADDING A FUNCTION. 0018 exists to
-- collapse round trips (9 → 4); a separate percentile function would have added
-- a fifth for numbers the `leads_7` CTE is already sitting on. The plan this
-- came from proposed a standalone function and was wrong about that.
--
-- SECURITY INVOKER is inherited from 0018 and is load-bearing: the aggregate
-- must run under the CALLER's RLS, exactly like the queries it replaced, so it
-- can never become a way to read another org's numbers.
--
-- Window bounds stay PARAMETERS for 0018's reason — the Cyprus wall-clock month
-- boundary lives in lib/utils/tz.ts with unit tests, and re-deriving it here
-- would be a second source of truth that drifts across a DST edge.
--
-- ONE BEHAVIOUR CHANGE, DELIBERATE AND STATED: all three response figures now
-- exclude rows where `first_response_at < received_at`. A negative interval
-- means a clock was corrected or a row was imported with a backdated
-- `received_at`; it does not mean the desk answered before the lead arrived. It
-- was already meaningless in the mean — it just had nobody to be inconsistent
-- with. Leaving the guard off the mean while the percentiles carried it would
-- put three numbers side by side computed over different row sets. The
-- assertion block below reports how many rows this actually affects, so the
-- change is visible rather than assumed.
--
-- `create or replace function` PRESERVES the existing ACL (HANDOFF §3) — the
-- revoke/grant pair from 0018 is NOT repeated here. `proacl` is re-read in the
-- assertion block anyway, because "preserves" is a claim worth checking.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

create or replace function admin_dashboard_stats(
  p_month_start timestamptz,
  p_d7          timestamptz,
  p_d30         timestamptz
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with open_deals as (
    select stage_id, coalesce(expected_value, 0) as expected_value
      from deals
     where status = 'open'
  ),
  won_deals as (
    select coalesce(expected_value, 0) as expected_value
      from deals
     where status = 'won'
       and won_at >= p_month_start
  ),
  leads_7 as (
    select received_at, first_response_at
      from leads
     where received_at >= p_d7
  )
  select jsonb_build_object(
    -- headline € tiles: exact sums over every row, no cap
    'open_pipeline', jsonb_build_object(
      'total', coalesce((select sum(expected_value) from open_deals), 0),
      'count', (select count(*) from open_deals)
    ),
    'won_month', jsonb_build_object(
      'total', coalesce((select sum(expected_value) from won_deals), 0),
      'count', (select count(*) from won_deals)
    ),
    -- pipeline € by stage (open deals only); the app joins names from
    -- deal_stages, which is a tiny table it already reads for ordering
    'stages', coalesce((
      select jsonb_agg(jsonb_build_object(
               'stage_id', stage_id,
               'total',    total,
               'count',    cnt
             ))
        from (
          select stage_id, sum(expected_value) as total, count(*) as cnt
            from open_deals
           group by stage_id
        ) s
    ), '[]'::jsonb),
    -- first-response KPI over ANSWERED leads only, in minutes.
    --
    -- `answered` counts every lead with a first_response_at, INCLUDING any with
    -- a negative interval, because it answers "did the desk reply?" — a
    -- question the clock anomaly does not change. The three duration figures
    -- exclude them; see the header. `total - answered` is the never-answered
    -- count, which the UI must show beside the percentiles: an unanswered lead
    -- is in no percentile, and percentiles without it flatter the desk.
    'leads7', (
      select jsonb_build_object(
        'total',    count(*),
        'answered', count(first_response_at),
        'avg_response_min',
          avg(extract(epoch from (first_response_at - received_at)) / 60.0)
            filter (where first_response_at is not null
                      and first_response_at >= received_at),
        'p50_response_min',
          percentile_cont(0.5) within group (
            order by extract(epoch from (first_response_at - received_at)) / 60.0
          ) filter (where first_response_at is not null
                      and first_response_at >= received_at),
        'p90_response_min',
          percentile_cont(0.9) within group (
            order by extract(epoch from (first_response_at - received_at)) / 60.0
          ) filter (where first_response_at is not null
                      and first_response_at >= received_at)
      )
      from leads_7
    ),
    'lead_sources30', coalesce((
      select jsonb_agg(jsonb_build_object('source', source, 'count', cnt)
                       order by cnt desc, source)
        from (
          select source, count(*) as cnt
            from leads
           where received_at >= p_d30
           group by source
        ) s
    ), '[]'::jsonb),
    'property_statuses', coalesce((
      select jsonb_agg(jsonb_build_object('status', status, 'count', cnt)
                       order by cnt desc, status)
        from (
          select status, count(*) as cnt
            from properties
           group by status
        ) s
    ), '[]'::jsonb),
    -- top agents by activity: previously sampled over the most recent 5000
    -- events, so a busy month could rank the wrong people. Now exact.
    --
    -- NOTE (0042): the 2026-08-23 review called this a vanity metric and it is
    -- right — clicks are not conversion. Replacing it needs an operator
    -- decision on which metrics take its place, so it is a BACKLOG line and
    -- deliberately NOT changed here.
    'top_actors30', coalesce((
      select jsonb_agg(jsonb_build_object('actor_id', actor_id, 'count', cnt)
                       order by cnt desc, actor_id)
        from (
          select actor_id, count(*) as cnt
            from events
           where occurred_at >= p_d30
             and actor_id is not null
           group by actor_id
           order by cnt desc, actor_id
           limit 5
        ) s
    ), '[]'::jsonb)
  );
$$;

comment on function admin_dashboard_stats(timestamptz, timestamptz, timestamptz) is
  'PERF-3: admin dashboard aggregates computed in SQL under the caller''s RLS. '
  'Replaces TS reduces over .limit(2000)/.limit(5000) fetches whose money sums '
  'silently undercounted past the cap. Window bounds are passed in because the '
  'Cyprus wall-clock boundaries live in lib/utils/tz.ts. '
  '0042 added p50/p90 first-response and excluded negative intervals from all '
  'three duration figures.';

do $$
declare
  is_definer boolean;
  negatives  int;
begin
  -- 1. still SECURITY INVOKER. If this ever flips, the function becomes a way
  --    to read another org's aggregates and every RLS test above it is moot.
  select p.prosecdef into is_definer
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'admin_dashboard_stats';
  if is_definer is null then
    raise exception '0042 aborted: admin_dashboard_stats is missing';
  end if;
  if is_definer then
    raise exception '0042 aborted: admin_dashboard_stats became SECURITY DEFINER';
  end if;

  -- 2. `create or replace` is documented to preserve the ACL; check rather than
  --    trust, because 0018's revoke/grant pair is deliberately not repeated.
  if has_function_privilege('anon', 'public.admin_dashboard_stats(timestamptz, timestamptz, timestamptz)', 'execute') then
    raise exception '0042 aborted: anon can execute admin_dashboard_stats';
  end if;
  if not has_function_privilege('authenticated', 'public.admin_dashboard_stats(timestamptz, timestamptz, timestamptz)', 'execute') then
    raise exception '0042 aborted: authenticated lost EXECUTE on admin_dashboard_stats';
  end if;

  -- 3. Report how many rows the new guard actually excludes, so the one
  --    behaviour change in this migration is observed and not assumed. A
  --    NOTICE, not an exception: a backdated import is legitimate data.
  select count(*) into negatives
    from leads
   where first_response_at is not null
     and first_response_at < received_at;
  raise notice '0042: % lead row(s) have first_response_at < received_at and are now excluded from the mean as well as the percentiles', negatives;
end $$;
