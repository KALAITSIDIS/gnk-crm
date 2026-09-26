-- =============================================================================
-- 0120 — a task belongs to the organisation of the viewing it names, and a
--        viewing's feedback-reminder supersession stays inside that organisation
--
-- THE GAP (BACKLOG "Every other tasks.* link is org-blind", viewing_id first —
-- the exact twin of 0119; reproduced 2026-09-26 against f645274 on the local
-- stack at 0119, through PostgREST with aal2 sessions of two throwaway
-- organisations, and pinned RED first by
-- supabase/tests/task-viewing-org-isolation.test.ts):
--
--   * tasks.viewing_id (0020) references viewings(id) ALONE, and tasks_insert /
--     tasks_update (0030 / 0032) check only the CALLER's organisation. So a
--     member of organisation B who learns an organisation-A viewing id — B
--     cannot read the viewing (viewings_select is org-scoped), but an id
--     travels in links, sign-slip URLs and logs — could INSERT a task of B
--     naming A's viewing, PATCH one of B's tasks onto it, or UPSERT the same;
--     and a real id (accepted) and a missing one (23503) told B apart whether
--     an A viewing exists.
--   * trg_supersede_viewing_nudges (0020, SECURITY DEFINER, never redefined)
--     matched the viewing's open viewing_feedback tasks by viewing_id alone.
--     When A then saved feedback on the viewing (saveViewingFeedback) or moved
--     its status (updateViewingStatus), the trigger marked B's task done and
--     wrote a `superseded` event into ORGANISATION B's chain, attributed by
--     auth.uid() to an A user. The nightly sweep's arms 4 and 4b
--     (create_followup_nudges, 0078) have the same join.
--
-- THE FIX — 0119's two layers, for viewings:
--
--   A. THE RELATIONSHIP. tasks (org_id, viewing_id) → viewings (org_id, id)
--      (tasks_org_viewing_fkey) REPLACES the single-column key, so PostgREST
--      keeps ONE relationship between the two tables; ON DELETE / ON UPDATE
--      NO ACTION exactly as 0020's key (a viewing with tasks still cannot be
--      deleted; no user session can delete a viewing today — authenticated
--      holds no DELETE grant and there is no policy; only service_role or
--      postgres could, no application path does, and the key still refuses
--      them while a task names the viewing); MATCH SIMPLE, so a task with no
--      viewing is exactly as before.
--      viewings (org_id, id) UNIQUE is the referenced side; the referencing
--      side gets an index. A cross-organisation id and a missing id now read
--      the same 23503 — no existence oracle THROUGH TASKS. The constraint binds
--      EVERY writer, service_role and definer bodies included.
--
--   B. THE TRIGGER. `and t.org_id = new.org_id` in trg_supersede_viewing_nudges.
--      With A validated the predicate cannot fail to hold; it is defence in
--      depth for the row A could not have stopped (one constrained NOT VALID
--      after an approved repair, or loaded by a replica-mode restore), and it
--      states the contract in the trigger's own text: the VIEWING's
--      organisation's reminders, written into THAT organisation's chain,
--      attributed to the user who saved the feedback or moved the status —
--      whom viewings_update (0032) has already placed in that organisation.
--      A same-organisation reminder assigned to ANOTHER staff member completes
--      exactly as before. Body, header, ACL, the trigger and its WHEN clause
--      are otherwise 0020's, byte for byte.
--
-- EXISTING DATA. The preflight below counts tasks whose organisation differs
-- from their viewing's and ABORTS THE WHOLE FILE before any DDL if there are
-- any: nothing is deleted, reassigned or repaired here, and the constraint is
-- never added NOT VALID by this file. Hosted, read-only, 2026-09-26: 0
-- viewings, 0 tasks, 0 mismatches; this file validates trivially there.
--
-- DEPLOY ORDER: ADDITIVE — hosted before the merge. Every legitimate writer of
-- tasks.viewing_id is the nightly sweep's arms 2 and 2b (0078), which take
-- org_id and viewing_id from the same viewings row; the application writes no
-- task with a viewing_id. No function signature, return shape or grant
-- changes — no release-compat entry. `database.types.ts` is regenerated: the
-- tasks Relationships entry `tasks_viewing_id_fkey` becomes
-- `tasks_org_viewing_fkey` over (org_id, viewing_id); no TypeScript names
-- either.
--
-- ROLLBACK (DECISIONS T-task-viewing-org-isolation): a FORWARD migration that
-- drops tasks_org_viewing_fkey and tasks_org_viewing_idx, re-adds
-- `tasks_viewing_id_fkey foreign key (viewing_id) references viewings(id)`,
-- drops viewings_org_id_id_key, re-creates trg_supersede_viewing_nudges from
-- 0020's text and resets this file's `comment on function`; regenerate the
-- types, move the verify-restore migrations pin FORWARD (one more ledger row),
-- remove its 0120 invariant row, revert the test's catalogue block and the
-- docs. No data moves either way: every row valid at 0120 is valid at 0119.
--
-- NOT CHANGED HERE (BACKLOG): create_followup_nudges arms 2 / 2b / 4 / 4b keep
-- their joins (with A validated they can meet no cross-organisation row — the
-- 0119 NOTE covers a NOT VALID constraint or a replica-mode restore); the
-- viewing_no_show reminders have no edit-time trigger (0075: sweep-only by
-- design); the other tasks.* links (mandate_id, reservation_id,
-- installment_id, lead_id, contact_id, property_id) and the other deal-side
-- keys stay on BACKLOG.
--
-- Pins that move with this file: the migrations count (119 -> 120) and a
-- 0120 invariant row in scripts/backup/verify-restore.sql. NO EXPLICIT
-- begin/commit — the CLI wraps the file (HANDOFF §3), as does one execute_sql
-- call.
-- =============================================================================

-- ADD CONSTRAINT takes an ACCESS EXCLUSIVE lock on viewings and on tasks
-- (0113's lesson): queued behind a long transaction it would block every read
-- of both tables behind it. Give up instead and apply again; hosted holds no
-- viewings and no tasks, so the scans themselves are instant. First, so the
-- preflight's own reads are bounded too. Apply outside 03:00–04:00 UTC
-- (pg_cron's clock: 06:00–07:00 Cyprus in summer), when the nightly sweep
-- updates tasks joined to viewings. Run twice by mistake, the file aborts at
-- viewings_org_id_id_key (42P07) and changes nothing.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. Preflight — abort, whole, over existing mismatches
-- ---------------------------------------------------------------------------
do $$
declare n int;
begin
  select count(*) into n
    from public.tasks t
    join public.viewings v on v.id = t.viewing_id
   where t.org_id <> v.org_id;
  if n > 0 then
    raise exception '0120 aborted: % task(s) name a viewing of another organisation — nothing was changed. '
                    'List them with: select t.id, t.org_id, t.viewing_id, v.org_id as viewing_org from public.tasks t '
                    'join public.viewings v on v.id = t.viewing_id where t.org_id <> v.org_id; and decide before constraining', n;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- A. The relationship: tasks (org_id, viewing_id) → viewings (org_id, id)
-- ---------------------------------------------------------------------------
alter table public.viewings
  add constraint viewings_org_id_id_key unique (org_id, id);

comment on constraint viewings_org_id_id_key on public.viewings is
  '0120: the referenced side of the tenant-bound foreign keys onto viewings '
  '(tasks_org_viewing_fkey first). Implied by the primary key; exists so a '
  'referencing table can name the pair.';

alter table public.tasks
  drop constraint tasks_viewing_id_fkey;

alter table public.tasks
  add constraint tasks_org_viewing_fkey
    foreign key (org_id, viewing_id) references public.viewings (org_id, id);

comment on constraint tasks_org_viewing_fkey on public.tasks is
  '0120: a task belongs to the organisation of the viewing it names, by construction. '
  'Replaces the single-column FK on viewing_id (ON DELETE NO ACTION, as that one was); '
  'org_id still references organizations(id) as well. A task with no viewing is not '
  'checked (MATCH SIMPLE).';

-- the referencing side of the new key (0020's partial nudge index serves only
-- kind = viewing_feedback, and has no org_id)
create index if not exists tasks_org_viewing_idx
  on public.tasks (org_id, viewing_id)
  where viewing_id is not null;

-- ---------------------------------------------------------------------------
-- B. The trigger: the viewing's OWN organisation's reminders, into its OWN chain
-- ---------------------------------------------------------------------------
-- 0020's text with one predicate added (`and t.org_id = new.org_id`). The
-- WHEN clause and the trigger itself are 0020's and are not re-created.
create or replace function trg_supersede_viewing_nudges() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  with superseded as (
    update tasks t
       set is_done = true, done_at = now()
     where t.viewing_id = new.id
       and t.org_id = new.org_id
       and t.kind = 'viewing_feedback'
       and not t.is_done
       and (new.feedback is not null or new.status <> 'completed')
    returning t.org_id, t.id
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, auth.uid(), 'task', id, 'superseded',
         jsonb_build_object('kind', 'viewing_feedback', 'viewing_id', new.id,
                            'reason', 'feedback_logged_or_viewing_reopened')
  from superseded;
  return null;
end $$;

-- create or replace keeps the ACL (0021's revoke); restated so hosted and
-- local cannot differ
revoke execute on function public.trg_supersede_viewing_nudges() from public, anon, authenticated;

comment on function public.trg_supersede_viewing_nudges() is
  'AFTER UPDATE OF viewings (feedback or status): completes the viewing''s open '
  'viewing_feedback reminders and writes each a `superseded` event attributed to '
  'the acting user. Since 0120 both are scoped to the VIEWING''s organisation '
  '(t.org_id = new.org_id) — never a task of another organisation, never a '
  'write into another organisation''s chain.';

-- ---------------------------------------------------------------------------
-- Apply-time assertions: the shape, and the constraint exercised once
-- ---------------------------------------------------------------------------
do $$
declare
  c     record;
  n     int;
  src   text;
  v_ok  boolean;
  v_con text;
begin
  -- exactly one foreign key from tasks to viewings, the composite one,
  -- validated, NO ACTION on delete and update, MATCH SIMPLE
  select count(*) into n from pg_constraint
   where conrelid = 'public.tasks'::regclass and confrelid = 'public.viewings'::regclass and contype = 'f';
  if n <> 1 then
    raise exception '0120 aborted: expected exactly one foreign key from tasks to viewings, found %', n;
  end if;
  select conname, convalidated, confdeltype, confupdtype, confmatchtype,
         (select array_agg(a.attname order by k.ord) from unnest(conkey) with ordinality k(attnum, ord)
            join pg_attribute a on a.attrelid = conrelid and a.attnum = k.attnum) as cols,
         (select array_agg(a.attname order by k.ord) from unnest(confkey) with ordinality k(attnum, ord)
            join pg_attribute a on a.attrelid = confrelid and a.attnum = k.attnum) as refcols
    into c
    from pg_constraint
   where conrelid = 'public.tasks'::regclass and confrelid = 'public.viewings'::regclass and contype = 'f';
  if c.conname <> 'tasks_org_viewing_fkey'
     or c.cols <> array['org_id', 'viewing_id']::name[]
     or c.refcols <> array['org_id', 'id']::name[]
     or not c.convalidated
     or c.confdeltype <> 'a' or c.confupdtype <> 'a' or c.confmatchtype <> 's' then
    raise exception '0120 aborted: tasks_org_viewing_fkey is not (org_id, viewing_id) -> viewings (org_id, id), validated, NO ACTION, MATCH SIMPLE (found % % -> % validated=% del=% upd=% match=%)',
      c.conname, c.cols, c.refcols, c.convalidated, c.confdeltype, c.confupdtype, c.confmatchtype;
  end if;
  if exists (select 1 from pg_constraint where conrelid = 'public.tasks'::regclass and conname = 'tasks_viewing_id_fkey') then
    raise exception '0120 aborted: the single-column tasks_viewing_id_fkey is still there (two relationships would make PostgREST embeds ambiguous)';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.viewings'::regclass
                    and conname = 'viewings_org_id_id_key' and contype = 'u') then
    raise exception '0120 aborted: viewings_org_id_id_key is missing';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'tasks' and indexname = 'tasks_org_viewing_idx') then
    raise exception '0120 aborted: tasks_org_viewing_idx is missing';
  end if;
  -- 0119's key is untouched
  if not exists (select 1 from pg_constraint where conrelid = 'public.tasks'::regclass
                    and conname = 'tasks_org_deal_fkey' and convalidated) then
    raise exception '0120 aborted: 0119''s tasks_org_deal_fkey is missing or not validated';
  end if;

  -- the trigger body: comments stripped, so a word in one can neither satisfy
  -- nor blind the check; the predicate must sit in the UPDATE's WHERE
  select p.prosrc into src
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'trg_supersede_viewing_nudges'
     and p.prosecdef and 'search_path=public' = any (p.proconfig);
  if src is null then
    raise exception '0120 aborted: trg_supersede_viewing_nudges lost SECURITY DEFINER or its search_path';
  end if;
  src := regexp_replace(src, '--[^\n]*', '', 'g');
  if src !~ 'update tasks t\s+set is_done = true, done_at = now\(\)\s+where t\.viewing_id = new\.id\s+and t\.org_id = new\.org_id\s+and t\.kind = ''viewing_feedback''' then
    raise exception '0120 aborted: trg_supersede_viewing_nudges does not scope its UPDATE to the viewing''s organisation';
  end if;
  if has_function_privilege('anon', 'public.trg_supersede_viewing_nudges()', 'execute')
     or has_function_privilege('authenticated', 'public.trg_supersede_viewing_nudges()', 'execute') then
    raise exception '0120 aborted: trg_supersede_viewing_nudges is executable by anon or authenticated (0021)';
  end if;
  -- the trigger itself is 0020's: AFTER UPDATE, FOR EACH ROW, with its WHEN clause
  select count(*) into n from pg_trigger t
   where t.tgrelid = 'public.viewings'::regclass and t.tgname = 'viewings_supersede_nudges' and not t.tgisinternal
     and t.tgfoid = 'public.trg_supersede_viewing_nudges()'::regprocedure
     and (t.tgtype & 2) = 0       -- not BEFORE (AFTER)
     and (t.tgtype & 1) = 1       -- FOR EACH ROW
     and (t.tgtype & 16) = 16     -- UPDATE
     and t.tgqual is not null;    -- WHEN (...)
  if n <> 1 then
    raise exception '0120 aborted: viewings_supersede_nudges is not 0020''s AFTER UPDATE FOR EACH ROW WHEN (...) trigger';
  end if;

  -- the constraint, exercised: two organisations, A's viewing, B's task naming
  -- it. The foreign-key violation this looks for is what unwinds the
  -- sub-block's own inserts (0088's probe); a task of A on A's viewing and a
  -- viewing-less task must pass first.
  v_ok := null;
  declare
    v_org_a uuid; v_org_b uuid; v_prop uuid; v_contact uuid; v_agent uuid; v_viewing uuid;
  begin
    begin
      insert into organizations (name, slug)
        values ('0120 probe A (rolled back)', '0120-probe-a-' || replace(gen_random_uuid()::text, '-', ''))
        returning id into v_org_a;
      insert into organizations (name, slug)
        values ('0120 probe B (rolled back)', '0120-probe-b-' || replace(gen_random_uuid()::text, '-', ''))
        returning id into v_org_b;
      insert into properties (org_id, reference, property_type)
        values (v_org_a, 'ZZZ0120-probe', 'apartment')
        returning id into v_prop;
      insert into contacts (org_id, first_name)
        values (v_org_a, '0120 probe')
        returning id into v_contact;
      -- any profile id satisfies viewings.agent_id's key (held FOR KEY SHARE,
      -- so it cannot vanish under the probe); none exists on an empty
      -- database — CI's and `db reset`'s migration run, before seed.sql —
      -- where the probe is skipped with a NOTICE (the test file proves the key
      -- there)
      select id into v_agent from profiles limit 1 for key share;
      if v_agent is null then
        raise exception using errcode = 'P0120', message = 'skip';
      end if;
      insert into viewings (org_id, property_id, contact_id, agent_id, scheduled_at)
        values (v_org_a, v_prop, v_contact, v_agent, now())
        returning id into v_viewing;
      -- the same-organisation link, and a task without a viewing: both accepted
      insert into tasks (org_id, title, viewing_id) values (v_org_a, '0120 probe own', v_viewing);
      insert into tasks (org_id, title)             values (v_org_a, '0120 probe none');
      -- organisation B's row naming organisation A's viewing: the
      -- single-column key accepted this
      insert into tasks (org_id, title, viewing_id) values (v_org_b, '0120 probe cross', v_viewing);
      raise exception using errcode = 'P0121', message = '0120 probe: a cross-organisation task was ACCEPTED';
    exception
      when foreign_key_violation then
        -- refused, and the sub-block's inserts are gone — but only THIS key's
        -- refusal is the verdict: any other 23503 in the sub-block is a probe
        -- that proved nothing
        get stacked diagnostics v_con = constraint_name;
        v_ok := (v_con = 'tasks_org_viewing_fkey');
      when sqlstate 'P0120' then
        v_ok := null;   -- no profile to name as agent: skipped, nothing written
      when sqlstate 'P0121' then
        v_ok := false;  -- accepted, and the sub-block's inserts are gone too
    end;
  end;
  if v_ok is false then
    raise exception '0120 aborted: tasks_org_viewing_fkey did not refuse a task naming another organisation''s viewing (the probe met %)',
      coalesce(v_con, 'no foreign-key violation — the cross-organisation row was accepted');
  end if;
  if v_ok is null then
    raise notice '0120: no profile exists — the constraint probe was skipped (the catalogue checks above still ran)';
  end if;

  raise notice '0120: tasks (org_id, viewing_id) -> viewings (org_id, id); viewing reminder supersession scoped to the viewing''s organisation';
end $$;
