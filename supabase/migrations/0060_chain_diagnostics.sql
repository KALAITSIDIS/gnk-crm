-- 0060 — verify_events_chain names the row that failed. Phase C, C5 step 1.
--
-- Before: `verify_events_chain(p_org) returns boolean`. When it returned
-- `false` you learned that the chain was broken somewhere in the org and
-- nothing whatever about where. It returns `false` precisely when somebody is
-- under pressure — a restore, a dispute, a suspected tamper — and at that
-- moment the only tool was bisecting by hand.
--
-- After: an overload `verify_events_chain(p_org, p_from_id)` returning
-- (ok, failed_id, reason). The one-argument boolean form SURVIVES UNCHANGED as
-- a wrapper, so the four existing callers do not move in this migration:
--
--   1. lib/services/evidence.ts        — admin.rpc(...), tests `data === true`
--   2. run_chain_checks()              — pg_cron 03:30, writes chain_checks.ok
--   3. supabase/tests/rls.test.ts      — 13 call sites asserting .toBe(true)
--   4. scripts/demo/availability-project{,-teardown}.sql
--
-- ============================================================================
-- `p_from_id` HAS NO DEFAULT, AND THAT IS DELIBERATE.
--
-- docs/PHASE_C_BRIEF.md §2 specifies `p_from_id default null`. With the
-- boolean one-argument wrapper also present that is a latent outage, not a
-- style preference. Postgres accepts BOTH create statements and then fails at
-- CALL time:
--
--   ERROR:  function public.verify_events_chain(uuid) is not unique
--   HINT:   Could not choose a best candidate function.
--
-- The migration would apply green and the breakage would surface on the 03:30
-- cron and in every RLS assertion. Measured on the local stack before this was
-- written. A full walk is `verify_events_chain(p_org, null)` — explicit.
-- ============================================================================
--
-- WHY AN OVERLOAD RATHER THAN A SECOND NAME. Three things were probed on the
-- local stack first, because nothing in this schema is overloaded today (the
-- only overloaded names are PostGIS's):
--
--   * SQL resolution — one-arg call still resolves to the boolean. Yes.
--   * `supabase gen types` — emits a union of the two signatures, not a
--     collision on the shared key. Yes.
--   * PostgREST — resolves by ARGUMENT NAME, so rpc(…, {p_org}) reaches the
--     boolean and rpc(…, {p_org, p_from_id}) reaches the row. Yes.
--
-- WHAT `p_from_id` IS FOR. Resuming a walk from a known-good point, which is
-- what the checkpoint in C5 step 3 will supply. It seeds `prev` from the row
-- immediately BEFORE p_from_id, so the link across the resume boundary is
-- still checked rather than assumed — a resume that skipped that check could
-- not tell a spliced chain from an intact one.
--
-- ONE BEHAVIOUR CHANGE BEYOND THE RETURN TYPE, and it is a fix. The old body
-- compared `r.hash <> encode(digest(...))`. A row with `hash IS NULL` makes
-- that expression NULL, the branch does not fire, and the row PASSES; the
-- failure then surfaces one row later, on the next row's prev_hash link. The
-- id it named would have been the wrong one — which matters now that the id is
-- the product. Both comparisons are `is distinct from`, and a null hash is
-- reported against its own row as `null_hash`.
--
-- No schema change. `events` is untouched; this is functions and grants only,
-- so it is additive and applies before the merge.

-- ---------------------------------------------------------------------------
-- The workhorse.
-- ---------------------------------------------------------------------------
create or replace function public.verify_events_chain(p_org uuid, p_from_id bigint)
returns table (ok boolean, failed_id bigint, reason text)
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  r record;
  prev text := null;
begin
  -- Resuming: seed `prev` with the hash of the row before the resume point so
  -- the first iteration still verifies the link. Left null for a full walk,
  -- which is what asserts that genesis has no predecessor.
  if p_from_id is not null then
    select e.hash into prev
      from events e
     where e.org_id = p_org and e.id < p_from_id
     order by e.id desc
     limit 1;
  end if;

  -- Ordered by id, never by occurred_at: the chain is built in insert order by
  -- trg_events_hash, and id is the only column that reproduces it. Partitioning
  -- (C5 step 4) keys on occurred_at and must not change this.
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

    if r.hash is distinct from encode(digest(
         coalesce(prev,'') || r.org_id::text || coalesce(r.actor_id::text,'') ||
         r.entity_type || coalesce(r.entity_id::text,'') || r.event_type ||
         r.payload::text || r.occurred_at::text, 'sha256'), 'hex')
    then
      return query select false, r.id, 'hash_mismatch'::text;
      return;
    end if;

    prev := r.hash;
  end loop;

  return query select true, null::bigint, null::text;
end $$;

-- ---------------------------------------------------------------------------
-- The wrapper. Same signature, same return type, same security context as the
-- function 0001 created — only the body changes, so `create or replace` keeps
-- the existing ACL (re-read below regardless).
-- ---------------------------------------------------------------------------
create or replace function public.verify_events_chain(p_org uuid)
returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select v.ok from public.verify_events_chain(p_org, null::bigint) v;
$$;

-- ---------------------------------------------------------------------------
-- GRANTS. A newly created function carries a PUBLIC =X grant; the two-argument
-- form is new, so it needs the lockdown 0007 applied to the one-argument form.
-- Grants are PER SIGNATURE — the overload does not inherit anything. This is
-- the trap that bit 0021 and 0044.
--
-- anon and authenticated stay revoked deliberately (0019's reasoning): a full
-- chain walk is O(all org events), so an on-demand walk exposed to any browser
-- session is a self-inflicted DoS. /reports reads the cached chain_checks row.
-- ---------------------------------------------------------------------------
revoke execute on function public.verify_events_chain(uuid, bigint) from public, anon, authenticated;
grant  execute on function public.verify_events_chain(uuid, bigint) to service_role;

-- Belt and braces on the wrapper: create-or-replace preserves the ACL, but
-- §4 of HANDOFF is explicit that a re-read beats an assumption.
revoke execute on function public.verify_events_chain(uuid) from public, anon, authenticated;
grant  execute on function public.verify_events_chain(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Verify, in the migration, against whatever data this database holds.
-- ---------------------------------------------------------------------------
do $$
declare
  n_orgs      int;
  n_bad       int := 0;
  o           record;
  d           record;
  b           boolean;
begin
  select count(*) into n_orgs from organizations;

  for o in select id, name from organizations loop
    select * into d from public.verify_events_chain(o.id, null::bigint);
    select public.verify_events_chain(o.id) into b;

    -- the wrapper must be a pure projection of the row form
    if b is distinct from d.ok then
      raise exception '0060: wrapper disagrees with detail for org % (% vs %)', o.id, b, d.ok;
    end if;

    if not d.ok then
      n_bad := n_bad + 1;
      raise warning '0060: chain for org % (%) FAILS at events.id=% reason=%',
        o.id, o.name, d.failed_id, d.reason;
    end if;
  end loop;

  raise notice '0060: chain diagnostics live. % org(s) checked, % failing.', n_orgs, n_bad;
end $$;
