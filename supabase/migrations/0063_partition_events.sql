-- 0063 — events becomes monthly RANGE-partitioned on occurred_at.
-- Phase C, C5 step 4. THE LAST AND RISKIEST STEP: it rewrites the evidence
-- spine. Read the safety net section before changing anything here.
--
-- Postgres cannot convert a table to partitioned in place, so this renames the
-- original aside, builds a partitioned table under the same name, copies every
-- row with its hash intact, and PROVES the copy is byte-identical before
-- anything else happens.
--
-- ============================================================================
-- UNLIKE 0060-0062, THIS FILE IS NOT RE-RUNNABLE, and cannot usefully be made
-- so: a rename-and-copy has no idempotent form (a second run would rename the
-- NEW table aside and copy it onto itself). Applying it by hand to hosted means
-- applying each numbered section once, in order, checking the result of each
-- before the next — and section 8 is the gate. If a section fails part-way, do
-- not re-run the file; the undo is: drop the partitioned `events`, drop schema
-- `events_parts`, rename `events_pre_partition` back, and rename its three
-- indexes and one constraint back. That undo was exercised twice while writing
-- this, and each time the fingerprint came back 9d3420a8… unchanged.
-- ============================================================================
--
-- ============================================================================
-- THE OLD TABLE IS NOT DROPPED HERE. That is migration 0064, applied only
-- after the deploy is confirmed, per the standing deploy-order rule. Until then
-- `public.events_pre_partition` is a complete, untouched rollback copy of the
-- most valuable table in the system. It is revoked from anon and authenticated
-- so it is invisible to PostgREST in the meantime.
-- ============================================================================
--
-- THE SAFETY NET IS A CHAIN FINGERPRINT, NOT A ROW COUNT. The C6 restore drill
-- (BACKUP_RESTORE §5) established that counts prove nothing here: an org whose
-- chain read `true` at source came back `false` with identical row counts. So
-- the assertion below compares `md5(string_agg(hash order by id))` before and
-- after, which is the only check that would notice a payload that changed shape
-- in transit, and re-verifies every org's chain on top.
--
-- ============================================================================
-- PARTITIONS LIVE IN THE `events_parts` SCHEMA, NOT IN `public`. MEASURED, not
-- assumed — a partition is a table and inherits none of the parent's
-- protection:
--
--   probe_parts.p_aug   rls=f  acl=(no explicit acl)
--   public.p_sep        rls=f  acl=... anon=Dxtm | authenticated=Dxtm ...
--
-- `pg_default_acl` in this database grants `anon=Dxtm` and `authenticated=Dxtm`
-- on every table `postgres` creates IN PUBLIC. `D` is TRUNCATE, and RLS DOES
-- NOT GATE TRUNCATE. A partition in `public` would therefore hand anon the
-- ability to truncate a month of the audit log — and the monthly job below
-- would mint a fresh one of those every month. Outside `public` no default ACL
-- applies at all.
--
-- IT IS NOT ABOUT POSTGREST, and the first draft of this comment said it was.
-- Measured instead of assumed: a partition moved INTO `public` and explicitly
-- granted `select` to anon is STILL refused by PostgREST after a full restart —
--   {"code":"PGRST205","message":"Could not find the table
--    'public.events_2026_08' in the schema cache"}
-- PostgREST excludes partitions from its schema cache, so they were never an
-- API surface in the first place. The grants are the whole risk, and the schema
-- is what removes it.
--
-- Also measured, because the migration depends on all three:
--   * the PARENT's policies cover rows living in partitions (1 of 3 rows
--     visible through the parent under an org-scoped policy);
--   * enabling RLS on a partition that has no policies of its own does NOT
--     block inserts or selects routed through the parent;
--   * a DEFAULT partition catches a date outside every range instead of
--     erroring, which is what stops a back-dated write becoming an outage.
--
-- ============================================================================
-- WHAT THE NEW PRIMARY KEY GIVES UP, which the brief does not mention.
--
-- PK becomes (id, occurred_at) because Postgres requires the partition key in
-- any unique index on a partitioned table. THAT NO LONGER ENFORCES `id` UNIQUE
-- ON ITS OWN, and `verify_events_chain` orders by id — duplicate ids would make
-- the walk order ambiguous.
--
-- In practice nothing can produce one: `id` is GENERATED ALWAYS, so a writer
-- must say OVERRIDING SYSTEM VALUE to supply it, and PostgREST never does. The
-- exposure is the restore path (which legitimately supplies ids) and anything
-- running as service_role. So it is DETECTED rather than assumed:
-- events_partition_health() reports duplicates, and the RLS suite asserts the
-- function returns nothing.
--
-- ============================================================================
-- MONOTONICITY. The chain is ordered by `id`; partitioning keys on
-- `occurred_at`. They agree only while inserts are monotonic in both. Asserted
-- below at migration time, and reported ongoing by events_partition_health().
--
-- IT IS DELIBERATELY NOT ENFORCED. A trigger rejecting a back-dated
-- occurred_at would refuse a legitimate write, and the chain still verifies
-- when they diverge because it orders by id only. What breaks is any future
-- optimisation assuming "later partition ⇒ later id", so the invariant is
-- something to WATCH, not something to impose. Measured on production before
-- writing this: 0 inversions, and no writer in the codebase sets occurred_at
-- at all — every insert takes `default now()`. The one place it is written
-- explicitly is the restore path, which replays id and occurred_at together.

-- ---------------------------------------------------------------------------
-- 1. Refuse to run if the invariant does not hold, and remember the fingerprint.
-- ---------------------------------------------------------------------------
create table if not exists public._events_partition_fingerprint (
  taken_at    timestamptz not null default now(),
  n_rows      bigint      not null,
  fingerprint text
);
truncate public._events_partition_fingerprint;

do $$
declare inversions bigint; dup_ids bigint;
begin
  select count(*) into inversions from (
    select occurred_at, lag(occurred_at) over (order by id) as prev from public.events
  ) t where t.occurred_at < t.prev;

  if inversions > 0 then
    raise exception
      '0063: % row(s) have occurred_at going BACKWARDS against id. Partitioning keys on '
      'occurred_at while the chain walks by id; investigate before partitioning.', inversions;
  end if;

  select count(*) into dup_ids from (
    select id from public.events group by id having count(*) > 1
  ) t;
  if dup_ids > 0 then
    raise exception '0063: % duplicate event id(s) — the chain walk order is already ambiguous', dup_ids;
  end if;

  insert into public._events_partition_fingerprint (n_rows, fingerprint)
  select count(*), md5(coalesce(string_agg(hash, '' order by id), '')) from public.events;

  raise notice '0063: pre-flight ok — % row(s), fingerprint %',
    (select n_rows from public._events_partition_fingerprint),
    (select fingerprint from public._events_partition_fingerprint);
end $$;

-- ---------------------------------------------------------------------------
-- 2. Move the original aside and take it off the API.
-- ---------------------------------------------------------------------------
alter table public.events rename to events_pre_partition;
revoke all on public.events_pre_partition from anon, authenticated;

-- RENAMING A TABLE DOES NOT RENAME ITS INDEXES OR CONSTRAINTS, and they share a
-- namespace with the new table's. Without this, `create index events_entity_idx`
-- below fails with "relation already exists" (measured), and the primary key
-- and foreign key silently land as `events_pkey1` / `events_org_id_fkey1` —
-- leaving the canonical names attached to the copy that 0064 deletes.
alter index       public.events_pkey            rename to events_pre_partition_pkey;
alter index       public.events_entity_idx      rename to events_pre_partition_entity_idx;
alter index       public.events_time_idx        rename to events_pre_partition_time_idx;
alter table       public.events_pre_partition
  rename constraint events_org_id_fkey to events_pre_partition_org_id_fkey;

comment on table public.events_pre_partition is
  'ROLLBACK COPY, dropped by 0064 once the 0063 deploy is confirmed. The '
  'unpartitioned events table exactly as it stood before 0063. Revoked from '
  'anon and authenticated so PostgREST cannot see it.';

-- ---------------------------------------------------------------------------
-- 3. The partitioned table, under the original name.
-- ---------------------------------------------------------------------------
create schema if not exists events_parts;
comment on schema events_parts is
  'Monthly partitions of public.events. NOT in public, and that is load-bearing: '
  'pg_default_acl grants anon and authenticated Dxtm (which includes TRUNCATE, '
  'which RLS does not gate) on every table postgres creates in public, and '
  'PostgREST exposes public. Neither applies here.';

create table public.events (
  id           bigint      generated always as identity,
  org_id       uuid        not null references organizations(id),
  occurred_at  timestamptz not null default now(),
  actor_id     uuid,
  entity_type  text        not null,
  entity_id    uuid,
  event_type   text        not null,
  payload      jsonb       not null default '{}',
  prev_hash    text,
  hash         text,
  hash_version smallint    not null default 1,
  primary key (id, occurred_at)
) partition by range (occurred_at);

comment on column public.events.hash_version is
  'Which formula minted this row''s hash. 1 = the 0001 formula, whose '
  'occurred_at term renders through the session TimeZone. 2 = 0061 onward: '
  'domain-separated and hashing occurred_at as ISO-8601 UTC. Set by '
  'trg_events_hash, never by a caller. verify_events_chain dispatches on it.';

-- ---------------------------------------------------------------------------
-- 4. Partition maintenance. Every partition is created HERE, so the revoke and
--    the RLS enable happen in one place rather than being remembered monthly.
-- ---------------------------------------------------------------------------
create or replace function public.ensure_events_partitions(
  p_from date default null, p_months_ahead int default 3)
returns int
language plpgsql security definer set search_path = public as $$
declare m date; hi date; part text; made int := 0;
begin
  -- Default window is a small sliding one. The migration passes the real
  -- earliest month once; after that the monthly job only has to keep ahead,
  -- so this never has to scan the table to find min(occurred_at).
  m  := coalesce(p_from, (date_trunc('month', now()) - interval '1 month')::date);
  m  := date_trunc('month', m)::date;
  hi := (date_trunc('month', now()) + make_interval(months => p_months_ahead))::date;

  while m <= hi loop
    part := 'events_' || to_char(m, 'YYYY_MM');
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'events_parts' and c.relname = part
    ) then
      execute format(
        'create table events_parts.%I partition of public.events for values from (%L) to (%L)',
        part, m, (m + interval '1 month')::date);
      -- Defence in depth. The schema already carries no default ACL, but a
      -- partition that is ever moved into public must not become readable or
      -- truncatable by doing so.
      execute format('alter table events_parts.%I enable row level security', part);
      execute format('revoke all on events_parts.%I from public, anon, authenticated', part);
      -- Explicit deny, not just "RLS on with no policies". Same behaviour, but
      -- it states the intent in the catalog and keeps `get_advisors` quiet:
      -- without it every partition raises rls_enabled_no_policy, one more every
      -- month forever, and an advisor nobody can read is an advisor nobody
      -- checks — which is what HANDOFF §3 says caused 0021.
      --
      -- SAFE BECAUSE PARTITION POLICIES DO NOT GOVERN PARENT-ROUTED ACCESS.
      -- Measured, not assumed: the full RLS suite (64 tests, real authenticated
      -- sessions reading and writing events) is green with this policy on every
      -- partition.
      execute format(
        'create policy deny_direct_access on events_parts.%I for all using (false) with check (false)',
        part);
      made := made + 1;
    end if;
    m := (m + interval '1 month')::date;
  end loop;

  return made;
end $$;

comment on function public.ensure_events_partitions(date, int) is
  'Creates any missing monthly partitions of public.events up to N months '
  'ahead, each with RLS enabled and every app role revoked. Run monthly by '
  'pg_cron. Falling behind is not an outage — the DEFAULT partition catches '
  'anything unclaimed — but events_partition_health() reports rows that land '
  'there, because a row in DEFAULT loses the pruning the partitioning is for.';

-- Cover the real data, then a look-ahead.
do $$
declare first_month date; n int;
begin
  select date_trunc('month', min(occurred_at))::date into first_month
    from public.events_pre_partition;
  n := public.ensure_events_partitions(first_month, 12);
  raise notice '0063: created % monthly partition(s) from % forward', n, first_month;
end $$;

-- THE DEFAULT PARTITION IS THE THING THAT STOPS A MISSING MONTH BEING AN
-- OUTAGE. Without it an insert whose occurred_at falls outside every range
-- raises, and events are written on the same code path as every mutation in
-- the app — so a missing partition would fail the user's save, not just the log.
create table if not exists events_parts.events_default partition of public.events default;
alter table events_parts.events_default enable row level security;
revoke all on events_parts.events_default from public, anon, authenticated;
drop policy if exists deny_direct_access on events_parts.events_default;
create policy deny_direct_access on events_parts.events_default
  for all using (false) with check (false);

-- ---------------------------------------------------------------------------
-- 5. Copy. The hash trigger does not exist on the new table yet, which is what
--    stops it recomputing every hash — the same guard the restore path gets
--    from session_replication_role (scripts/backup/restore.mjs §1).
-- ---------------------------------------------------------------------------
insert into public.events (
  id, org_id, occurred_at, actor_id, entity_type, entity_id,
  event_type, payload, prev_hash, hash, hash_version)
overriding system value
select id, org_id, occurred_at, actor_id, entity_type, entity_id,
       event_type, payload, prev_hash, hash, hash_version
  from public.events_pre_partition
 order by id;

-- The new table has its own identity sequence; advance it past what was copied
-- or the first write after this migration collides.
do $$
declare seq text; hi bigint;
begin
  seq := pg_get_serial_sequence('public.events', 'id');
  select max(id) into hi from public.events;
  perform setval(seq, coalesce(hi, 1), hi is not null);
  raise notice '0063: identity sequence % set to % (is_called=%)', seq, coalesce(hi,1), hi is not null;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Everything that hung off the original. Indexes created on the parent are
--    created on every partition automatically, now and in future.
-- ---------------------------------------------------------------------------
create index events_entity_idx on public.events (org_id, entity_type, entity_id, occurred_at);
create index events_time_idx   on public.events (org_id, occurred_at desc);

create trigger events_hash before insert on public.events
  for each row execute function public.trg_events_hash();

alter table public.events enable row level security;

-- Grants, explicitly. A new table in public picks up anon=Dxtm and
-- authenticated=Dxtm from pg_default_acl; the target is authenticated=ar and
-- no anon at all, which is what the original carried.
revoke all on public.events from public, anon, authenticated;
grant select, insert on public.events to authenticated;

create policy events_select on public.events for select
  using ((org_id = (select current_org_id()))
         and (((select current_role_gnk()) = 'admin'::user_role)
              or (actor_id = (select auth.uid()))));

create policy events_insert on public.events for insert
  with check (org_id = (select current_org_id()));

create policy require_aal2 on public.events
  as restrictive for all to authenticated
  using ((select mfa_satisfied())) with check ((select mfa_satisfied()));

-- ---------------------------------------------------------------------------
-- 7. Ongoing health: the invariants partitioning makes possible to break.
-- ---------------------------------------------------------------------------
create or replace function public.events_partition_health()
returns table (problem text, detail text)
language sql stable security definer set search_path = public as $$
  -- occurred_at going backwards against id: the chain still verifies (it walks
  -- by id) but "later partition => later id" stops holding
  select 'occurred_at_inversion',
         format('%s row(s) have occurred_at earlier than a lower id', count(*))
    from (select occurred_at, lag(occurred_at) over (order by id) as prev from events) t
   where t.occurred_at < t.prev
  having count(*) > 0
  union all
  -- PK (id, occurred_at) no longer makes id unique on its own
  select 'duplicate_event_id', format('id %s appears %s times', id, count(*))
    from events group by id having count(*) > 1
  union all
  -- a row in DEFAULT means ensure_events_partitions fell behind
  select 'row_in_default_partition',
         format('%s row(s) in events_parts.events_default', count(*))
    from events where tableoid = 'events_parts.events_default'::regclass
  having count(*) > 0
  union all
  -- A PARTITION THAT PICKED UP AN APP-ROLE GRANT. This is the one that would
  -- actually hurt: a partition created outside ensure_events_partitions, or
  -- moved into `public` where pg_default_acl hands anon and authenticated
  -- `Dxtm` — and `D` is TRUNCATE, which RLS does not gate.
  --
  -- Deliberately NOT phrased as "reachable over the API": measured, PostgREST
  -- excludes partitions from its schema cache entirely, so a partition granted
  -- `select` to anon is still refused over HTTP. The grant is the exposure that
  -- is real, so the grant is what this checks.
  select 'partition_granted_to_app_role',
         format('%s has %s', c.oid::regclass::text, array_to_string(c.relacl, ' | '))
    from pg_class c
   where c.oid in (select inhrelid from pg_inherits where inhparent = 'events'::regclass)
     and (c.relacl::text like '%anon=%' or c.relacl::text like '%authenticated=%');
$$;

comment on function public.events_partition_health() is
  'Empty means healthy. Reports the four things partitioning makes possible to '
  'break: occurred_at/id inversions, duplicate ids (PK is (id, occurred_at), so '
  'id alone is no longer unique), rows that fell into the DEFAULT partition, '
  'and any partition carrying a grant for anon or authenticated. Asserted empty '
  'by the RLS suite.';

revoke execute on function public.ensure_events_partitions(date, int) from public, anon, authenticated;
grant  execute on function public.ensure_events_partitions(date, int) to service_role;
revoke execute on function public.events_partition_health() from public, anon, authenticated;
grant  execute on function public.events_partition_health() to service_role;

-- Monthly, on the 1st at 03:20 — before the 03:30 chain check, and in the gap
-- after followup-nudges (03:15).
select cron.schedule('ensure-events-partitions', '20 3 1 * *',
                     $$select ensure_events_partitions()$$);

-- ---------------------------------------------------------------------------
-- 8. PROVE THE COPY. This is the assertion the whole migration rests on.
-- ---------------------------------------------------------------------------
do $$
declare
  before_rows bigint; before_fp text;
  after_rows  bigint; after_fp  text;
  o           record;
  d           record;
  h           record;
  n_parts     int;
begin
  select n_rows, fingerprint into before_rows, before_fp
    from public._events_partition_fingerprint;
  select count(*), md5(coalesce(string_agg(hash, '' order by id), ''))
    into after_rows, after_fp from public.events;

  if after_rows is distinct from before_rows then
    raise exception '0063: row count changed in the copy — % before, % after', before_rows, after_rows;
  end if;
  if after_fp is distinct from before_fp then
    raise exception
      '0063: CHAIN FINGERPRINT CHANGED — % before, % after. The copy is not '
      'byte-identical; DO NOT PROCEED.', before_fp, after_fp;
  end if;

  -- and the chain itself still verifies, per org, on the partitioned table
  for o in select id, name from organizations loop
    select * into d from public.verify_events_chain(o.id, null::bigint);
    if not d.ok then
      raise exception '0063: org % (%) no longer verifies after partitioning — id=% reason=%',
        o.id, o.name, d.failed_id, d.reason;
    end if;
  end loop;

  for h in select * from public.events_partition_health() loop
    raise exception '0063: partition health check failed — % : %', h.problem, h.detail;
  end loop;

  select count(*) into n_parts from pg_inherits where inhparent = 'public.events'::regclass;

  raise notice '0063: partitioned. % row(s) across % partition(s), fingerprint % unchanged, every chain verifies.',
    after_rows, n_parts, after_fp;
end $$;

drop table public._events_partition_fingerprint;
