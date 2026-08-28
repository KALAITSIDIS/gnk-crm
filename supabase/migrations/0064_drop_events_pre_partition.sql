-- 0064 — drop the pre-partition rollback copy. Phase C, C5 step 4, second half.
--
-- 0063 renamed the unpartitioned `events` aside rather than dropping it, so
-- that the deploy could be confirmed with a complete, untouched copy of the
-- evidence spine still on disk. This removes it.
--
-- ============================================================================
-- DESTRUCTIVE. APPLY ONLY AFTER THE 0063 DEPLOY IS CONFIRMED SERVING — the
-- standing rule (HANDOFF §0, "additive before the merge, destructive after the
-- deploy is confirmed"). Once this runs, the only copies of the pre-partition
-- table are the backups.
-- ============================================================================
--
-- IT REFUSES RATHER THAN TRUSTS. Every one of these must hold, or nothing is
-- dropped:
--
--   1. `events` is actually partitioned. If 0063 did not take, the rollback
--      copy is the live data and dropping it is the incident.
--   2. Row counts match exactly.
--   3. The CHAIN FINGERPRINT matches — md5(string_agg(hash order by id)) over
--      both tables. Counts alone prove nothing here: the C6 drill produced an
--      org whose chain read `true` at source and `false` after a restore with
--      identical counts (BACKUP_RESTORE §5).
--   4. Every org's chain verifies on the partitioned table.
--   5. events_partition_health() is empty.
--
-- If the rollback copy is already gone (a re-run, or a database built fresh
-- from 0063 onward — CI's is), this is a no-op with a notice rather than an
-- error.

do $$
declare
  pre_rows  bigint; pre_fp  text;
  new_rows  bigint; new_fp  text;
  o         record; d       record; h record;
  is_part   boolean;
begin
  if to_regclass('public.events_pre_partition') is null then
    raise notice '0064: events_pre_partition is already gone — nothing to do.';
    return;
  end if;

  -- 1. the live table must really be partitioned
  select c.relkind = 'p' into is_part from pg_class c where c.oid = 'public.events'::regclass;
  if not is_part then
    raise exception
      '0064: public.events is NOT partitioned (relkind is not ''p''). 0063 did not take, '
      'which makes events_pre_partition the real data. REFUSING TO DROP IT.';
  end if;

  -- 2 and 3. same rows, same chain, byte for byte
  select count(*), md5(coalesce(string_agg(hash, '' order by id), ''))
    into pre_rows, pre_fp from public.events_pre_partition;
  select count(*), md5(coalesce(string_agg(hash, '' order by id), ''))
    into new_rows, new_fp from public.events;

  if new_rows < pre_rows then
    raise exception '0064: the partitioned table has FEWER rows (% vs %). Refusing.', new_rows, pre_rows;
  end if;

  -- The live table may legitimately have grown since 0063, so compare the
  -- fingerprint over the PREFIX that both should share rather than the whole.
  if md5(coalesce((select string_agg(hash, '' order by id) from public.events
                    where id <= (select max(id) from public.events_pre_partition)), '')) is distinct from pre_fp
  then
    raise exception
      '0064: the partitioned table does not reproduce the pre-partition chain. '
      'Expected fingerprint %. REFUSING TO DROP THE ONLY OTHER COPY.', pre_fp;
  end if;

  -- 4. and it still verifies
  for o in select id, name from organizations loop
    select * into d from public.verify_events_chain(o.id, null::bigint);
    if not d.ok then
      raise exception '0064: org % (%) does not verify — id=% reason=%. Refusing.',
        o.id, o.name, d.failed_id, d.reason;
    end if;
  end loop;

  -- 5. and is structurally healthy
  for h in select * from public.events_partition_health() loop
    raise exception '0064: partition health failed — % : %. Refusing.', h.problem, h.detail;
  end loop;

  raise notice '0064: verified — % pre-partition row(s) reproduced exactly, fingerprint %. Dropping.',
    pre_rows, pre_fp;
end $$;

drop table if exists public.events_pre_partition;

do $$
begin
  if to_regclass('public.events_pre_partition') is not null then
    raise exception '0064: the drop did not take';
  end if;
  raise notice '0064: events_pre_partition dropped. % event(s) live across % partition(s).',
    (select count(*) from public.events),
    (select count(*) from pg_inherits where inhparent = 'public.events'::regclass);
end $$;
