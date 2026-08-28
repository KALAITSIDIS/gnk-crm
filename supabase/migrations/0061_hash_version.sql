-- 0061 — hash_version, and the end of the timezone landmine. Phase C, C5 step 2.
--
-- THE BUG, reproduced on the local stack before this was written. The same
-- INTACT data, three session timezones:
--
--   set time zone 'UTC';              verify_events_chain -> ok
--   set time zone 'Asia/Nicosia';     verify_events_chain -> FAILS at id 3
--   set time zone 'America/New_York'; verify_events_chain -> FAILS at id 3
--
-- Note the timezone in the middle. `Asia/Nicosia` is THIS DESK'S OWN timezone —
-- the failure is not an exotic edge case, it is what happens the first time
-- anybody connects with the local zone set. BACKUP_RESTORE §1.3 records the
-- same thing from the restore drill.
--
-- The cause is one term in the hashed material: `occurred_at::text` renders
-- through the session `TimeZone` GUC.
--
--   UTC      -> 2026-08-28 09:08:46.892006+00
--   Nicosia  -> 2026-08-28 12:08:46.892006+03
--
-- Measured, so the fix is aimed at the right term: `payload::text` (jsonb,
-- including floats, numerics, unicode and date-like strings), `org_id::text`,
-- `actor_id::text` and `entity_id::text` are all byte-stable under DateStyle,
-- lc_numeric, extra_float_digits AND TimeZone. `occurred_at::text` is the only
-- session-dependent term in the formula.
--
-- ============================================================================
-- WHY A VERSION COLUMN AND NOT A REWRITE.
--
-- Changing the formula invalidates every hash already written, and those
-- hashes ARE the commission evidence — the PDFs in Storage re-hash to values
-- recorded in `events` (BACKUP_RESTORE §5). Re-minting them would produce a
-- chain that verifies happily against invented values, which is the one
-- failure this system exists to prevent.
--
-- So: `hash_version smallint not null default 1`. Existing rows are v1 and
-- keep the formula they were minted with, forever. New rows are v2 and hash a
-- canonical UTC rendering. `verify_events_chain` dispatches per row, so a
-- chain that spans the boundary verifies end to end.
-- ============================================================================
--
-- THE v2 RENDERING IS ISO-8601 UTC, NOT EPOCH MICROSECONDS.
--
-- docs/PHASE_C_BRIEF.md §2 suggests epoch microseconds. Both are canonical and
-- both were measured byte-identical across TimeZone, DateStyle and lc_time, so
-- either satisfies the requirement. ISO-8601 is chosen because THIS HASH IS
-- EVIDENCE: someone re-deriving it years later, in another language, during a
-- dispute, can see `2026-08-28T09:08:46.892006Z` in the material and know
-- exactly what was hashed. `1787908126892006` additionally requires them to
-- know the epoch and the unit, and to get both right.
--
-- (The other candidate's one real hazard was checked rather than assumed:
-- `extract(epoch …)` returned `double precision` before PG 14 and `numeric`
-- since. For timestamps in this century both paths produce the same bigint —
-- the values are below 2^53 — so that hazard is real in principle and does not
-- bite here. It is not the reason for the choice; readability is.)
--
-- v2 material is domain-separated with a leading `v2|`, so a row cannot be
-- relabelled between versions and re-verified. A v1 material can never begin
-- with `v2|`: it begins with either a hex hash or a uuid.
--
-- ============================================================================
-- verify_events_chain NOW PINS `TimeZone` TO UTC, AND THAT FIXES v1 TOO.
--
-- v1 hashes stay timezone-dependent by construction — they are frozen. But the
-- verifier no longer has to be run in the right session to read them correctly:
-- pinning the GUC on the function means a v1 row is always recomputed under the
-- zone it was minted in. Production and CI have always run UTC, which is
-- exactly why the chain reads true there and false under Nicosia.
--
-- So this migration fixes the symptom for every row that already exists, and
-- fixes the cause for every row written from now on.
--
-- `trg_events_hash` DELIBERATELY DOES NOT PIN UTC. Pinning it would make the
-- timezone-independence test below vacuous — it would pass even if the v2
-- formula were still session-dependent. The test inserts under a non-UTC zone
-- and verifies under UTC, which only passes if the formula is genuinely
-- canonical.
--
-- ============================================================================
-- NO CHECK CONSTRAINT ON hash_version, DELIBERATELY.
--
-- `check (hash_version in (1,2))` would have to be REWRITTEN to add a v3, and
-- this repo has already learned where that leads: 0045, 0046 and 0048 each
-- widened `tasks_kind_chk` to add one string, 0046's first attempt went in
-- UNVERIFIED, and 0049 replaced the whole pattern with a lookup table. A
-- verifier that refuses what it does not understand is the better shape, so an
-- unrecognised version returns `unknown_hash_version` against its own row.
--
-- Nothing can write a bad value in normal operation regardless: the trigger
-- overwrites `hash_version` on every insert, exactly as it does `hash` and
-- `prev_hash`. Reaching a bad value requires a service-role UPDATE, which IS a
-- tamper, and the verifier names it.
--
-- ADDITIVE. A new nullable-by-default column, two function bodies. Applies
-- before the merge.

-- ---------------------------------------------------------------------------
-- 1. The column. `default 1` is a metadata-only default in PG 11+, so no table
--    rewrite: every existing row reads 1 without being touched.
-- ---------------------------------------------------------------------------
alter table public.events
  add column if not exists hash_version smallint not null default 1;

comment on column public.events.hash_version is
  'Which formula minted this row''s hash. 1 = the 0001 formula, whose '
  'occurred_at term renders through the session TimeZone. 2 = 0061 onward: '
  'domain-separated and hashing occurred_at as ISO-8601 UTC. Set by '
  'trg_events_hash, never by a caller. verify_events_chain dispatches on it.';

-- ---------------------------------------------------------------------------
-- 2. The trigger mints v2 from now on.
-- ---------------------------------------------------------------------------
create or replace function public.trg_events_hash() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare p text;
begin
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
end $$;

-- ---------------------------------------------------------------------------
-- 3. Verification dispatches per row, under a pinned UTC.
-- ---------------------------------------------------------------------------
create or replace function public.verify_events_chain(p_org uuid, p_from_id bigint)
returns table (ok boolean, failed_id bigint, reason text)
language plpgsql stable security definer
set search_path = public, extensions
set timezone = 'UTC'
as $$
declare
  r        record;
  prev     text := null;
  expected text;
begin
  if p_from_id is not null then
    select e.hash into prev
      from events e
     where e.org_id = p_org and e.id < p_from_id
     order by e.id desc
     limit 1;
  end if;

  for r in
    select * from events e
     where e.org_id = p_org
       and (p_from_id is null or e.id >= p_from_id)
     order by e.id
  loop
    if r.hash is null then
      return query select false, r.id, 'null_hash'::text;
      return;
    end if;

    if r.prev_hash is distinct from prev then
      return query select false, r.id, 'prev_hash_mismatch'::text;
      return;
    end if;

    if r.hash_version = 1 then
      -- FROZEN. Do not touch this expression: it is the only thing that can
      -- still read evidence minted before 0061. The `occurred_at::text` here
      -- is the bug — it is correct only because the function pins UTC.
      expected := encode(digest(
        coalesce(prev,'') || r.org_id::text || coalesce(r.actor_id::text,'') ||
        r.entity_type || coalesce(r.entity_id::text,'') || r.event_type ||
        r.payload::text || r.occurred_at::text, 'sha256'), 'hex');

    elsif r.hash_version = 2 then
      expected := encode(digest(
        'v2|' ||
        coalesce(prev,'') || r.org_id::text || coalesce(r.actor_id::text,'') ||
        r.entity_type || coalesce(r.entity_id::text,'') || r.event_type ||
        r.payload::text ||
        to_char(r.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'sha256'), 'hex');

    else
      return query select false, r.id, 'unknown_hash_version'::text;
      return;
    end if;

    if r.hash is distinct from expected then
      return query select false, r.id, 'hash_mismatch'::text;
      return;
    end if;

    prev := r.hash;
  end loop;

  return query select true, null::bigint, null::text;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Grants. `create or replace` preserves the ACL; assert rather than assume.
-- ---------------------------------------------------------------------------
revoke execute on function public.verify_events_chain(uuid, bigint) from public, anon, authenticated;
grant  execute on function public.verify_events_chain(uuid, bigint) to service_role;
revoke execute on function public.trg_events_hash() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Prove it, on whatever data this database holds.
--
-- The v2 probe runs in a SUBTRANSACTION and is rolled back, because `events` is
-- append-only and hash-chained: deleting the probe row afterwards would either
-- break the chain or work only by the accident of it being last. The idiom and
-- the reasoning are 0051's and 0053's.
-- ---------------------------------------------------------------------------
do $$
declare
  probe_org uuid;
  n_rows    bigint;
  n_v1      bigint;
  n_v2      bigint;
  d         record;
  probed    text := 'skipped (no organizations)';
begin
  select count(*), count(*) filter (where hash_version = 1), count(*) filter (where hash_version = 2)
    into n_rows, n_v1, n_v2 from events;

  -- (a) every existing chain still verifies, and now does so under ANY zone
  for probe_org in select id from organizations loop
    select * into d from public.verify_events_chain(probe_org, null::bigint);
    if not d.ok then
      raise exception '0061: org % no longer verifies — failed_id=% reason=%',
        probe_org, d.failed_id, d.reason;
    end if;
  end loop;

  -- (b) a v2 row, written under a DELIBERATELY WRONG session zone, must verify
  select id into probe_org from organizations order by created_at limit 1;
  if probe_org is not null then
    begin
      set local timezone = 'Pacific/Kiritimati';   -- UTC+14, as unlike UTC as it gets

      insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
      values (probe_org, null, 'config', null, 'hash_version_probe',
              jsonb_build_object('migration', '0061', 'note', 'rolled back'));

      set local timezone = 'UTC';

      select * into d from public.verify_events_chain(probe_org, null::bigint);
      if not d.ok then
        raise exception
          '0061: a v2 row written under UTC+14 does not verify under UTC — failed_id=% reason=%. '
          'The v2 formula is still session-dependent; DO NOT SHIP.', d.failed_id, d.reason;
      end if;

      if (select hash_version from events where org_id = probe_org order by id desc limit 1) <> 2 then
        raise exception '0061: the trigger did not stamp hash_version = 2';
      end if;

      probed := 'PASSED — v2 row minted under Pacific/Kiritimati verifies under UTC, '
             || 'in a chain whose earlier rows are v1';

      -- unwind the probe: the row, its hash and the identity bump all go
      raise exception using errcode = 'YY061', message = 'rollback the 0061 probe';
    exception
      when sqlstate 'YY061' then null;   -- specific: a real failure still propagates
    end;
  end if;

  raise notice '0061: hash_version live. % event(s): % v1, % v2. Probe: %',
    n_rows, n_v1, n_v2, probed;
end $$;
