-- =============================================================================
-- 0126 — a reservation belongs to the organisation of its contact, a task to
--        the organisation of the contact and the property it names, and the
--        retention sweep looks for, and completes, only the contact's own
--        organisation's reminders
--
-- THE GAP (BACKLOG "Every other tasks.* link is org-blind" — contact_id and
-- property_id, the two links 0125 left open — and its arm 4c; an external
-- audit of 2bad473 reproduced it on an isolated PostgreSQL fixture; reproduced
-- here 2026-09-29 against 2bad473 on the local stack at 0125, through
-- PostgREST with aal2 sessions of two throwaway organisations, and pinned RED
-- first by supabase/tests/task-contact-property-org-isolation.test.ts — its
-- 20 tests marked "RED at 0125" failed at 0125, each for the
-- reason it names, and the property link on its own too; its migration-file
-- tests need this file itself):
--
--   * reservations.contact_id (0044, ON DELETE SET NULL), tasks.contact_id and
--     tasks.property_id (0001, NO ACTION) referenced their parent by id ALONE,
--     and reservations_insert / reservations_update (0044) and tasks_insert /
--     tasks_update (0030 / 0032) check only the CALLER's organisation. A
--     member of organisation B who learned an organisation-A contact or
--     property id — B can read neither row, but an id travels in links,
--     screenshots and logs — could INSERT a reservation or a task of B naming
--     it, PATCH one of B's rows onto it or UPSERT the same; and a real id
--     (accepted) and a missing one (23503) told B whether the A row exists.
--   * create_followup_nudges (0078's retention arms, 0123's text) matched
--     retention_expired tasks to contacts by that id alone:
--       - arm 2c's duplicate guard counted a B row on A's contact, dated A's
--         retention day, as A's reminder — A's "review for destruction"
--         reminder was never raised;
--       - arm 4c (the self-heal) completed B's rows on A's contact dated any
--         day but A's retention day, and all of them once A's marker was
--         cleared, each with a `superseded` event in ORGANISATION B's chain —
--         so B, planting on several days, learned A's private retention date
--         and A's purge (measured: the two rows dated differently were
--         completed, the matching one stayed open, then clearing A's marker
--         completed it).
--   * warn_expiring_reservations and remind_due_installments (0125's text)
--     copy the hold's contact_id into the reminder, so a B hold naming A's
--     contact put A's contact id into B's tasks.
--
-- THE FIX — 0119–0125's two layers:
--
--   A. THE RELATIONSHIPS. reservations (org_id, contact_id) → contacts
--      (org_id, id) (reservations_org_contact_fkey, ON DELETE SET NULL
--      (contact_id)), tasks (org_id, contact_id) → contacts (org_id, id)
--      (tasks_org_contact_fkey, NO ACTION) and tasks (org_id, property_id) →
--      properties (org_id, id) (tasks_org_property_fkey, NO ACTION) each
--      REPLACE the single-column key, so PostgREST keeps ONE relationship per
--      pair. The referenced keys are 0123's contacts_org_id_id_key and 0088's
--      properties_org_id_id_key.
--        - ON DELETE SET NULL (contact_id), not plain SET NULL: a plain SET
--          NULL action on a composite key nulls EVERY referencing column, and
--          reservations.org_id is NOT NULL, so deleting a contact would fail
--          23502 where it used to clear the link. With the column list
--          (PostgreSQL 15+; local and hosted run 17) deleting a contact
--          clears only the hold's contact_id, exactly as 0044's key did, and
--          the hold keeps its organisation.
--        - NO ACTION for both task keys, as 0001's were: a contact or a
--          property with tasks still cannot be deleted.
--        - ON UPDATE NO ACTION as before, and it now covers the parent's
--          org_id too, so a contact or property that is linked cannot be
--          moved to another organisation (no application path writes any of
--          these org_ids), and neither can the linked task or hold.
--        - MATCH SIMPLE, and all four org_id columns are NOT NULL (asserted
--          below), so a row with no contact / property is exactly as before
--          and nothing else escapes the check.
--        - Each referencing side gets a partial (org_id, x) index (the
--          advisors' unindexed-foreign-key rule reads an index's leading
--          columns; 0044's / 0001's single-column indexes stay — they serve
--          the lookups by the parent id alone, the contact and property
--          pages). Neither table has a unique index naming these columns
--          (asserted below), so no 23505 can answer before these keys' 23503.
--        - A cross-organisation id and a missing id now read the same 23503
--          — no existence oracle through THESE THREE columns. The constraints
--          bind EVERY writer, service_role and definer bodies included.
--      ORDER, and why it is one file: both reservation sweeps copy the hold's
--      contact into tasks.contact_id. The tasks contact key ALONE would turn
--      one B hold naming an A contact into a refused insert that aborts
--      warn_expiring_reservations / remind_due_installments for EVERY
--      organisation (the audit measured it). The reservation key is added
--      first, and both commit together or not at all — there is no moment
--      with the second and without the first (and B below makes the sweeps
--      robust to such a hold even so). The sweeps copy tasks' property_id
--      only through keys that are already tenant-bound (viewings 0123,
--      mandates 0122, reservations 0124, and the SLA sweep's p.id, 0124), and
--      the application writers take org_id and the contact / property from
--      the same organisation (DEPLOY ORDER below).
--
--   B. THE SWEEPS. Each ties what it reads to ITS OWN row's organisation, row
--      by row, never current_org_id(): every one of them serves every
--      organisation in one cron run (p_org null), and a session filter would
--      silently shrink that job to one organisation, or none under the cron's
--      session. The existing `(p_org is null or … = p_org)` filters are the
--      CALLER's scope, not this tie, and stay. With A validated none of these
--      can change a result; they are defence in depth for a row A could not
--      have stopped (one written before a NOT VALID constraint after an
--      approved repair, or loaded by a replica-mode restore), and they state
--      each function's contract in its own text.
--        - create_followup_nudges gains `and t.org_id = d.org_id` in arm 2c's
--          duplicate guard and `and t.org_id = c.org_id` in arm 4c's
--          self-heal. The other arms' task matches (1–4b: deal_id,
--          viewing_id) are bound by 0119's and 0120's keys and are untouched.
--        - warn_expiring_reservations and remind_due_installments copy the
--          hold's contact through `left join contacts ct on ct.id =
--          r.contact_id and ct.org_id = r.org_id` (`ct.id as contact_id`)
--          instead of r.contact_id: 0124's SLA-sweep idiom (copy what was
--          read through a tenant-bound join). For every hold the key admits
--          this is the same id; for a hold it could not have stopped (above)
--          the reminder is raised WITHOUT the foreign contact — rather than
--          the tasks contact key refusing the insert and aborting the run for
--          EVERY organisation. LEFT, because a hold's contact is optional: a
--          hold with none, or whose contact is not its own organisation's,
--          still gets its reminder. Their guards, self-heals, titles, dates,
--          assignees and events are 0125's.
--      NOTHING ELSE moves in the three bodies (0123's / 0125's text) — the
--      assertions below prove it by comparing each new body, minus exactly
--      its own added lines, with the canonical one. ACLs restated:
--      service_role only (pg_cron runs them as postgres).
--
-- NOT CHANGED HERE (BACKLOG): leads.contact_id / converted_deal_id,
-- reservations.deal_id / offer_id / payment_plan_id, deals' and offers'
-- contact and property links, mandates' and properties' contact links, the
-- profile links; createReservation's missing RLS re-read of the form's
-- contact (a crafted foreign id is now refused 23503 by A, and the user sees
-- the driver's message instead of a sentence); mergeContacts' repoint without
-- an org filter (only same-organisation rows can match once A is validated).
--
-- EXISTING DATA. The preflight below counts reservations whose organisation
-- differs from their contact's, and tasks whose organisation differs from
-- their contact's or property's, and ABORTS THE WHOLE FILE before any DDL if
-- there are any: nothing is deleted, reassigned or repaired here, and no
-- constraint is ever added NOT VALID by this file. It also refuses if the
-- three keys it replaces are not the ones 0001 / 0044 left (their delete rule
-- is what it preserves), or if any of the three bodies, or their attributes
-- (definer, search_path, language, return type, volatility, argument list and
-- default, strictness, parallel safety, leakproof, EXECUTE grants), are not
-- the ones this file restates them from — an unrecorded hand edit is not
-- overwritten. Comments are restated, not guarded.
--
-- LOCKS. Every lock the DDL needs is taken at its strongest, in ONE
-- statement, BEFORE the counts: reservations, properties, contacts, then tasks
-- — parents before tasks, the order the reservation and lead-SLA sweeps take
-- them (each reads its parent rows and writes tasks last), so a sweep already
-- running makes this file WAIT for it rather than deadlock with it. What can
-- still collide is a writer that holds tasks and then checks a parent — every
-- task insert naming a contact or property checks its key at the end of its
-- statement, and create_followup_nudges writes tasks (arm 1) before it reads
-- properties and contacts — or a statement that holds contacts before
-- reservations: either ends in a 40P01 deadlock, and one of the two is rolled
-- back whole, cleanly. lock_timeout bounds EACH table's wait, not the
-- statement's: the LOCK can wait up to 5 s on each of its four tables while
-- holding the ones before it — up to about 20 s during which those tables
-- (properties and contacts are read by nearly every page) are unreadable.
-- Apply outside 02:55–04:05 UTC (create_followup_nudges runs at 03:15, the
-- reservation sweeps at 03:45 / 03:50 / 03:55) and not within a minute of a
-- :x0 minute (raise_lead_sla_tasks inserts tasks naming a property every ten
-- minutes), when the site is quiet: a collision costs that wait and a clean
-- 55P03 or 40P01 rollback — then apply again, and do NOT write the ledger row.
-- Run twice by mistake, the file aborts in its preflight (the replaced keys
-- and the bodies are no longer the old ones) and changes nothing.
--
-- DEPLOY ORDER: ADDITIVE — hosted before the merge. Every writer of the three
-- columns takes org_id and the contact / property from the same
-- organisation: the sweeps from tenant-bound rows (above); the application's
-- task and reservation writers from rows re-read under the caller's RLS or
-- read on the admin client with an explicit org_id (DECISIONS lists each).
-- No request the deployed application sends is refused by A. No function
-- signature, return shape or grant changes — no release-compat entry.
-- database.types.ts is regenerated: the Relationships entries
-- reservations_contact_id_fkey / tasks_contact_id_fkey / tasks_property_id_fkey
-- become reservations_org_contact_fkey / tasks_org_contact_fkey /
-- tasks_org_property_fkey over (org_id, x); no TypeScript names either, and no
-- query hints a constraint name.
--
-- ROLLBACK (DECISIONS T-task-contact-property-org-isolation): a FORWARD
-- migration that drops the three keys and their indexes, re-adds
-- `reservations_contact_id_fkey (contact_id) → contacts(id) ON DELETE SET
-- NULL`, `tasks_contact_id_fkey (contact_id) → contacts(id)` and
-- `tasks_property_id_fkey (property_id) → properties(id)`, re-creates
-- create_followup_nudges from 0123's text and the two reservation sweeps from
-- 0125's, each WITH its 0123 / 0125 comment (CREATE OR REPLACE keeps this
-- file's, which would then be false); regenerate the types, move the
-- verify-restore migrations pin FORWARD (one more ledger row), remove its 0126
-- rows, remove the new test file and supabase/tests/revert-0126.ts with the
-- lines that call it (its tests marked RED at 0125 fail on the rolled-back
-- catalogue), revert the docs. No data moves either way: every row valid at
-- 0126 is valid at 0125. Roll 0126 back BEFORE 0123 and 0125: its contact keys
-- depend on 0123's contacts_org_id_id_key, so 0123's own rollback stops at
-- that drop (2BP01, changing nothing) while 0126 is in place, and 0125's
-- rollback restates the reservation sweeps from bodies that carry 0126's
-- lines.
--
-- Pins that move with this file: the migrations count (125 -> 126) and four
-- 0126 invariant rows in scripts/backup/verify-restore.sql (the three
-- mismatch counts and one of dangling ids). NO EXPLICIT begin/commit — the CLI
-- wraps the file (HANDOFF §3), as does one execute_sql call.
-- =============================================================================

-- Bounded lock waits (0113's lesson); see LOCKS above.
set local lock_timeout = '5s';

-- The file must run as ONE transaction (the CLI's wrapper, or one
-- execute_sql call): otherwise SET LOCAL is a no-op, the preflight's LOCK is
-- released as soon as its statement ends, and a failed assertion would not
-- undo the DDL before it.
do $$
begin
  if current_setting('lock_timeout') <> '5s' then
    raise exception '0126 aborted: this file must run as ONE transaction (SET LOCAL lock_timeout did not take effect) — nothing was changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 0. Preflight — abort, whole, over existing mismatches, a changed key or a
--    changed body
-- ---------------------------------------------------------------------------
do $$
declare
  n_rc int; n_tc int; n_tp int;
  k record;
  f record;
  v_md5 text;
begin
  -- every lock the DDL below needs, at its strongest, BEFORE the counts;
  -- parents first, tasks last (see LOCKS in the header)
  lock table public.reservations, public.properties, public.contacts, public.tasks in access exclusive mode;

  select count(*) into n_rc from public.reservations r join public.contacts c on c.id = r.contact_id where r.org_id <> c.org_id;
  select count(*) into n_tc from public.tasks t join public.contacts c on c.id = t.contact_id where t.org_id <> c.org_id;
  select count(*) into n_tp from public.tasks t join public.properties p on p.id = t.property_id where t.org_id <> p.org_id;
  if n_rc + n_tc + n_tp > 0 then
    raise exception '0126 aborted: % reservation(s) name a contact of another organisation, % task(s) name a contact of another organisation, % task(s) name a property of another organisation — nothing was changed. '
                    'List them with the three joins in this preflight (reservations/contacts, tasks/contacts, tasks/properties) and decide before constraining',
                    n_rc, n_tc, n_tp;
  end if;

  -- the keys this file replaces must be the ones it replaces — their delete
  -- and update rules are what it preserves — and the only ones for the pair
  for k in
    select * from (values
      ('public.reservations'::regclass, 'public.contacts'::regclass,   'reservations_contact_id_fkey', 'FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL', '0044'),
      ('public.tasks'::regclass,        'public.contacts'::regclass,   'tasks_contact_id_fkey',        'FOREIGN KEY (contact_id) REFERENCES contacts(id)',                   '0001'),
      ('public.tasks'::regclass,        'public.properties'::regclass, 'tasks_property_id_fkey',       'FOREIGN KEY (property_id) REFERENCES properties(id)',                '0001')
    ) as t(rel, ref, name, def, src)
  loop
    if (select count(*) from pg_constraint where conrelid = k.rel and confrelid = k.ref and contype = 'f') <> 1
       or not exists (select 1 from pg_constraint
                       where conrelid = k.rel and confrelid = k.ref and contype = 'f' and conname = k.name
                         and convalidated and not condeferrable and pg_get_constraintdef(oid) = k.def) then
      raise exception '0126 aborted: the foreign key from % to % is not %''s % (%, validated, not deferrable, the only one) on this database — nothing was changed. '
                      'This file replaces it and keeps its rules; compare it with % and decide before applying',
                      k.rel, k.ref, k.src, k.name, k.def, k.src;
    end if;
  end loop;

  -- the functions this file restates must be the ones it restates them FROM:
  -- the body (md5) AND the attributes CREATE OR REPLACE and the grants below
  -- would silently reset — definer, search_path, language, return type,
  -- volatility, the argument list with its default, strictness, parallel
  -- safety, leakproof, EXECUTE grants
  for f in
    select * from (values
      ('create_followup_nudges',     'public.create_followup_nudges(uuid)',     '874347807d5340b5b3a2cd588e3b7499', '0123'),
      ('warn_expiring_reservations', 'public.warn_expiring_reservations(uuid)', '6f9febc3430ec5bba9cb4a81f1eb46fb', '0125'),
      ('remind_due_installments',    'public.remind_due_installments(uuid)',    'b84ea00e6b0a54a207e74f1edc817007', '0125')
    ) as t(name, sig, expect, src)
  loop
    select md5(replace(p.prosrc, E'\r', '')) into v_md5 from pg_proc p where p.oid = to_regprocedure(f.sig);
    if v_md5 is distinct from f.expect then
      raise exception '0126 aborted: % is not the body 0126 expects on this database (md5 %) — nothing was changed. '
                      'This file would overwrite it; diff the live body against %''s and decide before applying',
                      f.name, coalesce(v_md5, 'missing'), f.src;
    end if;
    if not exists (select 1 from pg_proc p
                    where p.oid = to_regprocedure(f.sig) and p.prosecdef
                      and p.proconfig = array['search_path=public'] and p.provolatile = 'v'
                      and p.prolang = (select l.oid from pg_language l where l.lanname = 'sql')
                      and p.prorettype = 'void'::regtype
                      and pg_get_function_arguments(p.oid) = 'p_org uuid DEFAULT NULL::uuid'
                      and not p.proisstrict and p.proparallel = 'u' and not p.proleakproof)
       or has_function_privilege('anon', to_regprocedure(f.sig), 'execute')
       or has_function_privilege('authenticated', to_regprocedure(f.sig), 'execute')
       or not has_function_privilege('service_role', to_regprocedure(f.sig), 'execute') then
      raise exception '0126 aborted: %''s attributes (SECURITY DEFINER, search_path, language, return type, volatility, arguments, strictness, parallel safety, leakproof or EXECUTE grants) are not the ones 0126 expects on this database — nothing was changed. '
                      'This file would reset them; compare them with %''s and decide before applying',
                      f.name, f.src;
    end if;
  end loop;
  raise notice '0126: preflight passed — no reservation names a contact, and no task a contact or property, of another organisation; the three keys and the three bodies are the ones replaced';
end $$;

-- ---------------------------------------------------------------------------
-- A. The relationships — the reservation's contact FIRST (see ORDER above)
-- ---------------------------------------------------------------------------
alter table public.reservations
  drop constraint reservations_contact_id_fkey;
alter table public.reservations
  add constraint reservations_org_contact_fkey
    foreign key (org_id, contact_id) references public.contacts (org_id, id) on delete set null (contact_id);
comment on constraint reservations_org_contact_fkey on public.reservations is
  '0126: a reservation belongs to the organisation of the contact it names, by construction. '
  'Replaces the single-column FK on contact_id; ON DELETE SET NULL (contact_id), as that one cleared the link — '
  'the column list keeps org_id (a plain SET NULL would null it too); a reservation with no contact is not checked (MATCH SIMPLE).';
create index if not exists reservations_org_contact_idx
  on public.reservations (org_id, contact_id)
  where contact_id is not null;

alter table public.tasks
  drop constraint tasks_contact_id_fkey;
alter table public.tasks
  add constraint tasks_org_contact_fkey
    foreign key (org_id, contact_id) references public.contacts (org_id, id);
comment on constraint tasks_org_contact_fkey on public.tasks is
  '0126: a task belongs to the organisation of the contact it names, by construction. '
  'Replaces the single-column FK on contact_id (NO ACTION, as that one was); a task with no contact is not checked (MATCH SIMPLE).';
create index if not exists tasks_org_contact_idx
  on public.tasks (org_id, contact_id)
  where contact_id is not null;

alter table public.tasks
  drop constraint tasks_property_id_fkey;
alter table public.tasks
  add constraint tasks_org_property_fkey
    foreign key (org_id, property_id) references public.properties (org_id, id);
comment on constraint tasks_org_property_fkey on public.tasks is
  '0126: a task belongs to the organisation of the property it names, by construction. '
  'Replaces the single-column FK on property_id (NO ACTION, as that one was); a task with no property is not checked (MATCH SIMPLE).';
create index if not exists tasks_org_property_idx
  on public.tasks (org_id, property_id)
  where property_id is not null;

-- ---------------------------------------------------------------------------
-- B1. create_followup_nudges (0123's text + `and t.org_id = d.org_id` in arm
--     2c's duplicate guard and `and t.org_id = c.org_id` in arm 4c's
--     self-heal)
-- ---------------------------------------------------------------------------
create or replace function public.create_followup_nudges(p_org uuid default null)
returns void
language sql security definer set search_path = public as $$
  -- 1) no-contact nudges: open deals with no logged contact for N days, one
  --    task per silent period, due Cyprus end-of-day of the boundary crossed
  with stale as (
    select d.id, d.org_id, d.title, d.agent_id, d.created_by,
           (coalesce(d.last_contact_at, d.created_at) at time zone 'Asia/Nicosia')::date
             + (nudge_threshold('deal_no_contact_days', 14))::int as boundary
      from deals d
     where d.status = 'open'
       and (p_org is null or d.org_id = p_org)
  ),
  created as (
    insert into tasks (org_id, title, due_at, assignee_id, deal_id, kind)
    -- the title states the CURRENT threshold; a task minted under the old one
    -- keeps the old wording, which is right — it is what was true when it was
    -- raised, and the supersede below closes it anyway
    select s.org_id,
           'No contact in ' || (nudge_threshold('deal_no_contact_days', 14))::int
             || ' days: ' || s.title,
           (s.boundary::timestamp + interval '23 hours 59 minutes') at time zone 'Asia/Nicosia',
           coalesce(
             (select pr.id from profiles pr where pr.id = s.agent_id and pr.is_active),
             (select pr.id from profiles pr where pr.id = s.created_by and pr.is_active),
             (select pr.id from profiles pr
               where pr.org_id = s.org_id and pr.role = 'admin' and pr.is_active
               order by pr.created_at limit 1)),
           s.id,
           'deal_no_contact'
      from stale s
     where current_date >= s.boundary
       -- keyed to THIS boundary, not to "any nudge for this deal": logging
       -- contact moves last_contact_at, which moves the boundary, so a later
       -- silence is a new cycle and mints a new task
       and not exists (
         select 1 from tasks t
          where t.deal_id = s.id
            and t.kind = 'deal_no_contact'
            and (t.due_at at time zone 'Asia/Nicosia')::date = s.boundary)
    returning org_id, deal_id, id, assignee_id
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'deal', deal_id, 'followup_task_created',
         jsonb_build_object('kind', 'deal_no_contact', 'task_id', id,
                            'assignee_id', assignee_id,
                            'days', (nudge_threshold('deal_no_contact_days', 14))::int)
  from created;

  -- 2) viewing-feedback nudges. The due date is a deterministic function of the
  --    viewing, NOT of when this ran: a catch-up run after cron downtime stamps
  --    the date the nudge should have carried and the task appears already
  --    overdue, which is honest.
  with due as (
    select v.id, v.org_id, v.agent_id, v.created_by, v.property_id, p.reference,
           ((v.scheduled_at + make_interval(hours => (nudge_threshold('viewing_feedback_hours', 48))::int))
              at time zone 'Asia/Nicosia')::date as nag_date
      from viewings v
      join properties p on p.id = v.property_id
       and p.org_id = v.org_id
     where v.status = 'completed'
       and v.feedback is null
       and now() >= v.scheduled_at
                    + make_interval(hours => (nudge_threshold('viewing_feedback_hours', 48))::int)
       and (p_org is null or v.org_id = p_org)
  ),
  created as (
    insert into tasks (org_id, title, due_at, assignee_id, viewing_id, property_id, kind)
    select d.org_id,
           'Log viewing feedback: ' || d.reference,
           (d.nag_date::timestamp + interval '23 hours 59 minutes') at time zone 'Asia/Nicosia',
           coalesce(
             (select pr.id from profiles pr where pr.id = d.agent_id and pr.is_active),
             (select pr.id from profiles pr where pr.id = d.created_by and pr.is_active),
             (select pr.id from profiles pr
               where pr.org_id = d.org_id and pr.role = 'admin' and pr.is_active
               order by pr.created_at limit 1)),
           d.id,
           d.property_id,
           'viewing_feedback'
      from due d
      -- "any task for this viewing" is the RIGHT guard here and is NOT the 0006
      -- bug: a viewing has ONE feedback lifecycle, and saveViewingFeedback can
      -- only ever set feedback, never clear it, so there is no second cycle.
      -- It also means changing the window leaves existing nudges alone.
     where not exists (
       select 1 from tasks t where t.viewing_id = d.id and t.kind = 'viewing_feedback')
    returning org_id, viewing_id, id, assignee_id
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'viewing', viewing_id, 'followup_task_created',
         jsonb_build_object('kind', 'viewing_feedback', 'task_id', id,
                            'assignee_id', assignee_id,
                            'hours', (nudge_threshold('viewing_feedback_hours', 48))::int)
  from created;

  -- 2b) no-show rebooking nudges (0075, audit WF-7). Due the Cyprus day after
  --     the missed slot; a viewing marked no_show weeks late mints a task that
  --     is already overdue, which is honest (same doctrine as arm 2). Not
  --     minted when a rebooking already exists — the nag would open pre-closed.
  with due as (
    select v.id, v.org_id, v.agent_id, v.created_by, v.property_id, v.contact_id,
           p.reference,
           (v.scheduled_at at time zone 'Asia/Nicosia')::date + 1 as nag_date
      from viewings v
      join properties p on p.id = v.property_id
       and p.org_id = v.org_id
     where v.status = 'no_show'
       and (p_org is null or v.org_id = p_org)
       and not exists (
         select 1 from viewings v2
          where v2.org_id = v.org_id
            and v2.contact_id = v.contact_id
            and v2.property_id = v.property_id
            and v2.id <> v.id
            and v2.scheduled_at > v.scheduled_at
            and v2.status <> 'cancelled')
  ),
  created as (
    insert into tasks (org_id, title, due_at, assignee_id, viewing_id, property_id, kind)
    select d.org_id,
           'Rebook after no-show: ' || d.reference,
           (d.nag_date::timestamp + interval '23 hours 59 minutes') at time zone 'Asia/Nicosia',
           coalesce(
             (select pr.id from profiles pr where pr.id = d.agent_id and pr.is_active),
             (select pr.id from profiles pr where pr.id = d.created_by and pr.is_active),
             (select pr.id from profiles pr
               where pr.org_id = d.org_id and pr.role = 'admin' and pr.is_active
               order by pr.created_at limit 1)),
           d.id,
           d.property_id,
           'viewing_no_show'
      from due d
      -- one-shot key (viewing_id, kind), the 0053 rationale: no_show is
      -- terminal, there is no second cycle to arm
     where not exists (
       select 1 from tasks t where t.viewing_id = d.id and t.kind = 'viewing_no_show')
    returning org_id, viewing_id, id, assignee_id
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'viewing', viewing_id, 'followup_task_created',
         jsonb_build_object('kind', 'viewing_no_show', 'task_id', id,
                            'assignee_id', assignee_id)
  from created;

  -- 2c) retention-expired nudges (0078, audit SEC-08). Admin-assigned only —
  --     destruction is admin-only, an agent cannot act on this. Due date IS
  --     the expiry date (already overdue on mint, which is honest: the duty
  --     lapsed the day the window closed). Keyed to the CYCLE: a purge nulls
  --     retention_until and the supersede below closes the task; a re-dated
  --     duty re-arms. Mints nothing for years — the earliest real expiry is
  --     2031 — and that is the point: it fires when memory has long failed.
  with due as (
    select c.id, c.org_id, c.display_name, c.retention_until
      from contacts c
     where c.erased_at is not null
       and c.retention_until is not null
       and c.retention_until <= (now() at time zone 'Asia/Nicosia')::date
       and (p_org is null or c.org_id = p_org)
  ),
  created as (
    insert into tasks (org_id, title, due_at, assignee_id, contact_id, kind)
    select d.org_id,
           'AML retention expired — review for destruction: ' || d.display_name,
           (d.retention_until::timestamp + interval '23 hours 59 minutes') at time zone 'Asia/Nicosia',
           (select pr.id from profiles pr
             where pr.org_id = d.org_id and pr.role = 'admin' and pr.is_active
             order by pr.created_at limit 1),
           d.id,
           'retention_expired'
      from due d
     where not exists (
       select 1 from tasks t
        where t.contact_id = d.id
          and t.org_id = d.org_id
          and t.kind = 'retention_expired'
          and (t.due_at at time zone 'Asia/Nicosia')::date = d.retention_until)
    returning org_id, contact_id, id, assignee_id
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'contact', contact_id, 'followup_task_created',
         jsonb_build_object('kind', 'retention_expired', 'task_id', id,
                            'assignee_id', assignee_id)
  from created;

  -- 3) self-heal the deal invariant. The trigger does this at edit time with
  --    actor attribution; this is the nightly safety net (and the only path
  --    that catches a deal whose boundary moved by a clock change — or, since
  --    0052, by an admin changing the threshold).
  with superseded as (
    update tasks t
       set is_done = true, done_at = now()
      from deals d
     where t.deal_id = d.id
       and t.kind = 'deal_no_contact'
       and not t.is_done
       and (p_org is null or t.org_id = p_org)
       and (d.status <> 'open'
            or (t.due_at at time zone 'Asia/Nicosia')::date
               <> (coalesce(d.last_contact_at, d.created_at) at time zone 'Asia/Nicosia')::date
                  + (nudge_threshold('deal_no_contact_days', 14))::int)
    returning t.org_id, t.id, t.deal_id, d.status, d.last_contact_at, t.created_at
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'task', id, 'superseded',
         jsonb_build_object('kind', 'deal_no_contact', 'deal_id', deal_id,
                            -- SAY WHICH ONE HAPPENED. Before 0052 a moved
                            -- boundary could only mean contact was logged, so
                            -- 'deal_contacted' was safe to assert. Now it can
                            -- also mean the admin changed the setting, and a
                            -- false statement in an append-only log can never
                            -- be taken back. A real contact stamps
                            -- last_contact_at AFTER the task was minted, which
                            -- is what tells the two apart.
                            'reason', case
                              when status <> 'open' then 'deal_closed'
                              when last_contact_at is not null
                               and last_contact_at > created_at then 'deal_contacted'
                              else 'threshold_changed'
                            end)
  from superseded;

  -- 4) self-heal the viewing invariant
  with superseded as (
    update tasks t
       set is_done = true, done_at = now()
      from viewings v
     where t.viewing_id = v.id
       and t.kind = 'viewing_feedback'
       and not t.is_done
       and (p_org is null or t.org_id = p_org)
       and (v.feedback is not null or v.status <> 'completed')
    returning t.org_id, t.id, t.viewing_id
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'task', id, 'superseded',
         jsonb_build_object('kind', 'viewing_feedback', 'viewing_id', viewing_id,
                            'reason', 'feedback_logged_or_viewing_reopened')
  from superseded;

  -- 4b) self-heal the no-show invariant (0075): a LATER non-cancelled viewing
  --     for the same contact+property means the rebooking happened — close the
  --     nag. The reason states exactly what the predicate proved, nothing more.
  with superseded as (
    update tasks t
       set is_done = true, done_at = now()
      from viewings v
     where t.viewing_id = v.id
       and t.kind = 'viewing_no_show'
       and not t.is_done
       and (p_org is null or t.org_id = p_org)
       and exists (
         select 1 from viewings v2
          where v2.org_id = v.org_id
            and v2.contact_id = v.contact_id
            and v2.property_id = v.property_id
            and v2.id <> v.id
            and v2.scheduled_at > v.scheduled_at
            and v2.status <> 'cancelled')
    returning t.org_id, t.id, t.viewing_id
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'task', id, 'superseded',
         jsonb_build_object('kind', 'viewing_no_show', 'viewing_id', viewing_id,
                            'reason', 'viewing_rebooked')
  from superseded;

  -- 4c) self-heal the retention invariant (0078): a purge nulls the marker
  --     (purgeExpiredRetention clears retention_until), and a corrected duty
  --     moves it — either way the open nag no longer describes the row. The
  --     reason names only what the predicate proved.
  with superseded as (
    update tasks t
       set is_done = true, done_at = now()
      from contacts c
     where t.contact_id = c.id
       and t.org_id = c.org_id
       and t.kind = 'retention_expired'
       and not t.is_done
       and (p_org is null or t.org_id = p_org)
       and (c.retention_until is null
            or (t.due_at at time zone 'Asia/Nicosia')::date <> c.retention_until)
    returning t.org_id, t.id, t.contact_id
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'task', id, 'superseded',
         jsonb_build_object('kind', 'retention_expired', 'contact_id', contact_id,
                            'reason', 'retention_purged_or_changed')
  from superseded;

  -- 5) self-heal the assignee invariant (0024). Deliberately covers EVERY
  --    system kind, mandate_renewal included: this job runs at 03:15, fifteen
  --    minutes after expire_mandates, so one place owns the invariant for all
  --    three rather than each cron re-implementing it.
  with rehomed as (
    update tasks t
       set assignee_id = (
         select pr.id from profiles pr
          where pr.org_id = t.org_id and pr.role = 'admin' and pr.is_active
          order by pr.created_at limit 1)
     where t.kind is not null
       and not t.is_done
       and (p_org is null or t.org_id = p_org)
       and exists (
         select 1 from profiles pr
          where pr.id = t.assignee_id and not pr.is_active)
       and exists (
         select 1 from profiles pr
          where pr.org_id = t.org_id and pr.role = 'admin' and pr.is_active)
    returning t.org_id, t.id, t.assignee_id, t.kind
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'task', id, 'reassigned',
         jsonb_build_object('kind', kind, 'assignee_id', assignee_id,
                            'reason', 'assignee_deactivated')
  from rehomed;
$$;

-- create or replace keeps the ACL (0020 / 0025); restated so hosted and local
-- cannot differ — pg_cron runs it as postgres and needs no grant
revoke execute on function public.create_followup_nudges(uuid) from public, anon, authenticated;
grant  execute on function public.create_followup_nudges(uuid) to service_role;

comment on function public.create_followup_nudges(uuid) is
  'Nightly (pg_cron, 03:15 UTC, as postgres; p_org null = every organisation) and '
  'service_role only: raises and self-heals the deal no-contact, viewing feedback, '
  'no-show rebooking and retention-expired reminders, and re-homes reminders of '
  'deactivated assignees. Since 0123 the viewing feedback and no-show arms read only '
  'the viewing''s own organisation''s property (p.org_id = v.org_id).'
  ' Since 0126 the retention arms'' duplicate guard and self-heal read only the contact''s own organisation''s tasks (t.org_id = the contact''s org_id).';

-- ---------------------------------------------------------------------------
-- B2. warn_expiring_reservations (0125's text; the hold's contact copied
--     through `left join contacts ct on ct.id = r.contact_id and ct.org_id =
--     r.org_id` as `ct.id as contact_id`)
-- ---------------------------------------------------------------------------
create or replace function public.warn_expiring_reservations(p_org uuid default null)
returns void
language sql security definer set search_path = public as $$
  with due_soon as (
    select r.id, r.org_id, r.property_id, ct.id as contact_id, r.created_by,
           r.expires_at,
           (r.expires_at at time zone 'Asia/Nicosia')::date as expiry_date,
           p.reference,
           p.assigned_agent_id
      from reservations r
      join properties p on p.id = r.property_id
       and p.org_id = r.org_id
      left join contacts ct on ct.id = r.contact_id
       and ct.org_id = r.org_id
     where r.status in ('held', 'confirmed')
       and r.expires_at > now()
       and r.expires_at <= now()
                           + make_interval(days => (nudge_threshold('reservation_expiry_days', 2))::int)
       and (p_org is null or r.org_id = p_org)
  ),
  created as (
    insert into tasks (org_id, title, due_at, assignee_id, property_id,
                       contact_id, reservation_id, kind)
    select d.org_id,
           'Reservation on ' || d.reference || ' lapses ' || to_char(d.expiry_date, 'DD Mon'),
           (d.expiry_date::timestamp + interval '23 hours 59 minutes') at time zone 'Asia/Nicosia',
           coalesce(
             d.created_by,
             d.assigned_agent_id,
             (select pr.id from profiles pr
               where pr.org_id = d.org_id and pr.role = 'admin' and pr.is_active
               order by pr.created_at limit 1)),
           d.property_id,
           d.contact_id,
           d.id,
           'reservation_expiring'
      from due_soon d
     where not exists (
       select 1 from tasks t
        where t.reservation_id = d.id
          and t.org_id = d.org_id
          and t.kind = 'reservation_expiring'
          -- keyed to THIS expiry, which is NOT a function of the threshold:
          -- widening the window changes which holds are picked up, never the
          -- key, so nothing re-mints
          and (t.due_at at time zone 'Asia/Nicosia')::date = d.expiry_date
     )
    returning org_id, id, reservation_id, property_id, assignee_id
  ),
  logged as (
    insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
    select org_id, null, 'property', property_id, 'reservation_expiring_soon',
           jsonb_build_object('task_id', id, 'reservation_id', reservation_id,
                              'assignee_id', assignee_id,
                              'days', (nudge_threshold('reservation_expiry_days', 2))::int)
      from created
    returning 1
  ),
  superseded as (
    update tasks t
       set is_done = true, done_at = now()
      from reservations r
     where t.reservation_id = r.id
       and t.org_id = r.org_id
       and t.kind = 'reservation_expiring'
       and not t.is_done
       and (p_org is null or t.org_id = p_org)
       and (r.status not in ('held', 'confirmed')
            or (t.due_at at time zone 'Asia/Nicosia')::date
               <> (r.expires_at at time zone 'Asia/Nicosia')::date)
    returning t.org_id, t.id, t.reservation_id, r.status
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'task', id, 'superseded',
         jsonb_build_object('kind', 'reservation_expiring',
                            'reservation_id', reservation_id,
                            'reason', case
                              when status in ('held', 'confirmed') then 'reservation_extended'
                              else 'reservation_no_longer_live'
                            end)
    from superseded;
$$;

revoke execute on function public.warn_expiring_reservations(uuid) from public, anon, authenticated;
grant  execute on function public.warn_expiring_reservations(uuid) to service_role;

comment on function public.warn_expiring_reservations(uuid) is
  'Nightly (pg_cron 03:50 UTC, as postgres; p_org null = every organisation) and service_role only: raises one '
  'reservation_expiring reminder per live hold about to lapse and completes it when the hold is extended or no '
  'longer live. Since 0124 it reads only the hold''s own organisation''s property (p.org_id = r.org_id).'
  ' Since 0125 its duplicate guard and its self-heal read only the hold''s own organisation''s tasks (t.org_id = the hold''s org_id).'
  ' Since 0126 it copies only the hold''s own organisation''s contact (ct.org_id = r.org_id); a hold with no such contact is reminded without one.';

-- ---------------------------------------------------------------------------
-- B3. remind_due_installments (0125's text; the hold's contact copied the
--     same way)
-- ---------------------------------------------------------------------------
create or replace function public.remind_due_installments(p_org uuid default null)
returns void
language sql security definer set search_path = public as $$
  with due_soon as (
    select i.id, i.org_id, i.reservation_id, i.label, i.amount, i.due_date,
           i.due_date - (now() at time zone 'Asia/Nicosia')::date as days_out,
           r.property_id, ct.id as contact_id, r.created_by,
           p.reference,
           p.assigned_agent_id
      from reservation_installments i
      join reservations r on r.id = i.reservation_id
       and r.org_id = i.org_id
      join properties    p on p.id = r.property_id
       and p.org_id = r.org_id
      left join contacts ct on ct.id = r.contact_id
       and ct.org_id = r.org_id
     where i.paid_at is null
       and i.due_date is not null
       -- CHASEABLE, not LIVE (0051): `converted` is the state a buyer spends
       -- most of a payment plan in, and dropping it here would stop chasing
       -- money the moment a sale is signed. RLS test 35 pins this.
       and r.status in ('held', 'confirmed', 'converted')
       and i.due_date <= (now() at time zone 'Asia/Nicosia')::date
                         + (nudge_threshold('installment_due_days', 7))::int
       and (p_org is null or i.org_id = p_org)
  ),
  created as (
    insert into tasks (org_id, title, due_at, assignee_id, property_id,
                       contact_id, reservation_id, installment_id, kind)
    select d.org_id,
           'Instalment "' || d.label || '" on ' || d.reference
             || ' due ' || to_char(d.due_date, 'DD Mon'),
           (d.due_date::timestamp + interval '23 hours 59 minutes') at time zone 'Asia/Nicosia',
           coalesce(
             d.created_by,
             d.assigned_agent_id,
             (select pr.id from profiles pr
               where pr.org_id = d.org_id and pr.role = 'admin' and pr.is_active
               order by pr.created_at limit 1)),
           d.property_id,
           d.contact_id,
           d.reservation_id,
           d.id,
           'installment_due'
      from due_soon d
     where not exists (
       select 1 from tasks t
        where t.installment_id = d.id
          and t.org_id = d.org_id
          and t.kind = 'installment_due'
          -- keyed to the LINE's due date, not to the threshold: widening the
          -- window changes which lines are picked up, never the key
          and (t.due_at at time zone 'Asia/Nicosia')::date = d.due_date
     )
    returning org_id, id, installment_id, reservation_id, property_id, assignee_id
  ),
  logged as (
    insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
    select c.org_id, null, 'property', c.property_id, 'installment_due_soon',
           jsonb_build_object('task_id', c.id,
                              'installment_id', c.installment_id,
                              'reservation_id', c.reservation_id,
                              'assignee_id', c.assignee_id,
                              'label', d.label,
                              'amount', d.amount,
                              'due_date', d.due_date,
                              'days', d.days_out)
      from created c join due_soon d on d.id = c.installment_id
    returning 1
  ),
  superseded as (
    update tasks t
       set is_done = true, done_at = now()
      from reservation_installments i
      join reservations r on r.id = i.reservation_id
       and r.org_id = i.org_id
     where t.installment_id = i.id
       and t.org_id = i.org_id
       and t.kind = 'installment_due'
       and not t.is_done
       and (p_org is null or t.org_id = p_org)
       and (i.paid_at is not null
            or i.due_date is null
            or r.status not in ('held', 'confirmed', 'converted')
            or (t.due_at at time zone 'Asia/Nicosia')::date <> i.due_date)
    returning t.org_id, t.id, t.installment_id, i.paid_at, i.label, r.status
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'task', id, 'superseded',
         jsonb_build_object('kind', 'installment_due',
                            'installment_id', installment_id,
                            'label', label,
                            'reason', case
                              when paid_at is not null then 'installment_paid'
                              when status not in ('held', 'confirmed', 'converted')
                                then 'reservation_no_longer_live'
                              else 'installment_rescheduled'
                            end)
    from superseded;
$$;

revoke execute on function public.remind_due_installments(uuid) from public, anon, authenticated;
grant  execute on function public.remind_due_installments(uuid) to service_role;

comment on function public.remind_due_installments(uuid) is
  'Nightly (pg_cron 03:55 UTC, as postgres; p_org null = every organisation) and service_role only: raises one '
  'installment_due reminder per unpaid line coming due on a chaseable reservation and completes it when the line is '
  'paid, rescheduled or its reservation ends. Since 0124 it reads only the line''s own organisation''s reservation '
  '(r.org_id = i.org_id, in the mint and the self-heal) and that reservation''s own property (p.org_id = r.org_id).'
  ' Since 0125 its duplicate guard and its self-heal read only the line''s own organisation''s tasks (t.org_id = the line''s org_id).'
  ' Since 0126 it copies only the reservation''s own organisation''s contact (ct.org_id = r.org_id); a line whose reservation has no such contact is reminded without one.';

-- ---------------------------------------------------------------------------
-- Apply-time assertions: the shapes, the body, and each key exercised
-- ---------------------------------------------------------------------------
do $$
declare
  c      record;
  n      int;
  src    text;
  v_ok   boolean;
  v_con  text;
  v_step text;
  -- the lines this file adds, exactly (newline + indentation + predicate),
  -- and the one select-list item it rewrites in place
  k_guard   constant text := E'\n          and t.org_id = d.org_id';
  k_heal    constant text := E'\n       and t.org_id = c.org_id';
  k_join    constant text := E'\n      left join contacts ct on ct.id = r.contact_id\n       and ct.org_id = r.org_id';
  k_sel_old constant text := 'r.property_id, r.contact_id, r.created_by,';
  k_sel_new constant text := 'r.property_id, ct.id as contact_id, r.created_by,';
begin
  -- each link: exactly one foreign key for the pair, the composite one,
  -- validated, the stated delete rule (and SET NULL column list), NO ACTION
  -- on update, MATCH SIMPLE, not deferrable; the old key gone
  for c in
    select * from (values
      ('public.reservations'::regclass, 'public.contacts'::regclass,   'reservations_org_contact_fkey', array['org_id','contact_id']::name[],  'n', array['contact_id']::name[], 'reservations_contact_id_fkey'),
      ('public.tasks'::regclass,        'public.contacts'::regclass,   'tasks_org_contact_fkey',        array['org_id','contact_id']::name[],  'a', null::name[],                'tasks_contact_id_fkey'),
      ('public.tasks'::regclass,        'public.properties'::regclass, 'tasks_org_property_fkey',       array['org_id','property_id']::name[], 'a', null::name[],                'tasks_property_id_fkey')
    ) as t(rel, ref, name, cols, del, setnull, old)
  loop
    select count(*) into n from pg_constraint where conrelid = c.rel and confrelid = c.ref and contype = 'f';
    if n <> 1 then
      raise exception '0126 aborted: expected exactly one foreign key from % to %, found %', c.rel, c.ref, n;
    end if;
    if not exists (
      select 1 from pg_constraint k
       where k.conrelid = c.rel and k.confrelid = c.ref and k.contype = 'f'
         and k.conname = c.name and k.convalidated
         and k.confdeltype::text = c.del and k.confupdtype = 'a' and k.confmatchtype = 's' and not k.condeferrable
         and (select array_agg(a.attname order by x.ord) from unnest(k.conkey) with ordinality x(attnum, ord)
                join pg_attribute a on a.attrelid = k.conrelid and a.attnum = x.attnum) = c.cols
         and (select array_agg(a.attname order by x.ord) from unnest(k.confkey) with ordinality x(attnum, ord)
                join pg_attribute a on a.attrelid = k.confrelid and a.attnum = x.attnum) = array['org_id','id']::name[]
         and (select array_agg(a.attname order by x.ord) from unnest(k.confdelsetcols) with ordinality x(attnum, ord)
                join pg_attribute a on a.attrelid = k.conrelid and a.attnum = x.attnum) is not distinct from c.setnull) then
      raise exception '0126 aborted: % is not % -> % (org_id, id), validated, delete rule % (set-null columns %), NO ACTION on update, MATCH SIMPLE, not deferrable',
        c.name, c.cols, c.ref, c.del, coalesce(c.setnull::text, 'none');
    end if;
    if exists (select 1 from pg_constraint where conrelid = c.rel and conname = c.old) then
      raise exception '0126 aborted: the single-column % is still there (two relationships would make PostgREST embeds ambiguous)', c.old;
    end if;
  end loop;
  -- and their exact text, the form pg_dump writes and the restore pack reads
  if (select count(*) from pg_constraint
        where (conname = 'reservations_org_contact_fkey' and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, contact_id) REFERENCES contacts(org_id, id) ON DELETE SET NULL (contact_id)')
           or (conname = 'tasks_org_contact_fkey'        and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, contact_id) REFERENCES contacts(org_id, id)')
           or (conname = 'tasks_org_property_fkey'       and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, property_id) REFERENCES properties(org_id, id)')) <> 3 then
    raise exception '0126 aborted: a new key''s definition is not the one stated';
  end if;

  -- the referenced keys and the referencing indexes
  if (select count(*) from pg_constraint
        where contype = 'u' and pg_get_constraintdef(oid) = 'UNIQUE (org_id, id)'
          and ((conrelid = 'public.contacts'::regclass   and conname = 'contacts_org_id_id_key')
            or (conrelid = 'public.properties'::regclass and conname = 'properties_org_id_id_key'))) <> 2 then
    raise exception '0126 aborted: a referenced (org_id, id) key is missing or wrong';
  end if;
  if (select count(*) from pg_indexes where schemaname = 'public'
        and ((tablename = 'reservations' and indexname = 'reservations_org_contact_idx' and indexdef ~ 'USING btree \(org_id, contact_id\) WHERE \(contact_id IS NOT NULL\)$')
          or (tablename = 'tasks'        and indexname = 'tasks_org_contact_idx'        and indexdef ~ 'USING btree \(org_id, contact_id\) WHERE \(contact_id IS NOT NULL\)$')
          or (tablename = 'tasks'        and indexname = 'tasks_org_property_idx'       and indexdef ~ 'USING btree \(org_id, property_id\) WHERE \(property_id IS NOT NULL\)$'))) <> 3 then
    raise exception '0126 aborted: a referencing index is missing or has the wrong definition';
  end if;
  -- no unique index may answer (23505) before a key does: every unique index
  -- naming one of these columns must name org_id too
  if exists (
    select 1 from pg_index i
     where i.indisunique
       and ((i.indrelid = 'public.tasks'::regclass
              and exists (select 1 from pg_attribute a where a.attrelid = i.indrelid and a.attnum = any (i.indkey)
                             and a.attname in ('contact_id', 'property_id')))
         or (i.indrelid = 'public.reservations'::regclass
              and exists (select 1 from pg_attribute a where a.attrelid = i.indrelid and a.attnum = any (i.indkey)
                             and a.attname = 'contact_id')))
       and not exists (select 1 from pg_attribute a where a.attrelid = i.indrelid and a.attnum = any (i.indkey) and a.attname = 'org_id')) then
    raise exception '0126 aborted: a unique index names contact_id or property_id without org_id — it would answer before the key';
  end if;
  -- MATCH SIMPLE skips a row with any null key column: the boundary rests on
  -- every org_id being NOT NULL
  if exists (select 1 from pg_attribute
              where attname = 'org_id' and not attnotnull
                and attrelid in ('public.tasks'::regclass, 'public.reservations'::regclass,
                                 'public.contacts'::regclass, 'public.properties'::regclass)) then
    raise exception '0126 aborted: an org_id a key relies on is nullable';
  end if;
  -- 0119–0125's tenant-bound keys on these tables and 0123's viewing keys, untouched
  select count(*) into n from pg_constraint
   where convalidated
     and ((conname = 'tasks_org_deal_fkey'                           and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, deal_id) REFERENCES deals(org_id, id)')
       or (conname = 'tasks_org_viewing_fkey'                        and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, viewing_id) REFERENCES viewings(org_id, id)')
       or (conname = 'tasks_org_mandate_fkey'                        and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, mandate_id) REFERENCES mandates(org_id, id)')
       or (conname = 'tasks_org_reservation_fkey'                    and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, reservation_id) REFERENCES reservations(org_id, id) ON DELETE CASCADE')
       or (conname = 'tasks_org_installment_fkey'                    and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, installment_id) REFERENCES reservation_installments(org_id, id) ON DELETE CASCADE')
       or (conname = 'tasks_org_lead_fkey'                           and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, lead_id) REFERENCES leads(org_id, id)')
       or (conname = 'reservations_org_property_fkey'                and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, property_id) REFERENCES properties(org_id, id) ON DELETE RESTRICT')
       or (conname = 'reservation_installments_org_reservation_fkey' and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, reservation_id) REFERENCES reservations(org_id, id) ON DELETE CASCADE')
       or (conname = 'viewings_org_property_fkey'                    and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, property_id) REFERENCES properties(org_id, id)')
       or (conname = 'viewings_org_contact_fkey'                     and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, contact_id) REFERENCES contacts(org_id, id)'));
  if n <> 10 then
    raise exception '0126 aborted: an earlier tenant-bound key (0119–0125) is missing, not validated, or changed';
  end if;

  -- create_followup_nudges: one overload; definer, search_path, language,
  -- return type, volatility, arguments and flags kept; nothing else moved
  -- relative to 0123's body — the body minus exactly this file's two lines;
  -- each predicate in its place (comments stripped for the shape, so a word
  -- in one can neither satisfy nor blind the check); service_role only
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'create_followup_nudges';
  if n <> 1 then
    raise exception '0126 aborted: expected one overload of create_followup_nudges, found %', n;
  end if;
  select p.prosrc into src from pg_proc p
   where p.oid = 'public.create_followup_nudges(uuid)'::regprocedure
     and p.prosecdef and p.proconfig = array['search_path=public'] and p.provolatile = 'v'
     and p.prolang = (select l.oid from pg_language l where l.lanname = 'sql')
     and p.prorettype = 'void'::regtype
     and pg_get_function_arguments(p.oid) = 'p_org uuid DEFAULT NULL::uuid'
     and not p.proisstrict and p.proparallel = 'u' and not p.proleakproof;
  if src is null then
    raise exception '0126 aborted: create_followup_nudges lost SECURITY DEFINER, its search_path, its language, its return type, its volatility, its arguments or its flags';
  end if;
  src := replace(src, E'\r', '');
  if (length(src) - length(replace(src, k_guard, ''))) / length(k_guard) <> 1
     or (length(src) - length(replace(src, k_heal, ''))) / length(k_heal) <> 1
     or md5(replace(replace(src, k_guard, ''), k_heal, '')) <> '874347807d5340b5b3a2cd588e3b7499' then
    raise exception '0126 aborted: create_followup_nudges is not 0123''s body plus exactly 0126''s two lines';
  end if;
  if regexp_replace(src, '--[^\n]*', '', 'g') !~ 'select 1 from tasks t\s+where t\.contact_id = d\.id\s+and t\.org_id = d\.org_id\s+and t\.kind = ''retention_expired'''
     or regexp_replace(src, '--[^\n]*', '', 'g') !~ 'from contacts c\s+where t\.contact_id = c\.id\s+and t\.org_id = c\.org_id\s+and t\.kind = ''retention_expired''' then
    raise exception '0126 aborted: create_followup_nudges does not scope its retention guard and its retention self-heal to the contact''s organisation';
  end if;
  if has_function_privilege('anon', 'public.create_followup_nudges(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.create_followup_nudges(uuid)', 'execute')
     or not has_function_privilege('service_role', 'public.create_followup_nudges(uuid)', 'execute') then
    raise exception '0126 aborted: create_followup_nudges must be executable by service_role only (0020 / 0025)';
  end if;

  -- the two reservation sweeps, the same way: each body minus exactly its
  -- added join (and its select-list item put back) is 0125's; the join and
  -- the copied column where they belong; ACLs
  for c in
    select * from (values
      ('warn_expiring_reservations', 'public.warn_expiring_reservations(uuid)', '6f9febc3430ec5bba9cb4a81f1eb46fb',
       'join properties p on p\.id = r\.property_id\s+and p\.org_id = r\.org_id\s+left join contacts ct on ct\.id = r\.contact_id\s+and ct\.org_id = r\.org_id\s+where r\.status in'),
      ('remind_due_installments',    'public.remind_due_installments(uuid)',    'b84ea00e6b0a54a207e74f1edc817007',
       'join properties\s+p on p\.id = r\.property_id\s+and p\.org_id = r\.org_id\s+left join contacts ct on ct\.id = r\.contact_id\s+and ct\.org_id = r\.org_id\s+where i\.paid_at is null')
    ) as t(name, sig, old_md5, shape)
  loop
    select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public' and p.proname = c.name;
    if n <> 1 then
      raise exception '0126 aborted: expected one overload of %, found %', c.name, n;
    end if;
    select p.prosrc into src from pg_proc p
     where p.oid = to_regprocedure(c.sig)
       and p.prosecdef and p.proconfig = array['search_path=public'] and p.provolatile = 'v'
       and p.prolang = (select l.oid from pg_language l where l.lanname = 'sql')
       and p.prorettype = 'void'::regtype
       and pg_get_function_arguments(p.oid) = 'p_org uuid DEFAULT NULL::uuid'
       and not p.proisstrict and p.proparallel = 'u' and not p.proleakproof;
    if src is null then
      raise exception '0126 aborted: % lost SECURITY DEFINER, its search_path, its language, its return type, its volatility, its arguments or its flags', c.name;
    end if;
    src := replace(src, E'\r', '');
    if (length(src) - length(replace(src, k_join, ''))) / length(k_join) <> 1
       or (length(src) - length(replace(src, k_sel_new, ''))) / length(k_sel_new) <> 1
       or md5(replace(replace(src, k_join, ''), k_sel_new, k_sel_old)) <> c.old_md5 then
      raise exception '0126 aborted: % is not 0125''s body plus exactly 0126''s contact join', c.name;
    end if;
    if regexp_replace(src, '--[^\n]*', '', 'g') !~ c.shape
       -- the reminder copies the contact it READ, never the hold's raw column
       or regexp_replace(src, '--[^\n]*', '', 'g') ~ 'r\.contact_id\s*,'
       or regexp_replace(src, '--[^\n]*', '', 'g') !~ 'ct\.id as contact_id' then
      raise exception '0126 aborted: % does not copy only the hold''s own organisation''s contact', c.name;
    end if;
    if has_function_privilege('anon', to_regprocedure(c.sig), 'execute')
       or has_function_privilege('authenticated', to_regprocedure(c.sig), 'execute')
       or not has_function_privilege('service_role', to_regprocedure(c.sig), 'execute') then
      raise exception '0126 aborted: %''s EXECUTE grants changed', c.name;
    end if;
  end loop;

  -- the keys, exercised: two organisations; A's contact and property, B's
  -- property; A's own hold and task naming them (accepted); then B's task
  -- naming A's contact, B's task naming A's property and B's hold (on B's own
  -- property) naming A's contact, each in its own sub-block and each refused
  -- by ITS key at ITS step. No column here needs a profile, so this runs on an
  -- empty database too.
  declare
    v_org_a uuid; v_org_b uuid; v_prop_a uuid; v_prop_b uuid; v_con_a uuid; v_res uuid;
    v_verdicts text[] := '{}';
  begin
    for c in
      select * from (values
        ('task contact',        'tasks_org_contact_fkey'),         -- B's task naming A's contact
        ('task property',       'tasks_org_property_fkey'),        -- B's task naming A's property
        ('reservation contact', 'reservations_org_contact_fkey')   -- B's hold naming A's contact
      ) as t(kind, expect)
    loop
      v_ok := null; v_con := null; v_step := 'setup';
      begin
        insert into organizations (name, slug)
          values ('0126 probe A (rolled back)', '0126-probe-a-' || replace(gen_random_uuid()::text, '-', ''))
          returning id into v_org_a;
        insert into organizations (name, slug)
          values ('0126 probe B (rolled back)', '0126-probe-b-' || replace(gen_random_uuid()::text, '-', ''))
          returning id into v_org_b;
        insert into properties (org_id, reference, property_type) values (v_org_a, 'ZZZ0126-probe-a', 'apartment') returning id into v_prop_a;
        insert into properties (org_id, reference, property_type) values (v_org_b, 'ZZZ0126-probe-b', 'apartment') returning id into v_prop_b;
        insert into contacts (org_id, first_name) values (v_org_a, '0126 probe A') returning id into v_con_a;
        -- the same-organisation links, and rows with none: all accepted
        v_step := 'own';
        insert into reservations (org_id, property_id, contact_id, status, held_from, expires_at)
          values (v_org_a, v_prop_a, v_con_a, 'held', now(), now() + interval '1 day');
        insert into tasks (org_id, title, contact_id, property_id) values (v_org_a, '0126 probe own', v_con_a, v_prop_a);
        insert into tasks (org_id, title) values (v_org_b, '0126 probe none');
        -- organisation B's row naming organisation A's parent: the
        -- single-column keys accepted each of these
        v_step := 'cross';
        if c.kind = 'task contact' then
          insert into tasks (org_id, title, contact_id) values (v_org_b, '0126 probe cross', v_con_a);
        elsif c.kind = 'task property' then
          insert into tasks (org_id, title, property_id) values (v_org_b, '0126 probe cross', v_prop_a);
        else
          insert into reservations (org_id, property_id, contact_id, status, held_from, expires_at)
            values (v_org_b, v_prop_b, v_con_a, 'held', now(), now() + interval '1 day');
        end if;
        raise exception using errcode = 'P0126', message = '0126 probe: a cross-organisation row was ACCEPTED';
      exception
        when foreign_key_violation then
          -- refused, and the sub-block's inserts are gone — but only THIS
          -- key's refusal, on the CROSS row, is the verdict
          get stacked diagnostics v_con = constraint_name;
          v_ok := (v_con = c.expect and v_step = 'cross');
        when unique_violation then
          get stacked diagnostics v_con = constraint_name;
          v_ok := false;
        when sqlstate 'P0126' then
          v_ok := false;  -- accepted, and the sub-block's inserts are gone too
      end;
      if v_ok is distinct from true then
        raise exception '0126 aborted: the % probe was not refused by % at the cross-organisation step (met % at the % step)',
          c.kind, c.expect, coalesce(v_con, 'no foreign-key violation'), v_step;
      end if;
      v_verdicts := v_verdicts || c.kind;
    end loop;

    -- the reservation key's delete action: deleting a contact clears only the
    -- hold's contact_id; the hold keeps its organisation (and everything else)
    v_ok := null; v_con := null; v_step := 'setup';
    begin
      insert into organizations (name, slug)
        values ('0126 probe A (rolled back)', '0126-probe-a-' || replace(gen_random_uuid()::text, '-', ''))
        returning id into v_org_a;
      insert into properties (org_id, reference, property_type) values (v_org_a, 'ZZZ0126-probe-a', 'apartment') returning id into v_prop_a;
      insert into contacts (org_id, first_name) values (v_org_a, '0126 probe A') returning id into v_con_a;
      insert into reservations (org_id, property_id, contact_id, status, held_from, expires_at)
        values (v_org_a, v_prop_a, v_con_a, 'held', now(), now() + interval '1 day')
        returning id into v_res;
      v_step := 'delete';
      delete from contacts where id = v_con_a;
      v_ok := exists (select 1 from reservations r
                       where r.id = v_res and r.contact_id is null and r.org_id = v_org_a
                         and r.property_id = v_prop_a and r.status = 'held');
      raise exception using errcode = 'P0127', message = '0126 probe: rolled back';
    exception
      when sqlstate 'P0127' then
        null;  -- the verdict is v_ok; the sub-block's rows are gone
      when others then
        get stacked diagnostics v_con = constraint_name;
        v_ok := false;
    end;
    if v_ok is distinct from true then
      raise exception '0126 aborted: deleting a contact did not clear only its hold''s contact_id at the % step (met %)', v_step, coalesce(nullif(v_con, ''), 'no error');
    end if;
    v_verdicts := v_verdicts || 'contact delete clears only contact_id'::text;
    raise notice '0126: probes: %', v_verdicts;
  end;

  raise notice '0126: reservations (org_id, contact_id) and tasks (org_id, contact_id / property_id) tenant-bound; the retention arms look for and complete only the contact''s own organisation''s tasks; the reservation sweeps copy only the hold''s own organisation''s contact';
end $$;
