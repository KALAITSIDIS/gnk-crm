-- =============================================================================
-- 0119 — a task belongs to the organisation of the deal it names, and a deal's
--        reminder supersession stays inside that organisation
--
-- THE GAP (BACKLOG "The deal nudge supersession writes across organisations",
-- found by T-atomic-deal-close's design critique; reproduced 2026-09-26 against
-- 79f3b3e on the local stack at 0118, through PostgREST with aal2 sessions of
-- two throwaway organisations, and pinned RED first by
-- supabase/tests/task-deal-org-isolation.test.ts):
--
--   * tasks.deal_id (0001) references deals(id) ALONE, and tasks_insert /
--     tasks_update (0030 / 0032) check only the CALLER's organisation. So a
--     member of organisation B who learns an organisation-A deal id — B cannot
--     read the deal, but an id travels in links, screenshots and logs — could
--     INSERT a task of B naming A's deal (201), PATCH one of B's tasks onto it
--     (200) or UPSERT the same. And because the foreign key was satisfied by a
--     deal B may not see and refused by a missing id, the answer told B
--     whether an A deal id exists.
--   * trg_supersede_deal_nudges (0025, SECURITY DEFINER) matched the deal's
--     open deal_no_contact tasks by deal_id alone. When A then closed the deal
--     through close_deal, or logged contact on it, the trigger marked B's task
--     done and wrote a `superseded` event into ORGANISATION B's chain — an
--     entry in B's append-only log about B's row, attributed by auth.uid() to
--     an A user B has never heard of; and the reverse for that A user, whose
--     id now sits in a foreign chain. The nightly sweep's step 3
--     (create_followup_nudges, 0078) has the same join.
--
-- THE FIX — two layers, both needed:
--
--   A. THE RELATIONSHIP. tasks (org_id, deal_id) → deals (org_id, id), the
--      shape 0088 gave property_media and 0101 notification_jobs. The
--      single-column FK is REPLACED, not joined: one relationship between the
--      two tables keeps every PostgREST embed (`deals(...)` from tasks,
--      `tasks(...)` from deals) unambiguous, and the pair subsumes the single
--      column — org_id is NOT NULL, and MATCH SIMPLE skips the check while
--      deal_id is null, so a task without a deal is exactly as before. ON
--      DELETE stays NO ACTION (0001 named none): a deal with tasks still
--      cannot be deleted. deals (org_id, id) UNIQUE is the referenced side and
--      costs one index; the referencing side gets one too. A cross-organisation
--      id and a missing id now read the same 23503 — no existence oracle
--      THROUGH TASKS (reservations.deal_id and leads.converted_deal_id keep
--      theirs — BACKLOG). The constraint binds EVERY writer, service_role and
--      definer bodies included: unlike 0118's guard, which keys on the role,
--      this is a fact about rows.
--
--   B. THE TRIGGER. `and t.org_id = new.org_id` in trg_supersede_deal_nudges.
--      With A validated the predicate cannot fail to hold; it is defence in
--      depth for the row A could not have stopped (one planted before 0119 and
--      constrained NOT VALID after an approved repair, or written past the
--      constraint with replication-role privileges), and it makes the trigger's
--      contract legible in its own text: it completes the DEAL's organisation's
--      reminders and writes into THAT organisation's chain, attributed to the
--      closer — whom close_deal (0118) and deals_update (0100) have already
--      placed in that organisation. A same-organisation reminder assigned to
--      ANOTHER staff member completes exactly as before: the predicate reads
--      organisations, never assignees. Body, header, ACL, the trigger and its
--      WHEN clause are otherwise 0025's, byte for byte.
--
-- EXISTING DATA. The preflight below counts tasks whose organisation differs
-- from their deal's and ABORTS THE WHOLE FILE before any DDL if there are any:
-- nothing is deleted, reassigned or repaired here, and the constraint is never
-- added NOT VALID by this file. Should a hosted database ever hold such rows,
-- the operator decides (repair through the app, or a separate migration adding
-- the constraint NOT VALID and validating it after the repair — and until it
-- is validated, the sweep's step 3 would need the same predicate as B).
-- Hosted, read-only, 2026-09-26: 0 tasks, 1 deal, 0 mismatches; this file
-- validates trivially there.
--
-- DEPLOY ORDER: ADDITIVE — hosted before the merge. The deployed application
-- (79f3b3e / aa01ef8) writes every task's org_id from the same row it read the
-- deal from (quickAddTask verifies each link through RLS first; the Won
-- follow-ups take close_deal's answer; the nightly sweep copies the deal's own
-- org; the lead cron writes no deal_id), so no request it sends is refused by
-- A. No function signature, return shape or grant changes — no release-compat
-- entry. `database.types.ts` is regenerated: the tasks Relationships entry
-- `tasks_deal_id_fkey` becomes `tasks_org_deal_fkey` over (org_id, deal_id);
-- no TypeScript names either.
--
-- ROLLBACK (DECISIONS T-task-deal-org-isolation): a FORWARD migration that
-- drops tasks_org_deal_fkey and tasks_org_deal_idx, re-adds
-- `tasks_deal_id_fkey foreign key (deal_id) references deals(id)`, drops
-- deals_org_id_id_key, re-creates trg_supersede_deal_nudges from 0025's text
-- and resets this file's `comment on function`; regenerate the types, move the
-- verify-restore migrations pin FORWARD again (a rollback is one more ledger
-- row), revert the test's catalogue block and the docs. No data moves either
-- way: every row valid at 0119 is valid at 0118.
--
-- NOT CHANGED HERE (BACKLOG): create_followup_nudges steps 1 and 3 keep their
-- joins (with A validated they can meet no cross-organisation row — a NOTE
-- says what to do if this constraint is ever NOT VALID or a replica-mode
-- restore loads rows past it); trg_supersede_viewing_nudges and the other
-- tasks.* links (viewing_id, mandate_id, reservation_id, installment_id,
-- lead_id, contact_id, property_id) carry no tenant tie — the same shape each,
-- one migration each; the other deal-side keys (offers.deal_id — the BACKLOG
-- entry named it too — reservations.deal_id, viewings.deal_id,
-- leads.converted_deal_id) can use deals_org_id_id_key later.
--
-- Pins that move with this file: the migrations count (118 -> 119) in
-- scripts/backup/verify-restore.sql. NO EXPLICIT begin/commit — the CLI wraps
-- the file (HANDOFF §3), as does one execute_sql call.
-- =============================================================================

-- ADD CONSTRAINT takes an ACCESS EXCLUSIVE lock on deals and on tasks (0113's
-- lesson): queued behind a long transaction — a close holding its row, a
-- sweep — it would block every read of both tables behind it. Give up instead
-- and apply again; hosted holds one deal and no tasks, so the scans themselves
-- are instant. First, so the preflight's own reads are bounded too. Apply
-- outside 03:00–04:00 UTC (pg_cron's clock: 06:00–07:00 Cyprus in summer),
-- when the nightly sweeps update tasks joined to deals. Run twice by mistake,
-- the file aborts at deals_org_id_id_key (42P07) and changes nothing.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. Preflight — abort, whole, over existing mismatches
-- ---------------------------------------------------------------------------
do $$
declare n int;
begin
  select count(*) into n
    from public.tasks t
    join public.deals d on d.id = t.deal_id
   where t.org_id <> d.org_id;
  if n > 0 then
    raise exception '0119 aborted: % task(s) name a deal of another organisation — nothing was changed. '
                    'List them with: select t.id, t.org_id, t.deal_id, d.org_id as deal_org from public.tasks t '
                    'join public.deals d on d.id = t.deal_id where t.org_id <> d.org_id; and decide before constraining', n;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- A. The relationship: tasks (org_id, deal_id) → deals (org_id, id)
-- ---------------------------------------------------------------------------
alter table public.deals
  add constraint deals_org_id_id_key unique (org_id, id);

comment on constraint deals_org_id_id_key on public.deals is
  '0119: the referenced side of the tenant-bound foreign keys onto deals '
  '(tasks_org_deal_fkey first). Implied by the primary key; exists so a '
  'referencing table can name the pair.';

alter table public.tasks
  drop constraint tasks_deal_id_fkey;

alter table public.tasks
  add constraint tasks_org_deal_fkey
    foreign key (org_id, deal_id) references public.deals (org_id, id);

comment on constraint tasks_org_deal_fkey on public.tasks is
  '0119: a task belongs to the organisation of the deal it names, by construction. '
  'Replaces the single-column FK on deal_id (ON DELETE NO ACTION, as that one was); '
  'org_id still references organizations(id) as well. A task with no deal is not '
  'checked (MATCH SIMPLE).';

-- the referencing side of the new key: the referential checks a deal's delete
-- or key change runs, and the trigger's own lookup (the partial nudge index
-- from 0020 serves only kind = deal_no_contact)
create index if not exists tasks_org_deal_idx
  on public.tasks (org_id, deal_id)
  where deal_id is not null;

-- ---------------------------------------------------------------------------
-- B. The trigger: the deal's OWN organisation's reminders, into its OWN chain
-- ---------------------------------------------------------------------------
-- 0025's text with one predicate added (`and t.org_id = new.org_id`). The
-- WHEN clause and the trigger itself are 0025's and are not re-created.
create or replace function trg_supersede_deal_nudges() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  with superseded as (
    update tasks t
       set is_done = true, done_at = now()
     where t.deal_id = new.id
       and t.org_id = new.org_id
       and t.kind = 'deal_no_contact'
       and not t.is_done
       and (new.status <> 'open'
            or (t.due_at at time zone 'Asia/Nicosia')::date
               <> (coalesce(new.last_contact_at, new.created_at) at time zone 'Asia/Nicosia')::date + 14)
    returning t.org_id, t.id
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, auth.uid(), 'task', id, 'superseded',
         jsonb_build_object('kind', 'deal_no_contact', 'deal_id', new.id,
                            'reason', case when new.status <> 'open'
                                           then 'deal_closed' else 'deal_contacted' end)
  from superseded;
  return null;
end $$;

-- create or replace keeps the ACL (0021's revoke); restated so hosted and
-- local cannot differ
revoke execute on function public.trg_supersede_deal_nudges() from public, anon, authenticated;

comment on function public.trg_supersede_deal_nudges() is
  'AFTER UPDATE OF deals (status or last_contact_at): completes the deal''s open '
  'deal_no_contact reminders and writes each a `superseded` event attributed to '
  'the acting user. Since 0119 both are scoped to the DEAL''s organisation '
  '(t.org_id = new.org_id) — never a task of another organisation, never a '
  'write into another organisation''s chain.';

-- ---------------------------------------------------------------------------
-- Apply-time assertions: the shape, and the constraint exercised once
-- ---------------------------------------------------------------------------
do $$
declare
  c    record;
  n    int;
  src  text;
  v_ok boolean;
begin
  -- exactly one foreign key from tasks to deals, the composite one, validated,
  -- NO ACTION on delete and update
  select count(*) into n from pg_constraint
   where conrelid = 'public.tasks'::regclass and confrelid = 'public.deals'::regclass and contype = 'f';
  if n <> 1 then
    raise exception '0119 aborted: expected exactly one foreign key from tasks to deals, found %', n;
  end if;
  select conname, convalidated, confdeltype, confupdtype, confmatchtype,
         (select array_agg(a.attname order by k.ord) from unnest(conkey) with ordinality k(attnum, ord)
            join pg_attribute a on a.attrelid = conrelid and a.attnum = k.attnum) as cols,
         (select array_agg(a.attname order by k.ord) from unnest(confkey) with ordinality k(attnum, ord)
            join pg_attribute a on a.attrelid = confrelid and a.attnum = k.attnum) as refcols
    into c
    from pg_constraint
   where conrelid = 'public.tasks'::regclass and confrelid = 'public.deals'::regclass and contype = 'f';
  if c.conname <> 'tasks_org_deal_fkey'
     or c.cols <> array['org_id', 'deal_id']::name[]
     or c.refcols <> array['org_id', 'id']::name[]
     or not c.convalidated
     or c.confdeltype <> 'a' or c.confupdtype <> 'a' or c.confmatchtype <> 's' then
    raise exception '0119 aborted: tasks_org_deal_fkey is not (org_id, deal_id) -> deals (org_id, id), validated, NO ACTION, MATCH SIMPLE (found % % -> % validated=% del=% upd=% match=%)',
      c.conname, c.cols, c.refcols, c.convalidated, c.confdeltype, c.confupdtype, c.confmatchtype;
  end if;
  if exists (select 1 from pg_constraint where conrelid = 'public.tasks'::regclass and conname = 'tasks_deal_id_fkey') then
    raise exception '0119 aborted: the single-column tasks_deal_id_fkey is still there (two relationships would make PostgREST embeds ambiguous)';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.deals'::regclass
                    and conname = 'deals_org_id_id_key' and contype = 'u') then
    raise exception '0119 aborted: deals_org_id_id_key is missing';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'tasks' and indexname = 'tasks_org_deal_idx') then
    raise exception '0119 aborted: tasks_org_deal_idx is missing';
  end if;

  -- the trigger body: comments stripped, so a word in one can neither satisfy
  -- nor blind the check; the predicate must sit in the UPDATE's WHERE
  select p.prosrc into src
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'trg_supersede_deal_nudges'
     and p.prosecdef and 'search_path=public' = any (p.proconfig);
  if src is null then
    raise exception '0119 aborted: trg_supersede_deal_nudges lost SECURITY DEFINER or its search_path';
  end if;
  src := regexp_replace(src, '--[^\n]*', '', 'g');
  if src !~ 'update tasks t\s+set is_done = true, done_at = now\(\)\s+where t\.deal_id = new\.id\s+and t\.org_id = new\.org_id\s+and t\.kind = ''deal_no_contact''' then
    raise exception '0119 aborted: trg_supersede_deal_nudges does not scope its UPDATE to the deal''s organisation';
  end if;
  if has_function_privilege('anon', 'public.trg_supersede_deal_nudges()', 'execute')
     or has_function_privilege('authenticated', 'public.trg_supersede_deal_nudges()', 'execute') then
    raise exception '0119 aborted: trg_supersede_deal_nudges is executable by anon or authenticated (0021)';
  end if;
  -- the trigger itself is 0025's: AFTER UPDATE, FOR EACH ROW, with its WHEN clause
  select count(*) into n from pg_trigger t
   where t.tgrelid = 'public.deals'::regclass and t.tgname = 'deals_supersede_nudges' and not t.tgisinternal
     and t.tgfoid = 'public.trg_supersede_deal_nudges()'::regprocedure
     and (t.tgtype & 2) = 0       -- not BEFORE (AFTER)
     and (t.tgtype & 1) = 1       -- FOR EACH ROW
     and (t.tgtype & 16) = 16     -- UPDATE
     and t.tgqual is not null;    -- WHEN (...)
  if n <> 1 then
    raise exception '0119 aborted: deals_supersede_nudges is not 0025''s AFTER UPDATE FOR EACH ROW WHEN (...) trigger';
  end if;

  -- the constraint, exercised: two organisations, A's deal, B's task naming it.
  -- The foreign-key violation this looks for is what unwinds the sub-block's
  -- own inserts (0088's probe); a task of A on A's deal must pass first.
  v_ok := null;
  declare
    v_org_a uuid; v_org_b uuid; v_stage uuid; v_deal uuid;
  begin
    begin
      insert into organizations (name, slug)
        values ('0119 probe A (rolled back)', '0119-probe-a-' || replace(gen_random_uuid()::text, '-', ''))
        returning id into v_org_a;
      insert into organizations (name, slug)
        values ('0119 probe B (rolled back)', '0119-probe-b-' || replace(gen_random_uuid()::text, '-', ''))
        returning id into v_org_b;
      insert into deal_stages (org_id, deal_type, name, sort_order)
        values (v_org_a, 'sale', '0119 probe', 1)
        returning id into v_stage;
      insert into deals (org_id, deal_type, stage_id, title)
        values (v_org_a, 'sale', v_stage, '0119 probe deal')
        returning id into v_deal;
      -- the same-organisation link, and a task without a deal: both accepted
      insert into tasks (org_id, title, deal_id) values (v_org_a, '0119 probe own', v_deal);
      insert into tasks (org_id, title)          values (v_org_a, '0119 probe none');
      -- organisation B's row naming organisation A's deal: the single-column
      -- key accepted this
      insert into tasks (org_id, title, deal_id) values (v_org_b, '0119 probe cross', v_deal);
      raise exception using errcode = 'P0119', message = '0119 probe: a cross-organisation task was ACCEPTED';
    exception
      when foreign_key_violation then
        v_ok := true;   -- refused, and the sub-block's inserts are gone
      when sqlstate 'P0119' then
        v_ok := false;  -- accepted, and the sub-block's inserts are gone too
    end;
  end;
  if v_ok is distinct from true then
    raise exception '0119 aborted: tasks_org_deal_fkey did not refuse a task naming another organisation''s deal';
  end if;

  raise notice '0119: tasks (org_id, deal_id) -> deals (org_id, id); deal reminder supersession scoped to the deal''s organisation';
end $$;
