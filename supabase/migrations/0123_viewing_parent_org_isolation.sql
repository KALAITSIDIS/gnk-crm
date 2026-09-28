-- =============================================================================
-- 0123 — a viewing belongs to the organisation of the property it shows and
--        of the contact it is for, and the nightly sweep's viewing reminders
--        read only the viewing's own organisation's property
--
-- THE GAP (BACKLOG "A viewing's own parent links are organisation-blind",
-- found by T-task-viewing-org-isolation's review; reproduced 2026-09-28
-- against 6501aec on the local stack at 0122, through PostgREST with aal2
-- sessions of two throwaway organisations, and pinned RED first by
-- supabase/tests/viewing-parent-org-isolation.test.ts, 17 of its 21 tests —
-- the last four need this file to exist):
--
--   * viewings.property_id and viewings.contact_id (0001) reference
--     properties(id) / contacts(id) ALONE, and viewings_insert /
--     viewings_update (0030 / 0032) check only the CALLER's organisation
--     (createViewing copies the form's ids without re-reading them). So an
--     agent or admin of organisation B who learned an organisation-A property
--     or contact id — B can read neither — could INSERT a B viewing naming
--     it, PATCH one of B's viewings onto it, or UPSERT the same; the service
--     role and the table owner likewise. A real id (accepted) and a missing
--     one (23503) told B whether the A row exists.
--   * create_followup_nudges (0078) arms 2 (viewing feedback) and 2b
--     (no-show rebooking) join `properties p on p.id = v.property_id` with no
--     organisation predicate and copy v.property_id and p.reference into the
--     reminder. Such a viewing therefore earned B a task IN B titled
--     "Log viewing feedback: <A's reference>" / "Rebook after no-show: <A's
--     reference>", whose property_id is A's property. Nothing was written into
--     A. The sweep reads no contact data (arm 2b compares contact ids inside
--     the viewing's own organisation only), so the contact link was an
--     acceptance and an oracle, not a disclosure through the sweep.
--
-- THE FIX — 0119–0122's two layers:
--
--   A. THE RELATIONSHIPS, each REPLACING its single-column key (one
--      relationship per table pair, so the app's `properties(...)` /
--      `contacts(...)` embeds from viewings, and the reverse embeds, stay
--      unambiguous — no PGRST201):
--        viewings (org_id, property_id) → properties (org_id, id)
--          viewings_org_property_fkey, NO ACTION as before
--        viewings (org_id, contact_id)  → contacts (org_id, id)
--          viewings_org_contact_fkey, NO ACTION as before
--      on 0088's properties_org_id_id_key and a NEW contacts_org_id_id_key
--      (contacts had no (org_id, id) key). MATCH SIMPLE, and every column
--      involved is NOT NULL (asserted), so no row escapes the check. A
--      property or contact with viewings still cannot be deleted. New, as
--      0119–0122 did for their parents: the update rule now also pins
--      properties.org_id and contacts.org_id under their viewings — no
--      application path writes either. Each key gets a referencing index
--      ((org_id, property_id), (org_id, contact_id) — the leading columns
--      the unindexed-foreign-key advisor looks for); 0077's
--      viewings_property_idx and viewings_contact_idx stay (the property
--      page, the evidence report and the clash check read by id alone).
--      Neither column is under a unique index, so no 23505 can answer before
--      the key does (0122's lesson): every cross-organisation attempt, and
--      every missing id, reads the same 23503.
--
--   B. THE SWEEP. `and p.org_id = v.org_id` in arms 2 and 2b's property join,
--      row by row, never current_org_id() (the nightly run serves every
--      organisation at once). With A validated the predicate cannot fail to
--      hold; it is defence in depth for a row A could not stop (one kept past
--      a NOT VALID constraint, or loaded by a replica-mode restore), and it
--      states the contract in the sweep's own text. NOTHING ELSE MOVES: the
--      body is 0078's plus exactly those two lines (asserted by md5 against
--      0078's body), same signature, return type, SECURITY DEFINER,
--      search_path and ACL (service_role only, restated). The Cyprus-day due
--      dates, the configurable thresholds, the one-shot guards, the
--      assignee fallback, the self-heals and the events are 0078's.
--
-- EXISTING DATA. The preflight below counts viewings whose property or
-- contact belongs to another organisation and ABORTS THE WHOLE FILE before any
-- DDL if there are any: nothing is deleted, reassigned or repaired, and no key
-- is added NOT VALID by this file. The LOCK before it (access exclusive on
-- viewings, properties and contacts — every lock the file's DDL needs, taken
-- at its strongest up front, so nothing is upgraded later) means no write can
-- land between the preflight's count and the keys' validation; the keys'
-- own validation is the backstop behind that (a mismatch would abort the
-- whole file with 23503, never half-apply it). The LOCK sits inside the
-- preflight's DO block (a top-level LOCK TABLE is refused under the CLI).
-- The preflight also refuses when the live create_followup_nudges is not
-- 0078's body (md5, CRs stripped): section B restates 0078's text and must
-- not silently overwrite an unrecorded change.
--
-- DEPLOY ORDER: ADDITIVE — hosted before the merge. Every legitimate writer
-- takes the property and contact from the caller's own organisation (the
-- create dialog's pickers list only the caller's rows; the contact merge
-- repoints within one organisation); a crafted foreign id, accepted until
-- now, is refused with 23503. createViewing returns the database's message,
-- which names the constraint and nothing of the foreign row. The sweep copies
-- property_id and org_id from the same viewing row. No function signature,
-- return shape or grant changes — no release-compat entry.
-- database.types.ts is regenerated: the Relationships entries
-- viewings_property_id_fkey and viewings_contact_id_fkey become the composite
-- keys; no TypeScript names either.
--
-- ROLLBACK (DECISIONS T-viewing-parent-org-isolation): a FORWARD migration
-- that drops the two composite keys and their two indexes, re-adds
-- `viewings_property_id_fkey foreign key (property_id) references
-- properties(id)` and `viewings_contact_id_fkey foreign key (contact_id)
-- references contacts(id)`, drops contacts_org_id_id_key, re-creates
-- create_followup_nudges from 0078's text and resets this file's
-- `comment on function` (CREATE OR REPLACE keeps a comment); regenerate the
-- types, move the verify-restore migrations pin FORWARD, remove its 0123
-- invariant rows, remove supabase/tests/viewing-parent-org-isolation.test.ts
-- (its RED-at-0122 tests fail on the rolled-back catalogue) and the docs. No
-- data moves either way: every row valid at 0123 is valid at 0122.
--
-- NOT CHANGED HERE (BACKLOG): viewings.agent_id and created_by (profiles have
-- no (org_id, id) key — the profile links are decided as one change),
-- viewings.deal_id (the deal-side keys), viewing_slips.viewing_id, the
-- sweep's task guards and self-heals on tasks.viewing_id / tasks.contact_id,
-- and tasks.property_id itself — NOT yet constrainable: mandates (0122) and
-- viewings (here) are tenant-bound, but warn_expiring_reservations,
-- remind_due_installments (0052) and raise_lead_sla_tasks (0098) still copy a
-- property into tasks through reservations.property_id,
-- reservation_installments.reservation_id and leads.property_id, which point
-- by id alone. A tasks (org_id, property_id) key before those would turn one
-- planted reservation or lead into a 23503 that aborts that nightly run for
-- every organisation (BACKLOG "The reservation, instalment and lead-SLA
-- sweeps copy another organisation's property").
--
-- Pins that move with this file: the migrations count (122 -> 123) and two
-- 0123 invariant rows in scripts/backup/verify-restore.sql. NO EXPLICIT
-- begin/commit — the CLI wraps the file (HANDOFF §3), as does one execute_sql
-- call.
-- =============================================================================

-- Bounded lock waits (0113's lesson): queued behind a long transaction, the
-- LOCK below would block every read of the three tables behind it. Give up
-- instead and apply again; hosted's tables are tiny, so the scans are
-- instant. Apply outside 03:15–04:00 UTC (create_followup_nudges at 03:15)
-- and away from a :x0 minute (raise_lead_sla_tasks): a collision ends in a
-- clean 55P03 rollback — then apply again, and do NOT write the ledger row.
-- Run twice by mistake, the file aborts in its preflight (the sweep is no
-- longer 0078's) and changes nothing.
set local lock_timeout = '5s';

-- The file must run as ONE transaction (the CLI's wrapper, or one
-- execute_sql call): otherwise SET LOCAL is a no-op, the preflight's LOCK is
-- released as soon as its statement ends, and a failed assertion would not
-- undo the DDL before it.
do $$
begin
  if current_setting('lock_timeout') <> '5s' then
    raise exception '0123 aborted: this file must run as ONE transaction (SET LOCAL lock_timeout did not take effect) — nothing was changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 0. Preflight — abort, whole, over existing mismatches on either link
-- ---------------------------------------------------------------------------
do $$
declare n_p int; n_c int; v_md5 text;
begin
  -- Every lock the DDL below needs, at its strongest, BEFORE the counts: no
  -- viewing, property or contact can be written between the preflight and
  -- the keys' validation, and no lock is upgraded mid-file. Inside this DO
  -- block on purpose: the CLI sends the file as one pipelined implicit
  -- transaction, where a top-level LOCK TABLE is refused (25P01) although
  -- SET LOCAL takes effect; here it is legal and held to commit.
  lock table public.viewings, public.properties, public.contacts in access exclusive mode;

  select count(*) into n_p from public.viewings v join public.properties p on p.id = v.property_id where v.org_id <> p.org_id;
  select count(*) into n_c from public.viewings v join public.contacts c   on c.id = v.contact_id  where v.org_id <> c.org_id;
  if n_p + n_c > 0 then
    raise exception '0123 aborted: % viewing(s) name a property of another organisation, % viewing(s) name a contact of another organisation — nothing was changed. '
                    'List them with: select v.id, v.org_id, v.property_id, p.org_id as property_org, v.contact_id, c.org_id as contact_org '
                    'from public.viewings v join public.properties p on p.id = v.property_id join public.contacts c on c.id = v.contact_id '
                    'where v.org_id <> p.org_id or v.org_id <> c.org_id; and decide before constraining',
                    n_p, n_c;
  end if;

  -- The sweep this file replaces must be 0078's, byte for byte (CRs
  -- stripped): section B restates 0078's text, so an unrecorded change on
  -- the target — a hotfix typed into an SQL editor — would be silently
  -- overwritten. Refuse instead, before any DDL.
  select md5(replace(p.prosrc, E'\r', '')) into v_md5
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'create_followup_nudges';
  if v_md5 is distinct from '09f1d9363b2d3f699dbae71a8ef3f66a' then
    raise exception '0123 aborted: create_followup_nudges is not 0078''s body on this database (md5 %) — nothing was changed. '
                    'This file would overwrite it; diff the live body against 0078 and decide before applying',
                    coalesce(v_md5, 'missing');
  end if;
  raise notice '0123: preflight passed — no viewing names a property or a contact of another organisation; the sweep is 0078''s';
end $$;

-- ---------------------------------------------------------------------------
-- A. The relationships
-- ---------------------------------------------------------------------------
-- the referenced side for contacts (properties has 0088's)
alter table public.contacts
  add constraint contacts_org_id_id_key unique (org_id, id);
comment on constraint contacts_org_id_id_key on public.contacts is
  '0123: the referenced side of organisation-bound links onto contacts (viewings_org_contact_fkey first). '
  'id is already unique; this only lets a referencing row name the organisation too.';

alter table public.viewings
  drop constraint viewings_property_id_fkey;
alter table public.viewings
  add constraint viewings_org_property_fkey
    foreign key (org_id, property_id) references public.properties (org_id, id);
comment on constraint viewings_org_property_fkey on public.viewings is
  '0123: a viewing shows a property of its own organisation, by construction. '
  'Replaces the single-column FK on property_id (NO ACTION, as that one was).';
create index if not exists viewings_org_property_idx
  on public.viewings (org_id, property_id);

alter table public.viewings
  drop constraint viewings_contact_id_fkey;
alter table public.viewings
  add constraint viewings_org_contact_fkey
    foreign key (org_id, contact_id) references public.contacts (org_id, id);
comment on constraint viewings_org_contact_fkey on public.viewings is
  '0123: a viewing is for a contact of its own organisation, by construction. '
  'Replaces the single-column FK on contact_id (NO ACTION, as that one was).';
create index if not exists viewings_org_contact_idx
  on public.viewings (org_id, contact_id);

-- ---------------------------------------------------------------------------
-- B. create_followup_nudges: arms 2 and 2b read the viewing's own property
-- ---------------------------------------------------------------------------
-- 0078's text with one predicate added twice (`and p.org_id = v.org_id` in
-- arm 2's and arm 2b's property join). Every other arm is 0078's.
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
  'the viewing''s own organisation''s property (p.org_id = v.org_id).';

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
  -- the line this file adds, exactly (newline + indentation + predicate), twice
  k_org  constant text := E'\n       and p.org_id = v.org_id';
begin
  -- each link: exactly one foreign key for the pair, the composite one,
  -- validated, NO ACTION on delete and update, MATCH SIMPLE; the old key gone
  for c in
    select * from (values
      ('public.properties'::regclass, 'viewings_org_property_fkey', array['org_id','property_id']::name[], 'viewings_property_id_fkey'),
      ('public.contacts'::regclass,   'viewings_org_contact_fkey',  array['org_id','contact_id']::name[],  'viewings_contact_id_fkey')
    ) as t(ref, name, cols, old)
  loop
    select count(*) into n from pg_constraint where conrelid = 'public.viewings'::regclass and confrelid = c.ref and contype = 'f';
    if n <> 1 then
      raise exception '0123 aborted: expected exactly one foreign key from viewings to %, found %', c.ref, n;
    end if;
    if not exists (
      select 1 from pg_constraint k
       where k.conrelid = 'public.viewings'::regclass and k.confrelid = c.ref and k.contype = 'f'
         and k.conname = c.name and k.convalidated
         and k.confdeltype = 'a' and k.confupdtype = 'a' and k.confmatchtype = 's'
         and (select array_agg(a.attname order by x.ord) from unnest(k.conkey) with ordinality x(attnum, ord)
                join pg_attribute a on a.attrelid = k.conrelid and a.attnum = x.attnum) = c.cols
         and (select array_agg(a.attname order by x.ord) from unnest(k.confkey) with ordinality x(attnum, ord)
                join pg_attribute a on a.attrelid = k.confrelid and a.attnum = x.attnum) = array['org_id','id']::name[]) then
      raise exception '0123 aborted: % is not % -> % (org_id, id), validated, NO ACTION, MATCH SIMPLE', c.name, c.cols, c.ref;
    end if;
    if exists (select 1 from pg_constraint where conrelid = 'public.viewings'::regclass and conname = c.old) then
      raise exception '0123 aborted: the single-column % is still there (two relationships would make PostgREST embeds ambiguous)', c.old;
    end if;
  end loop;

  if not exists (select 1 from pg_constraint where conrelid = 'public.contacts'::regclass and conname = 'contacts_org_id_id_key'
                    and contype = 'u' and pg_get_constraintdef(oid) = 'UNIQUE (org_id, id)') then
    raise exception '0123 aborted: contacts_org_id_id_key is not UNIQUE (org_id, id)';
  end if;
  if (select count(*) from pg_indexes where schemaname = 'public'
        and ((indexname = 'viewings_org_property_idx' and indexdef ~ 'ON public\.viewings USING btree \(org_id, property_id\)$')
          or (indexname = 'viewings_org_contact_idx'  and indexdef ~ 'ON public\.viewings USING btree \(org_id, contact_id\)$'))) <> 2 then
    raise exception '0123 aborted: a referencing index is missing or has the wrong definition';
  end if;
  -- no unique index may answer (23505) before the keys do (0122's lesson)
  if exists (select 1 from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
              where i.indrelid = 'public.viewings'::regclass and i.indisunique and a.attname in ('property_id', 'contact_id')) then
    raise exception '0123 aborted: a unique index on viewings covers property_id or contact_id — it would answer before the key';
  end if;
  -- MATCH SIMPLE skips a row with any null key column: the boundary rests on
  -- every column involved being NOT NULL
  if exists (select 1 from pg_attribute
              where not attnotnull
                and ((attrelid = 'public.viewings'::regclass and attname in ('org_id', 'property_id', 'contact_id'))
                  or (attrelid in ('public.properties'::regclass, 'public.contacts'::regclass) and attname = 'org_id'))) then
    raise exception '0123 aborted: viewings.org_id / property_id / contact_id, or properties.org_id / contacts.org_id, is nullable';
  end if;
  -- 0088's and 0119–0122's tenant-bound keys, untouched
  select count(*) into n from pg_constraint
   where convalidated
     and ((conname = 'tasks_org_deal_fkey'             and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, deal_id) REFERENCES deals(org_id, id)')
       or (conname = 'tasks_org_viewing_fkey'          and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, viewing_id) REFERENCES viewings(org_id, id)')
       or (conname = 'tasks_org_mandate_fkey'          and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, mandate_id) REFERENCES mandates(org_id, id)')
       or (conname = 'mandates_org_property_fkey'      and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, property_id) REFERENCES properties(org_id, id) ON DELETE CASCADE')
       or (conname = 'property_keys_org_property_fkey' and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, property_id) REFERENCES properties(org_id, id) ON DELETE CASCADE')
       or (conname = 'mandates_org_renewed_from_fkey'  and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, renewed_from_id) REFERENCES mandates(org_id, id)')
       or (conname = 'properties_org_id_id_key'        and pg_get_constraintdef(oid) = 'UNIQUE (org_id, id)')
       or (conname = 'viewings_org_id_id_key'          and pg_get_constraintdef(oid) = 'UNIQUE (org_id, id)'));
  if n <> 8 then
    raise exception '0123 aborted: an earlier tenant-bound key (0088 / 0119–0122) is missing, not validated, or changed';
  end if;

  -- create_followup_nudges: one overload; definer + search_path; each
  -- predicate in its place (comments stripped); nothing else moved relative
  -- to 0078's body; service_role only
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'create_followup_nudges';
  if n <> 1 then
    raise exception '0123 aborted: expected one overload of create_followup_nudges, found %', n;
  end if;
  select p.prosrc into src
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'create_followup_nudges'
     and p.prosecdef and 'search_path=public' = any (p.proconfig)
     and pg_get_function_identity_arguments(p.oid) = 'p_org uuid'
     and p.prorettype = 'void'::regtype;
  if src is null then
    raise exception '0123 aborted: create_followup_nudges lost SECURITY DEFINER, its search_path, its signature or its return type';
  end if;
  src := replace(src, E'\r', '');
  if regexp_replace(src, '--[^\n]*', '', 'g') !~ 'join properties p on p\.id = v\.property_id\s+and p\.org_id = v\.org_id\s+where v\.status = ''completed'''
     or regexp_replace(src, '--[^\n]*', '', 'g') !~ 'join properties p on p\.id = v\.property_id\s+and p\.org_id = v\.org_id\s+where v\.status = ''no_show''' then
    raise exception '0123 aborted: create_followup_nudges does not scope arm 2''s and arm 2b''s property join to the viewing''s organisation';
  end if;
  if (length(src) - length(replace(src, k_org, ''))) / length(k_org) <> 2
     or md5(replace(src, k_org, '')) <> '09f1d9363b2d3f699dbae71a8ef3f66a' then
    raise exception '0123 aborted: create_followup_nudges is not 0078''s body plus exactly the two organisation predicates';
  end if;
  if has_function_privilege('anon', 'public.create_followup_nudges(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.create_followup_nudges(uuid)', 'execute')
     or not has_function_privilege('service_role', 'public.create_followup_nudges(uuid)', 'execute') then
    raise exception '0123 aborted: create_followup_nudges must be executable by service_role only (0020 / 0025)';
  end if;

  -- the keys, exercised: two organisations, each with a property and a
  -- contact; A's own viewing (accepted), then B's viewing naming A's property
  -- (with B's own contact) and B's viewing naming A's contact (with B's own
  -- property), each in its own sub-block and each refused by ITS key at ITS
  -- step. viewings.agent_id needs a profile: any existing one satisfies its
  -- key (held FOR KEY SHARE); none exists on an empty database — CI's and
  -- `db reset`'s migration run, before seed.sql — where the probes are
  -- skipped with a NOTICE (the test file proves both keys there).
  declare
    v_org_a uuid; v_org_b uuid; v_prop_a uuid; v_prop_b uuid; v_con_a uuid; v_con_b uuid; v_agent uuid;
    v_verdicts text[] := '{}';
    v_skipped boolean := false;
  begin
    for c in
      select * from (values
        ('property', 'viewings_org_property_fkey'),
        ('contact',  'viewings_org_contact_fkey')
      ) as t(kind, expect)
    loop
      v_ok := null; v_con := null; v_step := 'setup';
      begin
        insert into organizations (name, slug)
          values ('0123 probe A (rolled back)', '0123-probe-a-' || replace(gen_random_uuid()::text, '-', ''))
          returning id into v_org_a;
        insert into organizations (name, slug)
          values ('0123 probe B (rolled back)', '0123-probe-b-' || replace(gen_random_uuid()::text, '-', ''))
          returning id into v_org_b;
        insert into properties (org_id, reference, property_type) values (v_org_a, 'ZZZ0123-probe-a', 'apartment') returning id into v_prop_a;
        insert into properties (org_id, reference, property_type) values (v_org_b, 'ZZZ0123-probe-b', 'apartment') returning id into v_prop_b;
        insert into contacts (org_id, first_name) values (v_org_a, '0123 probe A') returning id into v_con_a;
        insert into contacts (org_id, first_name) values (v_org_b, '0123 probe B') returning id into v_con_b;
        select id into v_agent from profiles limit 1 for key share;
        if v_agent is null then
          raise exception using errcode = 'P0123', message = 'skip';
        end if;
        -- the same-organisation viewing: accepted
        v_step := 'own';
        insert into viewings (org_id, property_id, contact_id, agent_id, scheduled_at)
          values (v_org_a, v_prop_a, v_con_a, v_agent, now());
        -- organisation B's viewing naming ONE of organisation A's parents:
        -- the single-column keys accepted each of these
        v_step := 'cross';
        if c.kind = 'property' then
          insert into viewings (org_id, property_id, contact_id, agent_id, scheduled_at)
            values (v_org_b, v_prop_a, v_con_b, v_agent, now());
        else
          insert into viewings (org_id, property_id, contact_id, agent_id, scheduled_at)
            values (v_org_b, v_prop_b, v_con_a, v_agent, now());
        end if;
        raise exception using errcode = 'P0124', message = '0123 probe: a cross-organisation viewing was ACCEPTED';
      exception
        when foreign_key_violation then
          -- refused, and the sub-block's inserts are gone — but only THIS
          -- key's refusal at the cross step is the verdict
          get stacked diagnostics v_con = constraint_name;
          v_ok := (v_con = c.expect and v_step = 'cross');
        when unique_violation then
          get stacked diagnostics v_con = constraint_name;
          v_ok := false;
        when sqlstate 'P0123' then
          v_ok := null;
          v_skipped := true;
        when sqlstate 'P0124' then
          v_ok := false;
      end;
      if v_skipped then
        exit;
      end if;
      if v_ok is distinct from true then
        raise exception '0123 aborted: the % probe was not refused by % at the cross-organisation step (met % at the % step)',
          c.kind, c.expect, coalesce(v_con, 'no foreign-key violation'), v_step;
      end if;
      v_verdicts := v_verdicts || c.kind;
    end loop;
    if v_skipped then
      raise notice '0123: no profile exists — the key probes were skipped (the catalogue checks above still ran)';
    else
      raise notice '0123: probes refused by their keys: %', v_verdicts;
    end if;
  end;

  raise notice '0123: viewings (org_id, property_id / contact_id) tenant-bound; the sweep''s viewing arms read only the viewing''s own property';
end $$;
