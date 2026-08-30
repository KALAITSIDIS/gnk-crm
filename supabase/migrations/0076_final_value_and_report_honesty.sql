-- 0076 — the books close on a REAL number, and three report defects go
-- (audit 2026-08-29: WF-2/DB-03, DB-01, RPT-1, RPT-2).
--
-- 1. `deals.final_value` — Won captured no final sale value; the dashboard
--    (0018→0057) and the C4 reports (0065) sum `expected_value`, a pre-close
--    ESTIMATE that is often stale or null, while the accepted offer's amount
--    was one join away and copied nowhere. "What did we actually earn" had no
--    honest answer. The three won sums switch to
--    coalesce(final_value, expected_value) — every existing row keeps its
--    figure, a newly-won deal reports the confirmed price.
-- 2. An ELEVENTH task kind `listing_status_check` — a Won deal whose linked
--    listing still reads available/reserved/under_offer raises a prompt task
--    (app-side, the raiseOneTask idiom). A task that ASKS, never a write that
--    flips: the reservation↔status auto-coupling was DECLINED 2026-08-26
--    ("the desk sets the listing status") and this respects that boundary.
-- 3. RPT-1 — `report_agent_performance`'s per-agent average lacked 0042's
--    negative-interval guard, so one backdated lead drags an agent's mean
--    negative while the dashboard next door excludes it. Same metric, two
--    definitions. The guard lands on the DURATION figure only; the
--    `leads_answered` COUNT keeps including anomalous rows — "did the desk
--    reply?" is not changed by a clock anomaly (0042's stated asymmetry).
-- 4. RPT-2 — `advance_rate` could exceed 100%: a deal that entered a stage
--    BEFORE the window but departed IN it counted in `advanced` but not
--    `entered`. `advanced` becomes the INTERSECTION cohort — departures by
--    deals that also entered that stage in-window — which bounds the rate at
--    100% by construction. Demotions still count as departures; the `note`
--    says so out loud instead of hiding it (the 0067 self-describing-output
--    convention). The base body is 0067's (NOT 0065's — 0067 added the
--    stage-id resolution; recreating from 0065 would silently revert it).
--
-- All four functions are full-body create-or-replace: ACLs preserved and
-- asserted, shapes asserted. Additive on every axis — hosted BEFORE the merge.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

-- ---------- 1. the column ----------------------------------------------------

alter table public.deals
  add column if not exists final_value numeric(14,2)
  constraint deals_final_value_non_negative
  check (final_value is null or final_value >= 0);

comment on column public.deals.final_value is
  'The CONFIRMED sale/rental value stamped at Won (defaulted from the accepted '
  'offer''s amount; admin-override closes may enter it by hand). Reports read '
  'coalesce(final_value, expected_value) for won rows, so pre-0076 deals keep '
  'reporting their estimate. The won event payload carries the same figure — '
  'the immutable record; this column is the queryable one.';

-- ---------- 2. the kind ------------------------------------------------------

insert into public.task_kinds (kind, description, added_in) values
  ('listing_status_check', 'A deal was won but the linked listing still reads available/reserved/under offer', '0076')
on conflict (kind) do nothing;

-- ---------- 3. admin_dashboard_stats (base: 0057) ----------------------------

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
    -- 0076: the confirmed price where one was captured, the estimate otherwise
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

-- ---------- 4. report_agent_performance (base: 0065) -------------------------

create or replace function public.report_agent_performance(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql stable security invoker set search_path = public
as $$
  with l as (
    select assigned_agent_id as agent_id,
           count(*)                                   as leads_assigned,
           count(first_response_at)                   as leads_answered,
           -- 0076 (RPT-1): 0042's negative-interval guard, on the DURATION
           -- only — `leads_answered` above keeps counting anomalous rows
           avg(extract(epoch from (first_response_at - received_at)) / 60.0)
             filter (where first_response_at is not null
                       and first_response_at >= received_at) as avg_first_response_min
      from leads
     where received_at >= p_from and received_at < p_to
       and assigned_agent_id is not null
     group by 1
  ),
  v as (
    select agent_id, count(*) as viewings_completed
      from viewings
     where scheduled_at >= p_from and scheduled_at < p_to
       and status = 'completed'
       and agent_id is not null
     group by 1
  ),
  d as (
    -- A deal counts in the window it CLOSED in, not the one it opened in.
    -- 0076: won_value prefers the CONFIRMED final_value over the estimate.
    select agent_id,
           count(*) filter (where status = 'won')                             as deals_won,
           coalesce(sum(coalesce(final_value, expected_value))
             filter (where status = 'won'), 0)                                as won_value,
           count(*) filter (where status = 'lost')                            as deals_lost
      from deals
     where agent_id is not null
       and ( (status = 'won'  and won_at  >= p_from and won_at  < p_to)
          or (status = 'lost' and lost_at >= p_from and lost_at < p_to) )
     group by 1
  ),
  agents as (
    select agent_id from l union
    select agent_id from v union
    select agent_id from d
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'agent_id',               a.agent_id,
           'leads_assigned',         coalesce(l.leads_assigned, 0),
           'leads_answered',         coalesce(l.leads_answered, 0),
           'avg_first_response_min', l.avg_first_response_min,
           'viewings_completed',     coalesce(v.viewings_completed, 0),
           'deals_won',              coalesce(d.deals_won, 0),
           'won_value',              coalesce(d.won_value, 0),
           'deals_lost',             coalesce(d.deals_lost, 0)
         ) order by coalesce(d.won_value, 0) desc, a.agent_id), '[]'::jsonb)
    from agents a
    left join l on l.agent_id = a.agent_id
    left join v on v.agent_id = a.agent_id
    left join d on d.agent_id = a.agent_id;
$$;

comment on function public.report_agent_performance(timestamptz, timestamptz) is
  'Per-agent leads, viewings and closes in a window. A deal counts in the '
  'window it CLOSED in; won_value prefers the confirmed final_value (0076). '
  'The response average excludes negative intervals (0042''s guard); the '
  'answered count deliberately does not. SECURITY INVOKER: a non-admin sees '
  'only their own.';

-- ---------- 5. report_source_roi (base: 0065) --------------------------------

create or replace function public.report_source_roi(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql stable security invoker set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'source',          source,
           'leads',           leads,
           'converted',       converted,
           'won',             won,
           'won_value',       won_value,
           -- rates as fractions, formatted by the app; null rather than 0/0
           'convert_rate',    case when leads     > 0 then converted::numeric / leads     end,
           'win_rate',        case when converted > 0 then won::numeric       / converted end
         ) order by won_value desc, leads desc, source), '[]'::jsonb)
    from (
      select l.source::text                                                as source,
             count(*)                                                      as leads,
             count(l.converted_deal_id)                                    as converted,
             count(*) filter (where d.status = 'won')                      as won,
             -- 0076: the confirmed price where one was captured
             coalesce(sum(coalesce(d.final_value, d.expected_value))
               filter (where d.status = 'won'), 0)                         as won_value
        from leads l
        -- LEFT JOIN, not a filter: a source with leads and no deals is a
        -- finding, and an inner join would hide it.
        left join deals d on d.id = l.converted_deal_id
       where l.received_at >= p_from and l.received_at < p_to
       group by l.source
    ) s;
$$;

comment on function public.report_source_roi(timestamptz, timestamptz) is
  'Leads per source in a window, and how many converted and won. Sources with '
  'zero conversions are KEPT (left join) — a source producing nothing is the '
  'finding, and an inner join would hide it. won_value prefers the confirmed '
  'final_value (0076).';

-- ---------- 6. report_stage_conversion (base: 0067) --------------------------

create or replace function public.report_stage_conversion(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql stable security invoker set search_path = public as $$
  with raw as (
    select e.entity_id                                       as deal_id,
           nullif(e.payload ->> 'from_stage_id', '')::uuid    as from_id,
           nullif(e.payload ->> 'to_stage_id',   '')::uuid    as to_id,
           e.payload ->> 'from'                               as from_name,
           e.payload ->> 'to'                                 as to_name
      from events e
     where e.entity_type = 'deal'
       and e.event_type  = 'stage_changed'
       and e.occurred_at >= p_from and e.occurred_at < p_to
  ),
  moves as (
    -- An id resolves to the stage's CURRENT name, so a rename keeps its history
    -- together. No id (pre-0067) or a deleted stage falls back to the name
    -- recorded at the time, which is then all that describes it.
    select deal_id,
           coalesce((select s.name from deal_stages s where s.id = r.from_id), r.from_name) as from_stage,
           coalesce((select s.name from deal_stages s where s.id = r.to_id),   r.to_name)   as to_stage,
           (r.from_id is not null or r.to_id is not null) as id_backed
      from raw r
  ),
  entered as (
    select to_stage as stage, count(distinct deal_id) as n
      from moves where to_stage is not null group by 1
  ),
  advanced as (
    -- 0076 (RPT-2): the INTERSECTION cohort — departures by deals that also
    -- ENTERED this stage in-window. A pre-window entrant departing in-window
    -- used to inflate the numerator past the denominator (rates over 100%
    -- rendered and exported unclamped). advanced ⊆ entered per stage now
    -- bounds the rate at 100% by construction.
    select m.from_stage as stage, count(distinct m.deal_id) as n
      from moves m
     where m.from_stage is not null
       and exists (
         select 1 from moves e
          where e.deal_id = m.deal_id
            and e.to_stage = m.from_stage)
     group by 1
  ),
  stages as (
    select stage from entered union select stage from advanced
  ),
  outcomes as (
    select count(*) filter (where event_type = 'won')  as won,
           count(*) filter (where event_type = 'lost') as lost
      from events
     where entity_type = 'deal'
       and event_type in ('won', 'lost')
       and occurred_at >= p_from and occurred_at < p_to
  )
  select jsonb_build_object(
    'derived_from', 'events',
    -- The grouping key is still a NAME — but since 0067 it is resolved from the
    -- stage id where the event recorded one, so a rename no longer splits
    -- history. The two counters below say how much of this window is covered.
    'stage_key',    'name',
    'moves_total',    (select count(*) from moves),
    'moves_with_ids', (select count(*) from moves where id_backed),
    'stages', coalesce((
      select jsonb_agg(jsonb_build_object(
               'stage',        s.stage,
               'entered',      coalesce(en.n, 0),
               'advanced',     coalesce(ad.n, 0),
               'advance_rate', case when coalesce(en.n, 0) > 0
                                    then coalesce(ad.n, 0)::numeric / en.n end)
             order by coalesce(en.n, 0) desc, s.stage)
        from stages s
        left join entered  en on en.stage = s.stage
        left join advanced ad on ad.stage = s.stage
    ), '[]'::jsonb),
    'transitions', coalesce((
      select jsonb_agg(jsonb_build_object('from', from_stage, 'to', to_stage, 'deals', n)
                       order by n desc, from_stage, to_stage)
        from (select from_stage, to_stage, count(distinct deal_id) as n
                from moves group by 1, 2) t
    ), '[]'::jsonb),
    'outcomes', (select jsonb_build_object('won', won, 'lost', lost) from outcomes),
    'note', 'won/lost are separate event types; they are counted but not '
            'attributed to the stage they left, because the payload does not '
            'record it. advanced counts departures in ANY direction (demotions '
            'included) by deals that entered the stage in-window; a departure '
            'without an in-window entry is excluded, which bounds advance_rate '
            'at 1.'
  );
$$;

comment on function public.report_stage_conversion(timestamptz, timestamptz) is
  'Movement between pipeline stages in a window, computed from `stage_changed` '
  'EVENTS rather than current deal state — so unlike the other reports it is '
  'genuinely re-derivable from the hash-chained log. Grouped by stage NAME, '
  'resolved from the stage id where the event recorded one (0067) so a rename '
  'does not split history; `moves_with_ids` vs `moves_total` says how much of '
  'the window that covers. Won/lost are separate event types: counted under '
  '`outcomes`, not attributed to the stage they left. Since 0076, advanced is '
  'the in-window-entry cohort, so advance_rate never exceeds 1.';

-- ---------- assertions -------------------------------------------------------

do $$
declare
  n    int;
  body text;
  conv jsonb;
begin
  -- the column landed with its constraint validated
  if not exists (
    select 1 from pg_constraint
     where conname = 'deals_final_value_non_negative' and convalidated
  ) then
    raise exception '0076 aborted: deals_final_value_non_negative missing or not validated';
  end if;

  -- eleven kinds, nothing lost
  select count(*) into n from public.task_kinds;
  if n <> 11 then
    raise exception '0076 aborted: expected 11 task kinds, found %', n;
  end if;

  -- each rewritten body carries its fix — checked against the compiled source,
  -- not by writing rows to a production database (the 0067 idiom)
  select prosrc into body from pg_proc where proname = 'admin_dashboard_stats';
  if position('final_value' in body) = 0 then
    raise exception '0076 aborted: admin_dashboard_stats does not read final_value';
  end if;
  select prosrc into body from pg_proc where proname = 'report_agent_performance';
  if position('final_value' in body) = 0
  or position('first_response_at >= received_at' in body) = 0 then
    raise exception '0076 aborted: report_agent_performance is missing a fix';
  end if;
  select prosrc into body from pg_proc where proname = 'report_source_roi';
  if position('final_value' in body) = 0 then
    raise exception '0076 aborted: report_source_roi does not read final_value';
  end if;
  select prosrc into body from pg_proc where proname = 'report_stage_conversion';
  if position('e.to_stage = m.from_stage' in body) = 0 then
    raise exception '0076 aborted: report_stage_conversion advanced is not the intersection cohort';
  end if;

  -- create-or-replace preserves ACLs, but T-C4 exists because that was
  -- assumed once too often
  if has_function_privilege('anon', 'public.admin_dashboard_stats(timestamptz, timestamptz, timestamptz)', 'execute')
  or has_function_privilege('anon', 'public.report_agent_performance(timestamptz, timestamptz)', 'execute')
  or has_function_privilege('anon', 'public.report_source_roi(timestamptz, timestamptz)', 'execute')
  or has_function_privilege('anon', 'public.report_stage_conversion(timestamptz, timestamptz)', 'execute') then
    raise exception '0076 aborted: a report function is callable by anon';
  end if;
  if not has_function_privilege('authenticated', 'public.report_agent_performance(timestamptz, timestamptz)', 'execute') then
    raise exception '0076 aborted: authenticated lost EXECUTE on report_agent_performance';
  end if;

  -- the reader still exposes 0067's coverage counters (regression guard: the
  -- rewrite is based on 0067's body, not 0065's)
  conv := public.report_stage_conversion(now() - interval '3650 days', now() + interval '1 day');
  if not (conv ? 'moves_with_ids' and conv ? 'moves_total') then
    raise exception '0076 aborted: report_stage_conversion lost its 0067 coverage counters';
  end if;

  raise notice '0076: final_value live, 11 task kinds, 4 report functions rewritten (won sums coalesce, response guard, bounded advance_rate), ACLs held';
end $$;
