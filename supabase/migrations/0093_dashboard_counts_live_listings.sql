-- =============================================================================
-- 0093 — the dashboard's "Listings by status" counts live rows only
--        (audit 2026-09-13, CRM-04)
--
-- On 2026-09-13 the card read "available 16" while the org held ten live rows
-- with that status. The other six were the archived PAF0005 phase and units:
-- an archived listing keeps its last STATUS (restore needs it), and
-- admin_dashboard_stats grouped `properties` by status with no visibility
-- predicate. The properties list excludes `visibility = 'archived'` from its
-- default scope; the card now counts the same rows the list shows.
--
-- The rest of the function is 0057's body verbatim. Additive in effect (the
-- JSON shape is unchanged), so the standing order applies: apply to hosted
-- BEFORE the merge. `create or replace` preserves the ACL (HANDOFF §3) and the
-- self-check below asserts it rather than assumes it.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.admin_dashboard_stats(p_month_start timestamp with time zone, p_d7 timestamp with time zone, p_d30 timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
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
    -- exclude them; see 0042. `total - answered` is the never-answered count,
    -- which the UI must show beside the percentiles: an unanswered lead is in
    -- no percentile, and percentiles without it flatter the desk.
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
    -- 0093: live rows only — an archived listing keeps its status for restore
    -- and must not be counted as if it were on the books. Same predicate as
    -- the properties list's default scope.
    'property_statuses', coalesce((
      select jsonb_agg(jsonb_build_object('status', status, 'count', cnt)
                       order by cnt desc, status)
        from (
          select status, count(*) as cnt
            from properties
           where visibility <> 'archived'
           group by status
        ) s
    ), '[]'::jsonb)
  );
$function$;

do $$
declare
  v    jsonb;
  k    text;
  acl  text;
  src  text;
begin
  v := admin_dashboard_stats(now(), now(), now());
  foreach k in array array['open_pipeline','won_month','stages','leads7',
                           'lead_sources30','property_statuses'] loop
    if not (v ? k) then
      raise exception '0093 aborted: lost key % from admin_dashboard_stats', k;
    end if;
  end loop;

  select prosrc into src from pg_proc where proname = 'admin_dashboard_stats';
  if src !~ 'visibility <> ''archived''' then
    raise exception '0093 aborted: property_statuses still counts archived rows';
  end if;

  select coalesce(proacl::text, 'NULL') into acl
    from pg_proc where proname = 'admin_dashboard_stats';
  if acl like '%anon=%' then
    raise exception '0093 aborted: anon gained EXECUTE on admin_dashboard_stats (acl %)', acl;
  end if;
  if acl not like '%authenticated=X%' then
    raise exception '0093 aborted: authenticated LOST EXECUTE (acl %)', acl;
  end if;

  raise notice '0093: property_statuses counts live listings only; 6 keys intact; acl %', acl;
end $$;
