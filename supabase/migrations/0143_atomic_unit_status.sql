-- =============================================================================
-- 0143 — a unit's status change commits WITH its audit lines: set_unit_status
--
-- THE DEFECT (operator-supplied finding against 60ac223, reproduced 2026-10-08
-- on an isolated local stack through the REAL server action and PostgREST —
-- supabase/tests/unit-status-actions.test.ts, 8 of 9 RED; DECISIONS
-- T-unit-status-atomic has the evidence):
--
--   * updateUnitStatus PATCHed properties.status and only after that request
--     had committed wrote `status_changed` — and, for an admin's move back to
--     market, `status_regression_override` — each as a request of its own. A
--     refused line kept the new status with no line (the action threw); an
--     answer lost after the PATCH committed was reported as an error and no
--     line was ever written;
--   * the retry then read the new status, wrote nothing and answered success:
--     the missing lines — and the listing_status_check the change should have
--     closed — stayed missing for good;
--   * the admin-only regression gate and the line's `from` came from a read
--     taken BEFORE the write, and the write had no condition on the old
--     status: a listing manager's change landing after an admin's sale moved
--     the sold unit back with no override line, recorded as `from: available`;
--     a double submit wrote two lines.
--
-- THE FIX — ONE function, SECURITY INVOKER, called by the action:
--
--   set_unit_status(unit, status, expected, operation) — in order, all in the
--   caller's transaction:
--      1. the caller from the session (auth.uid, aal2, active, organisation,
--         role) — admin or listing manager, before any row is read (the units
--         grid's own rule: properties_update alone also admits an agent on the
--         units assigned to them, who keeps the property's Details form);
--      2. the operation id, BEFORE any lock: a committed submission is
--         answered from its own `status_changed` line (`replayed` — the change
--         it committed), and the same id asking for anything else is refused.
--         A retry sent to check an unconfirmed change must not queue behind
--         the unit's lock and time out as "nothing was changed";
--      3. the unit — kind unit, the caller's organisation — read as the
--         caller SEES it, then locked FOR NO KEY UPDATE. A locking read also
--         applies the UPDATE policy: a unit seen but not lockable is refused
--         in words rather than reported missing;
--      4. the caller re-read under that lock (0118's step 4b), and the
--         operation id AGAIN: a double submit's twin that held the lock first
--         has committed by now, and is answered `replayed`;
--      5. the transition decided from the LOCKED row: already in the asked
--         status → `unchanged`, nothing written; moved since the page showed
--         it (≠ expected) → refused, nothing written; leaving sold or rented
--         (isStatusRegression, lib/validators/properties.ts) → admin only;
--      6. ONE UPDATE of status (row_count must be 1), then the
--         `status_changed` line {reference, from, to, operation_id} and, for a
--         regression, the `status_regression_override` line {from, to} — in
--         that order, each row count checked.
--   Any refusal raises: nothing is kept. The caller gets one jsonb answer:
--   `applied`, `replayed` (the original change) or `unchanged`.
--
-- THE OPERATION ID LIVES ON THE LINE (no operation table, unlike 0142): a
-- status change has a natural record — its own `status_changed` line, on ONE
-- unit. The unit's row lock serialises every change of that unit, so the
-- lookup made under it is decisive without a unique key; events_select shows
-- every user the lines they wrote, and the lookup asks only for the caller's
-- own (actor = auth.uid()); events_entity_idx (org, entity_type, entity_id,
-- occurred_at) serves it. Readers of the line (sales velocity, the timeline)
-- read `to` / `from` only; the extra key is ignored by both.
--
-- WHY INVOKER: every row the function writes the caller could write through
-- PostgREST under the same policies — properties_update, events_insert
-- (actor = auth.uid(), occurred_at = now()), require_aal2 on each — so the
-- database keeps enforcing all of them, statement by statement. The explicit
-- checks add the words, the role rule and the regression rule; they grant
-- nothing.
--
-- BOUNDED WAITS: `lock_timeout = 3s` — a change that cannot get the unit
-- answers 55P03 (nothing written, "try again") instead of running into the
-- 8 s statement timeout of `authenticated`, whose 57014 the app must treat as
-- an unknown outcome.
--
-- NOT HERE — THE FOLLOW-UP STAYS AFTER THE COMMIT, IN THE ACTION: closing the
-- listing_status_check a won deal raised. tasks_update admits only admins and
-- the task's assignee, so the closure runs as the system (followup-tasks.ts)
-- and cannot join this transaction without a definer. The action runs it on
-- `applied` AND on `replayed` — on a replay only while the unit still holds
-- the change's status — so the same press finishes a follow-up that failed,
-- and says so when it did not.
--
-- CONTRACT. New function; the app calls it from updateUnitStatus
-- (lib/actions/units.ts). Nothing the deployed app calls changes. No
-- release-compat entry (no existing signature or return shape changes).
-- database.types.ts regenerated.
--
-- VISIBLE CHANGES FOR A DIRECT POSTGREST CALLER: a new function, executable
-- by authenticated. Who may write units or events is unchanged — a direct
-- PATCH of properties.status is still possible for those properties_update
-- admits, and writes no line, as before (BACKLOG).
--
-- LOCKS (this file): none beyond the function's creation.
-- LOCKS (each call): the unit FOR NO KEY UPDATE, then — from the first audit
-- line — the organisation's events-chain advisory lock (0108) until COMMIT.
-- No row is written before the row lock is held. One row only, so no lock
-- order with 0141's or 0142's multi-unit locks can cycle; 40P01 is still
-- answered "nothing changed, try again".
--
-- DEPLOY ORDER: additive — hosted 0143 first, then merge. The deployed app
-- (PATCH + separate lines) keeps working against it unchanged.
--
-- EXISTING ROWS — READ-ONLY DIAGNOSTIC, NO REPAIR (the file's last row): units
-- whose current status no line records. A line the old path failed to write
-- cannot be written now — it would be a record made after the fact, under an
-- actor and a time it never had; nothing is fabricated.
--
-- ROLLBACK, a forward migration in ONE transaction, ONLY after the app is back
-- on a release that does not call the function: drop set_unit_status
-- (supabase/tests/revert-0143.ts is that SQL). Rolling the DATABASE back first
-- fails closed: the new action gets PGRST202 and says nothing was changed.
--
-- NUMBERING: 0140 is claimed by the unmerged branch fix/dashboard-won-value.
--
-- Pins that move with this file: scripts/backup/verify-restore.sql (the
-- migrations count, a grants row, the 0143 INTEGRITY row);
-- lib/supabase/database.types.ts.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3), as does one
-- execute_sql call. The file's LAST result is a read-only summary.
-- =============================================================================

set local lock_timeout = '5s';

do $$
begin
  if current_setting('lock_timeout') <> '5s' then
    raise exception '0143 aborted: this file must run as ONE transaction (SET LOCAL lock_timeout did not take effect) — nothing was changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Preflight: the name is free, and what the function counts on is in place
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
              where ns.nspname = 'public' and p.proname = 'set_unit_status') then
    raise exception '0143 aborted: a function named set_unit_status already exists — nothing was changed';
  end if;
  if (select array_agg(e.enumlabel::text order by e.enumsortorder) from pg_enum e
       where e.enumtypid = 'public.property_status'::regtype)
     is distinct from array['draft', 'available', 'reserved', 'under_offer', 'sold', 'rented', 'withdrawn'] then
    raise exception '0143 aborted: property_status is not the seven statuses PROPERTY_STATUSES lists — nothing was changed';
  end if;
  if to_regclass('public.events_entity_idx') is null then
    raise exception '0143 aborted: events_entity_idx (0063) is missing — the operation lookup would scan every event — nothing was changed';
  end if;
  -- nothing in the database writes a status line or guards a status: the
  -- function's lines must be the only ones a change through it produces
  if exists (select 1 from pg_trigger t
              where t.tgrelid = 'public.properties'::regclass and not t.tgisinternal
                and t.tgname not in ('properties_updated', 'properties_price_history', 'properties_reference_immutable',
                                     'properties_pk_immutable', 'properties_id_without_history')) then
    raise exception '0143 aborted: properties carries a trigger this file does not know — nothing was changed';
  end if;
  -- a session may still write both lines: were either type reserved (0128 /
  -- 0131 / 0134 / 0138 style), every call would fail 42501 at run time
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'events' and policyname = 'events_insert'
                    and with_check ~ 'actor_id = \( SELECT auth\.uid\(\)')
     or exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'events' and policyname = 'events_insert'
                   and with_check ~ '(status_changed|status_regression_override)') then
    raise exception '0143 aborted: events_insert no longer admits a session''s status_changed / status_regression_override lines — nothing was changed';
  end if;
  raise notice '0143: preflight passed — name free, statuses, triggers and events_insert as expected';
end $$;

-- ---------------------------------------------------------------------------
-- set_unit_status
-- ---------------------------------------------------------------------------
create function public.set_unit_status(
  p_unit_id      uuid,
  p_status       text,
  p_expected     text,
  p_operation_id uuid
)
returns jsonb
language plpgsql
security invoker
-- pg_temp LAST: unlisted, it is searched FIRST for relations and types
set search_path = public, pg_temp
-- a change that cannot get its row answers 55P03 (nothing written), well
-- inside the 8 s statement timeout of `authenticated`
set lock_timeout = '3s'
as $$
declare
  v_uid      uuid := auth.uid();
  v_org      uuid;
  v_role     user_role;
  v_statuses constant text[] := enum_range(null::property_status)::text[];
  v_to       property_status;
  v_expected property_status;
  v_prior    record;
  v_unit     record;
  v_now      record;
  v_regress  boolean;
  v_vis      visibility_level;
  v_rows     int;
begin
  -- 1. who is asking — from the session, never from a parameter
  if v_uid is null then
    raise exception 'Not authenticated.';
  end if;
  if not (select public.mfa_satisfied()) then
    raise exception 'Second factor required.';
  end if;
  v_org  := (select public.current_org_id());
  v_role := (select public.current_role_gnk());
  if v_org is null then
    raise exception 'Account deactivated.';
  end if;

  -- what is being asked — every test written so that NULL refuses (PostgREST
  -- passes an explicit JSON null through)
  if p_unit_id is null then
    raise exception 'Unit not found';
  end if;
  if p_status is null or not (p_status = any (v_statuses)) then
    raise exception 'Invalid status: %', coalesce(p_status, 'none');
  end if;
  if p_expected is null or not (p_expected = any (v_statuses)) or p_operation_id is null then
    raise exception 'This page is out of date — reload it and try again.';
  end if;
  v_to       := p_status::property_status;
  v_expected := p_expected::property_status;

  -- may this person manage units at all — before any row is read, so the
  -- answer cannot depend on (and so cannot reveal) whether an id exists
  if v_role is null or v_role not in ('admin', 'listing_manager') then
    raise exception 'Only admins and listing managers manage units.';
  end if;

  -- 2. has this submission already committed? Its own line says so. Asked
  --    BEFORE the lock: a retry checking an unconfirmed change must not wait
  --    behind the unit's lock (step 4 asks again under it, for a twin in flight)
  select e.payload, e.occurred_at
    into v_prior
    from public.events e
   where e.org_id = v_org
     and e.entity_type = 'property'
     and e.entity_id = p_unit_id
     and e.event_type = 'status_changed'
     and e.actor_id = v_uid
     and e.payload ->> 'operation_id' = p_operation_id::text
   limit 1;

  if not found then
    -- 3. the unit, as the caller sees it — then held
    perform 1
       from public.properties p
      where p.id = p_unit_id
        and p.org_id = v_org
        and p.kind = 'unit';
    if not found then
      raise exception 'Unit not found';
    end if;
    select p.id, p.parent_id, p.reference, p.status, p.visibility
      into v_unit
      from public.properties p
     where p.id = p_unit_id
       and p.org_id = v_org
       and p.kind = 'unit'
       for no key update;
    if not found then
      raise exception 'Status not changed — only admins and listing managers manage units.';
    end if;

    -- 4. the caller, read AGAIN now that the row is held (0118's step 4b)
    if not (select public.mfa_satisfied()) then
      raise exception 'Second factor required.';
    end if;
    v_org  := (select public.current_org_id());
    v_role := (select public.current_role_gnk());
    if v_org is null then
      raise exception 'Account deactivated.';
    end if;
    if v_role is null or v_role not in ('admin', 'listing_manager') then
      raise exception 'Only admins and listing managers manage units.';
    end if;

    --    and the submission AGAIN, under the lock: a twin of this one (a
    --    double submit) that held the lock first has committed by now
    select e.payload, e.occurred_at
      into v_prior
      from public.events e
     where e.org_id = v_org
       and e.entity_type = 'property'
       and e.entity_id = v_unit.id
       and e.event_type = 'status_changed'
       and e.actor_id = v_uid
       and e.payload ->> 'operation_id' = p_operation_id::text
     limit 1;

    if not found then
      -- 5. the transition, decided from the LOCKED row
      if v_unit.status = v_to then
        -- already what was asked: nothing to write, nothing to record
        return jsonb_build_object(
          'result',     'unchanged',
          'unit_id',    v_unit.id,
          'parent_id',  v_unit.parent_id,
          'reference',  v_unit.reference,
          'visibility', v_unit.visibility,
          'status',     v_unit.status);
      end if;
      if v_unit.status <> v_expected then
        raise exception 'This unit is now % — it changed after this page was loaded. Nothing was changed; reload the page and try again.',
          replace(v_unit.status::text, '_', ' ');
      end if;
      -- DB-01: sold/rented assert a closed transaction; leaving one is admin-only
      v_regress := v_unit.status in ('sold', 'rented') and v_to not in ('sold', 'rented');
      if v_regress and v_role <> 'admin' then
        raise exception 'Only an admin can move a sold or rented unit back to market.';
      end if;

      -- 6. ONE statement for the status, then its lines — or nothing at all
      update public.properties p
         set status = v_to
       where p.id = v_unit.id
         and p.org_id = v_org
         and p.kind = 'unit'
      returning p.visibility into v_vis;
      get diagnostics v_rows = row_count;
      if v_rows <> 1 then
        raise exception 'Status not changed — nothing was written.';
      end if;

      insert into public.events (org_id, actor_id, entity_type, entity_id, event_type, payload)
      values (v_org, v_uid, 'property', v_unit.id, 'status_changed',
              jsonb_build_object(
                'reference',    v_unit.reference,
                'from',         v_unit.status,
                'to',           v_to,
                'operation_id', p_operation_id));
      get diagnostics v_rows = row_count;
      if v_rows <> 1 then
        raise exception 'The timeline was not written — nothing was changed.';
      end if;

      -- the regression's own line, so "who put a sold unit back on the
      -- market" is one query (the details form writes the same pair)
      if v_regress then
        insert into public.events (org_id, actor_id, entity_type, entity_id, event_type, payload)
        values (v_org, v_uid, 'property', v_unit.id, 'status_regression_override',
                jsonb_build_object('from', v_unit.status, 'to', v_to));
        get diagnostics v_rows = row_count;
        if v_rows <> 1 then
          raise exception 'The timeline was not written — nothing was changed.';
        end if;
      end if;

      return jsonb_build_object(
        'result',       'applied',
        'operation_id', p_operation_id,
        'unit_id',      v_unit.id,
        'parent_id',    v_unit.parent_id,
        'reference',    v_unit.reference,
        'visibility',   v_vis,
        'status',       v_to,
        'from',         v_unit.status,
        'to',           v_to,
        'regression',   v_regress,
        'changed_at',   now(),
        'org_id',       v_org,
        'actor_id',     v_uid);
    end if;
  end if;

  -- a committed submission: answer what it committed, if this is the same ask
  if v_prior.payload ->> 'to' is distinct from p_status
     or v_prior.payload ->> 'from' is distinct from p_expected then
    raise exception 'This change was already used for a different status — reload the page and try again.';
  end if;
  select p.id, p.parent_id, p.reference, p.status, p.visibility
    into v_now
    from public.properties p
   where p.id = p_unit_id
     and p.org_id = v_org;
  if not found then
    raise exception 'Unit not found';
  end if;
  return jsonb_build_object(
    'result',       'replayed',
    'operation_id', p_operation_id,
    'unit_id',      v_now.id,
    'parent_id',    v_now.parent_id,
    'reference',    v_now.reference,
    'visibility',   v_now.visibility,
    'status',       v_now.status,
    'from',         v_prior.payload ->> 'from',
    'to',           v_prior.payload ->> 'to',
    'regression',   (v_prior.payload ->> 'from') in ('sold', 'rented') and (v_prior.payload ->> 'to') not in ('sold', 'rented'),
    'changed_at',   v_prior.occurred_at,
    'org_id',       v_org,
    'actor_id',     v_uid);
end $$;

revoke execute on function public.set_unit_status(uuid, text, text, uuid) from public, anon, service_role;
grant  execute on function public.set_unit_status(uuid, text, text, uuid) to authenticated;

comment on function public.set_unit_status(uuid, text, text, uuid) is
  'Changes one unit''s status in ONE transaction with its audit lines (0143): the unit FOR NO KEY UPDATE, the transition decided from '
  'the locked row (expected status, admin-only regression), one UPDATE, the status_changed line {reference, from, to, operation_id} and, '
  'for a regression, status_regression_override {from, to}. p_operation_id makes a retry answer {result: replayed}; a unit already in '
  'the asked status answers {result: unchanged}. SECURITY INVOKER: every policy holds.';

-- ---------------------------------------------------------------------------
-- Postflight. The behaviour needs sessions and is proven by
-- supabase/tests/unit-status-actions.test.ts; here the shape.
-- ---------------------------------------------------------------------------
do $$
declare
  n   int;
  src text;
  sig constant text := 'public.set_unit_status(uuid,text,text,uuid)';
begin
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'set_unit_status';
  if n <> 1 then raise exception '0143 postflight: expected one set_unit_status, found %', n; end if;

  select p.prosrc into src from pg_proc p
   where p.oid = to_regprocedure(sig)
     and not p.prosecdef
     and pg_get_userbyid(p.proowner) = 'postgres'
     and p.proconfig @> array['search_path=public, pg_temp', 'lock_timeout=3s']
     and cardinality(p.proconfig) = 2
     and p.prorettype = 'jsonb'::regtype
     and pg_get_function_identity_arguments(p.oid)
         = 'p_unit_id uuid, p_status text, p_expected text, p_operation_id uuid';
  if src is null then
    raise exception '0143 postflight: set_unit_status lost its signature, jsonb return, SECURITY INVOKER, owner, search_path or lock_timeout';
  end if;
  -- read the CODE: block and line comments stripped
  src := regexp_replace(src, '/\*.*?\*/', '', 'g');
  src := regexp_replace(src, '--[^\n]*', '', 'g');
  if src !~ 'p\.kind = ''unit''\s+for no key update;' then
    raise exception '0143 postflight: the unit is no longer locked FOR NO KEY UPDATE before the transition is decided';
  end if;
  if (select count(*) from regexp_matches(src, 'mfa_satisfied\(\)', 'g')) < 2
     or (select count(*) from regexp_matches(src, 'current_org_id\(\)', 'g')) < 2
     or (select count(*) from regexp_matches(src, 'current_role_gnk\(\)', 'g')) < 2 then
    raise exception '0143 postflight: the caller is no longer read before the lock AND again under it';
  end if;
  -- the submission looked up before the lock and again under it
  if (select count(*) from regexp_matches(src, 'e\.payload ->> ''operation_id'' = p_operation_id::text', 'g')) <> 2
     or strpos(src, 'e.payload ->> ''operation_id''') > strpos(src, 'for no key update;') then
    raise exception '0143 postflight: the operation id is no longer answered before the lock and again under it';
  end if;
  -- the transition is decided from the locked row
  if src !~ 'if v_unit\.status <> v_expected then\s+raise exception'
     or src !~ 'if v_regress and v_role <> ''admin'' then\s+raise exception' then
    raise exception '0143 postflight: the expected status or the admin-only regression is no longer checked against the locked row';
  end if;
  -- the write and both lines, each row count checked
  if (select count(*) from regexp_matches(src, 'get diagnostics v_rows = row_count;\s+if v_rows <> 1 then\s+raise exception', 'g')) <> 3 then
    raise exception '0143 postflight: the status write''s or a line''s row count is no longer checked';
  end if;
  if (select count(*) from regexp_matches(src, 'insert\s+into\s+(public\.)?events\y', 'gi')) <> 2 then
    raise exception '0143 postflight: expected exactly two event inserts (status_changed, status_regression_override)';
  end if;

  if has_function_privilege('anon', sig, 'execute')
     or has_function_privilege('service_role', sig, 'execute')
     or not has_function_privilege('authenticated', sig, 'execute') then
    raise exception '0143 postflight: set_unit_status grants are wrong';
  end if;

  -- without a session it refuses before it reads anything
  begin
    perform public.set_unit_status(gen_random_uuid(), 'sold', 'available', gen_random_uuid());
    raise exception '0143 postflight: set_unit_status ran without a session';
  exception
    when raise_exception then
      if sqlerrm <> 'Not authenticated.' then raise; end if;
  end;

  raise notice '0143: postflight passed — set_unit_status is SECURITY INVOKER (authenticated only)';
end $$;

-- the file's LAST result: units whose current status no line records —
-- counted, not repaired (a line written now would be a record made after the
-- fact). draft and available are where a unit starts; any other status was
-- set by the grid (status_changed) or the Details form (updated), or arrived
-- with an import (imported) — unless a line went missing. AN UPPER BOUND, not
-- proof of a lost line: a row written straight into the table (a fixture, a
-- maintenance script) is counted too.
select '0143' as migration,
       (select count(*) from public.properties u
         where u.kind = 'unit'
           and u.status not in ('draft', 'available')
           and not exists (
             select 1 from public.events e
              where e.org_id = u.org_id and e.entity_type = 'property' and e.entity_id = u.id
                and ((e.event_type = 'status_changed' and e.payload ->> 'to' = u.status::text)
                  or (e.event_type = 'updated' and e.payload -> 'changed' -> 'status' ->> 'to' = u.status::text)
                  or e.event_type = 'imported'))) as units_status_unrecorded;
