-- =============================================================================
-- 0127 — every definer surface a signed-in session reaches checks the second
--        factor; keys move only through their RPC; a typed key holder is kept
--
-- THE GAP (BACKLOG "`record_key_movement` has no second-factor check",
-- "Password-only (aal1) sessions reach two more definer surfaces",
-- "A staff id that matches no active profile silently discards a typed key
-- holder", "Key movements can bypass the RPC"; reproduced 2026-09-30 against
-- 53bcef0 on the local stack at 0126 through PostgREST, and pinned RED first by
-- supabase/tests/aal1-definer-boundary.test.ts — 18 of its 23 tests failed at
-- 0126, each for the reason it names; the 5 that passed are the aal2 paths
-- this file must keep working):
--
--   The second factor is mandatory (0059): every table carries a RESTRICTIVE
--   `require_aal2`, and every RPC since 0101 calls mfa_satisfied(). A SECURITY
--   DEFINER function or a definer view runs as its owner, so the tables' aal2
--   policy is not between it and the data. Four did not check:
--   * record_key_movement (0013, 0116): a password-only (aal1) admin, agent or
--     listing manager moved keys and wrote key events into the chain.
--   * next_reference (0001, 0033) checked NOTHING — no auth.uid(), no
--     organisation, no factor: any signed-in session advanced ANY
--     organisation's reference counter, or created one for an arbitrary
--     organisation id.
--   * mandates_safe (0036): its WHERE mirrors mandates_select but not
--     require_aal2, so aal1 read the organisation's mandates (the commission
--     too, for an admin). It stays a definer view on purpose (0100: the
--     listing manager's only read path, masking commission).
--   * org_mfa_status (0028): aal1 listed which colleagues have no factor.
--   And the key tables could be written AROUND the RPC: key_movements_insert
--   (0002, from the retired app-side writer) admitted a direct INSERT by any
--   staff member, and property_keys_insert / _update let an admin or listing
--   manager set the status and holder cache directly — no movement, no event.
--   record_key_movement also dropped a typed holder: a non-STRICT SELECT INTO
--   that finds no profile sets BOTH targets to NULL, so an id that matched no
--   active profile of the organisation erased the name typed beside it.
--
-- THE FIX
--   A. record_key_movement: 0116's body, plus `mfa_satisfied()` first, and the
--      holder resolved into separate locals so the typed name survives an id
--      that matches no active same-organisation profile (an active one still
--      wins, as before).
--   B. next_reference: a caller of the API must hold the second factor and
--      draw its OWN organisation's reference. The service role (the property
--      importer, scripts/import/properties.mts) and direct database sessions
--      are unchanged. Recognised by current_setting('role') — PostgREST's SET
--      ROLE, which a definer body still sees (current_user is the owner there)
--      and which does not depend on the key format (hosted uses sb_secret_
--      keys) — measured 2026-09-30: service_role → 'service_role', a user →
--      'authenticated', a direct session → 'none'.
--   C. org_mfa_status and D. mandates_safe: `(select mfa_satisfied())` in the
--      WHERE — an aal1 session gets no rows, exactly as from the tables.
--   E. key_movements_insert dropped: record_key_movement (a definer) is the
--      only writer, so RLS now refuses a direct INSERT (42501).
--   F. property_keys: a BEFORE INSERT OR UPDATE trigger refuses, for an API
--      user, a key born out of the office or with a holder, and any change of
--      status / current_holder_*. Keyed on current_user: inside
--      record_key_movement (a definer) the statement runs as its owner, so the
--      RPC passes; the service role (imports, fixtures) passes. A trigger, not
--      column grants: a column grant refuses a payload that merely NAMES
--      status (42501) before the (org_id, property_id) key can answer 23503,
--      which would blind 0122's tenant tests to the key they pin.
--
-- NOT CHANGED: every signature, return type, owner and ACL (create or replace
-- keeps them; verify-restore.sql pins them); the anon surface; the identity
-- helpers (current_org_id, current_role_gnk, mfa_satisfied) policies call;
-- rls_bare_auth_calls (0032 / 0100, catalogue lint granted on purpose). The
-- catalogue test in aal1-definer-boundary.test.ts lists each with its reason
-- and fails on the NEXT definer function or view that skips the check.
--
-- Rollback: a forward migration that restores 0116 / 0033 / 0028 / 0036's
-- text, re-creates key_movements_insert and drops the trigger. No data moves.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Preflight: this file restates four live definitions, so each must be the
-- text it was written against (CRs stripped) — a hotfix typed into an SQL
-- editor would otherwise be silently overwritten. Refuse before any DDL.
-- ---------------------------------------------------------------------------
do $$
declare
  v_md5 text;
  v_fn  text;
  v_exp text;
begin
  -- Each entry lists every text the target may legitimately hold. HOSTED's
  -- next_reference is 0033's body WITHOUT its one comment line ("-- was:
  -- format('GNK-%s-%s', …)") — measured 2026-09-30 in the read-only preflight:
  -- md5 55789a1a… on hosted = md5 of 0033's file body with that line removed,
  -- byte for byte; the 2026-08-20 apply went through a path that dropped the
  -- comment. Same statements, so both are accepted; anything else refuses.
  for v_fn, v_exp in values
    ('record_key_movement', '8d9dc7bae614e5808a26feb9e094abc7'),                                    -- 0116
    ('next_reference',      '6b096cb7cac34d174dc48d4f9caab82d,55789a1a1f590c6e736df708f9b7c3e7'),   -- 0033 (file / hosted)
    ('org_mfa_status',      '6c45ca65b132dcc91bb5d3f5587a0f3d')                                     -- 0028
  loop
    select md5(replace(p.prosrc, E'\r', '')) into v_md5
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname = v_fn;
    if v_md5 is null or not (v_md5 = any (string_to_array(v_exp, ','))) then
      raise exception '0127 aborted: % is not the body this file was written against (md5 %, expected %) — nothing was changed. '
                      'Diff the live body against its last migration and decide before applying',
                      v_fn, coalesce(v_md5, 'missing'), v_exp;
    end if;
  end loop;

  select md5(pg_get_viewdef('public.mandates_safe'::regclass)) into v_md5;
  if v_md5 is distinct from '988cd61000a77e749c783ec529567008' then
    raise exception '0127 aborted: mandates_safe is not 0036''s view (viewdef md5 %) — nothing was changed', coalesce(v_md5, 'missing');
  end if;

  if not exists (select 1 from pg_policy where polrelid = 'public.key_movements'::regclass and polname = 'key_movements_insert') then
    raise exception '0127 aborted: key_movements_insert is not there to drop — nothing was changed';
  end if;
  raise notice '0127: preflight passed — the four definitions are 0116 / 0033 / 0028 / 0036''s';
end $$;

-- ---------------------------------------------------------------------------
-- A. record_key_movement
-- ---------------------------------------------------------------------------
create or replace function public.record_key_movement(
  p_key_id uuid,
  p_action key_action,
  p_holder_profile_id uuid default null,
  p_holder_name text default null,
  p_note text default null
) returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_org uuid;
  v_role user_role;
  v_key record;
  v_holder_id uuid;
  v_holder_name text;
  v_profile_id uuid;
  v_profile_name text;
  v_new_status key_status;
  v_cache_holder_id uuid;
  v_cache_holder_name text;
  v_event_type text;
  v_movement_id uuid;
begin
  -- 0127: a definer runs as its owner, so require_aal2 on the key tables is
  -- not between it and them — the second factor is checked here (0059).
  if not (select public.mfa_satisfied()) then
    raise exception 'Second factor required.' using errcode = '42501';
  end if;

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
  -- name, if any, is used instead. 0127: resolved into separate locals — a
  -- non-STRICT SELECT INTO that finds no row NULLs every target, which
  -- erased the typed name too.
  v_holder_id := null;
  v_holder_name := nullif(trim(p_holder_name), '');
  if p_holder_profile_id is not null then
    select id, full_name
      into v_profile_id, v_profile_name
      from profiles
     where id = p_holder_profile_id
       and org_id = v_org
       and is_active;
    if found then
      v_holder_id := v_profile_id;
      v_holder_name := v_profile_name;
    end if;
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
end $function$;

-- ---------------------------------------------------------------------------
-- B. next_reference
-- ---------------------------------------------------------------------------
create or replace function public.next_reference(p_org uuid, p_district_code text)
returns text
language plpgsql
security definer
set search_path = public
as $function$
declare v int;
begin
  -- 0127: a caller of the API holds the second factor and draws its OWN
  -- organisation's reference. The service role (the property importer) and
  -- a direct database session are trusted as before. current_setting('role')
  -- is PostgREST's SET ROLE — still visible in a definer body, where
  -- current_user is the owner.
  if coalesce(current_setting('role', true), 'none') not in ('service_role', 'none') then
    if not (select public.mfa_satisfied()) then
      raise exception 'Second factor required.' using errcode = '42501';
    end if;
    if p_org is null or p_org is distinct from (select public.current_org_id()) then
      raise exception 'You can only number your own organisation''s properties' using errcode = '42501';
    end if;
  end if;

  insert into reference_counters(org_id, district_code, last_value)
       values (p_org, p_district_code, 1)
  on conflict (org_id, district_code)
       do update set last_value = reference_counters.last_value + 1
  returning last_value into v;
  -- was: format('GNK-%s-%s', p_district_code, lpad(v::text, 4, '0'))
  return format('%s%s', p_district_code, lpad(v::text, 4, '0'));
end $function$;

-- ---------------------------------------------------------------------------
-- C. org_mfa_status
-- ---------------------------------------------------------------------------
create or replace function public.org_mfa_status()
returns table(profile_id uuid, has_verified_factor boolean)
language sql
stable
security definer
set search_path = public, auth
as $function$
  select
    p.id,
    exists (
      select 1
        from auth.mfa_factors f
       where f.user_id = p.id
         and f.status = 'verified'
    )
  from profiles p
  where p.org_id = current_org_id()
    and current_role_gnk() = 'admin'
    -- 0127: a definer answers only a second-factor session, as the tables do
    and (select public.mfa_satisfied());
$function$;

-- ---------------------------------------------------------------------------
-- D. mandates_safe — 0036's view, plus the second factor
-- ---------------------------------------------------------------------------
create or replace view public.mandates_safe as
  select id, org_id, property_id, owner_contact_id, type, status,
         start_date, expiry_date, renewal_reminder_days, notes,
         signed_document_id, created_by, created_at, updated_at,
         case when current_role_gnk() = 'admin'
                or exists (select 1 from properties p
                           where p.id = mandates.property_id
                             and p.assigned_agent_id = auth.uid())
              then commission_pct end as commission_pct,
         case when current_role_gnk() = 'admin'
                or exists (select 1 from properties p
                           where p.id = mandates.property_id
                             and p.assigned_agent_id = auth.uid())
              then commission_notes end as commission_notes,
         renewed_from_id
  from mandates
  where org_id = current_org_id()
    and (current_role_gnk() in ('admin','listing_manager')
         or (current_role_gnk() = 'agent'
             and (created_by = auth.uid()
                  or exists (select 1 from properties p
                             where p.id = mandates.property_id
                               and p.assigned_agent_id = auth.uid()))))
    -- 0127: the RESTRICTIVE require_aal2 that mandates_select has and a
    -- definer view does not inherit
    and (select public.mfa_satisfied());

-- ---------------------------------------------------------------------------
-- E. key_movements: the RPC is the only writer
-- ---------------------------------------------------------------------------
drop policy key_movements_insert on public.key_movements;

-- ---------------------------------------------------------------------------
-- F. property_keys: status and holder change only through a movement
-- ---------------------------------------------------------------------------
create function public.property_keys_movement_fields_guard()
returns trigger
language plpgsql
set search_path = public
as $function$
begin
  -- current_user is the statement's role: 'authenticated' for a direct API
  -- write; the owner inside record_key_movement (a definer); 'service_role'
  -- for imports and fixtures. Only the first is refused.
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'in_office'
       or new.current_holder_profile_id is not null
       or new.current_holder_name is not null then
      raise exception 'A key is registered in the office with no holder — record a movement to change that'
        using errcode = '42501';
    end if;
  elsif new.status is distinct from old.status
     or new.current_holder_profile_id is distinct from old.current_holder_profile_id
     or new.current_holder_name is distinct from old.current_holder_name then
    raise exception 'A key''s status and holder change only through a key movement'
      using errcode = '42501';
  end if;
  return new;
end $function$;

revoke execute on function public.property_keys_movement_fields_guard() from public, anon, authenticated;

create trigger property_keys_movement_fields_guard
  before insert or update on public.property_keys
  for each row execute function public.property_keys_movement_fields_guard();

comment on function public.property_keys_movement_fields_guard() is
  '0127: an API user registers a key in the office with no holder and never writes status / current_holder_* directly; '
  'record_key_movement (a definer, so current_user is its owner) and the service role are the writers.';

-- ---------------------------------------------------------------------------
-- Postflight
-- ---------------------------------------------------------------------------
do $$
declare
  v_fn text;
begin
  foreach v_fn in array array['record_key_movement', 'next_reference', 'org_mfa_status'] loop
    if not exists (
      select 1 from pg_proc p
       where p.pronamespace = 'public'::regnamespace and p.proname = v_fn
         and p.prosecdef
         and regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~ 'mfa_satisfied\s*\('
         and has_function_privilege('authenticated', p.oid, 'execute')
         and not has_function_privilege('anon', p.oid, 'execute')
    ) then
      raise exception '0127 postflight: % lost its check, its definer flag or its grants', v_fn;
    end if;
  end loop;
  if pg_get_viewdef('public.mandates_safe'::regclass) !~ 'mfa_satisfied\(' then
    raise exception '0127 postflight: mandates_safe has no second-factor predicate';
  end if;
  if not has_table_privilege('authenticated', 'public.mandates_safe', 'select')
     or has_table_privilege('anon', 'public.mandates_safe', 'select') then
    raise exception '0127 postflight: mandates_safe grants changed';
  end if;
  if exists (select 1 from pg_policy where polrelid = 'public.key_movements'::regclass and polcmd = 'a') then
    raise exception '0127 postflight: key_movements still has an INSERT policy';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.property_keys'::regclass
                  and tgname = 'property_keys_movement_fields_guard' and tgenabled = 'O') then
    raise exception '0127 postflight: the property_keys guard trigger is missing or disabled';
  end if;
  raise notice '0127: postflight passed';
end $$;
