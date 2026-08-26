-- 0057 — remove `top_actors30` from `admin_dashboard_stats`.
-- Operator decision, 2026-08-26: DROP "top agents by activity", replace with
-- nothing.
--
-- 0042 predicted this migration in a comment it left in the function body:
-- "the 2026-08-23 review called this a vanity metric and it is right — clicks
-- are not conversion. Replacing it needs an operator decision on which metrics
-- take its place, so it is a BACKLOG line and deliberately NOT changed here."
-- The decision came back: nothing takes its place. The card is gone from the
-- admin dashboard and this stops the database computing the number for it.
--
-- ============================================================================
-- REPLACE WITH NOTHING MEANS THE QUERY GOES TOO.
--
-- Deleting only the card would leave every admin dashboard load paying for a
-- 30-day group-by over `events` that nobody reads. The aggregate had already
-- been made EXACT by 0042 (it previously ranked a 5000-row sample), so what is
-- being removed is real work, not a stub.
-- ============================================================================
--
-- THE DEPLOY ORDER IS THE DESTRUCTIVE ONE (HANDOFF §0a trap 2). This migration
-- removes a key from the function's jsonb. Pre-removal code does
-- `stats.top_actors30.map(...)`, which on `undefined` throws and takes the whole
-- admin dashboard to the error boundary. So: MERGE AND DEPLOY THE CODE FIRST,
-- confirm production is serving it, and only then apply this.
--
-- In the other direction it is safe: the deployed component simply ignores a
-- key that is still there. That asymmetry is why code-first is correct, and it
-- mirrors the note 0042 left on the OPTIONAL `p50/p90` fields for the additive
-- case.
--
-- `create or replace` PRESERVES THE ACL (HANDOFF §3) — asserted below rather
-- than assumed, because the property that matters is that `anon` has never had
-- EXECUTE on this function and must still not.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

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
    ), '[]'::jsonb)
  );
$function$;


do $$
declare
  v    jsonb;
  k    text;
  acl  text;
begin
  -- The window arguments are irrelevant to the SHAPE, which is what is asserted.
  v := admin_dashboard_stats(now(), now(), now());

  if v ? 'top_actors30' then
    raise exception '0057 aborted: top_actors30 is still in the result';
  end if;

  -- Everything the admin dashboard still reads must survive. A `create or
  -- replace` that silently dropped one of these would paint an empty card
  -- rather than fail, which is the failure worth catching here.
  foreach k in array array['open_pipeline','won_month','stages','leads7',
                           'lead_sources30','property_statuses'] loop
    if not (v ? k) then
      raise exception '0057 aborted: lost key % from admin_dashboard_stats', k;
    end if;
  end loop;

  select coalesce(proacl::text, 'NULL') into acl
    from pg_proc where proname = 'admin_dashboard_stats';

  if acl like '%anon=%' then
    raise exception '0057 aborted: anon gained EXECUTE on admin_dashboard_stats (acl %)', acl;
  end if;
  if acl not like '%authenticated=X%' then
    raise exception '0057 aborted: authenticated LOST EXECUTE (acl %)', acl;
  end if;

  raise notice '0057: top_actors30 removed, 6 keys intact, acl %', acl;
end $$;
