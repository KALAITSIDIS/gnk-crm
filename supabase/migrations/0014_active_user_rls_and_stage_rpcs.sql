-- =============================================================================
-- 0014 — Settings audit fixes (2026-07-20)
--
-- 1. Deactivation must be immediate. setUserActive bans the auth user, but a
--    ban only blocks NEW token issuance — a live access token (default 1h TTL)
--    kept full RLS access, because current_org_id()/current_role_gnk() never
--    looked at profiles.is_active. Adding `and is_active` makes both helpers
--    return NULL for a deactivated user, which fails every org/role predicate
--    in every policy: all reads and writes die on the next statement, token or
--    not. (The ban still matters — it stops the session refreshing forever.)
--    Reactivation restores access just as instantly; the functions are STABLE,
--    re-evaluated per statement.
--
-- 2. reorder_stage(uuid, text): the app-side stage reorder ran park-at(-1) +
--    two UPDATEs as three round-trips — a failure or concurrent move stranded
--    a stage at sort_order -1, and the stages_updated event was written
--    outside any transaction (same class 0011/0013 fixed for deals/keys).
--    SECURITY INVOKER (admin-only UPDATE policy still enforced), row-locks
--    both stages, swaps via the park trick inside ONE transaction (the
--    unique (org_id, deal_type, sort_order) index is per-statement, so the
--    park slot is still needed — but any RAISE now rolls the park back too),
--    and writes the event atomically.
--
-- 3. add_deal_stage(deal_type, text): appending a stage shifted the terminal
--    won/lost stages up one-by-one app-side (non-atomic, same class). The
--    function locks the type's stages, refuses duplicate names, shifts the
--    terminals descending, inserts before them, and writes the event — all in
--    one transaction. Returns the new stage id.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Active-user gate in the RLS helpers
-- ---------------------------------------------------------------------------
create or replace function current_org_id() returns uuid
language sql stable security definer set search_path = public as
$$ select org_id from profiles where id = auth.uid() and is_active $$;

create or replace function current_role_gnk() returns user_role
language sql stable security definer set search_path = public as
$$ select role from profiles where id = auth.uid() and is_active $$;

-- ---------------------------------------------------------------------------
-- 2. Atomic guarded stage reorder
-- ---------------------------------------------------------------------------
create or replace function reorder_stage(p_stage_id uuid, p_direction text)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_stage record;
  v_other record;
  v_rows int;
begin
  if p_direction not in ('up', 'down') then
    raise exception 'Unknown direction';
  end if;
  -- clean message up front; RLS + the row-count guards below stay the real gate
  if coalesce(current_role_gnk()::text, '') <> 'admin' then
    raise exception 'Admins only.';
  end if;

  -- Row lock: concurrent reorders within the same deal type serialize here,
  -- so the park slot (-1) is never contended and swaps stay consistent.
  select id, org_id, deal_type, name, sort_order, is_won, is_lost
    into v_stage
    from deal_stages
   where id = p_stage_id
     for update;
  if not found then
    raise exception 'Stage not found';
  end if;
  if v_stage.is_won or v_stage.is_lost then
    raise exception 'Won/lost stages stay last.';
  end if;

  -- nearest non-terminal neighbour in the requested direction
  if p_direction = 'up' then
    select id, sort_order into v_other
      from deal_stages
     where org_id = v_stage.org_id and deal_type = v_stage.deal_type
       and not is_won and not is_lost and sort_order < v_stage.sort_order
     order by sort_order desc
     limit 1
     for update;
  else
    select id, sort_order into v_other
      from deal_stages
     where org_id = v_stage.org_id and deal_type = v_stage.deal_type
       and not is_won and not is_lost and sort_order > v_stage.sort_order
     order by sort_order asc
     limit 1
     for update;
  end if;
  if not found then
    return; -- already at the edge: no-op, no event
  end if;

  -- park → swap; each UPDATE is row-count-guarded so an RLS-filtered 0-row
  -- write (non-admin caller) aborts and rolls the whole swap back.
  update deal_stages set sort_order = -1 where id = v_stage.id;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'Only admins may reorder stages';
  end if;
  update deal_stages set sort_order = v_stage.sort_order where id = v_other.id;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'Only admins may reorder stages';
  end if;
  update deal_stages set sort_order = v_other.sort_order where id = v_stage.id;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'Only admins may reorder stages';
  end if;

  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  values (
    v_stage.org_id,
    auth.uid(),
    'config',
    null,
    'stages_updated',
    jsonb_build_object('action', 'reorder', 'stage', v_stage.name, 'direction', p_direction)
  );
end $$;

-- ---------------------------------------------------------------------------
-- 3. Atomic guarded stage append
-- ---------------------------------------------------------------------------
create or replace function add_deal_stage(p_deal_type deal_type, p_name text)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_org uuid;
  v_name text;
  v_new_order int;
  v_new_id uuid;
  v_rows int;
  r record;
begin
  v_org := current_org_id();
  if v_org is null then
    raise exception 'Not authenticated';
  end if;
  -- clean message up front; the admin-only INSERT WITH CHECK stays the real gate
  if coalesce(current_role_gnk()::text, '') <> 'admin' then
    raise exception 'Admins only.';
  end if;
  v_name := btrim(p_name);
  if v_name = '' or length(v_name) > 60 then
    raise exception 'Stage name is required (max 60 characters)';
  end if;

  -- lock the type's stages: concurrent adds serialize, sort_order math is safe
  perform 1 from deal_stages
    where org_id = v_org and deal_type = p_deal_type
    for update;

  if exists (
    select 1 from deal_stages
     where org_id = v_org and deal_type = p_deal_type
       and lower(name) = lower(v_name)
  ) then
    raise exception 'A stage with this name already exists for this deal type.';
  end if;

  select coalesce(max(sort_order), 0) + 1 into v_new_order
    from deal_stages
   where org_id = v_org and deal_type = p_deal_type
     and not is_won and not is_lost;

  -- move terminal won/lost stages out of the way, descending so the unique
  -- (org_id, deal_type, sort_order) index never collides mid-shift
  for r in
    select id, sort_order from deal_stages
     where org_id = v_org and deal_type = p_deal_type and (is_won or is_lost)
     order by sort_order desc
  loop
    update deal_stages set sort_order = r.sort_order + 1 where id = r.id;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      raise exception 'Only admins may add stages';
    end if;
  end loop;

  -- non-admin INSERT violates the admin-only WITH CHECK and raises here,
  -- rolling back the terminal shift with it
  insert into deal_stages (org_id, deal_type, name, sort_order)
  values (v_org, p_deal_type, v_name, v_new_order)
  returning id into v_new_id;

  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  values (
    v_org,
    auth.uid(),
    'config',
    null,
    'stages_updated',
    jsonb_build_object('action', 'add', 'deal_type', p_deal_type, 'name', v_name)
  );

  return v_new_id;
end $$;

-- Grants follow the 0007/0010 convention: authenticated callers only
-- (PostgREST /rpc/*), service_role for scripts and the RLS test suite.
revoke execute on function public.reorder_stage(uuid, text) from public, anon;
grant  execute on function public.reorder_stage(uuid, text) to authenticated, service_role;
revoke execute on function public.add_deal_stage(deal_type, text) from public, anon;
grant  execute on function public.add_deal_stage(deal_type, text) to authenticated, service_role;
