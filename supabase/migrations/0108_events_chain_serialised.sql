-- =============================================================================
-- 0108 — the events hash chain is serialised per organisation
--        (found 2026-09-22 by 0107's concurrency test; audit 2026-09-22)
--
-- THE DEFECT. `trg_events_hash` (0061, rebound on every partition by 0063)
-- builds a row's prev_hash from "the organisation's latest event" — a plain
-- SELECT, under no lock. Two transactions inserting events for the same
-- organisation at the same instant both read the same latest row, both chain
-- onto it, and the second to commit is a FORK: verify_events_chain() answers
-- prev_hash_mismatch at that row, every later row is unverifiable, and the
-- only repair is deleting the evidence after the fork.
--
-- MEASURED on the local stack, 2026-09-22 22:07:24Z: six concurrent
-- submit_public_enquiry calls in the suite's fixture org wrote two
-- lead/created events 0.8 ms apart carrying the same prev_hash; the 282 rows
-- after them stopped verifying and 25 tests in the database suite went red
-- on a chain nobody had tampered with. In production two staff acting in the
-- same organisation inside one transaction's window would do the same, and
-- the nightly chain check would report damage that nobody caused and nobody
-- can undo without deleting evidence.
--
-- THE FIX. One line: before reading the latest hash the trigger takes a
-- transaction-scoped advisory lock keyed on the organisation, so event
-- inserts for one organisation serialise for the rest of the transaction —
-- the next writer waits for the commit and then reads the NEW latest row.
-- Other organisations are untouched. The hash expression is byte for byte
-- the one 0061 wrote, so nothing already minted changes its meaning and
-- verify_events_chain() is not touched. pg_advisory_xact_lock is released at
-- commit or rollback: no path can leak a lock.
--
-- COST, STATED: event writers in one organisation queue behind each other
-- for the duration of their transactions. For a desk of two that is
-- nothing; the alternative is unrepairable evidence. The concurrency proof
-- lives in supabase/tests/lead-escalation.test.ts (six parallel door calls,
-- three parallel sweeps, then the chain must verify) — a single session
-- cannot race itself, so this file's own self-test proves only that the
-- trigger still fires and chains after the redefinition.
--
-- Pins that move with this file: the migrations count in
-- scripts/backup/verify-restore.sql (108). No new table, function or job;
-- the trigger's ACL (postgres only, the 0021 lockdown) is preserved by
-- create or replace and asserted below.
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

comment on function public.trg_events_hash() is
  'BEFORE INSERT on events and every partition (0061 v2 hash, 0063 partitions, '
  '0108 serialised): takes a transaction-scoped advisory lock on the '
  'organisation, reads its latest hash, and writes prev_hash, hash and '
  'hash_version. The lock is what keeps two concurrent writers from forking '
  'the chain. Callable by nobody over PostgREST.';

-- ---------------------------------------------------------------------------
-- Apply-time assertions
-- ---------------------------------------------------------------------------
do $$
declare
  v_org uuid;
  v_ok  boolean;
  n     int;
begin
  -- the lock is in the installed body
  if not exists (select 1 from pg_proc where proname = 'trg_events_hash'
                    and prosrc like '%pg_advisory_xact_lock(hashtext(''events_chain''), hashtext(new.org_id::text))%') then
    raise exception '0108 aborted: the installed trigger does not take the per-organisation lock';
  end if;

  -- the binding survived: the parent and every partition still fire it
  select count(*) into n from pg_trigger t
   where t.tgname = 'events_hash' and not t.tgisinternal
     and t.tgfoid = 'public.trg_events_hash'::regproc;
  if n < 2 then
    raise exception '0108 aborted: events_hash is bound on % relation(s); expected the parent and its partitions', n;
  end if;

  -- the 0021 lockdown: a trigger body is callable by nobody over PostgREST
  if has_function_privilege('anon', 'public.trg_events_hash()', 'execute')
     or has_function_privilege('authenticated', 'public.trg_events_hash()', 'execute')
     or has_function_privilege('service_role', 'public.trg_events_hash()', 'execute') then
    raise exception '0108 aborted: trg_events_hash is callable over PostgREST';
  end if;

  -- it still fires and still chains: one event on the first organisation
  -- (the 0084 idiom — the row stays, as evidence of the apply), then the
  -- organisation's whole chain must verify
  select id into v_org from organizations order by created_at limit 1;
  if v_org is null then
    raise notice '0108: no organization to chain-test against — body, binding and grants checked only';
  else
    insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
    values (v_org, null, 'config', null, 'chain_serialised', jsonb_build_object('migration', '0108'));
    select t.ok into v_ok from verify_events_chain(v_org, null::bigint) t limit 1;
    if v_ok is distinct from true then
      raise exception '0108 aborted: the chain of the first organisation does not verify after the redefinition';
    end if;
  end if;

  raise notice '0108: trg_events_hash takes a per-organisation transaction lock before reading the latest hash; concurrent event writers can no longer fork the chain.';
end $$;
