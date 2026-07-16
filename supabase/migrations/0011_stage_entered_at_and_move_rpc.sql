-- =============================================================================
-- 0011 — Pipeline audit fixes (2026-07-16)
--
-- 1. deals.stage_entered_at: the kanban's "days in stage" was derived from
--    updated_at, which the deals_updated trigger touches on EVERY update —
--    including the health recompute that runs after nearly every mutation.
--    The counter therefore measured "days since last write", not stage tenure.
--    Backfill: latest stage_changed event for the deal, else created_at.
--
-- 2. move_deal_to_stage(uuid, uuid): drag-and-drop stage moves previously ran
--    as two app-side statements (UPDATE deals, INSERT events). Two defects:
--      * not atomic — a failed event insert left a moved deal with no event
--        (violates guardrail 1: event log first);
--      * a 0-row RLS-filtered UPDATE reported no error, so a listing manager's
--        drag logged a stage_changed event for a move that never happened —
--        corrupting the append-only evidence log.
--    The function runs SECURITY INVOKER (RLS applies), locks the deal row
--    (concurrent moves serialize, the event's "from" stage stays truthful),
--    verifies the UPDATE affected a row, and writes the event in the same
--    transaction. Any RAISE rolls back both statements together.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. stage_entered_at
-- ---------------------------------------------------------------------------
alter table deals add column stage_entered_at timestamptz not null default now();

update deals d
set stage_entered_at = coalesce(
  (select max(e.occurred_at)
     from events e
    where e.entity_type = 'deal'
      and e.entity_id = d.id
      and e.event_type = 'stage_changed'),
  d.created_at);

-- ---------------------------------------------------------------------------
-- 2. Atomic guarded stage move
-- ---------------------------------------------------------------------------
create or replace function move_deal_to_stage(p_deal_id uuid, p_stage_id uuid)
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
    jsonb_build_object('from', coalesce(v_from_name, v_deal.stage_id::text), 'to', v_to.name)
  );
end $$;

-- Grants follow the 0007/0010 convention: authenticated callers only
-- (PostgREST /rpc/*), service_role for scripts and the RLS test suite.
revoke execute on function public.move_deal_to_stage(uuid, uuid) from public, anon;
grant  execute on function public.move_deal_to_stage(uuid, uuid) to authenticated, service_role;
