-- =============================================================================
-- 0154 — the lead-source and stage-conversion reports say what they count
-- (F06, product review 2026-10-18; BACKLOG "report_stage_conversion counts a
-- `stage_changed` whose payload is `{}` …" folded in).
--
-- THE DEFECTS (measured on a stack at 0149 through PostgREST with aal2 users
-- of throwaway organisations — supabase/tests/report-definitions.test.ts):
--
--   report_source_roi (0076)
--   * A lead marked spam counted in `leads` and in the denominator of
--     `convert_rate`: one spam enquiry lowered a source's conversion rate as
--     much as a real enquiry nobody converted.
--   * `win_rate` = won / converted mixed two scopes for an agent: leads_select
--     is organisation-wide (0030) while deals_select limits an agent to the
--     deals assigned to or created by them (0032). `converted` counted every
--     converted enquiry of the agency; `won` only the agent's own deals.
--
--   report_stage_conversion (0130)
--   * Stages were grouped by NAME. The seed gives the sale and the rental
--     pipelines a "New", a "Qualified" and a "Viewing" (0003), so their
--     traffic merged into one row, and `stage_key` declared 'name' although
--     0067 already records every stage id.
--   * `advanced` counted a departure in ANY direction: a deal dragged back
--     from Viewing to Qualified "advanced" out of Viewing. RPT-2 (0076) kept
--     that and said so in the note; the ids every DB-written move records
--     since 0067 / 0131 now let the directions be told apart.
--   * A movement naming no stage at all — a `{}` or non-object payload, no id
--     and no name on either side — counted as a legacy move with a
--     null → null transition (BACKLOG, found by T-authentic-stage-movement).
--
-- THE FIX — both functions restated with the same signature, return type
-- (jsonb), SECURITY INVOKER, STABLE, search_path = public, owner and grants
-- (CREATE OR REPLACE keeps the OID, so the ACL; both are asserted below):
--
--   report_source_roi — 0076's body plus two keys and two rate rules:
--     `spam`              enquiries in the window marked spam (still counted
--                         in `leads`);
--     `converted_visible` converted enquiries whose deal the CALLER can read —
--                         the whole agency for an admin or a listing manager,
--                         an agent's own deals for an agent;
--     `convert_rate`      converted / leads, both WITHOUT spam;
--     `win_rate`          won / converted_visible — one scope on both sides.
--                         For an admin or a listing manager this is the same
--                         figure as before (leads_org_converted_deal_fkey
--                         forbids a dangling deal id).
--   report_stage_conversion — 0130's src / classified / raw CTEs kept (the two
--     CASE-guarded uuid casts and the two pg_input_is_valid calls verbatim, so
--     scripts/backup/verify-restore.sql's 0130 HONESTY row stays true), then:
--     * a movement with no id and no recorded name on either side is
--       MALFORMED: left out of every figure and counted in moves_malformed;
--     * each side resolves to a CURRENT stage of the event's organisation by
--       its id (pipeline = that stage's deal_type, its current name and
--       sort_order). A side with no id (pre-0067), or whose id names no
--       readable stage (deleted, another organisation's), keeps the name
--       recorded at the time and takes the deal's pipeline when the caller can
--       read the deal (RLS), else none (null);
--     * a stage row is (pipeline, stage id) — or (pipeline, recorded name) for
--       such a side — so two pipelines never share a row and a rename keeps
--       its history; `stage_key` is now 'id';
--     * a departure's direction compares the two stages' CURRENT sort_order
--       within one pipeline: `advanced` counts forward departures (still the
--       0076 intersection cohort, so advance_rate stays <= 1), the new
--       `regressed` backward ones, the new `departed_unknown` those whose
--       direction cannot be read (a side that is not a current stage, or two
--       pipelines). Direction uses TODAY'S order: a reorder (reorder_stage,
--       logged as a config stages_updated) re-reads history; the note says so;
--     * stage rows carry deal_type, stage_id and sort_order and come ordered
--       by pipeline, then sort_order; transitions carry deal_type, the two ids
--       and the direction; `outcomes_by_type` splits won / lost per pipeline
--       (the deal's type today, null when the caller cannot read the deal).
--     Won / lost stay counted and UNATTRIBUTED: close_deal's won / lost
--     payloads (0118) record only the destination stage, so the stage a deal
--     closed FROM is recorded nowhere, and a funnel that guessed would be
--     worse than one that says it cannot (DECISIONS T-c4). Changing
--     close_deal's payload is a separate decision (its 0118 tripwires).
--
-- NOT BUILT (binding scope): spend-based return on investment — docs/01 §10
-- Do-Not-Build ("source counting only until Phase 3+"); agency revenue —
-- commission is manual text (CLAUDE.md guardrail 8). `won_value` remains the
-- transaction value: coalesce(final_value, expected_value) of won deals.
--
-- CONTRACT — additive. Every existing key is still present; NEW keys only
-- (spam, converted_visible; deal_type / stage_id / sort_order / regressed /
-- departed_unknown on a stage row; deal_type / from_stage_id / to_stage_id /
-- direction on a transition; outcomes_by_type). Three keys change MEANING and
-- the labels change with them in the same release: convert_rate (spam out),
-- win_rate (one scope), advanced / advance_rate (forward only). The deployed
-- application reads stages[].stage / entered / advanced / advance_rate,
-- outcomes, note, moves_* and the source rows' original keys — all present —
-- so release-compat fails OPEN. lib/supabase/database.types.ts types both
-- results as Json: regenerating it changes nothing.
--
-- NOT CHANGED: what anyone may read or write (no table, policy, grant, event
-- or row is touched; RLS and require_aal2 still decide what a report holds),
-- the window rules, the cohort rule for `advanced`, the outcomes totals and
-- the coverage counters' meaning.
--
-- EXISTING DATA. None moves: two function bodies and their comments change.
--
-- LOCKS. CREATE OR REPLACE FUNCTION takes no table lock; lock_timeout (5 s)
-- bounds the catalog wait anyway, and the check below proves the file runs as
-- ONE transaction (otherwise SET LOCAL is a no-op and a failed postflight
-- would not undo the two replacements).
--
-- THE POSTFLIGHT WRITES, THEN UNDOES. Its behaviour probe creates a throwaway
-- organisation (five stages, one deal, three leads, five stage_changed
-- events dated 1900-01-01) inside a block that always rolls back, reads both
-- reports for that hour as the role applying the file, and requires that role
-- to bypass RLS (postgres does, locally and hosted). It refuses to run if
-- that hour already holds an event or a lead. Nothing it writes survives;
-- the events id sequence advances by five (ids are not gapless).
--
-- DEPLOY ORDER: ADDITIVE — hosted FIRST (the md5 preflight passed), then the
-- application release that reads the new keys. The new application also reads
-- a database still at 0130 / 0076 (a rollback): it keys its labels off
-- `stage_key` and the presence of `spam`, so it never labels an any-direction
-- figure "moved forward" or an all-enquiry rate "excl. spam".
--
-- ROLLBACK (supabase/tests/revert-0154.ts holds the text): a FORWARD
-- migration restating 0076's report_source_roi and 0130's
-- report_stage_conversion with their comments, under the same bounded lock;
-- move the verify-restore migrations pin FORWARD and remove its 0154 row.
-- Keep the page / route / report-export.ts readers — they run against those
-- bodies. No data moves either way.
--
-- Pins that move with this file: scripts/backup/verify-restore.sql (the
-- migrations count and one 0154 HONESTY row); supabase/tests/rls.test.ts 38 /
-- 39, stage-conversion-malformed.test.ts (the new keys). NO EXPLICIT
-- begin/commit — the CLI wraps the file (HANDOFF §3), as does one execute_sql
-- call; applied hosted inside the md5-guarded DO (DECISIONS
-- T-unit-type-apply-atomic). The file's LAST result is a read-only summary.
-- =============================================================================

-- Bounded lock waits (0113's lesson); see LOCKS above.
set local lock_timeout = '5s';

-- The file must run as ONE transaction (the CLI's wrapper, or one
-- execute_sql call): otherwise SET LOCAL is a no-op and a failed assertion
-- would not undo the replacements before it.
do $$
begin
  if current_setting('lock_timeout') <> '5s' then
    raise exception '0154 aborted: this file must run as ONE transaction (SET LOCAL lock_timeout did not take effect) — nothing was changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 0. Preflight — each function is the one this file was written against:
--    one overload, the same attributes and grants, and 0076's / 0130's body
--    (or this file's own, on a replay). Digests of md5(replace(prosrc,
--    chr(13), '')); hosted read 2026-10-18 equal to a database built from the
--    files.
-- ---------------------------------------------------------------------------
do $$
declare
  f     record;
  v_md5 text;
begin
  if to_regprocedure('pg_catalog.pg_input_is_valid(text, text)') is null then
    raise exception '0154 aborted: pg_input_is_valid(text, text) does not exist on this server (PostgreSQL %; 16+ is required) — nothing was changed',
                    current_setting('server_version');
  end if;

  for f in
    select * from (values
      ('report_source_roi', 'public.report_source_roi(timestamptz, timestamptz)',
       '5cebcb28051927a5def7908631fbc8e7', 'a2d98fbb96ce5ff94805c193dee3d331', '0076'),
      ('report_stage_conversion', 'public.report_stage_conversion(timestamptz, timestamptz)',
       'f5d44b9a7e9f420cb459cce9ff18b4a7', '68246923289bff0870562f640a5ffa08', '0130')
    ) as x(name, sig, before_md5, after_md5, base)
  loop
    if (select count(*) from pg_proc p
         where p.pronamespace = 'public'::regnamespace and p.proname = f.name) <> 1 then
      raise exception '0154 aborted: public.% is not exactly one function — nothing was changed', f.name;
    end if;

    select md5(replace(p.prosrc, chr(13), '')) into v_md5
      from pg_proc p
     where p.oid = to_regprocedure(f.sig)
       and not p.prosecdef
       and p.provolatile = 's'
       and p.prorettype = 'jsonb'::regtype
       and p.proconfig = array['search_path=public']
       and pg_get_userbyid(p.proowner) = 'postgres'
       and pg_get_function_arguments(p.oid) = 'p_from timestamp with time zone, p_to timestamp with time zone';
    if v_md5 is null then
      raise exception '0154 aborted: % is not the jsonb SECURITY INVOKER STABLE function owned by postgres with search_path=public and (p_from timestamptz, p_to timestamptz) this file replaces — nothing was changed', f.sig;
    end if;
    if not (v_md5 = f.before_md5 or v_md5 = f.after_md5) then
      raise exception '0154 aborted: the body of % is not %''s (md5 %) — read it before replacing it; nothing was changed', f.sig, f.base, v_md5;
    end if;

    -- the grants this file keeps: authenticated and service_role call it; anon
    -- (and so PUBLIC) may not
    if has_function_privilege('anon', f.sig, 'execute')
       or not has_function_privilege('authenticated', f.sig, 'execute')
       or not has_function_privilege('service_role', f.sig, 'execute') then
      raise exception '0154 aborted: the grants on % are not authenticated + service_role without anon — nothing was changed', f.sig;
    end if;
  end loop;

  raise notice '0154: preflight passed — report_source_roi is 0076''s and report_stage_conversion 0130''s (or this file''s, on a replay)';
end $$;

-- ---------------------------------------------------------------------------
-- 1. report_source_roi (base: 0076)
-- ---------------------------------------------------------------------------
create or replace function public.report_source_roi(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql stable security invoker set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'source',            source,
           'leads',             leads,
           -- 0154: enquiries marked spam; still counted in `leads`, never in a rate
           'spam',              spam,
           'converted',         converted,
           -- 0154: converted enquiries whose deal this caller can read (RLS on
           -- deals): the whole agency for an admin or a listing manager, an
           -- agent's own deals for an agent — the scope `won` always had
           'converted_visible', converted_visible,
           'won',               won,
           'won_value',         won_value,
           -- rates as fractions, formatted by the app; null rather than 0/0.
           -- 0154: spam is out of both sides of the convert rate, and the win
           -- rate divides within one scope
           'convert_rate',      case when leads - spam > 0
                                     then converted_not_spam::numeric / (leads - spam) end,
           'win_rate',          case when converted_visible > 0
                                     then won::numeric / converted_visible end
         ) order by won_value desc, leads desc, source), '[]'::jsonb)
    from (
      select l.source::text                                                as source,
             count(*)                                                      as leads,
             count(*) filter (where l.status = 'spam')                     as spam,
             count(l.converted_deal_id)                                    as converted,
             count(l.converted_deal_id) filter (where l.status <> 'spam')  as converted_not_spam,
             count(d.id)                                                   as converted_visible,
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
  'Enquiries (leads) received in a window, per recorded source, and what became '
  'of them: a cohort by received_at, followed to the converted deal''s status '
  'TODAY, whenever it closed. Every enquiry counts (repeat enquiries included); '
  '`spam` counts those marked spam, which are left out of both sides of '
  'convert_rate (0154). won / won_value / converted_visible read only deals the '
  'caller can see (RLS), and win_rate = won / converted_visible, so both sides '
  'share one scope (0154). won_value is the transaction value — '
  'coalesce(final_value, expected_value) of won deals, sale prices and rents '
  'together — not commission; no marketing spend is recorded, so this is not a '
  'return on investment (docs/01 §10). Sources with zero conversions are KEPT '
  '(left join).';

-- ---------------------------------------------------------------------------
-- 2. report_stage_conversion (base: 0130)
-- ---------------------------------------------------------------------------
create or replace function public.report_stage_conversion(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql stable security invoker set search_path = public as $$
  with src as (
    select e.org_id,
           e.entity_id                    as deal_id,
           e.payload -> 'from_stage_id'   as from_raw,
           e.payload -> 'to_stage_id'     as to_raw,
           e.payload ->> 'from'           as from_name,
           e.payload ->> 'to'             as to_name
      from events e
     where e.entity_type = 'deal'
       and e.event_type  = 'stage_changed'
       and e.occurred_at >= p_from and e.occurred_at < p_to
  ),
  classified as (
    -- 0130: classify each stage-id field BEFORE anything casts it.
    --   'none'      absent, JSON null or "" — a legacy id-less side (0076's nullif)
    --   'id'        a JSON string the uuid input function accepts
    --   'malformed' anything else (a non-uuid string, a number, a boolean, an
    --               object, an array)
    select s.*,
           case when s.from_raw is null or jsonb_typeof(s.from_raw) = 'null' or s.from_raw = '""'::jsonb then 'none'
                when jsonb_typeof(s.from_raw) = 'string' and pg_input_is_valid(s.from_raw #>> '{}', 'uuid') then 'id'
                else 'malformed' end as from_kind,
           case when s.to_raw is null or jsonb_typeof(s.to_raw) = 'null' or s.to_raw = '""'::jsonb then 'none'
                when jsonb_typeof(s.to_raw) = 'string' and pg_input_is_valid(s.to_raw #>> '{}', 'uuid') then 'id'
                else 'malformed' end as to_kind
      from src s
  ),
  checked as (
    -- 0154: a movement is malformed when either id is, or when it names no
    -- stage at all — no id and no recorded name on either side (a `{}` or a
    -- non-object payload)
    select k.*,
           (k.from_kind = 'malformed' or k.to_kind = 'malformed'
            or (k.from_kind = 'none' and k.to_kind = 'none'
                and coalesce(k.from_name, '') = '' and coalesce(k.to_name, '') = '')) as malformed
      from classified k
  ),
  raw as (
    -- Only well-formed movements go on. The casts are GUARDED by their own
    -- CASE — never evaluated unless the value is a valid uuid — so their
    -- safety does not depend on the WHERE below running first.
    select c.org_id,
           c.deal_id,
           case when c.from_kind = 'id' then (c.from_raw #>> '{}')::uuid end as from_id,
           case when c.to_kind   = 'id' then (c.to_raw   #>> '{}')::uuid end as to_id,
           c.from_name,
           c.to_name
      from checked c
     where not c.malformed
  ),
  moves as (
    -- 0154: each side resolves to a CURRENT stage of the event's organisation
    -- by its recorded id: that stage's pipeline (deal_type), current name (a
    -- rename keeps its history) and position. A side with no id (pre-0067),
    -- or whose id names no readable stage (deleted, another organisation's),
    -- keeps the name recorded at the time and takes the deal's pipeline when
    -- this caller can read the deal; otherwise its pipeline is unknown (null).
    select r.deal_id,
           sf.id                                 as from_stage_id,
           coalesce(sf.name, r.from_name)        as from_stage,
           coalesce(sf.deal_type, d.deal_type)   as from_type,
           sf.sort_order                         as from_order,
           st.id                                 as to_stage_id,
           coalesce(st.name, r.to_name)          as to_stage,
           coalesce(st.deal_type, d.deal_type)   as to_type,
           st.sort_order                         as to_order,
           -- direction by the two stages' CURRENT order, within one pipeline;
           -- null when either side is not a current stage or they differ
           case when sf.deal_type = st.deal_type and st.sort_order > sf.sort_order then 'forward'
                when sf.deal_type = st.deal_type and st.sort_order < sf.sort_order then 'backward'
           end                                   as direction,
           (r.from_id is not null or r.to_id is not null) as id_backed
      from raw r
      left join deal_stages sf on sf.id = r.from_id and sf.org_id = r.org_id
      left join deal_stages st on st.id = r.to_id   and st.org_id = r.org_id
      left join deals       d  on d.id  = r.deal_id and d.org_id  = r.org_id
  ),
  entered as (
    select to_type as deal_type, to_stage_id as stage_id, to_stage as stage, to_order as sort_order,
           count(distinct deal_id) as n
      from moves
     where to_stage is not null
     group by 1, 2, 3, 4
  ),
  departed as (
    -- 0076 (RPT-2): the INTERSECTION cohort — departures by deals that also
    -- ENTERED this stage in-window. A pre-window entrant departing in-window
    -- used to inflate the numerator past the denominator. advanced ⊆ entered
    -- per stage bounds advance_rate at 1 by construction. 0154: the same
    -- stage means the same pipeline and stage id (or recorded name), and the
    -- departures are split by direction.
    select m.from_type as deal_type, m.from_stage_id as stage_id, m.from_stage as stage, m.from_order as sort_order,
           count(distinct m.deal_id) filter (where m.direction = 'forward')  as advanced,
           count(distinct m.deal_id) filter (where m.direction = 'backward') as regressed,
           count(distinct m.deal_id) filter (where m.direction is null)      as departed_unknown
      from moves m
     where m.from_stage is not null
       and exists (
         select 1 from moves e
          where e.deal_id = m.deal_id
            and e.to_stage = m.from_stage
            and e.to_stage_id is not distinct from m.from_stage_id
            and e.to_type is not distinct from m.from_type)
     group by 1, 2, 3, 4
  ),
  stages as (
    select deal_type, stage_id, stage, sort_order from entered
    union
    select deal_type, stage_id, stage, sort_order from departed
  ),
  closes as (
    -- won / lost: written only by close_deal (0118), whose payload records the
    -- DESTINATION stage alone — counted, per pipeline (the deal's type today),
    -- never attributed to the stage the deal left
    select e.event_type, d.deal_type
      from events e
      left join deals d on d.id = e.entity_id and d.org_id = e.org_id
     where e.entity_type = 'deal'
       and e.event_type in ('won', 'lost')
       and e.occurred_at >= p_from and e.occurred_at < p_to
  )
  select jsonb_build_object(
    'derived_from', 'events',
    -- 0154: a stage row is (pipeline, stage id); a side without a current
    -- stage falls back to (pipeline, the name recorded at the time)
    'stage_key',    'id',
    'moves_total',    (select count(*) from moves),
    'moves_with_ids', (select count(*) from moves where id_backed),
    -- 0130 / 0154: stage_changed events left out of every figure — a stage id
    -- present but not a valid id, or no stage named at all;
    -- moves_total + moves_malformed = the window's visible stage_changed events
    'moves_malformed', (select count(*) from checked where malformed),
    'stages', coalesce((
      select jsonb_agg(jsonb_build_object(
               'deal_type',        s.deal_type,
               'stage_id',         s.stage_id,
               'stage',            s.stage,
               'sort_order',       s.sort_order,
               'entered',          coalesce(en.n, 0),
               'advanced',         coalesce(dp.advanced, 0),
               'regressed',        coalesce(dp.regressed, 0),
               'departed_unknown', coalesce(dp.departed_unknown, 0),
               'advance_rate',     case when coalesce(en.n, 0) > 0
                                        then coalesce(dp.advanced, 0)::numeric / en.n end)
             order by s.deal_type nulls last, s.sort_order nulls last, coalesce(en.n, 0) desc, s.stage, s.stage_id)
        from stages s
        left join entered  en on (en.deal_type, en.stage_id, en.stage) is not distinct from (s.deal_type, s.stage_id, s.stage)
        left join departed dp on (dp.deal_type, dp.stage_id, dp.stage) is not distinct from (s.deal_type, s.stage_id, s.stage)
    ), '[]'::jsonb),
    'transitions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'deal_type',     t.deal_type,
               'from',          t.from_stage,
               'to',            t.to_stage,
               'from_stage_id', t.from_stage_id,
               'to_stage_id',   t.to_stage_id,
               'direction',     t.direction,
               'deals',         t.n)
             order by t.n desc, t.deal_type nulls last, t.from_stage, t.to_stage)
        from (select coalesce(to_type, from_type) as deal_type, from_stage, to_stage,
                     from_stage_id, to_stage_id, direction, count(distinct deal_id) as n
                from moves group by 1, 2, 3, 4, 5, 6) t
    ), '[]'::jsonb),
    'outcomes', (select jsonb_build_object('won',  count(*) filter (where event_type = 'won'),
                                           'lost', count(*) filter (where event_type = 'lost'))
                   from closes),
    'outcomes_by_type', coalesce((
      select jsonb_agg(jsonb_build_object('deal_type', o.deal_type, 'won', o.won, 'lost', o.lost)
                       order by o.deal_type nulls last)
        from (select deal_type,
                     count(*) filter (where event_type = 'won')  as won,
                     count(*) filter (where event_type = 'lost') as lost
                from closes group by 1) o
    ), '[]'::jsonb),
    'note', 'Each pipeline (deal type) is reported separately, and a stage by its '
            'id under its current name, so a rename keeps its history; a change '
            'recorded before stage ids were kept, or naming a stage since '
            'deleted, is grouped under the name recorded at the time. entered '
            'counts the deals that moved into a stage in this window. Of those '
            'deals, advanced (moved forward) counts the ones that then left it '
            'for a later stage of the same pipeline, regressed (moved back) the '
            'ones that left it for an earlier stage, and departed_unknown the '
            'ones whose direction cannot be read because a side is not a '
            'current stage; a deal that left both ways counts in both. '
            'Direction compares the stages'' CURRENT order, so reordering a '
            'pipeline re-reads its history. advance_rate = advanced / entered, '
            'never above 1. won and lost are separate events: they are counted '
            'per pipeline but not attributed to the stage they left, because '
            'their payload records only the destination stage. A stage change '
            'whose recorded stage id is present but is not a valid id, or that '
            'names no stage at all, is malformed: it is left out of every '
            'figure and counted in moves_malformed.'
  );
$$;

comment on function public.report_stage_conversion(timestamptz, timestamptz) is
  'Movement between pipeline stages in a window, computed from `stage_changed` '
  'EVENTS rather than current deal state — so unlike the other reports it is '
  'genuinely re-derivable from the hash-chained log. Since 0154 a stage row is '
  '(pipeline, stage id) under the stage''s current name — a side with no '
  'current stage falls back to (the deal''s pipeline, the recorded name) — and '
  'departures are split by direction using the stages'' CURRENT sort_order: '
  'advanced (forward), regressed (backward), departed_unknown. advanced is '
  'still 0076''s in-window-entry cohort, so advance_rate never exceeds 1. '
  'Won/lost are separate event types: counted under `outcomes` and '
  '`outcomes_by_type`, not attributed to the stage they left (their payload '
  'records only the destination). Since 0130 a movement whose stage id is '
  'present but not a uuid — and since 0154 one naming no stage at all — is '
  'left out of every figure and counted in `moves_malformed`.';

-- ---------------------------------------------------------------------------
-- 3. Postflight — behaviour first, in a throwaway organisation inside a block
--    that always rolls back; then the bodies, attributes and grants
-- ---------------------------------------------------------------------------
do $$
declare
  f      record;
  v_body text;
  v_roi  jsonb;
  v_conv jsonb;
  v_got  jsonb;
  w0     constant timestamptz := '1900-01-01 00:00:00+00';
  w1     constant timestamptz := '1900-01-01 01:00:00+00';
  v_org  constant uuid := gen_random_uuid();
  s_new  constant uuid := gen_random_uuid();
  s_q    constant uuid := gen_random_uuid();
  s_v    constant uuid := gen_random_uuid();
  r_new  constant uuid := gen_random_uuid();
  r_q    constant uuid := gen_random_uuid();
  d_sale constant uuid := gen_random_uuid();
  d_rent constant uuid := gen_random_uuid();
  d_lead constant uuid := gen_random_uuid();
begin
  if not (select r.rolsuper or r.rolbypassrls from pg_roles r where r.rolname = current_user) then
    raise exception '0154 postflight: run this file as a role that bypasses RLS (postgres) — its probe reads a throwaway organisation through two SECURITY INVOKER reports (running as %)', current_user;
  end if;
  if exists (select 1 from public.events e where e.occurred_at >= w0 and e.occurred_at < w1)
     or exists (select 1 from public.leads l where l.received_at >= w0 and l.received_at < w1) then
    raise exception '0154 postflight: the probe hour (1900-01-01 00:00 UTC) already holds an event or a lead — the probe needs it empty';
  end if;

  begin
    insert into public.organizations (id, name, slug)
    values (v_org, '0154 postflight probe', 'zz-0154-probe-' || replace(v_org::text, '-', ''));
    insert into public.deal_stages (id, org_id, deal_type, name, sort_order) values
      (s_new, v_org, 'sale',   'New',       1),
      (s_q,   v_org, 'sale',   'Qualified', 2),
      (s_v,   v_org, 'sale',   'Viewing',   3),
      (r_new, v_org, 'rental', 'New',       1),
      (r_q,   v_org, 'rental', 'Qualified', 2);

    -- a sale deal New → Qualified → Viewing → back to Qualified; a rental deal
    -- New → Qualified (same NAME, other pipeline); one `{}` payload
    insert into public.events (org_id, actor_id, entity_type, entity_id, event_type, payload, occurred_at)
    select v_org, null, 'deal', x.deal, 'stage_changed', x.payload, w0 + x.at * interval '1 minute'
      from (values
        (d_sale, jsonb_build_object('from', 'New',       'to', 'Qualified', 'from_stage_id', s_new, 'to_stage_id', s_q), 1),
        (d_sale, jsonb_build_object('from', 'Qualified', 'to', 'Viewing',   'from_stage_id', s_q,   'to_stage_id', s_v), 2),
        (d_sale, jsonb_build_object('from', 'Viewing',   'to', 'Qualified', 'from_stage_id', s_v,   'to_stage_id', s_q), 3),
        (d_rent, jsonb_build_object('from', 'New',       'to', 'Qualified', 'from_stage_id', r_new, 'to_stage_id', r_q), 4),
        (d_rent, '{}'::jsonb, 5)
      ) as x(deal, payload, at);

    -- three website enquiries: one converted, one open, one spam
    insert into public.deals (id, org_id, deal_type, stage_id, title, status)
    values (d_lead, v_org, 'sale', s_new, '0154 postflight probe', 'open');
    insert into public.leads (org_id, source, status, received_at, converted_deal_id) values
      (v_org, 'website', 'converted', w0 + interval '1 minute', d_lead),
      (v_org, 'website', 'new',       w0 + interval '2 minutes', null),
      (v_org, 'website', 'spam',      w0 + interval '3 minutes', null);

    v_roi := public.report_source_roi(w0, w1);
    if jsonb_array_length(v_roi) <> 1
       or (v_roi -> 0 ->> 'source') is distinct from 'website'
       or (v_roi -> 0 ->> 'leads')::int is distinct from 3
       or (v_roi -> 0 ->> 'spam')::int is distinct from 1
       or (v_roi -> 0 ->> 'converted')::int is distinct from 1
       or (v_roi -> 0 ->> 'converted_visible')::int is distinct from 1
       or (v_roi -> 0 ->> 'convert_rate')::numeric is distinct from 0.5
       or (v_roi -> 0 ->> 'win_rate')::numeric is distinct from 0 then
      raise exception '0154 postflight: report_source_roi does not keep spam out of the convert rate (expected 1 of 2 non-spam enquiries): %', v_roi;
    end if;

    v_conv := public.report_stage_conversion(w0, w1);
    select jsonb_object_agg(s ->> 'stage_id',
                            jsonb_build_object('t', s ->> 'deal_type', 'e', (s ->> 'entered')::int,
                                               'a', (s ->> 'advanced')::int, 'r', (s ->> 'regressed')::int,
                                               'u', (s ->> 'departed_unknown')::int))
      into v_got
      from jsonb_array_elements(v_conv -> 'stages') s;
    if v_got is distinct from jsonb_build_object(
         s_q::text, jsonb_build_object('t', 'sale',   'e', 1, 'a', 1, 'r', 0, 'u', 0),
         s_v::text, jsonb_build_object('t', 'sale',   'e', 1, 'a', 0, 'r', 1, 'u', 0),
         r_q::text, jsonb_build_object('t', 'rental', 'e', 1, 'a', 0, 'r', 0, 'u', 0)) then
      raise exception '0154 postflight: report_stage_conversion does not split pipelines and directions: %', v_conv -> 'stages';
    end if;
    if (v_conv ->> 'stage_key') is distinct from 'id'
       or (v_conv ->> 'moves_total')::int is distinct from 4
       or (v_conv ->> 'moves_malformed')::int is distinct from 1
       or jsonb_typeof(v_conv -> 'outcomes_by_type') is distinct from 'array'
       or not (v_conv ? 'outcomes' and v_conv ? 'transitions' and v_conv ? 'note' and v_conv ? 'moves_with_ids') then
      raise exception '0154 postflight: report_stage_conversion''s keys are not this file''s (stage_key id, a `{}` payload malformed, outcomes_by_type): %',
                      v_conv - 'stages' - 'transitions' - 'note';
    end if;

    raise exception using errcode = 'P0001', message = '0154-postflight-undo';
  exception
    when raise_exception then
      if sqlerrm <> '0154-postflight-undo' then
        raise;
      end if;
  end;

  -- the 0130 guards, restated: every uuid cast in the stage body is one of the
  -- two CASE-guarded ones, the classification calls pg_input_is_valid twice,
  -- and advanced is still the intersection cohort
  select prosrc into v_body from pg_proc where oid = 'public.report_stage_conversion(timestamptz, timestamptz)'::regprocedure;
  if (select count(*) from regexp_matches(v_body, '::uuid', 'g')) <> 2
     or (select count(*) from regexp_matches(v_body,
           'when c\.(from|to)_kind\s*=\s*''id'' then \(c\.(from|to)_raw\s+#>> ''\{\}''\)::uuid end', 'g')) <> 2
     or (select count(*) from regexp_matches(v_body, 'pg_input_is_valid\(', 'g')) <> 2 then
    raise exception '0154 postflight: report_stage_conversion''s uuid casts are not exactly the two guarded ones';
  end if;
  if position('e.to_stage = m.from_stage' in v_body) = 0 then
    raise exception '0154 postflight: advanced is no longer 0076''s intersection cohort';
  end if;

  for f in
    select * from (values
      ('public.report_source_roi(timestamptz, timestamptz)',       'a2d98fbb96ce5ff94805c193dee3d331'),
      ('public.report_stage_conversion(timestamptz, timestamptz)', '68246923289bff0870562f640a5ffa08')
    ) as x(sig, after_md5)
  loop
    if not exists (select 1 from pg_proc p
                    where p.oid = to_regprocedure(f.sig)
                      and not p.prosecdef
                      and p.provolatile = 's'
                      and p.prorettype = 'jsonb'::regtype
                      and p.proconfig = array['search_path=public']
                      and pg_get_userbyid(p.proowner) = 'postgres'
                      and md5(replace(p.prosrc, chr(13), '')) = f.after_md5) then
      raise exception '0154 postflight: % is not the function this file wrote (its body, SECURITY INVOKER, STABLE, search_path=public, owner postgres)', f.sig;
    end if;
    if has_function_privilege('anon', f.sig, 'execute')
       or not has_function_privilege('authenticated', f.sig, 'execute')
       or not has_function_privilege('service_role', f.sig, 'execute') then
      raise exception '0154 postflight: the grants on % changed (anon must not, authenticated and service_role must execute)', f.sig;
    end if;
  end loop;

  raise notice '0154: postflight passed — spam out of the convert rate, one-scope win rate, stage rows per pipeline and direction, a `{}` move malformed; bodies, invoker and grants as written';
end $$;

-- for the CLI: the two bodies' digests (a guarded hosted apply discards this)
select string_agg(p.proname || '=' || md5(replace(p.prosrc, chr(13), '')), ' ' order by p.proname) as report_bodies
  from pg_proc p
 where p.oid in ('public.report_source_roi(timestamptz, timestamptz)'::regprocedure,
                 'public.report_stage_conversion(timestamptz, timestamptz)'::regprocedure);
