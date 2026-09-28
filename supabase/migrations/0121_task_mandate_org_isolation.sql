-- =============================================================================
-- 0121 — a task belongs to the organisation of the mandate it names, and the
--        two mandate sweeps look for, and complete, only that organisation's
--        reminders
--
-- THE GAP (BACKLOG "Every other tasks.* link is org-blind" — mandate_id, the
-- twin 0120's review named next; reproduced 2026-09-28 against 702c70f on the
-- local stack at 0120, through PostgREST with aal2 sessions of two throwaway
-- organisations, and pinned RED first by
-- supabase/tests/task-mandate-org-isolation.test.ts, 13 of its 27 tests):
--
--   * tasks.mandate_id (0006) references mandates(id) ALONE, and tasks_insert /
--     tasks_update (0030 / 0032) check only the CALLER's organisation. A member
--     of organisation B who learns an organisation-A mandate id — B cannot
--     read the mandate (mandates_select is org-scoped), but an id travels in
--     links, screenshots and logs — could INSERT a task of B naming it (201),
--     PATCH one of B's tasks onto it (200) or UPSERT the same (201); and a
--     real id (accepted) and a missing one (23503) told B whether an A
--     mandate exists.
--   * raise_key_recall_tasks (0053, 0091; SECURITY DEFINER, service_role only)
--     matched tasks to mandates by mandate_id alone in BOTH of its arms:
--       - the duplicate guard, so one planted key_recall row of B stopped A's
--         legitimate "Return keys" reminder from ever being raised;
--       - the self-heal, so once A's keys went back it completed B's row and
--         wrote a `superseded` event into ORGANISATION B's chain — attributed
--         to A's admin when setMandateStatus made the call at edit time
--         (p_actor), to the system when the nightly expire_mandates() did.
--   * expire_mandates (0053; pg_cron, as postgres) steps 2 and 3 had the same
--     two joins for mandate_renewal rows, system-attributed: a planted row
--     dated on A's expiry day suppressed A's renewal reminder, and the nightly
--     self-heal completed every planted row dated on ANY OTHER day — so B,
--     reading its own rows back, learned A's expiry date (measured: of three
--     guessed days, the two wrong ones were completed into B's chain).
--
-- THE FIX — 0119's two layers, for mandates, in both functions:
--
--   A. THE RELATIONSHIP. tasks (org_id, mandate_id) → mandates (org_id, id)
--      (tasks_org_mandate_fkey) REPLACES the single-column key, so PostgREST
--      keeps ONE relationship between the two tables (mandates' own
--      renewed_from_id key is to itself); ON DELETE / ON UPDATE NO ACTION
--      exactly as 0006's key — a mandate with tasks still cannot be deleted,
--      nor, through properties → mandates ON DELETE CASCADE (0001), its
--      property; no user session can delete a mandate at all (authenticated
--      holds no DELETE grant); MATCH SIMPLE, so a task with no mandate is
--      exactly as before. mandates (org_id, id) UNIQUE is the referenced side;
--      the referencing side gets tasks_org_mandate_idx (0006's
--      tasks_mandate_idx stays: it serves lookups by mandate id alone). A
--      cross-organisation id and a missing id now read the same 23503 — no
--      existence oracle THROUGH TASKS. The constraint binds EVERY writer,
--      service_role and definer bodies included.
--
--   B. THE SWEEPS. raise_key_recall_tasks gains `and t.org_id = c.org_id` in
--      its duplicate guard and `and t.org_id = m.org_id` in its self-heal;
--      expire_mandates gains `and t.org_id = m.org_id` in its renewal guard
--      (step 2) and its renewal self-heal (step 3). Each ties a task to ITS
--      OWN parent's organisation, row by row — never to current_org_id():
--      both functions legitimately serve every organisation in one run
--      (p_mandate null, and the cron), and a session-scoped filter would
--      silently shrink that job to one organisation, or to none under the
--      cron's session. With A validated the predicates cannot fail to hold;
--      they are defence in depth for the row A could not have stopped (one
--      written before a NOT VALID constraint after an approved repair, or
--      loaded by a replica-mode restore), and they state each function's
--      contract in its own text. NOTHING ELSE in either body moves — the
--      kinds and their separation, the (mandate_id, kind) key, the renewal
--      cycle key, the three-arm assignee fallback, the seven Cyprus days of
--      grace (0091), the held-key test, the flip and its order, the actor
--      (p_actor at edit time, NULL from the cron) — which the assertions
--      below prove by comparing each new body, minus exactly its added lines,
--      with the canonical 0091 / 0053 body. ACLs restated: raise_key_recall_
--      tasks service_role only (T-C4); expire_mandates its owner only (0022;
--      pg_cron runs it as postgres).
--
-- EXISTING DATA. The preflight below counts tasks whose organisation differs
-- from their mandate's and ABORTS THE WHOLE FILE before any DDL if there are
-- any: nothing is deleted, reassigned or repaired here, and the constraint is
-- never added NOT VALID by this file. Hosted, read-only, 2026-09-28 13:17Z:
-- 1 organisation, 4 mandates (none ended), 0 tasks, 0 mismatches, 0 dangling
-- mandate ids, both function bodies = the canonical ones; this file validates
-- trivially there.
--
-- DEPLOY ORDER: ADDITIVE — hosted before the merge. Every writer of
-- tasks.mandate_id takes org_id and mandate_id from the same mandates row
-- (expire_mandates step 2, raise_key_recall_tasks); the application writes
-- none (setMandateStatus's supersedeRenewalTasks only completes, under the
-- admin's RLS), so no request the deployed application sends is refused by A.
-- No function signature, return shape or grant changes — no release-compat
-- entry. database.types.ts is regenerated: the tasks Relationships entry
-- tasks_mandate_id_fkey becomes tasks_org_mandate_fkey over (org_id,
-- mandate_id); no TypeScript names either.
--
-- ROLLBACK (DECISIONS T-task-mandate-org-isolation): a FORWARD migration that
-- drops tasks_org_mandate_fkey and tasks_org_mandate_idx, re-adds
-- `tasks_mandate_id_fkey foreign key (mandate_id) references mandates(id)`,
-- drops mandates_org_id_id_key, re-creates raise_key_recall_tasks from 0091's
-- text (with 0091's comment) and expire_mandates from 0053's (with no
-- comment); regenerate the types, move the verify-restore migrations pin
-- FORWARD (one more ledger row), remove its 0121 invariant row, revert the
-- test's catalogue block and the docs. No data moves either way: every row
-- valid at 0121 is valid at 0120.
--
-- NOT CHANGED HERE (BACKLOG): property_keys.property_id is organisation-blind
-- too — a key of B filed on A's property counts as "held" for A's mandate
-- (measured: on its own it raised a recall task in A) — as are
-- mandates.property_id and the assignee fallback's profile arms: each is a
-- different relationship, one migration each. The other tasks.* links
-- (reservation_id, installment_id, lead_id, contact_id, property_id) and the
-- other sweeps' parent joins stay as they are.
--
-- Pins that move with this file: the migrations count (120 -> 121) and a
-- 0121 invariant row in scripts/backup/verify-restore.sql. NO EXPLICIT
-- begin/commit — the CLI wraps the file (HANDOFF §3), as does one execute_sql
-- call.
-- =============================================================================

-- ADD CONSTRAINT takes an ACCESS EXCLUSIVE lock on mandates and on tasks
-- (0113's lesson): queued behind a long transaction it would block every read
-- of both tables behind it. Give up instead and apply again; hosted holds 4
-- mandates and no tasks, so the scans themselves are instant. First, so the
-- preflight's own reads are bounded too. Apply outside 03:00–04:00 UTC
-- (pg_cron's clock: expire_mandates runs at 03:00), when the sweep updates
-- tasks joined to mandates. Run twice by mistake, the file aborts at
-- mandates_org_id_id_key (42P07) and changes nothing.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 0. Preflight — abort, whole, over existing mismatches
-- ---------------------------------------------------------------------------
do $$
declare n int;
begin
  select count(*) into n
    from public.tasks t
    join public.mandates m on m.id = t.mandate_id
   where t.org_id <> m.org_id;
  if n > 0 then
    raise exception '0121 aborted: % task(s) name a mandate of another organisation — nothing was changed. '
                    'List them with: select t.id, t.org_id, t.kind, t.mandate_id, m.org_id as mandate_org from public.tasks t '
                    'join public.mandates m on m.id = t.mandate_id where t.org_id <> m.org_id; and decide before constraining', n;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- A. The relationship: tasks (org_id, mandate_id) → mandates (org_id, id)
-- ---------------------------------------------------------------------------
alter table public.mandates
  add constraint mandates_org_id_id_key unique (org_id, id);

comment on constraint mandates_org_id_id_key on public.mandates is
  '0121: the referenced side of the tenant-bound foreign keys onto mandates '
  '(tasks_org_mandate_fkey first). Implied by the primary key; exists so a '
  'referencing table can name the pair.';

alter table public.tasks
  drop constraint tasks_mandate_id_fkey;

alter table public.tasks
  add constraint tasks_org_mandate_fkey
    foreign key (org_id, mandate_id) references public.mandates (org_id, id);

comment on constraint tasks_org_mandate_fkey on public.tasks is
  '0121: a task belongs to the organisation of the mandate it names, by construction. '
  'Replaces the single-column FK on mandate_id (ON DELETE NO ACTION, as that one was); '
  'org_id still references organizations(id) as well. A task with no mandate is not '
  'checked (MATCH SIMPLE).';

-- the referencing side of the new key (0006's tasks_mandate_idx has no org_id)
create index if not exists tasks_org_mandate_idx
  on public.tasks (org_id, mandate_id)
  where mandate_id is not null;

-- ---------------------------------------------------------------------------
-- B1. raise_key_recall_tasks: the mandate's OWN organisation's reminders
-- ---------------------------------------------------------------------------
-- 0091's text with two predicates added: `and t.org_id = c.org_id` in the
-- duplicate guard, `and t.org_id = m.org_id` in the self-heal.
create or replace function public.raise_key_recall_tasks(
  p_mandate uuid default null,
  p_actor   uuid default null
)
returns int
language sql security definer set search_path = public as $$
  with candidates as (
    select m.id as mandate_id, m.org_id, m.property_id, m.created_by, m.status,
           p.reference, p.assigned_agent_id,
           (select count(*) from property_keys k
             where k.property_id = m.property_id
               and k.status in ('in_office', 'checked_out')) as held
      from mandates m
      join properties p on p.id = m.property_id
     -- both terminal, and there is no transition back to active, which is why
     -- (mandate_id, kind) is a sufficient key
     where m.status in ('expired', 'terminated')
       and (p_mandate is null or m.id = p_mandate)
  ),
  created as (
    insert into tasks (org_id, title, due_at, assignee_id, property_id, mandate_id, kind)
    select c.org_id,
           'Return keys: ' || c.reference || ' — ' || c.held
             || case when c.held = 1 then ' key' else ' keys' end
             || ' still held (mandate ' || c.status || ')',
           -- grace, not urgency theatre: see the header
           -- 0091: anchored on the CYPRUS day, not current_date
           ((((now() at time zone 'Asia/Nicosia')::date + 7)::timestamp
             + interval '23 hours 59 minutes')
             at time zone 'Asia/Nicosia'),
           -- three-arm fallback, per 0012/0020/0047/0051: a NULL assignee is
           -- invisible on every surface, because /tasks and the agent dashboard
           -- both filter on assignee_id = me.
           coalesce(
             (select pr.id from profiles pr
               where pr.id = c.assigned_agent_id and pr.is_active),
             (select pr.id from profiles pr
               where pr.id = c.created_by and pr.is_active),
             (select pr.id from profiles pr
               where pr.org_id = c.org_id and pr.role = 'admin' and pr.is_active
               order by pr.created_at limit 1)),
           c.property_id,
           c.mandate_id,
           'key_recall'
      from candidates c
     where c.held > 0
       and not exists (
         select 1 from tasks t
          where t.mandate_id = c.mandate_id
            and t.org_id = c.org_id
            and t.kind = 'key_recall')
    returning org_id, id, mandate_id, property_id, assignee_id
  ),
  logged as (
    insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
    select c.org_id, p_actor, 'mandate', c.mandate_id, 'key_recall_task_created',
           jsonb_build_object('task_id', c.id,
                              'assignee_id', c.assignee_id,
                              'property_id', c.property_id,
                              'keys', d.held)
      from created c join candidates d on d.mandate_id = c.mandate_id
    returning 1
  ),
  -- self-heal: once nothing is held any more the task is COMPLETED, never
  -- deleted, so history keeps its shape. Handing the last key to the owner is
  -- the ordinary way this closes; marking it lost also closes it, because there
  -- is then nothing left to recall — the loss is its own record.
  superseded as (
    update tasks t
       set is_done = true, done_at = now()
      from mandates m
     where t.mandate_id = m.id
       and t.org_id = m.org_id
       and t.kind = 'key_recall'
       and not t.is_done
       and (p_mandate is null or m.id = p_mandate)
       and not exists (
         select 1 from property_keys k
          where k.property_id = m.property_id
            and k.status in ('in_office', 'checked_out'))
    returning t.org_id, t.id, t.mandate_id
  ),
  healed as (
    insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
    select org_id, p_actor, 'task', id, 'superseded',
           jsonb_build_object('kind', 'key_recall', 'mandate_id', mandate_id,
                              'reason', 'keys_returned')
      from superseded
    returning 1
  )
  select count(*)::int from created;
$$;

-- create or replace keeps the ACL (0053's T-C4 lockdown); restated so hosted
-- and local cannot differ
revoke execute on function public.raise_key_recall_tasks(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.raise_key_recall_tasks(uuid, uuid) to service_role;

comment on function public.raise_key_recall_tasks(uuid, uuid) is
  'Raises key_recall tasks for ended mandates whose keys are still held, and '
  'completes the task once nothing is held. Due date is seven CYPRUS days out '
  '(0091 — current_date is the UTC day, and this function is called '
  'synchronously from a user action, so the two can disagree). Since 0121 both '
  'the duplicate guard and the self-heal read only the MANDATE''s organisation''s '
  'tasks (t.org_id = the mandate''s org_id) — a row of another organisation can '
  'neither block a reminder nor be completed, and no event lands in another '
  'organisation''s chain.';

-- ---------------------------------------------------------------------------
-- B2. expire_mandates: the renewal guard and self-heal, the same way
-- ---------------------------------------------------------------------------
-- 0053's text with two predicates added (`and t.org_id = m.org_id` in step 2's
-- guard and step 3's self-heal). Steps 1 and 4 are 0053's.
create or replace function public.expire_mandates()
returns void
language sql security definer set search_path = public as $$
  -- 1) expiry flip first (so freshly-expired mandates can't mint a reminder
  --    in the same run), each with its system event (actor null = system/cron)
  with flipped as (
    update mandates set status = 'expired'
    where status = 'active' and expiry_date is not null and expiry_date < current_date
    returning org_id, id, expiry_date
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'mandate', id, 'status_changed',
         jsonb_build_object('from', 'active', 'to', 'expired', 'expiry_date', expiry_date)
  from flipped;

  -- 2) renewal reminders: active mandates within expiry - renewal_reminder_days,
  --    one task per expiry cycle, due Cyprus end-of-day of the expiry date,
  --    assigned to the property's agent (fallbacks: mandate creator, then the
  --    org's oldest active admin — never NULL, and never a deactivated profile)
  with created as (
    insert into tasks (org_id, title, due_at, assignee_id, property_id, mandate_id, kind)
    select m.org_id,
           'Mandate renewal: ' || p.reference || ' expires ' || to_char(m.expiry_date, 'DD Mon YYYY'),
           (m.expiry_date::timestamp + interval '23 hours 59 minutes') at time zone 'Asia/Nicosia',
           coalesce(
             (select pr.id from profiles pr where pr.id = p.assigned_agent_id and pr.is_active),
             (select pr.id from profiles pr where pr.id = m.created_by and pr.is_active),
             (select pr.id from profiles pr
               where pr.org_id = m.org_id and pr.role = 'admin' and pr.is_active
               order by pr.created_at limit 1)),
           m.property_id,
           m.id,
           'mandate_renewal'
    from mandates m
    join properties p on p.id = m.property_id
    where m.status = 'active'
      and m.expiry_date is not null
      and current_date >= m.expiry_date - m.renewal_reminder_days
      and not exists (
        select 1 from tasks t
        where t.mandate_id = m.id
          and t.org_id = m.org_id
          -- 0053: `tasks.mandate_id` is no longer single-kind. Without this a
          -- key_recall task dated on the expiry day would block the renewal
          -- reminder for that cycle.
          and t.kind = 'mandate_renewal'
          and (t.due_at at time zone 'Asia/Nicosia')::date = m.expiry_date)
    returning org_id, mandate_id, assignee_id
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'mandate', mandate_id, 'renewal_task_created',
         jsonb_build_object('assignee_id', assignee_id)
  from created;

  -- 3) self-heal: complete open renewal tasks whose mandate is no longer
  --    active or whose expiry moved (saveMandate does this at edit time with
  --    actor attribution; this is the nightly safety net)
  with superseded as (
    update tasks t
       set is_done = true, done_at = now()
      from mandates m
     where t.mandate_id = m.id
       and t.org_id = m.org_id
       -- 0053: THE BUG THIS MIGRATION EXISTS AROUND. Without this filter, every
       -- key_recall task is completed on the next run — they hang off mandates
       -- that are BY DEFINITION no longer active, so `m.status <> 'active'`
       -- matches every one of them.
       and t.kind = 'mandate_renewal'
       and not t.is_done
       and (m.status <> 'active'
            or m.expiry_date is null
            or (t.due_at at time zone 'Asia/Nicosia')::date <> m.expiry_date)
    returning t.org_id, t.id, t.mandate_id
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'task', id, 'superseded',
         jsonb_build_object('mandate_id', mandate_id, 'reason', 'mandate_renewed_or_inactive')
  from superseded;

  -- 4) 0053: chase keys on mandates that have ended. Runs LAST, after the flip
  --    in step 1, so a mandate that expired overnight is already `expired` and
  --    is picked up in the same pass rather than waiting a further night.
  select raise_key_recall_tasks();
$$;

-- create or replace keeps the ACL (0021 / 0022); restated so hosted and local
-- cannot differ — pg_cron runs it as postgres and needs no grant
revoke execute on function public.expire_mandates() from public, anon, authenticated, service_role;

comment on function public.expire_mandates() is
  'Nightly (pg_cron, 03:00 UTC, as postgres): expires overdue mandates, raises and '
  'self-heals mandate_renewal reminders, then raise_key_recall_tasks(). Every '
  'organisation in one run, system-attributed. Since 0121 the renewal guard and '
  'self-heal read only the MANDATE''s organisation''s tasks (t.org_id = m.org_id).';

-- ---------------------------------------------------------------------------
-- Apply-time assertions: the shape, the two bodies, and the constraint
-- exercised once
-- ---------------------------------------------------------------------------
do $$
declare
  c      record;
  n      int;
  src    text;
  v_ok   boolean;
  v_con  text;
  -- the lines this file adds, exactly (newline + indentation + predicate)
  k_guard   constant text := E'\n            and t.org_id = c.org_id';
  k_heal    constant text := E'\n       and t.org_id = m.org_id';
  k_renew   constant text := E'\n          and t.org_id = m.org_id';
begin
  -- exactly one foreign key from tasks to mandates, the composite one,
  -- validated, NO ACTION on delete and update, MATCH SIMPLE
  select count(*) into n from pg_constraint
   where conrelid = 'public.tasks'::regclass and confrelid = 'public.mandates'::regclass and contype = 'f';
  if n <> 1 then
    raise exception '0121 aborted: expected exactly one foreign key from tasks to mandates, found %', n;
  end if;
  select conname, convalidated, confdeltype, confupdtype, confmatchtype,
         (select array_agg(a.attname order by k.ord) from unnest(conkey) with ordinality k(attnum, ord)
            join pg_attribute a on a.attrelid = conrelid and a.attnum = k.attnum) as cols,
         (select array_agg(a.attname order by k.ord) from unnest(confkey) with ordinality k(attnum, ord)
            join pg_attribute a on a.attrelid = confrelid and a.attnum = k.attnum) as refcols
    into c
    from pg_constraint
   where conrelid = 'public.tasks'::regclass and confrelid = 'public.mandates'::regclass and contype = 'f';
  if c.conname <> 'tasks_org_mandate_fkey'
     or c.cols <> array['org_id', 'mandate_id']::name[]
     or c.refcols <> array['org_id', 'id']::name[]
     or not c.convalidated
     or c.confdeltype <> 'a' or c.confupdtype <> 'a' or c.confmatchtype <> 's' then
    raise exception '0121 aborted: tasks_org_mandate_fkey is not (org_id, mandate_id) -> mandates (org_id, id), validated, NO ACTION, MATCH SIMPLE (found % % -> % validated=% del=% upd=% match=%)',
      c.conname, c.cols, c.refcols, c.convalidated, c.confdeltype, c.confupdtype, c.confmatchtype;
  end if;
  if exists (select 1 from pg_constraint where conrelid = 'public.tasks'::regclass and conname = 'tasks_mandate_id_fkey') then
    raise exception '0121 aborted: the single-column tasks_mandate_id_fkey is still there (two relationships would make PostgREST embeds ambiguous)';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.mandates'::regclass
                    and conname = 'mandates_org_id_id_key' and contype = 'u') then
    raise exception '0121 aborted: mandates_org_id_id_key is missing';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'tasks' and indexname = 'tasks_org_mandate_idx') then
    raise exception '0121 aborted: tasks_org_mandate_idx is missing';
  end if;
  -- 0119's and 0120's keys are untouched
  select count(*) into n from pg_constraint
   where conrelid = 'public.tasks'::regclass and convalidated
     and conname in ('tasks_org_deal_fkey', 'tasks_org_viewing_fkey');
  if n <> 2 then
    raise exception '0121 aborted: 0119''s tasks_org_deal_fkey or 0120''s tasks_org_viewing_fkey is missing or not validated';
  end if;

  -- raise_key_recall_tasks: definer, search_path, service-only; each
  -- predicate in its place (comments stripped, so a word in one can neither
  -- satisfy nor blind the check); and nothing else moved
  select p.prosrc into src
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'raise_key_recall_tasks'
     and p.prosecdef and 'search_path=public' = any (p.proconfig);
  if src is null then
    raise exception '0121 aborted: raise_key_recall_tasks lost SECURITY DEFINER or its search_path';
  end if;
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname in ('raise_key_recall_tasks', 'expire_mandates');
  if n <> 2 then
    raise exception '0121 aborted: expected one overload each of raise_key_recall_tasks and expire_mandates, found %', n;
  end if;
  src := replace(src, E'\r', '');
  if regexp_replace(src, '--[^\n]*', '', 'g')
       !~ 'where t\.mandate_id = c\.mandate_id\s+and t\.org_id = c\.org_id\s+and t\.kind = ''key_recall''\)'
     or regexp_replace(src, '--[^\n]*', '', 'g')
       !~ 'update tasks t\s+set is_done = true, done_at = now\(\)\s+from mandates m\s+where t\.mandate_id = m\.id\s+and t\.org_id = m\.org_id\s+and t\.kind = ''key_recall''' then
    raise exception '0121 aborted: raise_key_recall_tasks does not scope its duplicate guard and its self-heal to the mandate''s organisation';
  end if;
  if (length(src) - length(replace(src, k_guard, ''))) / length(k_guard) <> 1
     or (length(src) - length(replace(src, k_heal, ''))) / length(k_heal) <> 1
     or md5(replace(replace(src, k_guard, ''), k_heal, '')) <> '06d5423a44c44262953f77baf7e0e822' then
    raise exception '0121 aborted: raise_key_recall_tasks is not 0091''s body plus exactly the two organisation predicates';
  end if;
  if has_function_privilege('anon', 'public.raise_key_recall_tasks(uuid, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.raise_key_recall_tasks(uuid, uuid)', 'execute')
     or not has_function_privilege('service_role', 'public.raise_key_recall_tasks(uuid, uuid)', 'execute') then
    raise exception '0121 aborted: raise_key_recall_tasks must be executable by service_role only (T-C4)';
  end if;

  -- expire_mandates: the same checks
  select p.prosrc into src
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'expire_mandates'
     and p.prosecdef and 'search_path=public' = any (p.proconfig);
  if src is null then
    raise exception '0121 aborted: expire_mandates lost SECURITY DEFINER or its search_path';
  end if;
  src := replace(src, E'\r', '');
  if regexp_replace(src, '--[^\n]*', '', 'g')
       !~ 'select 1 from tasks t\s+where t\.mandate_id = m\.id\s+and t\.org_id = m\.org_id\s+and t\.kind = ''mandate_renewal''\s+and \(t\.due_at'
     or regexp_replace(src, '--[^\n]*', '', 'g')
       !~ 'update tasks t\s+set is_done = true, done_at = now\(\)\s+from mandates m\s+where t\.mandate_id = m\.id\s+and t\.org_id = m\.org_id\s+and t\.kind = ''mandate_renewal''\s+and not t\.is_done' then
    raise exception '0121 aborted: expire_mandates does not scope its renewal guard and its renewal self-heal to the mandate''s organisation';
  end if;
  if (length(src) - length(replace(src, k_renew, ''))) / length(k_renew) <> 1
     or (length(src) - length(replace(src, k_heal, ''))) / length(k_heal) <> 1
     or md5(replace(replace(src, k_renew, ''), k_heal, '')) <> 'fc80663f594ddc1db9c0a4b1e19e8eb1' then
    raise exception '0121 aborted: expire_mandates is not 0053''s body plus exactly the two organisation predicates';
  end if;
  if has_function_privilege('anon', 'public.expire_mandates()', 'execute')
     or has_function_privilege('authenticated', 'public.expire_mandates()', 'execute')
     or has_function_privilege('service_role', 'public.expire_mandates()', 'execute') then
    raise exception '0121 aborted: expire_mandates must be callable by its owner only (0022; pg_cron runs it as postgres)';
  end if;

  -- the constraint, exercised: two organisations, A's mandate, B's task
  -- naming it. The foreign-key violation this looks for is what unwinds the
  -- sub-block's own inserts (0088's probe); a task of A on A's mandate and a
  -- mandate-less task must pass first. Needs no profile (a mandate's
  -- created_by is nullable), so it runs on an empty database too.
  v_ok := null;
  declare
    v_org_a uuid; v_org_b uuid; v_prop uuid; v_mandate uuid;
  begin
    begin
      insert into organizations (name, slug)
        values ('0121 probe A (rolled back)', '0121-probe-a-' || replace(gen_random_uuid()::text, '-', ''))
        returning id into v_org_a;
      insert into organizations (name, slug)
        values ('0121 probe B (rolled back)', '0121-probe-b-' || replace(gen_random_uuid()::text, '-', ''))
        returning id into v_org_b;
      insert into properties (org_id, reference, property_type)
        values (v_org_a, 'ZZZ0121-probe', 'apartment')
        returning id into v_prop;
      insert into mandates (org_id, property_id, type)
        values (v_org_a, v_prop, 'open')
        returning id into v_mandate;
      -- the same-organisation link, and a task without a mandate: both accepted
      insert into tasks (org_id, title, mandate_id, kind) values (v_org_a, '0121 probe own', v_mandate, 'key_recall');
      insert into tasks (org_id, title)                   values (v_org_a, '0121 probe none');
      -- organisation B's row naming organisation A's mandate: the
      -- single-column key accepted this
      insert into tasks (org_id, title, mandate_id, kind) values (v_org_b, '0121 probe cross', v_mandate, 'key_recall');
      raise exception using errcode = 'P0121', message = '0121 probe: a cross-organisation task was ACCEPTED';
    exception
      when foreign_key_violation then
        -- refused, and the sub-block's inserts are gone — but only THIS key's
        -- refusal is the verdict: any other 23503 in the sub-block is a probe
        -- that proved nothing
        get stacked diagnostics v_con = constraint_name;
        v_ok := (v_con = 'tasks_org_mandate_fkey');
      when sqlstate 'P0121' then
        v_ok := false;  -- accepted, and the sub-block's inserts are gone too
    end;
  end;
  if v_ok is distinct from true then
    raise exception '0121 aborted: tasks_org_mandate_fkey did not refuse a task naming another organisation''s mandate (the probe met %)',
      coalesce(v_con, 'no foreign-key violation — the cross-organisation row was accepted');
  end if;

  raise notice '0121: tasks (org_id, mandate_id) -> mandates (org_id, id); key-recall and renewal guards and self-heals scoped to the mandate''s organisation';
end $$;
