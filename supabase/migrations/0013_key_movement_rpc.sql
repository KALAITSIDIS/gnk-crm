-- =============================================================================
-- 0013 — Keys audit fixes (2026-07-20)
--
-- 1. record_key_movement(uuid, key_action, uuid, text, text): key checkout and
--    return previously ran as three app-side statements (status read via the
--    user client, key_movements INSERT via the user client, property_keys
--    cache UPDATE via the service role, events INSERT last). Three defects:
--      * check-then-act — two concurrent checkouts both read 'in_office' and
--        both logged a checkout; nothing at the DB level guarded transitions;
--      * not atomic — a failed cache update left a movement logged for a key
--        whose status/holder never changed (and a retry double-logged it);
--      * the event was outside the transaction (violates guardrail 1).
--    The function is SECURITY DEFINER because doc 04 intentionally lets
--    agents MOVE keys while only admin/LM may UPDATE the property_keys row —
--    the status/holder cache is derived state maintained by the system when a
--    movement happens. Definer therefore re-implements the matrix checks
--    itself: org scope, mover roles, and per-action status transitions. It
--    row-locks the key (concurrent movements serialize and re-check status),
--    refuses to store an unverifiable holder_profile_id (cross-org / inactive
--    profiles fall back to the typed name), and writes movement + cache +
--    event in one transaction.
--    This also activates the until-now unreachable enum states: 'transfer'
--    (→ with_owner) and 'mark_lost' (→ lost), with 'return' doubling as the
--    recovery path from with_owner/lost back to in_office.
--
-- 2. Unique (org_id, key_code): registering the same code twice was allowed;
--    physical key tags are unique per office. Doc 03 updated in this commit.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Atomic guarded key movement
-- ---------------------------------------------------------------------------
create or replace function record_key_movement(
  p_key_id uuid,
  p_action key_action,
  p_holder_profile_id uuid default null,
  p_holder_name text default null,
  p_note text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_role user_role;
  v_key record;
  v_holder_id uuid;
  v_holder_name text;
  v_new_status key_status;
  v_cache_holder_id uuid;
  v_cache_holder_name text;
  v_event_type text;
begin
  -- doc 04 matrix: movements = admin, agent, listing_manager, own org only
  v_org := current_org_id();
  v_role := current_role_gnk();
  if v_org is null or v_role not in ('admin', 'agent', 'listing_manager') then
    raise exception 'You do not have permission to move keys';
  end if;

  -- Row lock: concurrent movements of the same key serialize here and the
  -- status guard below re-checks against the committed state.
  select id, org_id, property_id, key_code, status,
         current_holder_profile_id, current_holder_name
    into v_key
    from property_keys
   where id = p_key_id
     and org_id = v_org
     for update;
  if not found then
    raise exception 'Key not found';
  end if;

  -- Resolve the holder. An id that does not match an active same-org profile
  -- is NOT stored (audit: unverified ids were cached verbatim) — the typed
  -- name, if any, is used instead.
  v_holder_id := null;
  v_holder_name := nullif(trim(p_holder_name), '');
  if p_holder_profile_id is not null then
    select id, full_name
      into v_holder_id, v_holder_name
      from profiles
     where id = p_holder_profile_id
       and org_id = v_org
       and is_active;
  end if;

  if p_action = 'checkout' then
    if v_key.status <> 'in_office' then
      raise exception 'Key is % — return it first', replace(v_key.status::text, '_', ' ');
    end if;
    if v_holder_id is null and v_holder_name is null then
      raise exception 'Pick a staff member or type the holder''s name';
    end if;
    v_new_status := 'checked_out';
    v_cache_holder_id := v_holder_id;
    v_cache_holder_name := v_holder_name;
    v_event_type := 'key_checkout';

  elsif p_action = 'return' then
    if v_key.status = 'in_office' then
      raise exception 'Key is already in the office';
    end if;
    -- who it came back from: the recorded holder unless the caller names one
    v_holder_id := coalesce(v_holder_id, v_key.current_holder_profile_id);
    v_holder_name := coalesce(v_holder_name, v_key.current_holder_name);
    v_new_status := 'in_office';
    v_cache_holder_id := null;
    v_cache_holder_name := null;
    v_event_type := 'key_return';

  elsif p_action = 'transfer' then
    if v_key.status not in ('in_office', 'checked_out') then
      raise exception 'Key is % — return it first', replace(v_key.status::text, '_', ' ');
    end if;
    v_new_status := 'with_owner';
    v_cache_holder_id := v_holder_id;
    v_cache_holder_name := v_holder_name;
    v_event_type := 'key_transfer';

  elsif p_action = 'mark_lost' then
    if v_key.status = 'lost' then
      raise exception 'Key is already marked lost';
    end if;
    -- keep the last holder on the row for accountability
    v_holder_id := coalesce(v_holder_id, v_key.current_holder_profile_id);
    v_holder_name := coalesce(v_holder_name, v_key.current_holder_name);
    v_new_status := 'lost';
    v_cache_holder_id := v_holder_id;
    v_cache_holder_name := v_holder_name;
    v_event_type := 'key_lost';

  else
    raise exception 'Unknown key action %', p_action;
  end if;

  insert into key_movements (org_id, key_id, action, holder_profile_id, holder_name, note, created_by)
  values (v_org, v_key.id, p_action, v_holder_id, v_holder_name, nullif(trim(p_note), ''), auth.uid());

  update property_keys
     set status = v_new_status,
         current_holder_profile_id = v_cache_holder_id,
         current_holder_name = v_cache_holder_name
   where id = v_key.id;

  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  values (
    v_org,
    auth.uid(),
    'key',
    v_key.id,
    v_event_type,
    jsonb_build_object('key_code', v_key.key_code, 'holder', v_holder_name)
  );
end $$;

-- Grants follow the 0007/0010 convention: authenticated callers only
-- (PostgREST /rpc/*), service_role for scripts and the RLS test suite.
revoke execute on function public.record_key_movement(uuid, key_action, uuid, text, text) from public, anon;
grant  execute on function public.record_key_movement(uuid, key_action, uuid, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Key codes are unique per org
-- ---------------------------------------------------------------------------
create unique index if not exists property_keys_org_code_uniq
  on property_keys (org_id, key_code);
