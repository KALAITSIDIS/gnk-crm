-- 0067 — stage_changed carries stage IDS as well as names.
--
-- Follow-on from C4 (T-c4), deliberately left out of 0065 because changing a
-- guarded write path is not a reporting migration's business.
--
-- THE PROBLEM. `move_deal_to_stage` (0011) logs the stage NAMES:
--
--   jsonb_build_object('from', coalesce(v_from_name, v_deal.stage_id::text),
--                      'to',   v_to.name)
--
-- so `report_stage_conversion` (0065) joins its funnel on a MUTABLE STRING.
-- Rename "Qualified" to "Qualified lead" and that stage's history splits in two
-- at the rename, silently — one row for each spelling, each with half the
-- traffic, and nothing on the report saying why.
--
-- THE FIX IS ADDITIVE IN BOTH DIRECTIONS. The payload gains `from_stage_id` and
-- `to_stage_id`; the names STAY, because the timeline renderer
-- (`lib/services/events.ts` → `stage_changed`) reads them, RLS test 15 asserts
-- `payload.to` by value, and every event already written has only names. This
-- adds keys to future payloads and removes nothing.
--
-- `events` is hash-chained, and that is fine: the hash covers `payload::text`,
-- so rows written from here on hash their new shape and every existing row is
-- untouched. Same reasoning as 0061's hash_version — old evidence keeps
-- verifying under the formula it was minted with.
--
-- AND THE READER IS UPDATED IN THE SAME MIGRATION, which is the point. A
-- payload field that nothing consumes is not an improvement, it is clutter that
-- looks like one. report_stage_conversion now resolves an id to the stage's
-- CURRENT name and falls back to the recorded name when there is no id, so:
--
--   * events written from now on follow a rename and stay grouped;
--   * events written before this migration behave exactly as they did;
--   * a stage deleted outright falls back to the name recorded at the time,
--     which is the only thing left that describes it.
--
-- The report also now reports HOW MANY moves in the window carried ids, so a
-- reader can see how rename-proof the answer actually is rather than assuming.

-- ---------------------------------------------------------------------------
-- 1. The writer. Body is 0011's, unchanged except the payload — this is a
--    guarded path (row lock, deal-type check, won/lost refusal, RLS-filtered
--    UPDATE), and the smallest possible delta is the safest one.
-- ---------------------------------------------------------------------------
create or replace function public.move_deal_to_stage(p_deal_id uuid, p_stage_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_deal record;
  v_to record;
  v_from_name text;
  v_rows int;
begin
  -- Row lock: concurrent moves of the same deal serialize here, so the
  -- from-stage recorded in the event is always the stage actually left.
  select id, org_id, deal_type, stage_id, status
    into v_deal
    from deals
   where id = p_deal_id
     for update;
  if not found then
    raise exception 'Deal not found';
  end if;
  if v_deal.stage_id = p_stage_id then
    return; -- no-op drag back onto the same column
  end if;
  if v_deal.status <> 'open' then
    raise exception 'Deal is already % — closed deals do not move stages', v_deal.status;
  end if;

  select id, name, deal_type, is_won, is_lost
    into v_to
    from deal_stages
   where id = p_stage_id;
  if not found then
    raise exception 'Stage not found';
  end if;
  if v_to.deal_type <> v_deal.deal_type then
    raise exception 'Stage belongs to another deal type';
  end if;
  -- Won/lost stay behind the guarded flows (T3.4): accepted-offer check,
  -- admin override, mandatory lost reason. The kanban cannot bypass them.
  if v_to.is_won or v_to.is_lost then
    raise exception 'Use the deal page to mark this deal % (guarded flow)',
      case when v_to.is_won then 'won' else 'lost' end;
  end if;

  select name into v_from_name from deal_stages where id = v_deal.stage_id;

  update deals
     set stage_id = p_stage_id,
         stage_entered_at = now(),
         last_activity_at = now()
   where id = p_deal_id;
  get diagnostics v_rows = row_count;
  -- RLS filtered the UPDATE to nothing (e.g. listing manager: may see all org
  -- deals but update none). Abort so no phantom event reaches the log.
  if v_rows = 0 then
    raise exception 'You do not have permission to move this deal';
  end if;

  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  values (
    v_deal.org_id,
    auth.uid(),
    'deal',
    p_deal_id,
    'stage_changed',
    -- NAMES STAY: the timeline renderer reads them, RLS test 15 asserts
    -- `payload.to`, and every pre-0067 event has only these. IDS ADDED so
    -- stage analytics survive a rename (0067).
    jsonb_build_object(
      'from',          coalesce(v_from_name, v_deal.stage_id::text),
      'to',            v_to.name,
      'from_stage_id', v_deal.stage_id,
      'to_stage_id',   v_to.id
    )
  );
end $$;

-- 0011's grants, restated: create-or-replace preserves the ACL, and §4 of
-- HANDOFF says to assert rather than assume.
revoke execute on function public.move_deal_to_stage(uuid, uuid) from public, anon;
grant  execute on function public.move_deal_to_stage(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. The reader, resolving ids where they exist.
-- ---------------------------------------------------------------------------
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
            'record it'
  );
$$;

comment on function public.report_stage_conversion(timestamptz, timestamptz) is
  'Movement between pipeline stages in a window, computed from `stage_changed` '
  'EVENTS rather than current deal state — so unlike the other reports it is '
  'genuinely re-derivable from the hash-chained log. Grouped by stage NAME, '
  'resolved from the stage id where the event recorded one (0067) so a rename '
  'does not split history; `moves_with_ids` vs `moves_total` says how much of '
  'the window that covers. Won/lost are separate event types: counted under '
  '`outcomes`, not attributed to the stage they left.';

-- ---------------------------------------------------------------------------
-- 3. Prove it, in a rolled-back subtransaction — the 0051/0053 idiom, because
--    a real move writes to the append-only hash-chained log.
-- ---------------------------------------------------------------------------
do $$
declare
  n_with_ids bigint;
  n_total    bigint;
  conv       jsonb;
begin
  -- the payload must now name both keys, checked against the function source
  -- rather than by writing an event to production
  if position('from_stage_id' in (
       select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'move_deal_to_stage')) = 0
  then
    raise exception '0067: move_deal_to_stage does not write from_stage_id';
  end if;

  -- and the reader must expose the coverage counters
  conv := public.report_stage_conversion(now() - interval '3650 days', now() + interval '1 day');
  if not (conv ? 'moves_with_ids' and conv ? 'moves_total') then
    raise exception '0067: report_stage_conversion is missing its coverage counters';
  end if;

  n_total    := (conv ->> 'moves_total')::bigint;
  n_with_ids := (conv ->> 'moves_with_ids')::bigint;

  raise notice '0067: stage ids live. % historic stage move(s) in this database, % carrying ids (pre-0067 events carry none, by design).',
    n_total, n_with_ids;
end $$;
