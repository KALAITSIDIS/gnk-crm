-- =============================================================================
-- 0116 — a key's movement event names the movement, never the holder (SEC-03)
--
-- THE LEAK (BACKLOG, found by T-imported-identity-shape's scouting critic;
-- verified against 0510047). `record_key_movement` (0013, never re-created)
-- logged every key movement with the key's code AND the holder's name: the
-- typed name of an external holder on a checkout (a lawyer, a cleaner), the
-- property OWNER's typed name on a transfer, the same cached name again on a
-- return or a loss, and a staff member's full name by value. The events table
-- is append-only and hash-chained — nothing written there can be erased or
-- corrected (the T-merged-event-ids-only rule). Hosted (read-only, counts only,
-- 2026-09-25): one checkout and one return carry a typed name, neither a staff
-- member's.
--
-- THE HOLDER HAS A HOME ALREADY. `key_movements` gets one row per movement,
-- written in the same transaction with the same name, and it is what staff
-- read: the History dialog and the /keys movements list; "who has it now" is
-- `property_keys.current_holder_*`. The chain copy fed only a "to X" suffix on
-- the Activity tab and the admin feed. So nothing moves to a new table.
--
-- WHAT THIS FILE DOES. Re-creates the function from 0013's text with the event
-- payload reduced to the key's code and the id of the movement row it
-- describes — the id is the fact, the row carries the name. That needs one new
-- variable and a `returning id into` on the movement insert; nothing else in
-- the body changes (a `diff` against 0013's body shows only those three
-- places). The signature, the defaults, `returns void`, SECURITY DEFINER,
-- `search_path` and the grants are unchanged, so the apply is not
-- deploy-coupled in either order.
--
-- NOT DONE HERE (BACKLOG): the function has no second-factor check; a staff id
-- that matches no active profile silently discards the typed name; staff may
-- INSERT into key_movements directly; erasure reaches neither holder column.
--
-- Pins that move with this file: the migrations count in
-- scripts/backup/verify-restore.sql (116). database.types.ts is unchanged.
-- =============================================================================

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
  v_movement_id uuid;
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
  values (v_org, v_key.id, p_action, v_holder_id, v_holder_name, nullif(trim(p_note), ''), auth.uid())
  returning id into v_movement_id;

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
    jsonb_build_object('key_code', v_key.key_code, 'movement_id', v_movement_id)
  );
end $$;

-- grants: unchanged by create or replace, re-stated (the 0044 lesson)
revoke execute on function public.record_key_movement(uuid, key_action, uuid, text, text) from public, anon;
grant  execute on function public.record_key_movement(uuid, key_action, uuid, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Apply-time assertions. The behaviour needs a session and is proven by
-- supabase/tests/key-movement-event-shape.test.ts; here the shape.
-- ---------------------------------------------------------------------------
do $$
declare
  n   int;
  src text;
begin
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'record_key_movement';
  if n <> 1 then raise exception '0116 aborted: expected one record_key_movement, found %', n; end if;

  select p.prosrc into src from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'record_key_movement'
     and p.prosecdef and 'search_path=public' = any (p.proconfig)
     and p.prorettype = 'void'::regtype
     and pg_get_function_identity_arguments(p.oid)
         = 'p_key_id uuid, p_action key_action, p_holder_profile_id uuid, p_holder_name text, p_note text';
  if src is null then
    raise exception '0116 aborted: the function lost its signature, void return, SECURITY DEFINER or search_path';
  end if;
  if src ~ '''holder''' then
    raise exception '0116 aborted: the event still carries a holder';
  end if;
  if src !~ '''movement_id'', v_movement_id' or src !~ 'returning id into v_movement_id' then
    raise exception '0116 aborted: the event does not name its movement row';
  end if;

  if has_function_privilege('anon', 'public.record_key_movement(uuid,key_action,uuid,text,text)', 'execute')
     or not has_function_privilege('authenticated', 'public.record_key_movement(uuid,key_action,uuid,text,text)', 'execute')
     or not has_function_privilege('service_role', 'public.record_key_movement(uuid,key_action,uuid,text,text)', 'execute') then
    raise exception '0116 aborted: grants are wrong';
  end if;

  -- without a session it still refuses before it reads anything
  begin
    perform public.record_key_movement(gen_random_uuid(), 'checkout', null, 'x', null);
    raise exception '0116 aborted: the function ran without a session';
  exception
    when raise_exception then
      if sqlerrm <> 'You do not have permission to move keys' then raise; end if;
  end;

  raise notice '0116: record_key_movement logs { key_code, movement_id }; signature, grants and first refusal unchanged';
end $$;
