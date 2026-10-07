-- =============================================================================
-- 0142 — applying a unit type commits as ONE transaction: apply_unit_type
--
-- THE DEFECT (operator-supplied finding, reproduced 2026-10-07 against
-- b375c2b on an isolated local stack, through the REAL server action and
-- PostgREST — supabase/tests/unit-type-apply-actions.test.ts, 15 of 23 RED;
-- DECISIONS T-unit-type-apply-atomic has the evidence):
--
--   * applyUnitType read the template and the units, then PATCHed one unit per
--     request and only then wrote the `updated` audit lines with logEvents. A
--     refusal on a later unit kept the earlier units stamped and repriced
--     (their trg_price_history rows and `price_changed` lines included) with
--     NO unit-type line; a refused audit write kept every unit stamped while
--     the action THREW;
--   * a type with no €/m² rate wrote back the price JavaScript had read
--     earlier: a price edited in between (committed mid-flight, or holding the
--     row when the PATCH arrived) was overwritten with the older value;
--   * nothing checked the caller's role: properties_update lets an agent edit
--     the units assigned to them, so an agent's direct call stamped — and
--     repriced — those units, reported as success;
--   * a row the database silently skipped (0 rows, no error) was left out and
--     the rest reported as the scope applied;
--   * a retry — a double submit, or a press after a lost answer — applied the
--     stamp again (a second set of audit lines);
--   * the price was computed in floating point: 64.35 m² × €1000 = €64.350
--     stamped €64.300 (the €100 rule rounds a half up).
--
-- THE FIX — ONE function, SECURITY INVOKER, called by the action:
--
-- A. unit_type_applications — the operation record. One row per committed
--    application: (org, operation id) is its primary key, so a retry of a
--    committed submission answers what it committed and changes nothing, and
--    the same id with other inputs or from another user is refused. Applying a
--    type has no natural row to carry the id (0141's version row, 0096's lead):
--    the audit lines are partitioned events (no unique key without
--    occurred_at) and a listing manager reads only the events they wrote — a
--    reuse of an admin's id would go unseen. Select and insert only, for the
--    organisation's admins and listing managers; no update, no delete.
--
-- B. apply_unit_type(project, type, operation, [block]) — in order, all in the
--    caller's transaction:
--      1. the caller from the session (auth.uid, aal2, active, organisation,
--         role) — admin or listing manager, before any row is read;
--     1b. the operation id, BEFORE any lock: a committed submission is
--         answered at once (replay or refuse, as in A). A retry sent to check
--         an unconfirmed stamp must not queue behind the project's lock and
--         time out as "nothing was changed" when its original committed;
--      2. the container (project or phase of the caller's organisation) locked
--         FOR NO KEY UPDATE — every stamp and every 0141 reprice of it queues
--         here, so two stamps never interleave. NOT FOR UPDATE: that also
--         blocks the KEY SHARE every foreign-key check onto the container
--         takes, and the nightly sweeps take the events-chain lock before such
--         an insert (0117's and 0141's lesson);
--      3. the caller re-read under that lock (0118's step 4b);
--      4. the operation id AGAIN, under the lock: a double submit's twin that
--         queued here behind its original is answered `replayed`;
--      5. the template — of THIS container and organisation — locked FOR SHARE,
--         so the stamp copies one version of it;
--      6. the target set: every DIRECT unit of the container in the block (or
--         all), archived ones included — the scope the action has always had —
--         read as the caller SEES it, then locked FOR NO KEY UPDATE in id
--         order. A price edit, a move or an archive of any of them waits for
--         this transaction or committed before it and is read here (the lock
--         re-reads the row). The two sets must be the same: a locking read
--         also applies the UPDATE policy, so a unit the caller sees but may
--         not update would drop out of the locked set silently — and with it
--         out of every count below;
--      7. ONE UPDATE: beds, baths, covered area and veranda copied (a blank
--         field clears — a stamp, not a merge); the price set ONLY when the
--         type can say it — round(covered × rate, −2), exact numeric, a half
--         up, veranda never priced — and otherwise left as the LOCKED row holds
--         it (`asking_price = coalesce(v_price, u.asking_price)`: nothing read
--         earlier is written back). row_count must equal the target set: a row
--         a trigger skipped refuses the whole stamp;
--      8. the canonical price trail counted, not written: trg_price_history
--         (0005) must have written one price_history row and one
--         `price_changed` line per unit whose price actually moved, in THIS
--         transaction (every row of it carries now());
--      9. one `updated` line per stamped unit — the action's payload, plus the
--         operation id — and the operation record (A).
--    Any refusal raises: nothing is kept. The caller gets one jsonb answer:
--    `applied` or `replayed` (the original counts).
--
-- WHY INVOKER: every row the function writes the caller could write through
-- PostgREST under the same policies — properties_update, events_insert,
-- unit_type_applications_insert, require_aal2 on each — so the database keeps
-- enforcing all of them, statement by statement. The explicit checks add the
-- words and the role rule (properties_update alone admits an assigned agent);
-- they grant nothing. trg_price_history stays the ONE writer of per-unit
-- history and `price_changed`.
--
-- BOUNDED WAITS: the function carries `lock_timeout = 3s` — a stamp that
-- cannot get its rows answers 55P03 (nothing written, "try again") instead of
-- running into the 8 s statement timeout of `authenticated`, whose 57014 the
-- app must treat as an unknown outcome.
--
-- CONTRACT. New function and table; the app calls it from applyUnitType
-- (lib/actions/units.ts). Nothing the deployed app calls changes. No
-- release-compat entry (no existing signature or return shape changes).
-- database.types.ts regenerated.
--
-- VISIBLE CHANGES FOR A DIRECT POSTGREST CALLER: a new table, readable and
-- insertable by the organisation's admins and listing managers (aal2).
--
-- LOCKS (this file): the new table only; SHARE ROW EXCLUSIVE on properties for
-- the composite foreign key's creation — milliseconds, writers of properties
-- wait. lock_timeout 5 s; a 55P03 keeps nothing — apply again. ONE
-- transaction (checked below).
-- LOCKS (each call): the container FOR NO KEY UPDATE, the template FOR SHARE,
-- the target units FOR NO KEY UPDATE in id order, then — from the first
-- trigger or audit line — the organisation's events-chain advisory lock (0108)
-- until COMMIT. No row is written before every row lock is held. The same
-- accepted deadlock as 0141: a writer that updates several of these units in
-- ANOTHER order in one statement (the inherited-field sync) — PostgreSQL
-- aborts one side (40P01), nothing of it is kept, the action asks for a retry.
--
-- DEPLOY ORDER: additive — hosted 0142 first, then merge. The deployed app
-- (direct PATCHes) keeps working against it unchanged.
--
-- EXISTING ROWS — READ-ONLY DIAGNOSTIC, NO REPAIR (the file's last row): the
-- unit-type lines the old path wrote. A partial stamp left no line at all, so
-- it cannot be counted from the trail; nothing is repaired.
--
-- NOT CHANGED: trg_price_history; who may read or write units, unit types or
-- events (a direct PostgREST caller may still PATCH units as before); the
-- scope (direct units, archived included); payment plans; price lists.
--
-- NOT DONE HERE (BACKLOG): the bulk price-drop alert a reprice raises is not
-- raised by a stamp that lowers prices (it never was); the stamp does not
-- refresh the container's quality score or the units' own pages (it never
-- did); unit_types.project_id is still a single-column key (an existing
-- entry).
--
-- ROLLBACK, a forward migration in ONE transaction, ONLY after the app is back
-- on a release that does not call the function: drop apply_unit_type and
-- unit_type_applications (supabase/tests/revert-0142.ts is that SQL). Rolling
-- the DATABASE back first fails closed: the new action gets PGRST202 and says
-- nothing was changed.
--
-- NUMBERING: 0140 is claimed by the unmerged branch fix/dashboard-won-value.
--
-- Pins that move with this file: scripts/backup/verify-restore.sql (the
-- migrations count, a grants row, the 0142 INTEGRITY rows);
-- scripts/backup/export.mjs (TABLES); lib/supabase/database.types.ts;
-- docs/04's policy rows.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3), as does one
-- execute_sql call. The file's LAST result is a read-only summary.
-- =============================================================================

set local lock_timeout = '5s';

do $$
begin
  if current_setting('lock_timeout') <> '5s' then
    raise exception '0142 aborted: this file must run as ONE transaction (SET LOCAL lock_timeout did not take effect) — nothing was changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Preflight: the names are free, and what the function counts on is in place
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
              where ns.nspname = 'public' and p.proname = 'apply_unit_type') then
    raise exception '0142 aborted: a function named apply_unit_type already exists — nothing was changed';
  end if;
  if to_regclass('public.unit_type_applications') is not null then
    raise exception '0142 aborted: unit_type_applications already exists — nothing was changed';
  end if;
  if not exists (
    select 1 from pg_trigger t
     where t.tgrelid = 'public.properties'::regclass and t.tgname = 'properties_price_history'
       and t.tgfoid = 'public.trg_price_history()'::regprocedure and t.tgenabled = 'O' and not t.tgisinternal
       and (t.tgtype & 1) = 1      -- FOR EACH ROW
       and (t.tgtype & 2) = 0      -- AFTER
       and (t.tgtype & 16) = 16    -- UPDATE
  ) then
    raise exception '0142 aborted: properties_price_history is not the enabled AFTER UPDATE row trigger 0005 attached — nothing was changed';
  end if;
  if not exists (select 1 from pg_constraint c
                  where c.conrelid = 'public.properties'::regclass and c.conname = 'properties_org_id_id_key'
                    and c.contype = 'u') then
    raise exception '0142 aborted: properties_org_id_id_key (0088) is missing — nothing was changed';
  end if;
  raise notice '0142: preflight passed — names free, trg_price_history attached';
end $$;

-- ---------------------------------------------------------------------------
-- A. the operation record
-- ---------------------------------------------------------------------------
create table public.unit_type_applications (
  org_id        uuid        not null references public.organizations(id),
  operation_id  uuid        not null,
  project_id    uuid        not null,
  unit_type_id  uuid        not null,
  block         text,
  request       text        not null check (request ~ '^[0-9a-f]{32}$'),
  units         int         not null check (units > 0),
  price_changed int         not null check (price_changed >= 0 and price_changed <= units),
  created_by    uuid        not null,
  created_at    timestamptz not null default now(),
  primary key (org_id, operation_id),
  -- the project is the organisation's own (the composite key, 0088's idiom);
  -- the record goes with it. The type is recorded by id, not keyed: a type
  -- deleted later leaves its applications on record.
  constraint unit_type_applications_project_fkey
    foreign key (org_id, project_id) references public.properties (org_id, id) on delete cascade
);

create index unit_type_applications_project_idx on public.unit_type_applications (project_id);

comment on table public.unit_type_applications is
  'One row per committed application of a unit type (0142, apply_unit_type): the operation id a form minted, the request''s md5, '
  'who applied it and the counts its answer repeats. A retry of the same id answers this row instead of applying again. '
  'Select and insert only (admins and listing managers, aal2); never updated or deleted by a session.';

alter table public.unit_type_applications enable row level security;

-- hosted's default privileges hand new tables to anon / authenticated /
-- service_role; the local CLI's do not — state the grants either way. The
-- backup export (scripts/backup/export.mjs) reads every table as service_role:
-- it may read this one, nothing more.
revoke all on public.unit_type_applications from public, anon, authenticated, service_role;
grant select, insert on public.unit_type_applications to authenticated;
grant select on public.unit_type_applications to service_role;

create policy unit_type_applications_select on public.unit_type_applications for select
  using (org_id = (select public.current_org_id())
         and (select public.current_role_gnk()) in ('admin', 'listing_manager'));
create policy unit_type_applications_insert on public.unit_type_applications for insert
  with check (org_id = (select public.current_org_id())
              and created_by = (select auth.uid())
              and (select public.current_role_gnk()) in ('admin', 'listing_manager'));

create policy require_aal2 on public.unit_type_applications
  as restrictive for all to authenticated
  using ((select public.mfa_satisfied()))
  with check ((select public.mfa_satisfied()));

-- ---------------------------------------------------------------------------
-- B. apply_unit_type
-- ---------------------------------------------------------------------------
create function public.apply_unit_type(
  p_project_id   uuid,
  p_unit_type_id uuid,
  p_operation_id uuid,
  p_block        text default null
)
returns jsonb
language plpgsql
security invoker
-- pg_temp LAST: unlisted, it is searched FIRST for relations and types
set search_path = public, pg_temp
-- a stamp that cannot get its rows answers 55P03 (nothing written), well
-- inside the 8 s statement timeout of `authenticated`
set lock_timeout = '3s'
as $$
declare
  v_uid        uuid := auth.uid();
  v_org        uuid;
  v_role       user_role;
  v_block      text;
  v_request    text;
  v_project    record;
  v_prior      record;
  v_type       record;
  v_price      numeric;
  v_seen       uuid[];
  v_ids        uuid[];
  v_scope      int;
  v_moves      int;
  v_rows       int;
  v_lines      int;
  v_constraint text;
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
  if p_project_id is null then
    raise exception 'Project not found';
  end if;
  if p_unit_type_id is null then
    raise exception 'Type not found on this project';
  end if;
  if p_operation_id is null then
    raise exception 'This form is out of date — reload the page and try again.';
  end if;
  v_block := nullif(p_block, '');
  if v_block is not null and char_length(v_block) > 20 then
    raise exception 'No units in that scope';
  end if;

  -- the request, canonical: what a reused operation id must match
  v_request := md5(jsonb_build_object(
    'project', p_project_id,
    'type',    p_unit_type_id,
    'block',   v_block)::text);

  -- 2. may this person manage units at all — before any row is read, so the
  --    answer cannot depend on (and so cannot reveal) whether an id exists
  if v_role is null or v_role not in ('admin', 'listing_manager') then
    raise exception 'Only admins and listing managers manage units.';
  end if;

  -- 2b. has this submission already committed? Answer it BEFORE any lock: a
  --     retry checking an unconfirmed stamp must not wait behind the
  --     project's lock and time out as "nothing was changed" (step 4 asks
  --     again under the lock, for a twin still in flight)
  select a.project_id, a.created_by, a.request, a.units, a.price_changed
    into v_prior
    from public.unit_type_applications a
   where a.org_id = v_org and a.operation_id = p_operation_id;
  if found then
    if v_prior.project_id is distinct from p_project_id
       or v_prior.created_by is distinct from v_uid
       or v_prior.request is distinct from v_request then
      raise exception 'This submission was already used for a different change — reload the page and try again.';
    end if;
    return jsonb_build_object(
      'result',        'replayed',
      'operation_id',  p_operation_id,
      'project_id',    p_project_id,
      'units',         v_prior.units,
      'price_changed', v_prior.price_changed);
  end if;

  -- 3. the container, locked: every stamp and reprice of it queues here —
  --    NO KEY, so a foreign-key check onto it never waits on this call
  select p.id, p.org_id, p.reference
    into v_project
    from public.properties p
   where p.id = p_project_id
     and p.org_id = v_org
     and p.kind in ('project', 'phase')
     for no key update;
  if not found then
    raise exception 'Project not found';
  end if;

  -- 3b. the caller, read AGAIN now that the row is held (0118's step 4b)
  if not (select public.mfa_satisfied()) then
    raise exception 'Second factor required.';
  end if;
  v_org  := (select public.current_org_id());
  v_role := (select public.current_role_gnk());
  if v_org is null then
    raise exception 'Account deactivated.';
  end if;
  if v_org <> v_project.org_id then
    raise exception 'Project not found';
  end if;
  if v_role is null or v_role not in ('admin', 'listing_manager') then
    raise exception 'Only admins and listing managers manage units.';
  end if;

  -- 4. AGAIN, under the lock: a twin of this submission (a double submit)
  --    that held the lock first has committed by now. Answer what it committed.
  select a.project_id, a.created_by, a.request, a.units, a.price_changed
    into v_prior
    from public.unit_type_applications a
   where a.org_id = v_org and a.operation_id = p_operation_id;
  if found then
    if v_prior.project_id is distinct from v_project.id
       or v_prior.created_by is distinct from v_uid
       or v_prior.request is distinct from v_request then
      raise exception 'This submission was already used for a different change — reload the page and try again.';
    end if;
    return jsonb_build_object(
      'result',        'replayed',
      'operation_id',  p_operation_id,
      'project_id',    v_project.id,
      'units',         v_prior.units,
      'price_changed', v_prior.price_changed);
  end if;

  -- 5. the template: this container's, this organisation's — held, so the
  --    stamp copies one version of it
  select t.id, t.code, t.bedrooms, t.bathrooms, t.covered_area_sqm, t.veranda_sqm, t.price_per_sqm
    into v_type
    from public.unit_types t
   where t.id = p_unit_type_id
     and t.project_id = v_project.id
     and t.org_id = v_org
     for share;
  if not found then
    raise exception 'Type not found on this project';
  end if;
  -- the units' own measurement rule (0113 checks both columns; said in words)
  if v_type.covered_area_sqm is not null and v_type.covered_area_sqm <= 0 then
    raise exception 'Type %: Covered area must be greater than 0 m² — leave it blank if it is not known or does not apply.', v_type.code;
  end if;

  -- the price the type says, or none: COVERED area only (the veranda is
  -- recorded, never priced), €100 steps, a half up — exact numeric, as
  -- priceFromType (lib/services/unit-type.ts) computes the picker's figure
  v_price := case when v_type.covered_area_sqm > 0 and v_type.price_per_sqm > 0
                  then round(v_type.covered_area_sqm * v_type.price_per_sqm, -2) end;
  if v_price > 999999999999.99 then
    raise exception 'Type %: that rate puts the price past the largest amount a price can hold.', v_type.code;
  end if;

  -- 6. the target set — every direct unit in the scope, archived included —
  --    as the caller SEES it, then locked in one order before anything is
  --    written. A locking read also applies the UPDATE policy: a unit visible
  --    but not updatable would leave the locked set without a word, so the two
  --    sets must match (a unit moved, added or removed between the two reads
  --    refuses too — nothing was written, the action asks for a retry)
  select coalesce(array_agg(u.id order by u.id), '{}')
    into v_seen
    from public.properties u
   where u.parent_id = v_project.id
     and u.org_id = v_org
     and u.kind = 'unit'
     and (v_block is null or u.block = v_block);
  select coalesce(array_agg(s.id order by s.id), '{}')
    into v_ids
    from (select u.id
            from public.properties u
           where u.parent_id = v_project.id
             and u.org_id = v_org
             and u.kind = 'unit'
             and (v_block is null or u.block = v_block)
           order by u.id
             for no key update) s;
  v_scope := cardinality(v_ids);
  if v_scope = 0 and cardinality(v_seen) = 0 then
    raise exception 'No units in that scope';
  end if;
  if v_ids <> v_seen then
    raise exception 'Not every unit in that scope could be updated — nothing was changed.';
  end if;

  -- the prices that will actually move, read under the locks
  select count(*) into v_moves
    from public.properties u
   where u.id = any(v_ids)
     and v_price is not null
     and u.asking_price is distinct from v_price;

  -- 7. ONE statement; a price the type cannot say stays what the LOCKED row
  --    holds — nothing read earlier is written back
  update public.properties u
     set bedrooms         = v_type.bedrooms,
         bathrooms        = v_type.bathrooms,
         covered_area_sqm = v_type.covered_area_sqm,
         veranda_sqm      = v_type.veranda_sqm,
         asking_price     = coalesce(v_price, u.asking_price)
   where u.id = any(v_ids)
     and u.org_id = v_org
     and u.parent_id = v_project.id
     and u.kind = 'unit';
  get diagnostics v_rows = row_count;
  if v_rows <> v_scope then
    raise exception 'Not every unit in that scope could be updated — nothing was changed.';
  end if;

  -- 8. the canonical trail, written by trg_price_history (0005) inside that
  --    UPDATE: one price_history row and one price_changed line per unit
  --    whose price moved, in THIS transaction
  select count(*) into v_rows
    from public.price_history h
   where h.org_id = v_org and h.property_id = any(v_ids) and h.changed_at = now()
     and h.new_price = v_price;
  select count(*) into v_lines
    from public.price_history h
   where h.org_id = v_org and h.property_id = any(v_ids) and h.changed_at = now();
  if v_rows <> v_moves or v_lines <> v_moves then
    raise exception 'The price history was not written for every unit — nothing was changed.';
  end if;
  select count(*) into v_rows
    from public.events e
   where e.org_id = v_org and e.entity_type = 'property' and e.event_type = 'price_changed'
     and e.occurred_at = now()
     and e.entity_id = any(v_ids);
  if v_rows <> v_moves then
    raise exception 'The timeline was not written for every unit — nothing was changed.';
  end if;

  -- 9. one unit-type line per stamped unit: ids, the type's code, the block
  --    and the project's reference — the payload applyUnitType wrote
  insert into public.events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select v_org, v_uid, 'property', t.id, 'updated',
         jsonb_build_object(
           'section',      'unit_type',
           'source',       'type_applied',
           'unit_type',    v_type.code,
           'scope',        coalesce(v_block, 'all units'),
           'project',      v_project.reference,
           'operation_id', p_operation_id)
    from unnest(v_ids) as t(id)
   order by t.id;
  get diagnostics v_lines = row_count;
  if v_lines <> v_scope then
    raise exception 'The timeline was not written for every unit — nothing was changed.';
  end if;

  begin
    insert into public.unit_type_applications
      (org_id, operation_id, project_id, unit_type_id, block, request, units, price_changed, created_by)
    values
      (v_org, p_operation_id, v_project.id, v_type.id, v_block, v_request, v_scope, v_moves, v_uid);
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    -- the same id, committed meanwhile by a call on ANOTHER container (this
    -- container's calls queue on its lock and are answered at step 4)
    if v_constraint = 'unit_type_applications_pkey' then
      raise exception 'This submission was already used for a different change — reload the page and try again.';
    end if;
    raise;
  end;

  return jsonb_build_object(
    'result',        'applied',
    'operation_id',  p_operation_id,
    'project_id',    v_project.id,
    'unit_type',     v_type.code,
    'units',         v_scope,
    'price_changed', v_moves);
end $$;

revoke execute on function public.apply_unit_type(uuid, uuid, uuid, text) from public, anon, service_role;
grant  execute on function public.apply_unit_type(uuid, uuid, uuid, text) to authenticated;

comment on function public.apply_unit_type(uuid, uuid, uuid, text) is
  'Stamps a unit type onto every direct unit of a project or phase (or one block) in ONE transaction (0142): container FOR NO KEY UPDATE, '
  'template FOR SHARE, units FOR NO KEY UPDATE in id order, one UPDATE whose row count must cover the scope; the price only when the type '
  'has a rate (exact, €100 steps), otherwise the locked row''s own. trg_price_history writes the price trail; one updated line per unit. '
  'p_operation_id makes a retry answer {result: replayed}. SECURITY INVOKER: every policy holds.';

-- ---------------------------------------------------------------------------
-- Postflight. The behaviour needs sessions and is proven by
-- supabase/tests/unit-type-apply-actions.test.ts; here the shape.
-- ---------------------------------------------------------------------------
do $$
declare
  n   int;
  src text;
  uncovered text[];
  sig constant text := 'public.apply_unit_type(uuid,uuid,uuid,text)';
begin
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'apply_unit_type';
  if n <> 1 then raise exception '0142 postflight: expected one apply_unit_type, found %', n; end if;

  select p.prosrc into src from pg_proc p
   where p.oid = to_regprocedure(sig)
     and not p.prosecdef
     and pg_get_userbyid(p.proowner) = 'postgres'
     and p.proconfig @> array['search_path=public, pg_temp', 'lock_timeout=3s']
     and cardinality(p.proconfig) = 2
     and p.prorettype = 'jsonb'::regtype
     and pg_get_function_identity_arguments(p.oid)
         = 'p_project_id uuid, p_unit_type_id uuid, p_operation_id uuid, p_block text';
  if src is null then
    raise exception '0142 postflight: apply_unit_type lost its signature, jsonb return, SECURITY INVOKER, owner, search_path or lock_timeout';
  end if;
  -- read the CODE: block and line comments stripped
  src := regexp_replace(src, '/\*.*?\*/', '', 'g');
  src := regexp_replace(src, '--[^\n]*', '', 'g');
  if src !~ 'p\.kind in \(''project'', ''phase''\)\s+for no key update;'
     or src !~ 'order by u\.id\s+for no key update\) s;' then
    raise exception '0142 postflight: the container and its units (in id order) are no longer locked FOR NO KEY UPDATE';
  end if;
  if (select count(*) from regexp_matches(src, 'mfa_satisfied\(\)', 'g')) < 2
     or (select count(*) from regexp_matches(src, 'current_org_id\(\)', 'g')) < 2
     or (select count(*) from regexp_matches(src, 'current_role_gnk\(\)', 'g')) < 2 then
    raise exception '0142 postflight: the caller is no longer read before the lock AND again under it';
  end if;
  if src !~ 'get diagnostics v_rows = row_count;\s+if v_rows <> v_scope then'
     or src !~ 'get diagnostics v_lines = row_count;\s+if v_lines <> v_scope then' then
    raise exception '0142 postflight: the stamp''s or the audit lines'' row count is no longer checked';
  end if;
  -- the operation record read before the container's lock AND under it
  if (select count(*) from regexp_matches(src, 'from public\.unit_type_applications a\s+where a\.org_id = v_org and a\.operation_id = p_operation_id;', 'g')) <> 2
     or strpos(src, 'from public.unit_type_applications a') > strpos(src, 'for no key update;') then
    raise exception '0142 postflight: the operation record is no longer answered before the lock and again under it';
  end if;
  -- the locked set is the set the caller sees (a policy cannot drop a unit silently)
  if src !~ 'if v_ids <> v_seen then\s+raise exception' then
    raise exception '0142 postflight: the locked units are no longer compared with the units in scope';
  end if;
  -- the price: never a value read before the lock — the type's, or the row's own
  if src !~ 'asking_price\s+= coalesce\(v_price, u\.asking_price\)' then
    raise exception '0142 postflight: the price is no longer the type''s or the locked row''s own';
  end if;
  if src !~ 'e\.event_type = ''price_changed''\s+and e\.occurred_at = now\(\)' then
    raise exception '0142 postflight: the per-unit price trail is no longer counted';
  end if;
  -- trg_price_history is the ONE per-unit price writer
  if src ~* 'insert\s+into\s+(public\.)?price_history'
     or src ~* 'insert\s+into\s+(public\.)?events[^;]*price_changed' then
    raise exception '0142 postflight: apply_unit_type writes a price line trg_price_history already writes';
  end if;
  if (select count(*) from regexp_matches(src, 'insert\s+into\s+(public\.)?events\y', 'gi')) <> 1 then
    raise exception '0142 postflight: expected exactly one event insert (the unit-type lines)';
  end if;

  if has_function_privilege('anon', sig, 'execute')
     or has_function_privilege('service_role', sig, 'execute')
     or not has_function_privilege('authenticated', sig, 'execute') then
    raise exception '0142 postflight: apply_unit_type grants are wrong';
  end if;

  -- the record: RLS on, two policies + require_aal2, select/insert only
  if not (select relrowsecurity from pg_class where oid = 'public.unit_type_applications'::regclass) then
    raise exception '0142 postflight: RLS is not enabled on unit_type_applications';
  end if;
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'unit_type_applications';
  if n <> 3 then
    raise exception '0142 postflight: expected 3 policies on unit_type_applications, found %', n;
  end if;
  if has_table_privilege('anon', 'public.unit_type_applications', 'select, insert, update, delete, truncate, references, trigger')
     or has_table_privilege('authenticated', 'public.unit_type_applications', 'update, delete, truncate, references, trigger')
     or has_table_privilege('service_role', 'public.unit_type_applications', 'insert, update, delete, truncate, references, trigger')
     or not has_table_privilege('authenticated', 'public.unit_type_applications', 'select')
     or not has_table_privilege('authenticated', 'public.unit_type_applications', 'insert')
     or not has_table_privilege('service_role', 'public.unit_type_applications', 'select') then
    raise exception '0142 postflight: unit_type_applications grants are wrong';
  end if;
  select array_agg(t) into uncovered from public.rls_aal2_coverage() t;
  if uncovered is not null then
    raise exception '0142 postflight: table(s) missing require_aal2: %', uncovered;
  end if;

  -- without a session it refuses before it reads anything
  begin
    perform public.apply_unit_type(gen_random_uuid(), gen_random_uuid(), gen_random_uuid());
    raise exception '0142 postflight: apply_unit_type ran without a session';
  exception
    when raise_exception then
      if sqlerrm <> 'Not authenticated.' then raise; end if;
  end;

  raise notice '0142: postflight passed — apply_unit_type is SECURITY INVOKER (authenticated only); unit_type_applications holds the operation record';
end $$;

-- the file's LAST result: what the old path left, counted, not repaired
select '0142' as migration,
       (select count(*) from public.events
         where event_type = 'updated' and payload ->> 'source' = 'type_applied') as type_applied_lines,
       (select count(*) from public.unit_types) as unit_types;
