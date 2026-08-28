-- 0062 — events_chain_checkpoint + incremental verification. Phase C, C5 step 3.
--
-- `run_chain_checks()` walks EVERY event from genesis, nightly, per org. At 119
-- rows that is free; the point of C5 is that it will not stay free. This makes
-- the nightly pass resume from the last proven position and moves the full walk
-- to weekly.
--
-- ============================================================================
-- READ THIS BEFORE TRUSTING AN INCREMENTAL RESULT.
--
-- A RESUMED WALK DOES NOT RE-PROVE THE PREFIX. Measured on the local stack
-- while building step 1, with a row deliberately corrupted at id 5:
--
--     walk     | ok | failed_id | reason
--     full     | f  |         5 | hash_mismatch
--     resumed  | t  |           |            <- resumed from id 8, saw nothing
--
-- That is not a defect in the resume; it is what checkpointing MEANS. The chain
-- links each row to the STORED hash of its predecessor, so editing a payload
-- and leaving the `hash` column alone does not propagate — row 6 still verifies
-- against row 5's untouched hash. Nothing downstream of a tamper can detect it.
--
-- Three consequences, all built in below:
--
--   1. `last_hash` is a TRUST ANCHOR, not decoration. Every resume re-checks
--      that the anchor row still exists and still carries the hash the last
--      successful walk recorded. That catches an edit to the anchor's `hash`.
--   2. The resume starts AT the anchor, not after it, so the anchor row's own
--      contents are recomputed. That catches a payload edit that left `hash`
--      alone — at the anchor, which is the one prefix row we can still check.
--   3. THE FULL WALK STILL HAPPENS, weekly, and `full_walk_at` records when.
--      Without that column nothing can answer the only question incremental
--      verification creates: how stale is the proof of the part we stopped
--      checking? A five-minute-old incremental `ok` over a year-old prefix
--      proof would otherwise be indistinguishable from a real one.
-- ============================================================================
--
-- THE CHECKPOINT ONLY EVER ADVANCES ON SUCCESS. A failed walk leaves it where
-- it was, so the next run re-attempts from the last KNOWN-GOOD position rather
-- than skipping past the damage. This is also why it is a separate table from
-- `chain_checks` and not two more columns on it: `chain_checks.ok` must record
-- the failure in the same pass that the checkpoint must refuse to move.
--
-- NO FOREIGN KEY TO events.id, DELIBERATELY. C5 step 4 repartitions `events`
-- and changes its primary key to (id, occurred_at); an FK to events(id) would
-- have to be dropped to permit that. `last_id` is a plain bigint, and the
-- anchor check below is what gives it meaning instead.
--
-- run_chain_checks_full() IS A SEPARATE NAME, NOT `run_chain_checks(p_full
-- boolean default false)`. A defaulted argument would CREATE A SECOND FUNCTION
-- rather than replace the first, and the existing zero-argument call — from the
-- 03:30 cron and from RLS test 21 — would then fail at call time with
-- "function is not unique". Exactly the trap 0060's header documents.
--
-- ADDITIVE: one new table, three new functions, one replaced function, one new
-- cron job. Applies before the merge.

-- ---------------------------------------------------------------------------
-- 1. The checkpoint.
-- ---------------------------------------------------------------------------
create table if not exists public.events_chain_checkpoint (
  org_id       uuid primary key references organizations(id),
  last_id      bigint      not null,
  last_hash    text        not null,
  verified_at  timestamptz not null,
  full_walk_at timestamptz
);

comment on table public.events_chain_checkpoint is
  'The furthest point in each org''s event chain that a SUCCESSFUL verification '
  'has reached. Advanced only on success, so a failure leaves the last '
  'known-good anchor in place. Written only by advance_chain_checkpoint.';
comment on column public.events_chain_checkpoint.last_hash is
  'The trust anchor. A resumed walk re-checks that events.id = last_id still '
  'carries this exact hash before believing anything after it.';
comment on column public.events_chain_checkpoint.full_walk_at is
  'When the whole chain was last re-proved from genesis. An incremental pass '
  'does NOT update this. If it is old, the prefix proof is old, however recent '
  'verified_at looks.';

alter table public.events_chain_checkpoint enable row level security;
revoke all on public.events_chain_checkpoint from anon, authenticated;
grant select on public.events_chain_checkpoint to authenticated;

-- `drop policy if exists` before each create, so THE WHOLE FILE IS RE-RUNNABLE.
-- This one is applied to hosted by hand, statement group by statement group
-- (HANDOFF §3), and a failure part-way through would otherwise leave a file
-- that cannot simply be run again.
--
-- Same audience and shape as chain_checks: staff read their own org's row,
-- nothing app-side writes.
drop policy if exists events_chain_checkpoint_select on public.events_chain_checkpoint;
create policy events_chain_checkpoint_select on public.events_chain_checkpoint
  for select using (org_id = (select current_org_id()));

-- A TABLE CREATED AFTER 0029 DOES NOT INHERIT require_aal2. Explicit, and in
-- the exact shape rls_aal2_coverage() demands: RESTRICTIVE, ALL, to
-- authenticated, both USING and WITH CHECK present.
drop policy if exists require_aal2 on public.events_chain_checkpoint;
create policy require_aal2 on public.events_chain_checkpoint
  as restrictive for all to authenticated
  using ((select mfa_satisfied())) with check ((select mfa_satisfied()));

-- ---------------------------------------------------------------------------
-- 2. The one new workhorse: verify, then advance on success.
--
-- p_full = true  -> walk from genesis, and stamp full_walk_at
-- p_full = false -> resume from the anchor; falls back to a full walk when
--                   there is no checkpoint yet, or when the anchor no longer
--                   holds (which is itself reported, not silently swallowed)
-- ---------------------------------------------------------------------------
create or replace function public.advance_chain_checkpoint(p_org uuid, p_full boolean)
returns table (ok boolean, failed_id bigint, reason text, from_id bigint, walked bigint)
language plpgsql security definer
set search_path = public, extensions
set timezone = 'UTC'
as $$
declare
  cp        record;
  anchor    text;
  v_from    bigint := null;
  v_note    text   := null;
  d         record;
  new_id    bigint;
  new_hash  text;
  n_walked  bigint;
begin
  if not p_full then
    select * into cp from events_chain_checkpoint c where c.org_id = p_org;

    if found then
      -- ANCHOR CHECK 1: the anchor row must still be there.
      select e.hash into anchor from events e where e.org_id = p_org and e.id = cp.last_id;

      if anchor is null then
        -- Either deleted or its hash was nulled. Either way the anchor is gone,
        -- so an incremental result would be worthless. Say so and walk it all.
        v_note := 'checkpoint_anchor_missing';
        -- The WARNING matters: run_chain_checks records only `ok`, so without
        -- it a tampered checkpoint over an intact chain would be logged as a
        -- clean pass and the signal would be lost. Nothing app-side can write
        -- this table, so reaching here at all means service_role touched it.
        raise warning '0062: org % checkpoint anchor (id %) is missing — falling back to a full walk',
          p_org, cp.last_id;
      elsif anchor is distinct from cp.last_hash then
        -- ANCHOR CHECK 2: the stored hash no longer matches what the last
        -- successful walk recorded — someone edited the hash column itself.
        v_note := 'checkpoint_anchor_changed';
        raise warning '0062: org % checkpoint anchor (id %) no longer matches the recorded hash — falling back to a full walk',
          p_org, cp.last_id;
      else
        -- Resume AT the anchor, not after it: verify_events_chain seeds `prev`
        -- from the row before p_from_id, so passing last_id recomputes the
        -- anchor's own contents too.
        v_from := cp.last_id;
      end if;
    end if;
  end if;

  select * into d from public.verify_events_chain(p_org, v_from);

  if not d.ok then
    -- The checkpoint is NOT moved. The next run re-attempts from the same
    -- known-good position rather than stepping over the damage.
    return query select false, d.failed_id, coalesce(v_note || '/', '') || d.reason,
                        v_from, 0::bigint;
    return;
  end if;

  select max(e.id) into new_id from events e where e.org_id = p_org;

  if new_id is null then
    -- An org with no events at all: nothing to anchor to. Verified, vacuously.
    return query select true, null::bigint, v_note, v_from, 0::bigint;
    return;
  end if;

  select e.hash into new_hash from events e where e.org_id = p_org and e.id = new_id;
  select count(*) into n_walked from events e
   where e.org_id = p_org and (v_from is null or e.id >= v_from);

  insert into events_chain_checkpoint (org_id, last_id, last_hash, verified_at, full_walk_at)
  values (p_org, new_id, new_hash, now(), case when v_from is null then now() else null end)
  on conflict (org_id) do update
    set last_id      = excluded.last_id,
        last_hash    = excluded.last_hash,
        verified_at  = excluded.verified_at,
        -- a full walk stamps it; an incremental pass must NOT, or the staleness
        -- of the prefix proof becomes invisible
        full_walk_at = coalesce(excluded.full_walk_at, events_chain_checkpoint.full_walk_at);

  return query select true, null::bigint, v_note, v_from, n_walked;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Nightly: incremental. Same zero-argument signature 0016 created, so the
--    03:30 cron job and RLS test 21 do not move.
-- ---------------------------------------------------------------------------
create or replace function public.run_chain_checks() returns void
language plpgsql security definer set search_path = public as $$
declare o record; d record;
begin
  for o in select id from organizations loop
    select * into d from public.advance_chain_checkpoint(o.id, false);
    insert into chain_checks (org_id, checked_at, ok)
    values (o.id, now(), d.ok)
    on conflict (org_id) do update
      set checked_at = excluded.checked_at, ok = excluded.ok;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Weekly: the real thing, from genesis.
-- ---------------------------------------------------------------------------
create or replace function public.run_chain_checks_full() returns void
language plpgsql security definer set search_path = public as $$
declare o record; d record;
begin
  for o in select id from organizations loop
    select * into d from public.advance_chain_checkpoint(o.id, true);
    insert into chain_checks (org_id, checked_at, ok)
    values (o.id, now(), d.ok)
    on conflict (org_id) do update
      set checked_at = excluded.checked_at, ok = excluded.ok;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 5. GRANTS. New functions carry a PUBLIC =X grant. 0019's reasoning applies:
--    a walk is O(events), so nothing reachable from a browser session may
--    trigger one on demand. service_role only, matching run_chain_checks.
-- ---------------------------------------------------------------------------
revoke execute on function public.advance_chain_checkpoint(uuid, boolean) from public, anon, authenticated;
grant  execute on function public.advance_chain_checkpoint(uuid, boolean) to service_role;
revoke execute on function public.run_chain_checks_full() from public, anon, authenticated;
grant  execute on function public.run_chain_checks_full() to service_role;
revoke execute on function public.run_chain_checks() from public, anon, authenticated;
grant  execute on function public.run_chain_checks() to service_role;

-- ---------------------------------------------------------------------------
-- 6. Cron. 03:30 nightly stays and is now incremental; the full walk runs
--    Sundays at 03:35, in the gap before expire-reservations (03:45).
-- ---------------------------------------------------------------------------
-- cron.schedule upserts by jobname, so this is idempotent on a re-apply.
select cron.schedule('verify-events-chain-full', '35 3 * * 0',
                     $$select run_chain_checks_full()$$);

-- Seed the anchors with a full walk, so the first nightly pass has something to
-- resume from and full_walk_at is honest from the start.
select run_chain_checks_full();

-- ---------------------------------------------------------------------------
-- 7. Prove it, against whatever data this database holds.
-- ---------------------------------------------------------------------------
do $$
declare
  o             record;
  d             record;
  cp            record;
  n_orgs        int := 0;
  probe_org     uuid;
  full_walk_was timestamptz;
  probed        text := 'skipped (no org with events)';
begin
  -- (a) the seeding full walk left every org with events anchored and verified
  for o in select id, name from organizations loop
    n_orgs := n_orgs + 1;

    if exists (select 1 from events where org_id = o.id) then
      select * into cp from events_chain_checkpoint where org_id = o.id;
      if not found then
        raise exception '0062: org % (%) has events but no checkpoint', o.id, o.name;
      end if;
      if cp.full_walk_at is null then
        raise exception '0062: org % anchored without a full walk recorded', o.id;
      end if;
      if cp.last_hash is distinct from
         (select hash from events where org_id = o.id and id = cp.last_id) then
        raise exception '0062: org % anchor hash does not match the row it names', o.id;
      end if;
    end if;
  end loop;

  -- Alias is `org`, not `o`: `o` is the record variable above, and plpgsql
  -- resolves `o.id` to the VARIABLE, raising "column reference is ambiguous".
  -- 0046's first version shipped an unverified constraint to exactly this.
  select org.id into probe_org from organizations org
   where exists (select 1 from events e where e.org_id = org.id)
   order by org.created_at limit 1;

  if probe_org is not null then
    begin
      select c.full_walk_at into full_walk_was
        from events_chain_checkpoint c where c.org_id = probe_org;

      -- (b) an incremental pass over an unchanged chain succeeds, actually
      --     resumes (from_id is set), and does NOT restamp full_walk_at
      select * into d from public.advance_chain_checkpoint(probe_org, false);
      if not d.ok then
        raise exception '0062: incremental pass failed on an unchanged chain — id=% reason=%',
          d.failed_id, d.reason;
      end if;
      if d.from_id is null then
        raise exception '0062: incremental pass fell back to a full walk despite a valid anchor';
      end if;
      if (select c.full_walk_at from events_chain_checkpoint c where c.org_id = probe_org)
         is distinct from full_walk_was then
        raise exception '0062: an incremental pass restamped full_walk_at — prefix staleness would become invisible';
      end if;

      -- (c) a broken anchor must force a full walk, not be resumed past
      update events_chain_checkpoint set last_hash = 'deadbeef' where org_id = probe_org;
      select * into d from public.advance_chain_checkpoint(probe_org, false);
      if d.from_id is not null then
        raise exception '0062: a broken anchor did not force a full walk';
      end if;
      if not d.ok then
        raise exception '0062: the fallback full walk failed — id=% reason=%', d.failed_id, d.reason;
      end if;
      if d.reason is distinct from 'checkpoint_anchor_changed' then
        raise exception '0062: a broken anchor was not reported (reason=%)', d.reason;
      end if;

      probed := 'PASSED — resume honoured a valid anchor, refused and reported a '
             || 'broken one, and left full_walk_at alone';

      raise exception using errcode = 'YY062', message = 'rollback the 0062 probe';
    exception
      when sqlstate 'YY062' then null;   -- specific: a real failure still propagates
    end;
  end if;

  raise notice '0062: checkpoints live. % org(s). Probe: %', n_orgs, probed;
end $$;

-- The probe's writes were inside a subtransaction and unwound with it, so the
-- shipped anchors are the ones the seeding full walk above left. ASSERT that
-- rather than re-seeding over it — a redundant re-seed would hide the case
-- where the subtransaction did not scope the way this file claims.
do $$
declare cp record; bad int := 0;
begin
  for cp in select c.*, (select e.hash from events e
                          where e.org_id = c.org_id and e.id = c.last_id) as live_hash
              from events_chain_checkpoint c loop
    if cp.full_walk_at is null or cp.last_hash is distinct from cp.live_hash then
      bad := bad + 1;
      raise warning '0062: org % left with a bad anchor after the probe (full_walk_at=%, hash match=%)',
        cp.org_id, cp.full_walk_at, (cp.last_hash is not distinct from cp.live_hash);
    end if;
  end loop;
  if bad > 0 then
    raise exception '0062: % checkpoint(s) did not survive the probe rollback intact', bad;
  end if;
  raise notice '0062: post-probe check — every anchor intact and stamped with a full walk.';
end $$;
