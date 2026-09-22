-- =============================================================================
-- 0109 — the events chain: the id is taken UNDER the lock, so id order is
--        chain order (audit 2026-09-22, second brief, finding 1)
--
-- THE DEFECT, one layer below 0108's. 0108 made concurrent event writers of
-- one organisation queue on a transaction-scoped advisory lock before the
-- trigger reads "the organisation's latest hash". That stops two writers
-- chaining onto the SAME row. It does not stop them chaining in an order the
-- verifier cannot follow, because `events.id` is an identity column whose
-- value is assigned by the column DEFAULT — before the BEFORE ROW trigger
-- runs, so BEFORE the lock is taken. The interleaving, reproduced live on
-- 2026-09-22 with two independent sessions and explicit barriers
-- (supabase/tests/events-chain-order.test.ts):
--
--   A: begin; insert A1              -> id 3361, holds the lock
--   B: begin; insert B               -> id 3362 assigned, then WAITS on the lock
--   A: insert A2; commit             -> id 3363, prev_hash = hash(A1)
--   B: (wakes) reads the latest row  -> A2, prev_hash = hash(A2); commit
--
--   verify_events_chain: false, failed_id 3362, prev_hash_mismatch
--
-- The trigger built the chain in LOCK order (A1, A2, B); the verifier walks
-- it in ID order (A1, B, A2). Row 3362 links to a row that comes after it,
-- and every later row is unverifiable. The same thing happens without a
-- multi-event transaction whenever two sessions take their identity values
-- in one order and reach the lock in the other. The incremental checkpoint
-- (0062) makes it worse: anchored at A2 while B is still uncommitted, the
-- next resumed walk starts at A2 and never looks at B at all — only the
-- weekly full walk would report the damage.
--
-- THE FIX. One line, after the lock: the trigger takes a FRESH identity
-- value from the table's own sequence, discarding the one the default
-- assigned. A BEFORE ROW trigger may set an identity column (measured on
-- this partitioned table, 2026-09-22: the default consumed 3366, the trigger
-- assigned 3367, the row landed in its month partition, a three-row insert
-- linked 3369 → 3371 → 3373). Because every event insert of an organisation
-- passes through the same lock, and the lock is held until commit or
-- rollback, within one organisation:
--
--     lock order == id order == commit order == chain order.
--
-- The row the trigger reads as "latest" is therefore always the row with
-- the greatest committed id, the checkpoint's max(id) is always the chain's
-- tail, and a row with a lower id can never appear after the anchor.
--
-- WHAT DOES NOT CHANGE. The hash material is byte for byte 0061's (v2); no
-- row already minted changes meaning, hash_version stays 2, and
-- verify_events_chain, the checkpoint, the restore path and the export are
-- untouched. Historical ids, timestamps, payloads and hashes are preserved:
-- this file inserts one row (the apply's own evidence) and rewrites nothing.
-- A chain that was ALREADY forked before this apply is REPORTED below as a
-- warning, per organisation, and left exactly as it is — repairing evidence
-- is a person's decision (docs/BACKUP_RESTORE, the suffix-delete recipe),
-- never a migration's.
--
-- COST, STATED. One unused sequence value per event (the default's), so ids
-- advance by two. Ids were never contiguous — a rolled-back insert already
-- leaves a gap — and nothing reads them as a count. The restore path is
-- unaffected because it runs with session_replication_role = replica, which
-- disables this trigger (scripts/backup/restore.mjs §1); a restore that
-- forgot to would now be renumbered as well as re-hashed, and both were
-- always wrong.
--
-- ISOLATION. The "latest row" read relies on the READ COMMITTED snapshot
-- taken after the lock is acquired, which sees the previous holder's commit.
-- Every writer here (PostgREST, pg_cron, the migrations) runs READ COMMITTED,
-- the cluster default on both stacks. A REPEATABLE READ writer would read a
-- stale tail; none exists, and none should be added.
--
-- Pins that move with this file: the migrations count in
-- scripts/backup/verify-restore.sql (109). No new table, function or job;
-- the trigger's ACL (postgres only) is preserved and asserted.
-- =============================================================================
create or replace function public.trg_events_hash()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare p text;
begin
  -- 0108: serialise this organisation's event inserts for the transaction,
  -- so two concurrent writers cannot both chain onto the same latest row
  perform pg_advisory_xact_lock(hashtext('events_chain'), hashtext(new.org_id::text));

  -- 0109: the identity value the column default assigned was taken BEFORE
  -- the lock; a waiter can hold a lower id than a row the holder writes
  -- after it, and the verifier walks by id. Take the id HERE, under the
  -- lock, so that within one organisation id order is chain order.
  new.id := nextval(pg_get_serial_sequence('public.events', 'id'));

  select hash into p from events where org_id = new.org_id order by id desc limit 1;

  -- The version is OWNED BY THIS TRIGGER, like hash and prev_hash. Whatever a
  -- caller supplied is discarded.
  new.hash_version := 2;
  new.prev_hash    := p;
  new.hash := encode(digest(
    'v2|' ||
    coalesce(p,'') || new.org_id::text || coalesce(new.actor_id::text,'') ||
    new.entity_type || coalesce(new.entity_id::text,'') || new.event_type ||
    new.payload::text ||
    to_char(new.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'sha256'), 'hex');
  return new;
end $function$;

-- the 0101/0108 standard, enforced rather than assumed: a trigger body is
-- callable by nobody over PostgREST
revoke execute on function public.trg_events_hash() from public, anon, authenticated, service_role;

comment on function public.trg_events_hash() is
  'BEFORE INSERT on events and every partition (0061 v2 hash, 0063 partitions, '
  '0108 serialised, 0109 id under the lock): takes a transaction-scoped '
  'advisory lock on the organisation, takes a fresh identity value for the row '
  'UNDER that lock, reads the organisation''s latest hash, and writes '
  'prev_hash, hash and hash_version. The lock keeps two writers from forking '
  'the chain; taking the id under it keeps id order equal to chain order, '
  'which is the order verify_events_chain walks. Callable by nobody over '
  'PostgREST.';

-- ---------------------------------------------------------------------------
-- Apply-time assertions
-- ---------------------------------------------------------------------------
do $$
declare
  v_src    text;
  v_org    uuid;
  v_clean  boolean;
  v_tail   bigint;
  v_bumped bigint;
  v_id     bigint;
  d        record;
  o        record;
  n        int;
  n_bad    int := 0;
begin
  -- the installed body takes the lock, THEN the id
  select prosrc into v_src from pg_proc where proname = 'trg_events_hash';
  if v_src is null
     or position('pg_advisory_xact_lock(hashtext(''events_chain''), hashtext(new.org_id::text))' in v_src) = 0
     or position('new.id := nextval(pg_get_serial_sequence(''public.events'', ''id''))' in v_src) = 0
     or position('new.id := nextval(' in v_src) < position('pg_advisory_xact_lock(' in v_src) then
    raise exception '0109 aborted: the installed trigger does not take the id under the per-organisation lock';
  end if;

  -- the binding survived: the parent and every partition still fire it
  select count(*) into n from pg_trigger t
   where t.tgname = 'events_hash' and not t.tgisinternal
     and t.tgfoid = 'public.trg_events_hash'::regproc;
  if n < 2 then
    raise exception '0109 aborted: events_hash is bound on % relation(s); expected the parent and its partitions', n;
  end if;

  -- the lockdown: a trigger body is callable by nobody over PostgREST
  if has_function_privilege('anon', 'public.trg_events_hash()', 'execute')
     or has_function_privilege('authenticated', 'public.trg_events_hash()', 'execute')
     or has_function_privilege('service_role', 'public.trg_events_hash()', 'execute') then
    raise exception '0109 aborted: trg_events_hash is callable over PostgREST';
  end if;

  -- PRE-EXISTING DAMAGE IS REPORTED, NEVER REWRITTEN: a chain that already
  -- fails is named, with the row and the reason, and left exactly as it is.
  -- This apply does not depend on it — the fix is what stops the next fork.
  for o in select id, name from organizations loop
    select * into d from public.verify_events_chain(o.id, null::bigint);
    if not d.ok then
      n_bad := n_bad + 1;
      raise warning '0109: organisation % (%) already fails verification at events.id % (%) — pre-existing damage, left untouched; a person decides the repair',
        o.id, o.name, d.failed_id, d.reason;
    end if;
  end loop;

  -- it re-takes the id under the lock and still chains: bump the sequence as
  -- a concurrent writer's default would, insert one event on the first
  -- organisation (the 0084 idiom — the row stays, as evidence of the apply),
  -- and the row's id must be newer than both the bump and the chain's tail
  select id into v_org from organizations order by created_at limit 1;
  if v_org is null then
    raise notice '0109: no organization to chain-test against — body, binding and grants checked only';
  else
    select ok into v_clean from public.verify_events_chain(v_org, null::bigint);
    select coalesce(max(id), 0) into v_tail from events where org_id = v_org;
    v_bumped := nextval(pg_get_serial_sequence('public.events', 'id'));
    insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
    values (v_org, null, 'config', null, 'chain_id_under_lock', jsonb_build_object('migration', '0109'))
    returning id into v_id;
    if v_id <= v_bumped then
      raise exception '0109 aborted: the trigger kept the default''s identity value (row id %, sequence was at %)', v_id, v_bumped;
    end if;
    if v_id <= v_tail then
      raise exception '0109 aborted: the new row''s id % is not newer than the organisation''s tail %', v_id, v_tail;
    end if;
    -- a clean chain must stay clean end to end; a damaged one is checked
    -- from the new row only (its link to the row before it), so the apply
    -- proves the trigger without pretending about history
    select * into d from public.verify_events_chain(v_org, case when v_clean then null::bigint else v_id end);
    if d.ok is distinct from true then
      raise exception '0109 aborted: the new row does not verify after the redefinition (id %, reason %)', d.failed_id, d.reason;
    end if;
  end if;

  raise notice '0109: trg_events_hash takes the identity value under the per-organisation lock; id order is chain order. % organisation(s) reported with pre-existing chain damage (0 is the expected number).', n_bad;
end $$;
