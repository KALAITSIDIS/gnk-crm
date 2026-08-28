-- 0065 — reporting engine. Phase C, C4.
--
-- Five metrics from IMPROVEMENTS §C, plus a citation that anchors a report in
-- the audit trail. All SECURITY INVOKER, all computed live. `admin_dashboard_stats`
-- (0018) is the pattern: group-bys in SQL, window bounds passed IN rather than
-- re-derived, ids returned and names joined by the app.
--
-- ============================================================================
-- NO MATERIALISED VIEW, AND THE BRIEF'S WARNING IS WORSE THAN IT SAYS.
--
-- docs/PHASE_C_BRIEF.md §3 calls C4 "a materialised-view problem" and warns
-- that an MV over an RLS table is computed once for everyone. Measured on the
-- local stack before writing a line — two rows, one per org, under a session
-- scoped to org 1111…:
--
--   MV read directly                    -> BOTH rows (100 and 999)
--   MV read via a SECURITY INVOKER fn   -> BOTH rows (100 and 999)
--   the same aggregate computed live    -> one row (100)
--
-- And the obvious repair is not available:
--
--   alter materialized view probe_mv enable row level security;
--   ERROR: ALTER action ENABLE ROW SECURITY cannot be performed on relation
--          "probe_mv" (42809)
--
-- So an MV cannot be made safe by policy at all — only by never granting it and
-- filtering in a wrapper. At 120 events and 1 property that trade is absurd, so
-- there is no MV here. If a query is ever measurably slow, an MV can be
-- introduced BEHIND THESE SIGNATURES without the callers moving.
--
-- ============================================================================
-- WHAT THE CITATION PROVES, AND WHAT IT DOES NOT. Read before quoting it.
--
-- The brief's upgrade is to make reports citable: record the (last_id, hash)
-- the report was computed at so a dispute can re-derive the figure and prove
-- the inputs had not changed. Half of that is achievable and half is not, and
-- pretending otherwise would be the worst possible outcome in an evidence
-- product.
--
--   * ACHIEVED: the report records the verified state of the org's hash-chained
--     event log at the moment it ran — the checkpoint's (last_id, last_hash)
--     from 0062, which is a point some walk actually PROVED, not merely a
--     high-water mark. A figure quoted in a dispute can be tied to an audit
--     trail whose integrity is demonstrable.
--   * NOT ACHIEVED: most of these metrics are computed over MUTABLE ENTITY
--     TABLES — `deals.expected_value`, `leads.source`, `viewings.status`. Those
--     are not hash-chained, so the citation cannot prove they were unchanged.
--     Re-running the report later can legitimately give a different number.
--
-- The one metric that IS re-derivable from events is stage conversion, which
-- reads `stage_changed` events and nothing else. It is marked as such in its
-- output (`derived_from: "events"`) so a reader can tell the difference without
-- reading this file.
--
-- ============================================================================
-- SECURITY INVOKER IS LOAD-BEARING, exactly as 0018 says. An agent running a
-- report sees their own rows because `events_select`, `deals_select` and the
-- rest say so; an admin sees the org. /reports is deliberately NOT admin-only
-- (it already shows a scope note to non-admins on the evidence page), so these
-- must never become a way to read past a policy.

-- ---------------------------------------------------------------------------
-- 1. Indexes the new aggregates need. Same reasoning as 0018 §1: correct at
--    120 rows and at 10 million, which is mostly a matter of not writing
--    anything that assumes a full table.
-- ---------------------------------------------------------------------------
-- price_history had ONLY its primary key — every window scan was a seq scan.
create index if not exists price_history_changed_idx
  on price_history (org_id, changed_at desc);

-- deals_won_idx is partial on status='won', so a created_at window across all
-- statuses (time-to-close, stage conversion) cannot use it.
create index if not exists deals_created_idx
  on deals (org_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 2. The citation.
--
--    SECURITY INVOKER, and the shape is deliberately honest about scope:
--    `visible_last_event_id` is what the CALLER could see (an agent sees their
--    own events, an admin the org's), while `chain_verified_through` comes from
--    events_chain_checkpoint, which is org-scoped and staff-readable by design.
--    Making this SECURITY DEFINER to force an org-wide high-water mark would
--    have added another `authenticated_security_definer_function_executable`
--    advisor entry to buy a number the checkpoint already provides, verified.
-- ---------------------------------------------------------------------------
create or replace function public.report_citation()
returns jsonb
language sql stable security invoker set search_path = public
as $$
  -- EVERY SUBQUERY IS ORG-SCOPED EXPLICITLY, not left to RLS to narrow.
  -- events_chain_checkpoint holds ONE ROW PER ORG, so `(select last_id from
  -- events_chain_checkpoint)` returns exactly one row only for a caller RLS
  -- filters — and raises 21000 "more than one row returned by a subquery used
  -- as an expression" for anything that bypasses it (service_role, the test
  -- suite, this migration's own verification block, which is how it was
  -- caught). A citation that works in the app and explodes in a script is a
  -- citation that will explode during an incident.
  select jsonb_build_object(
    'computed_at',            now(),
    -- what this caller could see when the report ran
    'visible_last_event_id',  (select max(id) from events
                                where org_id = (select current_org_id())),
    -- the org-wide point a verification walk actually proved (0062)
    'chain_verified_through', (select last_id      from events_chain_checkpoint
                                where org_id = (select current_org_id())),
    'chain_verified_hash',    (select last_hash    from events_chain_checkpoint
                                where org_id = (select current_org_id())),
    'chain_verified_at',      (select verified_at  from events_chain_checkpoint
                                where org_id = (select current_org_id())),
    'chain_full_walk_at',     (select full_walk_at from events_chain_checkpoint
                                where org_id = (select current_org_id())),
    -- so a reader knows whether the figures above are org-wide or one agent's
    'scope', case when (select current_role_gnk()) = 'admin' then 'org' else 'own' end
  );
$$;

comment on function public.report_citation() is
  'Anchors a report in the audit trail: the verified (last_id, last_hash) of '
  'the org''s event chain when the report ran, plus the caller''s scope. It '
  'does NOT prove the figures are reproducible — most metrics read mutable '
  'entity tables, which are not hash-chained. Only report_stage_conversion is '
  'derived from events alone. A service_role caller gets 42501 rather than a '
  'citation, and that is correct: current_org_id() is authenticated-only '
  '(0007), so a caller with no org has nothing to be scoped to.';

-- ---------------------------------------------------------------------------
-- 3. Agent performance.
--    ids only; the app joins profiles, as 0018 does with deal_stages.
-- ---------------------------------------------------------------------------
create or replace function public.report_agent_performance(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql stable security invoker set search_path = public
as $$
  with l as (
    select assigned_agent_id as agent_id,
           count(*)                                   as leads_assigned,
           count(first_response_at)                   as leads_answered,
           avg(extract(epoch from (first_response_at - received_at)) / 60.0)
             filter (where first_response_at is not null) as avg_first_response_min
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
    select agent_id,
           count(*) filter (where status = 'won')                             as deals_won,
           coalesce(sum(expected_value) filter (where status = 'won'), 0)     as won_value,
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
  'window it CLOSED in. SECURITY INVOKER: a non-admin sees only their own.';

-- ---------------------------------------------------------------------------
-- 4. Source ROI. Which lead sources actually produce won business.
-- ---------------------------------------------------------------------------
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
             coalesce(sum(d.expected_value) filter (where d.status = 'won'), 0) as won_value
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
  'finding, and an inner join would hide it.';

-- ---------------------------------------------------------------------------
-- 5. Time to close.
-- ---------------------------------------------------------------------------
create or replace function public.report_time_to_close(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql stable security invoker set search_path = public
as $$
  with closed as (
    select status,
           extract(epoch from (coalesce(won_at, lost_at) - created_at)) / 86400.0 as days
      from deals
     where (status = 'won'  and won_at  >= p_from and won_at  < p_to)
        or (status = 'lost' and lost_at >= p_from and lost_at < p_to)
  )
  select jsonb_build_object(
    'won', (
      select jsonb_build_object(
        'count',      count(*),
        'avg_days',   avg(days),
        -- median as well as mean: one nine-month deal drags an average
        -- somewhere no actual deal has ever been
        'median_days', percentile_cont(0.5) within group (order by days),
        'p90_days',    percentile_cont(0.9) within group (order by days))
      from closed where status = 'won'),
    'lost', (
      select jsonb_build_object(
        'count',       count(*),
        'avg_days',    avg(days),
        'median_days', percentile_cont(0.5) within group (order by days))
      from closed where status = 'lost')
  );
$$;

comment on function public.report_time_to_close(timestamptz, timestamptz) is
  'Days from deal creation to close, for deals CLOSED in the window. Reports '
  'median and p90 alongside the mean because one long deal drags an average '
  'somewhere no real deal has been.';

-- ---------------------------------------------------------------------------
-- 6. Stage conversion — THE ONE METRIC DERIVED FROM EVENTS ALONE, which is what
--    makes its citation mean what the brief wanted it to mean.
--
--    TWO PROPERTIES OF THE EXISTING EVENTS SHAPE THIS, and both were checked
--    against the writers rather than assumed. The first draft of this function
--    read `payload->>'from_stage_id'` and would have returned zeros forever:
--
--    a) `stage_changed` RECORDS STAGE NAMES, NOT IDS. move_deal_to_stage (0011,
--       the only writer) logs
--         jsonb_build_object('from', coalesce(v_from_name, v_deal.stage_id::text),
--                            'to',   v_to.name)
--       so this report is keyed on a MUTABLE STRING. Renaming a stage splits
--       its history at the rename. That is a real weakness, but fixing it means
--       changing a guarded write path from a reporting migration, so it is
--       reported (`stage_key: "name"`) rather than silently worked around.
--       Adding ids to future payloads is a one-line, strictly additive change
--       when someone wants id-exact history.
--
--    b) WON AND LOST ARE NOT `stage_changed`. Those transitions go through the
--       deal page's guarded flows and emit `won` / `lost` (lib/actions/deals.ts),
--       whose payloads carry the DESTINATION stage name and not the stage left.
--       So outcomes are counted, but deliberately NOT attributed to the stage
--       they came from — a funnel that guessed would be worse than one that
--       says it cannot.
-- ---------------------------------------------------------------------------
create or replace function public.report_stage_conversion(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql stable security invoker set search_path = public
as $$
  with moves as (
    select e.entity_id            as deal_id,
           e.payload ->> 'from'   as from_stage,
           e.payload ->> 'to'     as to_stage
      from events e
     where e.entity_type = 'deal'
       and e.event_type  = 'stage_changed'
       and e.occurred_at >= p_from and e.occurred_at < p_to
  ),
  entered as (
    select to_stage as stage, count(distinct deal_id) as n
      from moves where to_stage is not null group by 1
  ),
  advanced as (
    select from_stage as stage, count(distinct deal_id) as n
      from moves where from_stage is not null group by 1
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
    -- so a reader knows the join key is a name, without reading the migration
    'stage_key',    'name',
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
            'record it'
  );
$$;

comment on function public.report_stage_conversion(timestamptz, timestamptz) is
  'Movement between pipeline stages in a window, computed from `stage_changed` '
  'EVENTS rather than current deal state — so unlike the other reports it is '
  'genuinely re-derivable from the hash-chained log, and says so in its output. '
  'Keyed on stage NAME because that is what the event payload carries (0011), '
  'which it also declares. Won/lost are separate event types: counted under '
  '`outcomes`, not attributed to the stage they left.';

-- ---------------------------------------------------------------------------
-- 7. Price reductions.
-- ---------------------------------------------------------------------------
create or replace function public.report_price_reductions(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql stable security invoker set search_path = public
as $$
  with cuts as (
    select ph.property_id, ph.old_price, ph.new_price, ph.changed_at,
           (ph.old_price - ph.new_price) / nullif(ph.old_price, 0) as cut_fraction
      from price_history ph
     where ph.changed_at >= p_from and ph.changed_at < p_to
       and ph.old_price is not null and ph.new_price is not null
       and ph.new_price < ph.old_price          -- reductions only, not rises
  )
  select jsonb_build_object(
    'reductions',          (select count(*)                    from cuts),
    'properties_affected', (select count(distinct property_id) from cuts),
    'avg_cut_fraction',    (select avg(cut_fraction)           from cuts),
    'median_cut_fraction', (select percentile_cont(0.5) within group (order by cut_fraction) from cuts),
    'total_cut_amount',    (select coalesce(sum(old_price - new_price), 0) from cuts),
    -- the tail worth looking at: which listings are being cut repeatedly
    'repeat_cuts', coalesce((
      select jsonb_agg(jsonb_build_object(
               'property_id',  property_id,
               'cuts',         cuts_n,
               'total_cut',    total_cut,
               'first_cut_at', first_cut,
               'last_cut_at',  last_cut)
             order by cuts_n desc, total_cut desc, property_id)
        from (
          select property_id, count(*) as cuts_n,
                 sum(old_price - new_price) as total_cut,
                 min(changed_at) as first_cut, max(changed_at) as last_cut
            from cuts group by property_id having count(*) > 1
        ) r
    ), '[]'::jsonb)
  );
$$;

comment on function public.report_price_reductions(timestamptz, timestamptz) is
  'Asking-price REDUCTIONS in a window (rises excluded), with the repeat-cut '
  'tail called out separately — a listing cut three times is a different '
  'problem from thirty listings cut once.';

-- ---------------------------------------------------------------------------
-- 8. GRANTS. Same shape as admin_dashboard_stats: authenticated may run them
--    (they are SECURITY INVOKER, so RLS still decides what they see), anon may
--    never reach org aggregates.
-- ---------------------------------------------------------------------------
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.report_citation()',
    'public.report_agent_performance(timestamptz, timestamptz)',
    'public.report_source_roi(timestamptz, timestamptz)',
    'public.report_time_to_close(timestamptz, timestamptz)',
    'public.report_stage_conversion(timestamptz, timestamptz)',
    'public.report_price_reductions(timestamptz, timestamptz)'
  ] loop
    execute format('revoke execute on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated, service_role', fn);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 9. Verify, against whatever this database holds.
-- ---------------------------------------------------------------------------
do $$
declare
  c jsonb; n int := 0; fn record;
begin
  -- every function must be SECURITY INVOKER; a DEFINER here would be a way to
  -- read past a policy, which is the whole risk C4 carries
  for fn in
    select p.proname, p.prosecdef,
           coalesce(array_to_string(p.proacl, ' | '), '(default PUBLIC=X)') as acl
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public' and p.proname like 'report\_%'
  loop
    n := n + 1;
    if fn.prosecdef then
      raise exception '0065: %() is SECURITY DEFINER — reports must run under the caller''s RLS', fn.proname;
    end if;
    if fn.acl like '%anon=%' then
      raise exception '0065: %() is executable by anon — acl %', fn.proname, fn.acl;
    end if;
  end loop;

  if n <> 6 then
    raise exception '0065: expected 6 report functions, found %', n;
  end if;

  -- they must all run and return jsonb rather than erroring on an empty database
  perform public.report_agent_performance(now() - interval '30 days', now());
  perform public.report_source_roi(now() - interval '30 days', now());
  perform public.report_time_to_close(now() - interval '30 days', now());
  perform public.report_stage_conversion(now() - interval '30 days', now());
  perform public.report_price_reductions(now() - interval '30 days', now());
  c := public.report_citation();

  raise notice '0065: reporting engine live. % functions, all SECURITY INVOKER, anon revoked. Citation scope=%, verified_through=%.',
    n, c ->> 'scope', c ->> 'chain_verified_through';
end $$;
