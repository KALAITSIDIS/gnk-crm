-- =============================================================================
-- 0130 — one malformed stage_changed payload no longer takes the
--        stage-conversion report down; it is left out and COUNTED
--
-- THE GAP (BACKLOG "One crafted `stage_changed` empties the stage-conversion
-- report"; reproduced 2026-10-01 against 31c877d on the local stack at 0129
-- through PostgREST with aal2 sessions of throwaway organisations, pinned RED
-- first by supabase/tests/stage-conversion-malformed.test.ts):
--
--   * report_stage_conversion (0076) reads
--       nullif(e.payload ->> 'from_stage_id', '')::uuid
--       nullif(e.payload ->> 'to_stage_id',   '')::uuid
--     straight off the event. events_insert (0071 / 0128) checks org, actor,
--     terminal deal types and occurred_at — never the payload — so an aal2
--     agent's direct POST of a deal `stage_changed` with to_stage_id "x" is
--     accepted (measured), and from then on every window containing it raises
--     22P02 for every caller who can SEE that event: the writing agent and
--     its organisation's admins (measured). A peer agent of the same
--     organisation (events_select shows an agent only its own events), another
--     organisation, and a window that ends before the event were unaffected
--     (measured). The chain is append-only, so the break was permanent for
--     those windows.
--   * Every non-uuid shape raised the same way: a non-uuid string, whitespace,
--     a space-padded uuid, a JSON number / boolean / object / array (->> of a
--     non-string renders its JSON text, which then fails the cast).
--   * The page (app/(app)/reports/performance/page.tsx) ignored the RPC's
--     error and painted "Nothing in this window."; the CSV route answered 500.
--     Those consumers are fixed in the same change, against the field below.
--
-- THE FIX — this file restates 0076's body (NOT 0067's or 0065's: 0076 holds
-- the intersection cohort for `advanced`) with ONE change of meaning:
--
--   Each stage-id field is classified before anything casts it:
--     * absent, JSON null or the empty string  → no id (a pre-0067 / legacy
--       side): its recorded name stands, exactly as 0076 did (nullif '');
--     * a JSON string the uuid input function accepts (pg_input_is_valid,
--       PostgreSQL 16+; local and hosted run 17) → an id, cast and resolved to
--       the stage's CURRENT name as 0067 does, falling back to the recorded
--       name when no readable stage has that id (deleted, another
--       organisation's) — unchanged;
--     * anything else → MALFORMED.
--   The cast sits inside `case when <the field is a valid uuid> then … end`,
--   so it is never evaluated for a value that would raise — CASE guarantees
--   that ordering wherever the planner puts the expression; it does not rely
--   on a WHERE clause running first.
--   A movement with EITHER field malformed is left out of every figure —
--   stages, transitions, moves_total, moves_with_ids — and never rescued by
--   its recorded names (a forged id beside a plausible name must not become a
--   valid-looking move). It is counted, per event, in the new field
--   `moves_malformed`, and the `note` says so.
--
-- THE INVARIANT: every event 0076 reported, 0130 reports identically (0076
-- either cast a field successfully or raised; the three "no id" cases are the
-- ones its nullif let through). Only the events that made 0076 raise change —
-- from "the whole report fails" to "excluded and counted". Pinned by the test
-- file: each valid / legacy case's figures at 0129 equal its figures at 0130.
--
-- CONTRACT — additive. Same signature, return type (jsonb), SECURITY INVOKER,
-- STABLE, search_path = public, owner and grants (create or replace keeps
-- them; asserted below). Every existing key keeps its meaning; `moves_total`
-- and `moves_with_ids` count the movements the figures are computed from, so
-- moves_total + moves_malformed = the window's visible stage_changed events.
-- New key: `moves_malformed` (integer). Readers: the performance page and the
-- CSV route (both updated here); lib/supabase/database.types.ts types the
-- result as Json, so regenerating it changes nothing.
--
-- NOT CHANGED: what anyone may read or write (no policy is touched; RLS and
-- require_aal2 still decide which events a caller's report contains); no
-- event row is written, modified, deleted or rehashed; the definition of
-- advancement, the window, the outcomes and the coverage counters.
--
-- LOCKS. CREATE OR REPLACE FUNCTION takes no table lock; lock_timeout (5 s)
-- bounds the catalog wait anyway, and the check below proves the file runs as
-- ONE transaction (otherwise SET LOCAL is a no-op).
--
-- ROLLBACK, a forward migration: restate 0076's body (section 6 of 0076,
-- md5 4fd70bfa… CR-stripped) and its comment; in the same change revert the
-- page / route / report-export.ts consumers (they read `moves_malformed` as
-- optional, so they also run against 0076) and delete the 0130 rows in
-- scripts/backup/verify-restore.sql. No data moves.
-- =============================================================================

set local lock_timeout = '5s';

do $$
begin
  if current_setting('lock_timeout') <> '5s' then
    raise exception '0130 aborted: this file must run as ONE transaction (SET LOCAL lock_timeout did not take effect) — nothing was changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Preflight: the function this file restates must be 0076's text, and the
-- server must have pg_input_is_valid (PostgreSQL 16+).
-- ---------------------------------------------------------------------------
do $$
declare
  v_md5 text;
begin
  if to_regprocedure('pg_catalog.pg_input_is_valid(text, text)') is null then
    raise exception '0130 aborted: pg_input_is_valid(text, text) does not exist on this server (PostgreSQL %; 16+ is required) — nothing was changed',
                    current_setting('server_version');
  end if;

  if (select count(*) from pg_proc p
       where p.pronamespace = 'public'::regnamespace and p.proname = 'report_stage_conversion') <> 1 then
    raise exception '0130 aborted: public.report_stage_conversion is not exactly one function — nothing was changed';
  end if;

  select md5(replace(p.prosrc, E'\r', '')) into v_md5
    from pg_proc p
   where p.oid = 'public.report_stage_conversion(timestamptz, timestamptz)'::regprocedure;
  if v_md5 is distinct from '4fd70bfa3c3c02beaafa81a5d83636a2' then
    raise exception '0130 aborted: report_stage_conversion is not the body this file was written against (md5 %, expected 0076''s 4fd70bfa…) — nothing was changed. '
                    'Diff the live body against 0076 section 6 and decide before applying',
                    coalesce(v_md5, 'missing');
  end if;
  raise notice '0130: preflight passed — report_stage_conversion is 0076''s; pg_input_is_valid present';
end $$;

-- ---------------------------------------------------------------------------
-- The reader
-- ---------------------------------------------------------------------------
create or replace function public.report_stage_conversion(p_from timestamptz, p_to timestamptz)
returns jsonb
language sql stable security invoker set search_path = public as $$
  with src as (
    select e.entity_id                    as deal_id,
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
  raw as (
    -- Only well-formed movements go on. The casts are GUARDED by their own
    -- CASE — never evaluated unless the value is a valid uuid — so their
    -- safety does not depend on the WHERE below running first.
    select c.deal_id,
           case when c.from_kind = 'id' then (c.from_raw #>> '{}')::uuid end as from_id,
           case when c.to_kind   = 'id' then (c.to_raw   #>> '{}')::uuid end as to_id,
           c.from_name,
           c.to_name
      from classified c
     where c.from_kind <> 'malformed'
       and c.to_kind   <> 'malformed'
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
    -- 0130: stage_changed events left out because a stage id is malformed;
    -- moves_total + moves_malformed = the window's visible stage_changed events
    'moves_malformed', (select count(*) from classified
                         where from_kind = 'malformed' or to_kind = 'malformed'),
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
            'at 1. A stage change whose recorded stage id is present but is not '
            'a valid id is malformed: it is left out of every figure and counted '
            'in moves_malformed.'
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
  'the in-window-entry cohort, so advance_rate never exceeds 1. Since 0130, a '
  'movement whose from_stage_id or to_stage_id is present but not a uuid is '
  'left out of every figure (never rescued by its recorded name) and counted '
  'in `moves_malformed`, instead of failing the whole report.';

-- ---------------------------------------------------------------------------
-- Postflight — checked against the catalog and one read-only call, never by
-- writing rows (the 0067 idiom)
-- ---------------------------------------------------------------------------
do $$
declare
  v_fn   oid := 'public.report_stage_conversion(timestamptz, timestamptz)'::regprocedure;
  v_body text;
  conv   jsonb;
begin
  select prosrc into v_body from pg_proc where oid = v_fn;
  -- every uuid cast in the body is one of the two CASE-guarded ones
  if (select count(*) from regexp_matches(v_body, '::uuid', 'g')) <> 2
     or (select count(*) from regexp_matches(v_body,
           'when c\.(from|to)_kind\s*=\s*''id'' then \(c\.(from|to)_raw\s+#>> ''\{\}''\)::uuid end', 'g')) <> 2
     or (select count(*) from regexp_matches(v_body, 'pg_input_is_valid\(', 'g')) <> 2 then
    raise exception '0130 postflight: report_stage_conversion''s uuid casts are not exactly the two guarded ones';
  end if;
  if position('e.to_stage = m.from_stage' in v_body) = 0 then
    raise exception '0130 postflight: advanced is no longer 0076''s intersection cohort';
  end if;

  if (select prosecdef from pg_proc where oid = v_fn)
     or (select provolatile from pg_proc where oid = v_fn) <> 's'
     or (select proconfig from pg_proc where oid = v_fn) is distinct from array['search_path=public'] then
    raise exception '0130 postflight: report_stage_conversion is not SECURITY INVOKER / STABLE / search_path=public';
  end if;
  if has_function_privilege('anon', v_fn, 'execute')
     or not has_function_privilege('authenticated', v_fn, 'execute')
     or not has_function_privilege('service_role', v_fn, 'execute') then
    raise exception '0130 postflight: report_stage_conversion''s grants changed (anon must not, authenticated and service_role must execute)';
  end if;

  -- one read-only call over ten years: the shape, and — as whoever applies
  -- this — how many malformed movements the database already holds
  conv := public.report_stage_conversion(now() - interval '3650 days', now() + interval '1 day');
  if not (conv ? 'moves_with_ids' and conv ? 'moves_total' and conv ? 'moves_malformed'
          and conv ? 'stages' and conv ? 'transitions' and conv ? 'outcomes' and conv ? 'note') then
    raise exception '0130 postflight: report_stage_conversion lost a key: %', (select array_agg(k) from jsonb_object_keys(conv) k);
  end if;
  raise notice '0130: postflight passed — guarded casts, invoker, grants held; % movements, % malformed in the last ten years (as %)',
               conv ->> 'moves_total', conv ->> 'moves_malformed', current_user;
end $$;
