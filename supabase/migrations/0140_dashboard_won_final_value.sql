-- =============================================================================
-- 0140 — the dashboard's "won this month" counts the confirmed final value again
--
-- THE GAP (BACKLOG "The dashboard's \"won this month\" lost `final_value`
-- again"; the 2026-10-04 triage's #2, re-verified and upheld by two
-- skeptics; pinned RED first by supabase/tests/dashboard-won-value.test.ts):
--
--   * 0076 made a won deal count at coalesce(final_value, expected_value)
--     everywhere — the reports, the leaderboard, the dashboard tile. 0093
--     rebuilt admin_dashboard_stats() from 0057's body to fix the listings
--     card and silently undid 0076's two lines: the admin's headline
--     "won this month" summed the ESTIMATE again. close_deal (0117) records
--     the accepted offer's amount as final_value when nobody types one, so
--     nearly every real win closes at a price other than its estimate; the
--     tile and the reports then disagree. No test pinned it. Hosted held no
--     won deal on 2026-10-04 (read-only), so no figure was ever shown wrong
--     there yet.
--
-- THE FIX: 0093's function text BYTE FOR BYTE (generated from 0093's file by
-- a script and diffed) except 0076's two lines — the won_deals CTE selects
-- coalesce(final_value, expected_value, 0) AS won_value, and won_month.total
-- sums won_value — with a comment line. Signature, return type (jsonb, the
-- same six keys), language sql, STABLE, SECURITY INVOKER (RLS decides which
-- deals an admin sees), search_path=public: all unchanged. CREATE OR REPLACE
-- keeps the grants (authenticated, service_role; never anon) and the
-- postflight asserts them.
--
-- PREFLIGHT refuses, changing nothing, unless admin_dashboard_stats is the
-- only function of that name, has 0093's body (md5 of prosrc, CR-stripped:
-- 23f87cba94b4a79357cb5888bab2203a — hosted identical on 2026-10-04), is
-- sql / STABLE / INVOKER with search_path=public, and is executable by
-- authenticated and service_role and NOT by anon.
--
-- POSTFLIGHT: the six keys; the won value read from final_value and summed;
-- 0093's live-listings predicate kept; the attributes and grants unchanged;
-- and a PROBE, rolled back: a won deal estimated at 100 and closed at 250 in
-- a throwaway organisation, dated far in the future so no real deal shares
-- the window — won_month must read 250, not 100. The file's last row is a
-- summary.
--
-- CONTRACT: no signature or return-shape change — the release-compat rule
-- (a changed RETURN SHAPE fails open) does not apply. Not deploy-coupled:
-- hosted first, then merge, in either order.
--
-- LOCKS: CREATE OR REPLACE FUNCTION takes no table lock; a dashboard load
-- that started before the commit finishes on the old body. lock_timeout 5 s
-- bounds the pg_proc row lock. ONE transaction (checked below).
--
-- ROLLBACK, a forward migration in one transaction: 0093's function text
-- (supabase/tests/revert-0140.ts slices it from 0093's file). In the same
-- change: delete the test file and helper, remove the restore pack's 0140
-- row and move its migrations pin FORWARD, restore the BACKLOG entry. No data
-- moves.
--
-- Pins that move with this file: scripts/backup/verify-restore.sql (the
-- migrations count, the 0140 row). NO EXPLICIT begin/commit — the CLI wraps
-- the file, as does one execute_sql call.
-- =============================================================================

set local lock_timeout = '5s';

do $$
begin
  if current_setting('lock_timeout') <> '5s' then
    raise exception '0140 aborted: this file must run as ONE transaction (SET LOCAL lock_timeout did not take effect) — nothing was changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Preflight: the function is 0093's, as 0093 left it
-- ---------------------------------------------------------------------------
do $$
declare
  v_sig constant text := 'public.admin_dashboard_stats(timestamp with time zone,timestamp with time zone,timestamp with time zone)';
  v_md5 text;
begin
  if (select count(*) from pg_proc p
       where p.pronamespace = 'public'::regnamespace and p.proname = 'admin_dashboard_stats') <> 1 then
    raise exception '0140 aborted: admin_dashboard_stats is overloaded or missing — nothing was changed';
  end if;
  select md5(replace(p.prosrc, E'\r', '')) into v_md5
    from pg_proc p
   where p.oid = to_regprocedure(v_sig) and not p.prosecdef and p.provolatile = 's'
     and p.prolang = (select oid from pg_language where lanname = 'sql')
     and p.proconfig = array['search_path=public']
     and pg_get_function_result(p.oid) = 'jsonb';
  if v_md5 is distinct from '23f87cba94b4a79357cb5888bab2203a' then
    raise exception '0140 aborted: admin_dashboard_stats is not 0093''s body and attributes (md5 %) — nothing was changed', coalesce(v_md5, 'missing, or not sql / STABLE / INVOKER / search_path=public / jsonb');
  end if;
  if has_function_privilege('anon', v_sig, 'execute')
     or not has_function_privilege('authenticated', v_sig, 'execute')
     or not has_function_privilege('service_role', v_sig, 'execute') then
    raise exception '0140 aborted: admin_dashboard_stats''s grants are not 0093''s (authenticated and service_role, never anon) — nothing was changed';
  end if;
  raise notice '0140: preflight passed — admin_dashboard_stats is 0093''s';
end $$;

-- ---------------------------------------------------------------------------
-- The function: 0093's text, won_month at the confirmed final value (0076)
-- ---------------------------------------------------------------------------
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
    -- 0140 (0076's rule, undone by 0093): a won deal counts at its CONFIRMED
    -- final value; the estimate only where none was recorded
    select coalesce(final_value, expected_value, 0) as won_value
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
      'total', coalesce((select sum(won_value) from won_deals), 0),
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

-- ---------------------------------------------------------------------------
-- Postflight, and the probe
-- ---------------------------------------------------------------------------
do $$
declare
  v_sig constant text := 'public.admin_dashboard_stats(timestamp with time zone,timestamp with time zone,timestamp with time zone)';
  v_src text;
  v jsonb;
  k text;
  v_org uuid; v_stage uuid;
  v_total numeric; v_count int;
begin
  select regexp_replace(p.prosrc, '--[^\n]*', '', 'g') into v_src
    from pg_proc p
   where p.oid = to_regprocedure(v_sig) and not p.prosecdef and p.provolatile = 's'
     and p.proconfig = array['search_path=public'] and pg_get_function_result(p.oid) = 'jsonb';
  if v_src is null then
    raise exception '0140 postflight: admin_dashboard_stats lost its attributes (sql / STABLE / INVOKER / search_path / jsonb)';
  end if;
  if v_src !~ 'coalesce\(final_value, expected_value, 0\) as won_value'
     or v_src !~ '''total'', coalesce\(\(select sum\(won_value\) from won_deals\), 0\)'
     or v_src ~ 'sum\(expected_value\) from won_deals' then
    raise exception '0140 postflight: won_month does not sum the confirmed final value';
  end if;
  if v_src !~ 'visibility <> ''archived''' then
    raise exception '0140 postflight: 0093''s live-listings predicate is gone';
  end if;
  if has_function_privilege('anon', v_sig, 'execute')
     or not has_function_privilege('authenticated', v_sig, 'execute')
     or not has_function_privilege('service_role', v_sig, 'execute') then
    raise exception '0140 postflight: admin_dashboard_stats''s grants changed';
  end if;
  v := public.admin_dashboard_stats(now(), now(), now());
  foreach k in array array['open_pipeline','won_month','stages','leads7','lead_sources30','property_statuses'] loop
    if not (v ? k) then
      raise exception '0140 postflight: lost key % from admin_dashboard_stats', k;
    end if;
  end loop;

  -- the probe: a won deal estimated at 100, closed at 250, in a throwaway
  -- organisation and a window no real deal shares — rolled back
  begin
    insert into organizations (name, slug)
      values ('0140 probe (rolled back)', '0140-probe-' || replace(gen_random_uuid()::text, '-', ''))
      returning id into v_org;
    insert into deal_stages (org_id, deal_type, name, sort_order, is_won)
      values (v_org, 'sale', '0140 probe won', 1, true) returning id into v_stage;
    insert into deals (org_id, deal_type, stage_id, title, status, expected_value, final_value, won_at)
      values (v_org, 'sale', v_stage, '0140 probe', 'won', 100, 250, '2999-01-02T00:00:00Z');
    v := public.admin_dashboard_stats('2999-01-01T00:00:00Z', now(), now());
    v_total := (v -> 'won_month' ->> 'total')::numeric;
    v_count := (v -> 'won_month' ->> 'count')::int;
    raise exception using errcode = 'P0140', message = format('%s|%s', v_total, v_count);
  exception
    when sqlstate 'P0140' then
      if split_part(sqlerrm, '|', 1)::numeric is distinct from 250 or split_part(sqlerrm, '|', 2)::int is distinct from 1 then
        raise exception '0140 postflight: the probe''s won deal (estimate 100, final 250) read as total % over % deal(s), not 250 over 1',
          split_part(sqlerrm, '|', 1), split_part(sqlerrm, '|', 2);
      end if;
  end;
  perform set_config('gnk.m0140_summary', 'won_month_reads_final_value=true probe_total=250 keys=6', true);
  raise notice '0140: postflight passed — won this month counts the confirmed final value; the probe read 250, not its estimate 100';
end $$;

-- the file's LAST result: a read-only summary of what the postflight proved
select current_setting('gnk.m0140_summary', true) as summary;
