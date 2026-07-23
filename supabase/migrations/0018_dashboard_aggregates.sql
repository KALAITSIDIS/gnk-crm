-- 0018_dashboard_aggregates.sql
--
-- PERF-3 (audit 2026-07-22, docs/BACKLOG.md "Dashboard SQL-side aggregates").
--
-- The admin dashboard summed money in TypeScript over row-capped fetches:
-- deals/leads/properties at .limit(2000) and events at .limit(5000). Counts
-- were already exact (`count: "exact"`, 2026-07-16), but the € FIGURES were
-- not — past the cap the headline "Open pipeline" and "Won this month" tiles
-- silently under-reported, with nothing on screen saying so. A wrong number
-- that looks right is worse than an error.
--
-- Fix per the BACKLOG line: one SECURITY INVOKER function doing the group-bys
-- in SQL. SECURITY INVOKER is load-bearing — the aggregates must be computed
-- under the CALLER's RLS, exactly like the queries they replace, so this can
-- never become a way to read another org's totals.
--
-- Window bounds are PARAMETERS, not computed here on purpose: the Cyprus
-- wall-clock month boundary already lives in lib/utils/tz.ts with unit tests
-- (doc 02 §A11). Re-deriving it in SQL would be a second source of truth that
-- could drift across a DST edge.

-- ---------------------------------------------------------------------------
-- 1. Indexes the new aggregates need
-- ---------------------------------------------------------------------------
-- `deals_stage_idx` is PARTIAL on status='open', so it cannot serve the
-- won-this-month window at all; that predicate has always been unindexed.
create index if not exists deals_won_idx
  on deals (org_id, won_at desc)
  where status = 'won';

-- `leads_status_idx` leads with (org_id, status, ...), so a received_at range
-- across all statuses cannot use it. Both lead aggregates below are such ranges.
create index if not exists leads_received_idx
  on leads (org_id, received_at desc);

-- ---------------------------------------------------------------------------
-- 2. Admin dashboard aggregates, in one round trip
-- ---------------------------------------------------------------------------
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
    -- first-response KPI: average over ANSWERED leads only, in minutes
    'leads7', (
      select jsonb_build_object(
        'total',    count(*),
        'answered', count(first_response_at),
        'avg_response_min',
          avg(extract(epoch from (first_response_at - received_at)) / 60.0)
            filter (where first_response_at is not null)
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
  'Cyprus wall-clock boundaries live in lib/utils/tz.ts.';

-- anon must never reach org aggregates; service_role keeps EXECUTE because its
-- grant rides on PUBLIC and 0007 proved that revoking PUBLIC strips it (0010).
revoke execute on function public.admin_dashboard_stats(timestamptz, timestamptz, timestamptz) from public, anon;
grant  execute on function public.admin_dashboard_stats(timestamptz, timestamptz, timestamptz) to authenticated, service_role;
