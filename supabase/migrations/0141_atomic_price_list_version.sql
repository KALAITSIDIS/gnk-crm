-- =============================================================================
-- 0141 — a price-list version, and the bulk reprice it records, commit as ONE
--        transaction: record_price_list_version
--
-- THE DEFECT (an external audit's priority 2, reproduced 2026-10-05 against
-- 2ef18a1 on an isolated local stack, through the REAL server actions and
-- PostgREST — supabase/tests/price-uplift-actions.test.ts, pinned RED first,
-- 23 of 26; DECISIONS T-price-uplift-atomic has the evidence):
--
--   * applyPriceUplift PATCHed one unit per request, wrote its OWN
--     `price_changed` event per unit — on top of the one trg_price_history
--     (0005) already writes, so every repriced unit carried two — and then
--     called createPriceListVersion, which inserted the header, the items and
--     the `price_list_created` event as three more requests. A failure at any
--     step kept everything before it: repriced units with no version, an
--     empty v1 header (0 items) that RLS lets nobody delete while it is the
--     latest, a version with no event (the action then THREW);
--   * the version number was max + 1 read without a lock: two concurrent
--     versions collided on (project_id, version) — after the prices had
--     moved ("Prices updated, but the version was not created");
--   * nothing tied the write to what was reviewed: a price edited after the
--     preview was uplifted again from its new value, a unit added to the block
--     was repriced unseen, ARCHIVED units (which the page never previews) were
--     repriced and evented, a resubmit or a retry after a lost answer applied
--     the percentage twice;
--   * an agent's direct call changed the units RLS let it change and wrote
--     `price_changed` lines for prices RLS had silently NOT changed (0-row
--     PATCH, no error), then failed at price_lists;
--   * the unit reads were unpaged: a 1200-unit project repriced 1000 units
--     and snapshotted 1000 — PostgREST's max_rows, silently.
--
-- THE FIX — ONE function, SECURITY INVOKER, called by both actions:
--
-- A. price_lists.operation_id / .operation: the version a submission created
--    IS its operation record. Unique per organisation; a retry of a committed
--    submission (same id, same request) answers what it committed and changes
--    nothing; the same id with other inputs, on another project or from
--    another user is refused. `operation` holds the request's md5 and the
--    counts the answer repeats. Both null on every row written before 0141
--    and by any direct insert (the deployed app's, until it is replaced).
--
-- B. record_price_list_version(project, operation, notes, [mode, amount,
--    block, expected]) — with no mode, a plain snapshot (the "New version"
--    button); with one, the bulk reprice and its snapshot. In order, all in
--    the caller's transaction:
--      1. the caller from the session (auth.uid, aal2, organisation, role) —
--         admin or listing manager, before any row is read;
--      2. the container (project or phase of the caller's organisation)
--         locked FOR NO KEY UPDATE — every version and every reprice of it
--         queues here, so max(version) + 1 is read by one writer at a time.
--         NOT FOR UPDATE: that also blocks the KEY SHARE every foreign-key
--         check onto the container takes (a unit created under it, a task,
--         a viewing), and the nightly sweeps take the events-chain lock
--         BEFORE such an insert (create_followup_nudges, expire_mandates)
--         while this call takes it after — a deadlock (0117's lesson, found
--         by this file's review). A unit created meanwhile is simply not in
--         the version: it reads as created after it;
--      3. the caller re-read under that lock (0118's step 4b);
--      4. the operation id: replay or refuse, as in A;
--      5. EVERY unit of the container locked FOR NO KEY UPDATE in id order —
--         a price edit, a move or an archive of any of them now waits for
--         this transaction (or committed before it and is read below), so the
--         check, the writes and the snapshot see one state;
--      6. reprice only: the reviewed scope (`p_expected`, every unit the page
--         previewed, priced or not, with the price it showed) must be exactly
--         the scope now — direct, NOT archived, the block or all — unit for
--         unit and price for price; otherwise answer `stale` and write
--         nothing. Then the €100 rule in exact numeric (half away from zero,
--         floor €100, null / ≤ 0 skipped, unchanged left alone —
--         lib/services/price-uplift.ts computes the preview the same way, in
--         exact decimals), ONE UPDATE of the changed units, each row
--         re-checked against the price it was computed from, row_count =
--         changed — and the canonical trail counted: trg_price_history must
--         have written one price_history row and one `price_changed` event per
--         changed unit in THIS transaction (a disabled trigger refuses the
--         reprice rather than recording none);
--      7. the version: every priced direct unit of the container (the
--         snapshot's meaning since 0001, archived units included), header +
--         items (row_count checked) + ONE `price_list_created` event carrying
--         the operation's shape (version, units, and for a reprice source,
--         mode, amount, scope, changed — the context the action's duplicate
--         per-unit lines used to carry; ids and numbers only, never notes).
--    Any refusal raises: nothing is kept. The caller gets one jsonb answer:
--    `applied` (with the changes, for the bulk price-drop alert), `replayed`
--    (the original version and counts, and the changes read back from
--    price_history — every row of a transaction carries its now()) or
--    `stale`.
--
-- WHY INVOKER: every row the function writes, the caller could write through
-- PostgREST under the same policies — properties_update, price_lists_insert,
-- price_list_items_insert, events_insert, require_aal2 on each — so the
-- database keeps enforcing all of them, statement by statement (a demotion or
-- a lost factor committed while the call waited for a lock is refused at the
-- next statement, as 0117's RLS did). The explicit checks in 1 and 3 add the
-- words; they grant nothing. trg_price_history stays the definer it is (0005)
-- and the ONE writer of per-unit history and `price_changed`.
--
-- WHY NOT:
--   * a definer (0118's shape): it would have to restate four tables'
--     policies and require_aal2 for no authority the caller lacks;
--   * a separate operations table: a new RLS surface (aal2 coverage, grants,
--     the PK catalogue) for a record the version already is;
--   * a trigger change to stamp operation context on each unit's line: the
--     timeline renders only from / to (lib/services/events.ts), every event of
--     the transaction shares the version event's occurred_at, and
--     trg_price_history is also the writer for direct edits and imports —
--     left exactly as 0005 wrote it.
--
-- CONTRACT. New function; the app calls it from applyPriceUplift and
-- createPriceListVersion (lib/actions/units.ts). Nothing the deployed app
-- calls changes: its direct inserts leave the two new columns null. No
-- release-compat entry (no existing signature or return shape changes).
-- database.types.ts regenerated (the function and the two columns).
--
-- VISIBLE CHANGES FOR A DIRECT POSTGREST CALLER: none to existing endpoints.
-- price_lists rows gain two nullable columns.
--
-- LOCKS (this file): ACCESS EXCLUSIVE on price_lists for the ALTER (the
-- columns are nullable, no default: metadata only) and the unique index on a
-- small table — milliseconds; readers of price_lists (the units page, share
-- links) wait for them. lock_timeout 5 s; a 55P03 keeps nothing — apply
-- again. ONE transaction (checked below).
-- LOCKS (each call): the container row FOR NO KEY UPDATE, its units FOR NO
-- KEY UPDATE in id order, then — from the first unit's trigger — the
-- organisation's events-chain advisory lock (0108) until COMMIT. No row is
-- written before every row lock is held, so the chain lock is never held
-- while this transaction waits for a unit, and no foreign-key check waits on
-- it. ONE REMAINING DEADLOCK, measured by review, accepted: a writer that
-- updates several of the same units in ANOTHER order in one statement (the
-- inherited-field sync, lib/services/unit-inheritance.ts; the contact merge's
-- owner repoint) can meet this call's id order — PostgreSQL then aborts one
-- side (40P01) and nothing of it is kept; the actions say so and ask for a
-- retry. A reprice of 1200 units measured well inside the 8 s statement
-- timeout of `authenticated`.
--
-- DEPLOY ORDER: additive — hosted 0141 first, then merge. The deployed app
-- (direct PATCH / INSERTs) keeps working against it unchanged.
--
-- EXISTING ROWS — READ-ONLY DIAGNOSTIC, NO REPAIR (the file's last row):
--   duplicate_price_lines  `price_changed` events with source 'bulk_uplift':
--                          the action's copies of a trigger line, written by
--                          every release before the 0141 app. Append-only and
--                          hash-chained: they stay; readers already show
--                          from / to only;
--   empty_versions         price_lists headers with no items — partial
--                          snapshots of the old path.
-- The deployed (pre-0141) app keeps writing both until the merge deploys, so
-- the figures here are not final: RE-RUN the two counts once the new release
-- is live (the select is the file's last statement) and record THOSE.
-- RESOLUTION: none by migration; an operator decision per row, recorded in
-- DECISIONS.
--
-- NOT CHANGED: trg_price_history and the per-unit trail of direct edits and
-- imports; who may read or write price lists, units or events (policies
-- untouched — a direct PostgREST caller may still write a version without
-- this function, as before); the snapshot's set (every priced DIRECT unit;
-- phase units belong to the phase's own list); effective_date (the column
-- default); payment plans; share links.
--
-- NOT DONE HERE (BACKLOG): refusing direct session writes of price_lists /
-- price_list_items / `price_changed` (deploy-coupled, as 0117 → 0118 was);
-- price_list_items_insert still checks only the list's organisation, not the
-- unit's (an existing entry); price_lists.project_id is a single-column key,
-- so another organisation's admin who knows a project's id can insert a
-- version row against it that this organisation cannot see — max(version) + 1
-- then meets it on (project_id, version) and every version and reprice of
-- that project is refused until it is removed (fails closed; before 0141 the
-- units had already been repriced by then); the operation record
-- (operation_id, operation, created_by) is writable by the organisation's
-- admins and listing managers through price_lists_update — an insider can
-- make a retry answer "already used" or report other counts, never apply a
-- change twice (the ids are random and minted at submit); a project-level
-- reprice still ignores units under its phases (their own pages reprice them).
--
-- ROLLBACK, a forward migration in ONE transaction, ONLY after the app is
-- back on a release that does not call the function (pre-0141 actions): drop
-- record_price_list_version, the unique index, the pairing check and the two
-- columns (supabase/tests/revert-0141.ts is that SQL). Rolling the DATABASE
-- back first fails closed: the new actions get PGRST202 and say nothing was
-- changed. In the same change: delete supabase/tests/price-list-version.test.ts,
-- price-uplift-actions.test.ts and revert-0141.ts; remove the restore pack's
-- 0141 rows and move its migrations pin FORWARD.
--
-- NUMBERING: 0140 is claimed by the unmerged branch fix/dashboard-won-value
-- (applied on the shared local stack). If that branch is abandoned this file
-- keeps its number; the ledger tolerates the gap.
--
-- Pins that move with this file: scripts/backup/verify-restore.sql (the
-- migrations count, a grants row, the 0141 INTEGRITY row);
-- lib/supabase/database.types.ts; docs/04's price_lists rows.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3), as does one
-- execute_sql call. The file's LAST result is a read-only summary.
-- =============================================================================

set local lock_timeout = '5s';

do $$
begin
  if current_setting('lock_timeout') <> '5s' then
    raise exception '0141 aborted: this file must run as ONE transaction (SET LOCAL lock_timeout did not take effect) — nothing was changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Preflight: the names are free, and the per-unit writer this function counts
-- on is attached as 0005 left it
-- ---------------------------------------------------------------------------
do $$
begin
  lock table public.price_lists in access exclusive mode;

  if exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
              where ns.nspname = 'public' and p.proname = 'record_price_list_version') then
    raise exception '0141 aborted: a function named record_price_list_version already exists — nothing was changed';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'price_lists'
                and column_name in ('operation_id', 'operation')) then
    raise exception '0141 aborted: price_lists already has an operation column — nothing was changed';
  end if;
  if to_regclass('public.price_lists_org_operation_key') is not null then
    raise exception '0141 aborted: price_lists_org_operation_key already exists — nothing was changed';
  end if;
  if not exists (
    select 1 from pg_trigger t
     where t.tgrelid = 'public.properties'::regclass and t.tgname = 'properties_price_history'
       and t.tgfoid = 'public.trg_price_history()'::regprocedure and t.tgenabled = 'O' and not t.tgisinternal
       and (t.tgtype & 1) = 1      -- FOR EACH ROW
       and (t.tgtype & 2) = 0      -- AFTER
       and (t.tgtype & 16) = 16    -- UPDATE
  ) then
    raise exception '0141 aborted: properties_price_history is not the enabled AFTER UPDATE row trigger 0005 attached — nothing was changed';
  end if;
  raise notice '0141: preflight passed — names free, trg_price_history attached';
end $$;

-- ---------------------------------------------------------------------------
-- A. the version a submission created is its operation record
-- ---------------------------------------------------------------------------
alter table public.price_lists
  add column operation_id uuid,
  add column operation    jsonb;

alter table public.price_lists
  add constraint price_lists_operation_pair
  check ((operation_id is null) = (operation is null));

create unique index price_lists_org_operation_key on public.price_lists (org_id, operation_id);

comment on column public.price_lists.operation_id is
  'The submission that created this version through record_price_list_version (0141); unique per organisation. A retry with the same id answers this row instead of applying again. Null before 0141 and for direct inserts.';
comment on column public.price_lists.operation is
  'record_price_list_version''s record of the submission (0141): kind (snapshot | reprice), the request''s md5 (a reused id must match it), and for a reprice mode, amount, block and the counts its answer repeats. Never notes.';

-- ---------------------------------------------------------------------------
-- B. record_price_list_version
-- ---------------------------------------------------------------------------
create function public.record_price_list_version(
  p_project_id   uuid,
  p_operation_id uuid,
  p_notes        text    default null,
  p_mode         text    default null,
  p_amount       numeric default null,
  p_block        text    default null,
  p_expected     jsonb   default null
)
returns jsonb
language plpgsql
security invoker
-- pg_temp LAST: unlisted, it is searched FIRST for relations and types
set search_path = public, pg_temp
as $$
declare
  v_uid        uuid := auth.uid();
  v_org        uuid;
  v_role       user_role;
  v_kind       text;
  v_block      text;
  v_notes      text;
  v_request    text;
  v_project    record;
  v_prior      record;
  v_scope      int := 0;
  v_mismatch   int := 0;
  v_changes    jsonb;
  v_changed    int := 0;
  v_unchanged  int := 0;
  v_skipped    int := 0;
  v_before     numeric := 0;
  v_after      numeric := 0;
  v_max        numeric;
  v_rows       int;
  v_priced     int;
  v_version    int;
  v_list_id    uuid;
  v_items      int;
  v_operation  jsonb;
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
  if p_operation_id is null then
    raise exception 'This form is out of date — reload the page and try again.';
  end if;
  if p_notes is not null and char_length(p_notes) > 2000 then
    raise exception 'Keep the version note under 2000 characters.';
  end if;
  v_notes := nullif(btrim(p_notes), '');

  if p_mode is null then
    v_kind := 'snapshot';
    if p_amount is not null or p_block is not null or p_expected is not null then
      raise exception 'A plain price list version takes no price change.';
    end if;
  elsif p_mode in ('percent', 'fixed') then
    v_kind := 'reprice';
    -- numeric admits NaN and ±Infinity: refuse them with zero
    if p_amount is null or p_amount = 'NaN'::numeric
       or p_amount in ('Infinity'::numeric, '-Infinity'::numeric) or p_amount = 0 then
      raise exception 'Enter a change other than zero';
    end if;
    v_block := nullif(p_block, '');
    if v_block is not null and char_length(v_block) > 20 then
      raise exception 'No units in that scope';
    end if;
    -- the reviewed scope: an array of {id, price} — read one test at a time,
    -- each only once the one before it holds (no cast meets a malformed value)
    if p_expected is null or jsonb_typeof(p_expected) <> 'array' then
      raise exception 'The reviewed prices could not be read — reload the page and review the change again.';
    end if;
    if jsonb_array_length(p_expected) > 10000 then
      raise exception 'The reviewed prices could not be read — reload the page and review the change again.';
    end if;
    if exists (
         select 1 from jsonb_array_elements(p_expected) e
          where jsonb_typeof(e) <> 'object'
             or coalesce(jsonb_typeof(e -> 'id'), 'missing') <> 'string'
             or coalesce(jsonb_typeof(e -> 'price'), 'missing') not in ('number', 'null')) then
      raise exception 'The reviewed prices could not be read — reload the page and review the change again.';
    end if;
    if exists (
         select 1 from jsonb_array_elements(p_expected) e
          where (e ->> 'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
      raise exception 'The reviewed prices could not be read — reload the page and review the change again.';
    end if;
    if (select count(*) <> count(distinct (e ->> 'id')::uuid) from jsonb_array_elements(p_expected) e) then
      raise exception 'The reviewed prices could not be read — reload the page and review the change again.';
    end if;
  else
    raise exception 'Unknown change — use a percentage or a fixed amount.';
  end if;

  -- the request, canonical: what a reused operation id must match (jsonb's
  -- text form orders keys; trim_scale makes 250000.00 and 250000 one value)
  v_request := md5(jsonb_build_object(
    'kind',     v_kind,
    'project',  p_project_id,
    'mode',     p_mode,
    'amount',   trim_scale(p_amount),
    'block',    v_block,
    'notes',    v_notes,
    'reviewed', (select jsonb_agg(jsonb_build_array(lower(e ->> 'id'), trim_scale((e ->> 'price')::numeric))
                                  order by lower(e ->> 'id'))
                   from jsonb_array_elements(coalesce(p_expected, '[]'::jsonb)) e))::text);

  -- 2. may this person manage price lists at all — before any row is read,
  --    so the answer cannot depend on (and so cannot reveal) whether an id exists
  if v_role is null or v_role not in ('admin', 'listing_manager') then
    raise exception 'Only admins and listing managers manage price lists.';
  end if;

  -- 3. the container, locked: every version of it queues here — NO KEY, so a
  --    foreign-key check onto it never waits on this call (header)
  select p.id, p.org_id, p.reference, p.kind
    into v_project
    from public.properties p
   where p.id = p_project_id
     and p.org_id = v_org
     and p.kind in ('project', 'phase')
     for no key update;
  if not found then
    raise exception 'Project not found';
  end if;

  -- 3b. the caller, read AGAIN now that the row is held (0118's step 4b):
  --     RLS re-reads the profile at every later statement anyway; this says so
  --     in words instead of a refused or a 0-row write
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
    raise exception 'Only admins and listing managers manage price lists.';
  end if;

  -- 4. has this submission already committed? Answer what it committed.
  select pl.id, pl.version, pl.project_id, pl.created_by, pl.created_at, pl.operation
    into v_prior
    from public.price_lists pl
   where pl.org_id = v_org and pl.operation_id = p_operation_id;
  if found then
    if v_prior.project_id is distinct from v_project.id
       or v_prior.created_by is distinct from v_uid
       or (v_prior.operation ->> 'request') is distinct from v_request then
      raise exception 'This submission was already used for a different change — reload the page and review it again.';
    end if;
    return jsonb_strip_nulls(jsonb_build_object(
      'result',        'replayed',
      'kind',          v_prior.operation ->> 'kind',
      'operation_id',  p_operation_id,
      'org_id',        v_org,
      'actor_id',      v_uid,
      'project_id',    v_project.id,
      'price_list_id', v_prior.id,
      'version',       v_prior.version,
      'units',         (select count(*) from public.price_list_items i where i.price_list_id = v_prior.id),
      'changed',       v_prior.operation -> 'changed',
      'unchanged',     v_prior.operation -> 'unchanged',
      'skipped',       v_prior.operation -> 'skipped',
      'total_before',  v_prior.operation -> 'total_before',
      'total_after',   v_prior.operation -> 'total_after',
      -- the changes it committed, read back from the canonical trail: every
      -- row of that transaction carries its now(), the header's created_at
      -- included — so a replay can still raise the bulk price-drop alert the
      -- committing request may have lost its answer before reaching
      'changes',       case when v_prior.operation ->> 'kind' = 'reprice' then (
                         select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'reference', u.reference,
                                                                      'from', trim_scale(h.old_price), 'to', trim_scale(h.new_price))
                                                   order by u.reference, u.id), '[]'::jsonb)
                           from public.price_history h
                           join public.properties u on u.id = h.property_id
                          where h.org_id = v_org and h.changed_at = v_prior.created_at
                            and h.changed_by is not distinct from v_prior.created_by
                            and u.parent_id = v_project.id and u.kind = 'unit') end));
  end if;

  -- 5. every unit of the container, locked in one order before anything is
  --    written (header)
  perform 1
     from public.properties u
    where u.parent_id = v_project.id and u.org_id = v_org and u.kind = 'unit'
    order by u.id
      for no key update;

  if v_kind = 'reprice' then
    -- 6a. what was reviewed is what is there: the page's scope (direct, not
    --     archived, the block or all), unit for unit, price for price
    with scope as (
      select u.id, u.asking_price
        from public.properties u
       where u.parent_id = v_project.id and u.org_id = v_org and u.kind = 'unit'
         and u.visibility <> 'archived'
         and (v_block is null or u.block = v_block)
    ), reviewed as (
      select (e ->> 'id')::uuid as id, (e ->> 'price')::numeric as price
        from jsonb_array_elements(p_expected) e
    )
    select (select count(*) from scope),
           (select count(*)
              from scope s full join reviewed r on r.id = s.id
             where s.id is null or r.id is null or s.asking_price is distinct from r.price)
      into v_scope, v_mismatch;
    if v_mismatch > 0 then
      -- nothing is written: the locks end with this transaction
      return jsonb_build_object(
        'result',       'stale',
        'kind',         v_kind,
        'operation_id', p_operation_id,
        'project_id',   v_project.id);
    end if;
    if v_scope = 0 then
      raise exception 'No units in that scope';
    end if;

    -- 6b. the new prices — the €100 rule in exact numeric: round half away
    --     from zero to a multiple of 100 (a percentage as
    --     round(price × (100 + amount), -4) / 100, which never divides an
    --     inexact value), never below €100; no price / ≤ 0 is skipped; a price
    --     the rule leaves where it is, unchanged. lib/services/price-uplift.ts
    --     computes the preview with the same digits.
    select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'reference', c.reference,
                                                 'from', trim_scale(c.old_price), 'to', trim_scale(c.new_price))
                              order by c.reference, c.id) filter (where c.new_price <> c.old_price), '[]'::jsonb),
           count(*) filter (where c.new_price <> c.old_price),
           count(*) filter (where c.new_price = c.old_price),
           coalesce(sum(c.old_price), 0),
           coalesce(sum(c.new_price), 0),
           max(c.new_price)
      into v_changes, v_changed, v_unchanged, v_before, v_after, v_max
      from (select u.id, u.reference, u.asking_price as old_price,
                   greatest(case when p_mode = 'percent'
                                 then round(u.asking_price * (100 + p_amount), -4) / 100
                                 else round(u.asking_price + p_amount, -2)
                            end, 100::numeric) as new_price
              from public.properties u
             where u.parent_id = v_project.id and u.org_id = v_org and u.kind = 'unit'
               and u.visibility <> 'archived'
               and (v_block is null or u.block = v_block)
               and u.asking_price > 0) c;
    v_skipped := v_scope - v_changed - v_unchanged;

    if v_changed = 0 then
      if v_skipped = v_scope then
        raise exception 'None of those units has a price to change.';
      end if;
      raise exception 'That change rounds to nothing — no price would move.';
    end if;
    if v_max > 999999999999.99 then
      raise exception 'That change would take a price past the largest amount a price can hold.';
    end if;

    -- 6c. ONE statement; each row re-checked against the price it was
    --     computed from; every changed unit, or none
    update public.properties p
       set asking_price = c."to"
      from jsonb_to_recordset(v_changes) as c(id uuid, "from" numeric, "to" numeric)
     where p.id = c.id
       and p.org_id = v_org
       and p.parent_id = v_project.id
       and p.kind = 'unit'
       and p.asking_price = c."from";
    get diagnostics v_rows = row_count;
    if v_rows <> v_changed then
      raise exception 'Not every unit could be repriced — nothing was changed.';
    end if;

    -- 6d. the canonical trail, written by trg_price_history (0005) inside that
    --     UPDATE: one price_history row and one price_changed event per
    --     changed unit, in THIS transaction (every row of it carries now())
    select count(*) into v_rows
      from public.price_history h
      join jsonb_to_recordset(v_changes) as c(id uuid, "from" numeric, "to" numeric) on c.id = h.property_id
     where h.org_id = v_org and h.changed_at = now() and h.old_price = c."from" and h.new_price = c."to";
    if v_rows <> v_changed then
      raise exception 'The price history was not written for every unit — nothing was changed.';
    end if;
    select count(*) into v_rows
      from public.events e
     where e.org_id = v_org and e.entity_type = 'property' and e.event_type = 'price_changed'
       and e.occurred_at = now()
       and e.entity_id in (select c.id from jsonb_to_recordset(v_changes) as c(id uuid));
    if v_rows <> v_changed then
      raise exception 'The timeline was not written for every unit — nothing was changed.';
    end if;

    -- the note a reprice records when none was typed (the action's wording
    -- before 0141: "+3% on block C (12 units)")
    v_notes := coalesce(v_notes,
      case when p_amount > 0 then '+' else '' end || trim_scale(p_amount)::text
      || case when p_mode = 'percent' then '%' else '' end
      || ' on ' || case when v_block is null then 'all units' else 'block ' || v_block end
      || ' (' || v_changed || ' units)');
  end if;

  -- 7. the version: every priced direct unit of the container, under the lock
  select count(*) into v_priced
    from public.properties u
   where u.parent_id = v_project.id and u.org_id = v_org and u.kind = 'unit' and u.asking_price is not null;
  if v_priced = 0 then
    raise exception 'No units with prices to snapshot';
  end if;

  select coalesce(max(pl.version), 0) + 1 into v_version
    from public.price_lists pl
   where pl.project_id = v_project.id;

  v_operation := jsonb_strip_nulls(jsonb_build_object(
    'kind',         v_kind,
    'request',      v_request,
    'mode',         p_mode,
    'amount',       trim_scale(p_amount),
    'block',        v_block,
    'changed',      case when v_kind = 'reprice' then v_changed end,
    'unchanged',    case when v_kind = 'reprice' then v_unchanged end,
    'skipped',      case when v_kind = 'reprice' then v_skipped end,
    'total_before', case when v_kind = 'reprice' then trim_scale(v_before) end,
    'total_after',  case when v_kind = 'reprice' then trim_scale(v_after) end));

  begin
    insert into public.price_lists (org_id, project_id, version, notes, created_by, operation_id, operation)
    values (v_org, v_project.id, v_version, v_notes, v_uid, p_operation_id, v_operation)
    returning id into v_list_id;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    -- the same id, committed meanwhile by a call on ANOTHER container (this
    -- container's calls queue on its lock and are answered at step 4)
    if v_constraint = 'price_lists_org_operation_key' then
      raise exception 'This submission was already used for a different change — reload the page and review it again.';
    end if;
    raise;
  end;

  insert into public.price_list_items (price_list_id, unit_id, list_price)
  select v_list_id, u.id, u.asking_price
    from public.properties u
   where u.parent_id = v_project.id and u.org_id = v_org and u.kind = 'unit' and u.asking_price is not null;
  get diagnostics v_items = row_count;
  if v_items <> v_priced then
    raise exception 'The version could not record every price — nothing was changed.';
  end if;

  -- ids, numbers and the block code only — the note stays on the row (SEC-03)
  insert into public.events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  values (v_org, v_uid, 'property', v_project.id, 'price_list_created',
          jsonb_strip_nulls(jsonb_build_object(
            'version',      v_version,
            'units',        v_items,
            'operation_id', p_operation_id,
            'source',       case when v_kind = 'reprice' then 'bulk_uplift' end,
            'mode',         p_mode,
            'amount',       trim_scale(p_amount),
            'scope',        case when v_kind = 'reprice' then coalesce(v_block, 'all units') end,
            'changed',      case when v_kind = 'reprice' then v_changed end)));

  return jsonb_strip_nulls(jsonb_build_object(
    'result',        'applied',
    'kind',          v_kind,
    'operation_id',  p_operation_id,
    'org_id',        v_org,
    'actor_id',      v_uid,
    'project_id',    v_project.id,
    'price_list_id', v_list_id,
    'version',       v_version,
    'units',         v_items,
    'changed',       case when v_kind = 'reprice' then v_changed end,
    'unchanged',     case when v_kind = 'reprice' then v_unchanged end,
    'skipped',       case when v_kind = 'reprice' then v_skipped end,
    'total_before',  case when v_kind = 'reprice' then trim_scale(v_before) end,
    'total_after',   case when v_kind = 'reprice' then trim_scale(v_after) end,
    'changes',       case when v_kind = 'reprice' then v_changes end));
end $$;

revoke execute on function public.record_price_list_version(uuid, uuid, text, text, numeric, text, jsonb) from public, anon, service_role;
grant  execute on function public.record_price_list_version(uuid, uuid, text, text, numeric, text, jsonb) to authenticated;

comment on function public.record_price_list_version(uuid, uuid, text, text, numeric, text, jsonb) is
  'Records a project''s or phase''s next price-list version in ONE transaction (0141): with no mode a plain snapshot; '
  'with mode percent | fixed, first the bulk reprice the reviewed prices (p_expected) describe — refused as {result: stale} '
  'if they no longer match. Container and its units FOR NO KEY UPDATE; trg_price_history writes the per-unit trail; '
  'one price_list_created event. p_operation_id makes a retry answer {result: replayed}. SECURITY INVOKER: every policy holds.';

-- ---------------------------------------------------------------------------
-- Postflight. The behaviour needs sessions and is proven by
-- supabase/tests/price-list-version.test.ts and price-uplift-actions.test.ts;
-- here the shape.
-- ---------------------------------------------------------------------------
do $$
declare
  n   int;
  src text;
  sig constant text := 'public.record_price_list_version(uuid,uuid,text,text,numeric,text,jsonb)';
begin
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'record_price_list_version';
  if n <> 1 then raise exception '0141 postflight: expected one record_price_list_version, found %', n; end if;

  select p.prosrc into src from pg_proc p
   where p.oid = to_regprocedure(sig)
     and not p.prosecdef
     and pg_get_userbyid(p.proowner) = 'postgres'
     and p.proconfig = array['search_path=public, pg_temp']
     and p.prorettype = 'jsonb'::regtype
     and pg_get_function_identity_arguments(p.oid)
         = 'p_project_id uuid, p_operation_id uuid, p_notes text, p_mode text, p_amount numeric, p_block text, p_expected jsonb';
  if src is null then
    raise exception '0141 postflight: record_price_list_version lost its signature, jsonb return, SECURITY INVOKER, owner or search_path';
  end if;
  -- read the CODE: comments stripped — block comments too, so code parked in
  -- one is not counted — and a word in one can neither satisfy nor blind the
  -- checks below
  src := regexp_replace(src, '/\*.*?\*/', '', 'g');
  src := regexp_replace(src, '--[^\n]*', '', 'g');
  if src !~ 'p\.kind in \(''project'', ''phase''\)\s+for no key update;'
     or src !~ 'order by u\.id\s+for no key update;' then
    raise exception '0141 postflight: the container and its units (in id order) are no longer locked FOR NO KEY UPDATE';
  end if;
  if (select count(*) from regexp_matches(src, 'mfa_satisfied\(\)', 'g')) < 2
     or (select count(*) from regexp_matches(src, 'current_org_id\(\)', 'g')) < 2
     or (select count(*) from regexp_matches(src, 'current_role_gnk\(\)', 'g')) < 2 then
    raise exception '0141 postflight: the caller is no longer read before the lock AND again under it';
  end if;
  if src !~ 'get diagnostics v_rows = row_count;\s+if v_rows <> v_changed then'
     or src !~ 'get diagnostics v_items = row_count;\s+if v_items <> v_priced then' then
    raise exception '0141 postflight: a write''s row count is no longer checked';
  end if;
  -- …and the trail it counts after its UPDATE: one price_history row AND one
  -- price_changed line per changed unit, in this transaction
  if src !~ 'from public\.price_history h\s+join jsonb_to_recordset\(v_changes\)'
     or src !~ 'e\.event_type = ''price_changed''\s+and e\.occurred_at = now\(\)' then
    raise exception '0141 postflight: the per-unit trail (history and price_changed line) is no longer counted';
  end if;
  -- trg_price_history is the ONE per-unit writer: the function writes no
  -- history and no price_changed line of its own, and exactly one event —
  -- schema-qualified or not (search_path reaches public either way)
  if src ~* 'insert\s+into\s+(public\.)?price_history'
     or src ~* 'insert\s+into\s+(public\.)?events[^;]*price_changed' then
    raise exception '0141 postflight: record_price_list_version writes a per-unit line trg_price_history already writes';
  end if;
  if (select count(*) from regexp_matches(src, 'insert\s+into\s+(public\.)?events\y', 'gi')) <> 1 then
    raise exception '0141 postflight: expected exactly one event insert (price_list_created)';
  end if;
  -- SEC-03: the note stays on the row
  if src ~* 'insert\s+into\s+(public\.)?events[^;]*notes' then
    raise exception '0141 postflight: the price_list_created event carries the note';
  end if;

  if has_function_privilege('anon', sig, 'execute')
     or has_function_privilege('service_role', sig, 'execute')
     or not has_function_privilege('authenticated', sig, 'execute') then
    raise exception '0141 postflight: record_price_list_version grants are wrong';
  end if;

  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'price_lists' and is_nullable = 'YES'
         and ((column_name = 'operation_id' and data_type = 'uuid')
           or (column_name = 'operation' and data_type = 'jsonb'))) <> 2 then
    raise exception '0141 postflight: price_lists.operation_id / operation are not the nullable uuid / jsonb columns';
  end if;
  if not exists (
    select 1 from pg_index i
     where i.indexrelid = 'public.price_lists_org_operation_key'::regclass and i.indisunique and i.indisvalid
       and i.indrelid = 'public.price_lists'::regclass
       and pg_get_indexdef(i.indexrelid) ~ '\(org_id, operation_id\)$'
  ) then
    raise exception '0141 postflight: price_lists_org_operation_key is not a valid unique index on (org_id, operation_id)';
  end if;
  if not exists (select 1 from pg_constraint c
                  where c.conrelid = 'public.price_lists'::regclass and c.conname = 'price_lists_operation_pair'
                    and c.contype = 'c' and c.convalidated) then
    raise exception '0141 postflight: price_lists_operation_pair is missing or not validated';
  end if;

  -- without a session it refuses before it reads anything
  begin
    perform public.record_price_list_version(gen_random_uuid(), gen_random_uuid());
    raise exception '0141 postflight: record_price_list_version ran without a session';
  exception
    when raise_exception then
      if sqlerrm <> 'Not authenticated.' then raise; end if;
  end;

  raise notice '0141: postflight passed — record_price_list_version is SECURITY INVOKER (authenticated only); price_lists carries the operation record';
end $$;

-- the file's LAST result: what the old path left behind, counted, not repaired
select '0141' as migration,
       (select count(*) from public.events
         where event_type = 'price_changed' and payload ->> 'source' = 'bulk_uplift') as duplicate_price_lines,
       (select count(*) from public.price_lists pl
         where not exists (select 1 from public.price_list_items i where i.price_list_id = pl.id)) as empty_versions;
