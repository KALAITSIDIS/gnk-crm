-- =============================================================================
-- 0125 — a task belongs to the organisation of the reservation, instalment
--        line and lead it names, and the four sweeps that look tasks up by
--        those ids look for, and complete, only that organisation's tasks
--
-- THE GAP (BACKLOG "Every other tasks.* link is org-blind" — reservation_id,
-- installment_id and lead_id, the NEXT that 0124's review named; reproduced
-- 2026-09-29 against 8a9aef6 on the local stack at 0124, through PostgREST
-- with aal2 sessions of two throwaway organisations, and pinned RED first by
-- supabase/tests/task-reservation-lead-org-isolation.test.ts — its 15
-- behavioural and catalogue tests marked "RED at 0124" failed at 0124; its
-- migration-file tests need this file itself):
--
--   * tasks.reservation_id (0047, ON DELETE CASCADE), tasks.installment_id
--     (0051, ON DELETE CASCADE) and tasks.lead_id (0098, NO ACTION) referenced
--     their parent by id ALONE, and tasks_insert / tasks_update (0030 / 0032)
--     check only the CALLER's organisation. A member of organisation B who
--     learned an organisation-A id — B can read none of these rows, but an id
--     travels in links, screenshots and logs — could INSERT a task of B naming
--     A's hold, line or lead (201), PATCH one of B's tasks onto it (200) or
--     UPSERT the same; and a real id (accepted) and a missing one (23503) told
--     B whether the A row exists.
--   * The sweeps then matched tasks to parents by that id alone:
--       - the duplicate guards of warn_expiring_reservations,
--         remind_due_installments and raise_lead_sla_tasks counted B's row as
--         A's reminder: A's reservation and instalment reminders were
--         suppressed for that date, and A's lead-SLA reminder for good (its
--         guard is "one task per lead, ever");
--       - their self-heals, and expire_reservations' superseded arm (0090),
--         completed B's row on A's state and wrote a `superseded` event into
--         ORGANISATION B's chain — so B, reading its own rows back, learned
--         A's hold lapsing or moving (planting on several days: A's exact
--         expiry date — measured, the rows on the wrong days were completed),
--         A's line being paid or rescheduled (the event carries A's line
--         LABEL), A's lead being answered.
--
-- THE FIX — 0119–0121's two layers, for the three links:
--
--   A. THE RELATIONSHIPS. tasks (org_id, reservation_id) → reservations
--      (org_id, id) (tasks_org_reservation_fkey, ON DELETE CASCADE), tasks
--      (org_id, installment_id) → reservation_installments (org_id, id)
--      (tasks_org_installment_fkey, ON DELETE CASCADE — clearSchedule
--      hard-deletes lines and their reminders go with them, 0051) and tasks
--      (org_id, lead_id) → leads (org_id, id) (tasks_org_lead_fkey, NO
--      ACTION — a lead with tasks still cannot be deleted; no user session can
--      delete a lead at all) each REPLACE the single-column key, so PostgREST
--      keeps ONE relationship per pair. The referenced keys are 0124's
--      reservations_org_id_id_key, 0101's leads_org_id_id_key and a new
--      reservation_installments_org_id_id_key. ON UPDATE NO ACTION as before —
--      and it now covers the parent's org_id too, so a parent with tasks
--      cannot be moved to another organisation (no application path writes
--      any of the three org_ids). MATCH SIMPLE, and all four org_id columns
--      are NOT NULL (asserted below), so a task with no such parent is exactly
--      as before and nothing else escapes the check. Each referencing side
--      gets a partial (org_id, x) index; 0047 / 0051 / 0098's single-column
--      indexes stay (they serve lookups by the parent id alone). tasks has no
--      unique index but its primary key (asserted below), so no 23505 can
--      answer before these keys' 23503. A cross-organisation id and a missing
--      id now read the same 23503 — no existence oracle THROUGH TASKS. The
--      constraints bind EVERY writer, service_role and definer bodies included.
--
--   B. THE SWEEPS. warn_expiring_reservations and remind_due_installments
--      gain `and t.org_id = d.org_id` in their duplicate guards and `and
--      t.org_id = r.org_id` / `and t.org_id = i.org_id` in their self-heals;
--      raise_lead_sla_tasks gains `and t.org_id = l.org_id` in both (its guard
--      is one line, so the predicate goes inline there); expire_reservations
--      gains `and t.org_id = e.org_id` in its superseded arm. Each ties a task
--      to ITS OWN parent's organisation, row by row — never current_org_id():
--      every one of them serves every organisation in one cron run (p_org
--      null, or no p_org at all), and a session filter would silently shrink
--      that job to one organisation, or none under the cron's session. With A
--      validated the predicates cannot fail to hold; they are defence in depth
--      for the row A could not have stopped (one written before a NOT VALID
--      constraint after an approved repair, or loaded by a replica-mode
--      restore), and they state each function's contract in its own text. The
--      existing `(p_org is null or t.org_id = p_org)` filters are the CALLER's
--      scope, not this tie, and stay. NOTHING ELSE moves — 0124's bodies for
--      the three sweeps (with their property predicates), 0090's for
--      expire_reservations (which still must not name the properties table:
--      0089's declined coupling, asserted below) — which the assertions prove
--      by comparing each new body, minus exactly its added lines, with the
--      canonical one. ACLs restated: all four service_role only (0047 / 0051 /
--      0098 / 0044; pg_cron runs them as postgres).
--
-- EXISTING DATA. The preflight below counts tasks whose organisation differs
-- from their reservation's, instalment line's or lead's, and ABORTS THE WHOLE
-- FILE before any DDL if there are any: nothing is deleted, reassigned or
-- repaired here, and no constraint is ever added NOT VALID by this file. It
-- also refuses if any of the four bodies, or their attributes (definer,
-- search_path, volatility, EXECUTE grants), are not the ones this file
-- restates them from — an unrecorded hand edit is not overwritten. Hosted,
-- read-only, 2026-09-29 05:04Z: ledger 0124, 1
-- organisation, 2 profiles, 0 reservations, 0 instalment lines, 11 leads,
-- 0 tasks, 0 mismatches, the four bodies and attributes exactly as 0124 /
-- 0090 left them, the three single-column keys; this file validates
-- trivially there.
--
-- A row that ever escaped the new keys (see B) is also not CASCADED: deleting
-- A's reservation or line deletes the tasks whose (org_id, id) pair matches —
-- every valid row — and would leave such a row naming a deleted id. The
-- preflight guarantees there is none at apply; the restore pack's 0125
-- INTEGRITY rows count such rows, and dangling ids, after.
--
-- LOCKS. Every lock the DDL needs is taken at its strongest, in ONE statement,
-- BEFORE the counts: reservation_installments, reservations, leads, then
-- tasks — the order the sweeps themselves take them (each reads its parent,
-- the instalment sweep the line before its reservation, and writes tasks
-- last), so a sweep already running makes this file WAIT for it rather than
-- deadlock with it. What can still collide is a writer that holds tasks and
-- then checks a parent — an application task insert naming a reservation
-- (transitionReservation's follow-up, raiseLiveHoldCheck's prompt) checks its
-- key at the end of its statement — and that ends in a 40P01 deadlock: one of
-- the two is rolled back whole, cleanly. Apply outside 02:55–04:05 UTC (the
-- three reservation sweeps run at 03:45 / 03:50 / 03:55) and not within a
-- minute of a :x0 minute (raise_lead_sla_tasks runs every ten minutes), when
-- the site is quiet: a collision costs at most 5 s and a clean 55P03 or 40P01
-- rollback — then apply again, and do NOT write the ledger row. Run twice by
-- mistake, the file aborts in its preflight (the bodies are no longer the old
-- ones) and changes nothing.
--
-- DEPLOY ORDER: ADDITIVE — hosted before the merge. Every writer of the three
-- columns takes org_id and the parent id from the same organisation: the
-- three sweeps from the parent row itself; transitionReservation from a
-- reservation it re-read under the caller's RLS; raiseLiveHoldCheck from a
-- live hold it read with `org_id = params.orgId`. No request the deployed
-- application sends is refused by A. No function signature, return shape or
-- grant changes — no release-compat entry. database.types.ts is regenerated:
-- the tasks Relationships entries tasks_reservation_id_fkey /
-- tasks_installment_id_fkey / tasks_lead_id_fkey become tasks_org_*_fkey over
-- (org_id, x); no TypeScript names either.
--
-- ROLLBACK (DECISIONS T-task-reservation-lead-org-isolation): a FORWARD
-- migration that drops the three tasks_org_*_fkey keys and their indexes,
-- re-adds `tasks_reservation_id_fkey (reservation_id) → reservations(id) ON
-- DELETE CASCADE`, `tasks_installment_id_fkey (installment_id) →
-- reservation_installments(id) ON DELETE CASCADE` and `tasks_lead_id_fkey
-- (lead_id) → leads(id)`, drops reservation_installments_org_id_id_key,
-- re-creates the three sweeps from 0124's text and expire_reservations from
-- 0090's, each WITH its 0124 / 0090 comment (CREATE OR REPLACE keeps this
-- file's, which would then be false); regenerate the types, move the
-- verify-restore migrations pin FORWARD (one more ledger row), remove its 0125
-- rows, remove the new test file (its tests marked RED at 0124 fail on the
-- rolled-back catalogue), revert the docs. No data moves either way: every
-- row valid at 0125 is valid at 0124.
--
-- NOT CHANGED HERE (BACKLOG): tasks.contact_id and tasks.property_id stay
-- single-column. property_id could follow now (since 0124 every sweep writer
-- reads it through a tenant-bound parent); contact_id must wait for a
-- reservations (org_id, contact_id) key — both reservation sweeps copy
-- r.contact_id into tasks.contact_id, and reservations.contact_id still
-- points by id alone, so a tasks contact key would turn one B hold naming an
-- A contact into a refused insert that aborts both sweeps for everyone. Also
-- reservations.contact_id / deal_id / offer_id / payment_plan_id,
-- leads.contact_id / converted_deal_id and the profile links.
--
-- Pins that move with this file: the migrations count (124 -> 125) and four
-- 0125 invariant rows in scripts/backup/verify-restore.sql (the three
-- mismatch counts and one of dangling ids). NO EXPLICIT
-- begin/commit — the CLI wraps the file (HANDOFF §3), as does one execute_sql
-- call.
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
    raise exception '0125 aborted: this file must run as ONE transaction (SET LOCAL lock_timeout did not take effect) — nothing was changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 0. Preflight — abort, whole, over existing mismatches or a changed body
-- ---------------------------------------------------------------------------
do $$
declare
  n_r int; n_i int; n_l int;
  f record;
  v_md5 text;
begin
  -- every lock the DDL below needs, at its strongest, BEFORE the counts; the
  -- sweeps' own order, tasks last (see LOCKS in the header)
  lock table public.reservation_installments, public.reservations, public.leads, public.tasks in access exclusive mode;

  select count(*) into n_r from public.tasks t join public.reservations r on r.id = t.reservation_id where t.org_id <> r.org_id;
  select count(*) into n_i from public.tasks t join public.reservation_installments i on i.id = t.installment_id where t.org_id <> i.org_id;
  select count(*) into n_l from public.tasks t join public.leads l on l.id = t.lead_id where t.org_id <> l.org_id;
  if n_r + n_i + n_l > 0 then
    raise exception '0125 aborted: % task(s) name a reservation of another organisation, % task(s) name an instalment line of another organisation, % task(s) name a lead of another organisation — nothing was changed. '
                    'List them with the three joins in this preflight (tasks/reservations, tasks/reservation_installments, tasks/leads) and decide before constraining',
                    n_r, n_i, n_l;
  end if;

  -- the functions this file restates must be the ones it restates them FROM:
  -- the body (md5) AND the attributes CREATE OR REPLACE and the grants below
  -- would silently reset — definer, search_path, volatility, EXECUTE grants
  for f in
    select * from (values
      ('warn_expiring_reservations', 'public.warn_expiring_reservations(uuid)',   'ad1f48646a22f8b1bd9ae0acdd8de11a', '0124'),
      ('remind_due_installments',    'public.remind_due_installments(uuid)',      '8be21b0e317d1c46ff3a0316e9dff40c', '0124'),
      ('raise_lead_sla_tasks',       'public.raise_lead_sla_tasks(uuid, integer)', '292c1cd4e14cdfe5fcb4d29ecf33d895', '0124'),
      ('expire_reservations',        'public.expire_reservations()',              'b7cdb54d68a76c5f2e1a3383391e85b4', '0090')
    ) as t(name, sig, expect, src)
  loop
    select md5(replace(p.prosrc, E'\r', '')) into v_md5 from pg_proc p where p.oid = to_regprocedure(f.sig);
    if v_md5 is distinct from f.expect then
      raise exception '0125 aborted: % is not the body 0125 expects on this database (md5 %) — nothing was changed. '
                      'This file would overwrite it; diff the live body against %''s and decide before applying',
                      f.name, coalesce(v_md5, 'missing'), f.src;
    end if;
    if not exists (select 1 from pg_proc p
                    where p.oid = to_regprocedure(f.sig) and p.prosecdef
                      and p.proconfig = array['search_path=public'] and p.provolatile = 'v')
       or has_function_privilege('anon', to_regprocedure(f.sig), 'execute')
       or has_function_privilege('authenticated', to_regprocedure(f.sig), 'execute')
       or not has_function_privilege('service_role', to_regprocedure(f.sig), 'execute') then
      raise exception '0125 aborted: %''s attributes (SECURITY DEFINER, search_path, volatility or EXECUTE grants) are not the ones 0125 expects on this database — nothing was changed. '
                      'This file would reset them; compare them with %''s and decide before applying',
                      f.name, f.src;
    end if;
  end loop;
  raise notice '0125: preflight passed — no task names a reservation, instalment line or lead of another organisation; the four bodies are the ones restated';
end $$;

-- ---------------------------------------------------------------------------
-- A. The relationships
-- ---------------------------------------------------------------------------
-- the referenced side for instalment lines (reservations has 0124's, leads 0101's)
alter table public.reservation_installments
  add constraint reservation_installments_org_id_id_key unique (org_id, id);
comment on constraint reservation_installments_org_id_id_key on public.reservation_installments is
  '0125: the referenced side of organisation-bound links onto instalment lines (tasks_org_installment_fkey first). '
  'id is already unique; this only lets a referencing row name the organisation too.';

alter table public.tasks
  drop constraint tasks_reservation_id_fkey;
alter table public.tasks
  add constraint tasks_org_reservation_fkey
    foreign key (org_id, reservation_id) references public.reservations (org_id, id) on delete cascade;
comment on constraint tasks_org_reservation_fkey on public.tasks is
  '0125: a task belongs to the organisation of the reservation it names, by construction. '
  'Replaces the single-column FK on reservation_id (ON DELETE CASCADE, as that one was); '
  'a task with no reservation is not checked (MATCH SIMPLE).';
create index if not exists tasks_org_reservation_idx
  on public.tasks (org_id, reservation_id)
  where reservation_id is not null;

alter table public.tasks
  drop constraint tasks_installment_id_fkey;
alter table public.tasks
  add constraint tasks_org_installment_fkey
    foreign key (org_id, installment_id) references public.reservation_installments (org_id, id) on delete cascade;
comment on constraint tasks_org_installment_fkey on public.tasks is
  '0125: a task belongs to the organisation of the instalment line it names, by construction. '
  'Replaces the single-column FK on installment_id (ON DELETE CASCADE, as that one was — clearSchedule''s line delete '
  'takes the line''s reminder with it, 0051); a task with no line is not checked (MATCH SIMPLE).';
create index if not exists tasks_org_installment_idx
  on public.tasks (org_id, installment_id)
  where installment_id is not null;

alter table public.tasks
  drop constraint tasks_lead_id_fkey;
alter table public.tasks
  add constraint tasks_org_lead_fkey
    foreign key (org_id, lead_id) references public.leads (org_id, id);
comment on constraint tasks_org_lead_fkey on public.tasks is
  '0125: a task belongs to the organisation of the lead it names, by construction. '
  'Replaces the single-column FK on lead_id (NO ACTION, as that one was); a task with no lead is not checked (MATCH SIMPLE).';
create index if not exists tasks_org_lead_idx
  on public.tasks (org_id, lead_id)
  where lead_id is not null;

-- ---------------------------------------------------------------------------
-- B1. warn_expiring_reservations (0124's text + `and t.org_id = d.org_id` in
--     the guard and `and t.org_id = r.org_id` in the self-heal)
-- ---------------------------------------------------------------------------
create or replace function public.warn_expiring_reservations(p_org uuid default null)
returns void
language sql security definer set search_path = public as $$
  with due_soon as (
    select r.id, r.org_id, r.property_id, r.contact_id, r.created_by,
           r.expires_at,
           (r.expires_at at time zone 'Asia/Nicosia')::date as expiry_date,
           p.reference,
           p.assigned_agent_id
      from reservations r
      join properties p on p.id = r.property_id
       and p.org_id = r.org_id
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
  ' Since 0125 its duplicate guard and its self-heal read only the hold''s own organisation''s tasks (t.org_id = the hold''s org_id).';

-- ---------------------------------------------------------------------------
-- B2. remind_due_installments (0124's text + `and t.org_id = d.org_id` in the
--     guard and `and t.org_id = i.org_id` in the self-heal)
-- ---------------------------------------------------------------------------
create or replace function public.remind_due_installments(p_org uuid default null)
returns void
language sql security definer set search_path = public as $$
  with due_soon as (
    select i.id, i.org_id, i.reservation_id, i.label, i.amount, i.due_date,
           i.due_date - (now() at time zone 'Asia/Nicosia')::date as days_out,
           r.property_id, r.contact_id, r.created_by,
           p.reference,
           p.assigned_agent_id
      from reservation_installments i
      join reservations r on r.id = i.reservation_id
       and r.org_id = i.org_id
      join properties    p on p.id = r.property_id
       and p.org_id = r.org_id
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
  ' Since 0125 its duplicate guard and its self-heal read only the line''s own organisation''s tasks (t.org_id = the line''s org_id).';

-- ---------------------------------------------------------------------------
-- B3. raise_lead_sla_tasks (0124's text + `and t.org_id = l.org_id` in the
--     one-line guard and in the self-heal)
-- ---------------------------------------------------------------------------
create or replace function public.raise_lead_sla_tasks(p_org uuid default null, p_minutes int default 60)
returns int
language plpgsql security definer set search_path = public as $fn$
declare
  v_count  int := 0;
  v_closed int := 0;
begin
  if p_minutes is null or p_minutes < 1 then
    raise exception 'raise_lead_sla_tasks: p_minutes must be a positive number of minutes';
  end if;

  -- 1) mint: open website leads past the hour with no first response and no
  --    task yet. One task per lead, ever — a lead has one first response.
  with due as (
    select l.id, l.org_id, l.assigned_agent_id, p.id as property_id, p.reference
      from leads l
      left join properties p on p.id = l.property_id
       and p.org_id = l.org_id
     where l.source = 'website'
       and l.status in ('new', 'contacted', 'qualified')
       and l.first_response_at is null
       and l.received_at < now() - make_interval(mins => p_minutes)
       and (p_org is null or l.org_id = p_org)
       and not exists (select 1 from tasks t where t.lead_id = l.id and t.org_id = l.org_id and t.kind = 'lead_unanswered')
  ),
  created as (
    insert into tasks (org_id, title, due_at, assignee_id, lead_id, property_id, kind)
    select d.org_id,
           -- the reference, never the person: a title is read on every list
           'Website enquiry unanswered for over an hour' || coalesce(': ' || d.reference, ''),
           -- due NOW, not end of day: it is already late, and red is the truth
           now(),
           coalesce(d.assigned_agent_id,
                    (select pr.id from profiles pr
                      where pr.org_id = d.org_id and pr.role = 'admin' and pr.is_active
                      order by pr.created_at limit 1)),
           d.id, d.property_id, 'lead_unanswered'
      from due d
    returning org_id, lead_id, id, assignee_id
  ),
  logged as (
    insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
    select org_id, null, 'lead', lead_id, 'followup_task_created',
           jsonb_build_object('kind', 'lead_unanswered', 'task_id', id,
                              'assignee_id', assignee_id, 'minutes', p_minutes)
      from created
    returning 1
  )
  select count(*) into v_count from logged;

  -- 2) self-heal: the lead was answered or closed → the task is superseded.
  with superseded as (
    update tasks t
       set is_done = true, done_at = now()
      from leads l
     where t.lead_id = l.id
       and t.org_id = l.org_id
       and t.kind = 'lead_unanswered'
       and not t.is_done
       and (p_org is null or t.org_id = p_org)
       and (l.first_response_at is not null
            or l.status not in ('new', 'contacted', 'qualified'))
    returning t.org_id, t.id, t.lead_id
  ),
  logged as (
    insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
    select org_id, null, 'task', id, 'superseded',
           jsonb_build_object('kind', 'lead_unanswered', 'lead_id', lead_id,
                              'reason', 'lead_answered_or_closed')
      from superseded
    returning 1
  )
  select count(*) into v_closed from logged;

  return v_count;
end $fn$;

revoke execute on function public.raise_lead_sla_tasks(uuid, int) from public, anon, authenticated;
grant  execute on function public.raise_lead_sla_tasks(uuid, int) to service_role;

comment on function public.raise_lead_sla_tasks(uuid, int) is
  'Every ten minutes (0098): one lead_unanswered task per website lead still '
  'open with no first response after p_minutes (default 60), assigned to the '
  'lead''s agent or the oldest active admin, due now; superseded by the same '
  'sweep once the lead is answered or closed. Returns the number minted. '
  'p_org is for the tests; cron calls it for every org.'
  ' Since 0124 it reads only the lead''s own organisation''s property (p.org_id = l.org_id) and copies the property it read (p.id), so a lead naming another organisation''s property is chased without it.'
  ' Since 0125 its one-per-lead guard and its self-heal read only the lead''s own organisation''s tasks (t.org_id = l.org_id).';

-- ---------------------------------------------------------------------------
-- B4. expire_reservations (0090's text + `and t.org_id = e.org_id` in the
--     superseded arm)
-- ---------------------------------------------------------------------------
create or replace function public.expire_reservations() returns void
language sql security definer set search_path = public as $$
  with expired as (
    update reservations
       set status = 'expired',
           released_at = now(),
           release_reason = coalesce(release_reason, 'expired automatically'),
           updated_at = now()
     where status in ('held', 'confirmed')
       and expires_at < now()
    returning id, org_id, property_id, contact_id, expires_at
  ),
  -- unchanged: the expiry's own event, exactly as 0044 wrote it
  expiry_events as (
    insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
    select org_id, null, 'property', property_id, 'reservation_expired',
           jsonb_build_object('reservation_id', id,
                              'contact_id', contact_id,
                              'expired_at', expires_at)
      from expired
    returning 1
  ),
  -- 0090: the prompt about a hold that has now lapsed is COMPLETED, never
  -- deleted, so history keeps its shape (0047's idiom).
  superseded as (
    update tasks t
       set is_done = true, done_at = now()
      from expired e
     where t.reservation_id = e.id
       and t.org_id = e.org_id
       and t.kind = 'reservation_still_live'
       and not t.is_done
    returning t.org_id, t.id, t.reservation_id
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'task', id, 'superseded',
         jsonb_build_object(
           'kind', 'reservation_still_live',
           'reservation_id', reservation_id,
           'reason', 'the hold lapsed before anyone settled it')
    from superseded;
$$;

revoke execute on function public.expire_reservations() from public, anon, authenticated;
grant  execute on function public.expire_reservations() to service_role;

comment on function public.expire_reservations() is
  'Nightly: expires holds past their date, events each expiry on the property, '
  'and completes any reservation_still_live prompt about a hold it just '
  'expired (0090 — otherwise the prompt outlives its ask AND its duplicate '
  'guard suppresses every later one on that property). Idempotent by '
  'construction: the update selects only live rows, so a second run in a night '
  'matches nothing.'
  ' Since 0125 it completes only the hold''s own organisation''s prompts (t.org_id = e.org_id).';

-- ---------------------------------------------------------------------------
-- Apply-time assertions: the shapes, the bodies, and each key exercised
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
  -- and the one guard it rewrites in place
  k_guard   constant text := E'\n          and t.org_id = d.org_id';
  k_warn    constant text := E'\n       and t.org_id = r.org_id';
  k_remind  constant text := E'\n       and t.org_id = i.org_id';
  k_sla     constant text := E'\n       and t.org_id = l.org_id';
  k_expire  constant text := E'\n       and t.org_id = e.org_id';
  k_sla_old constant text := 'where t.lead_id = l.id and t.kind = ''lead_unanswered'')';
  k_sla_new constant text := 'where t.lead_id = l.id and t.org_id = l.org_id and t.kind = ''lead_unanswered'')';
begin
  -- each link: exactly one foreign key from tasks to the parent, the
  -- composite one, validated, the stated delete rule, NO ACTION on update,
  -- MATCH SIMPLE; the old key gone
  for c in
    select * from (values
      ('public.reservations'::regclass,             'tasks_org_reservation_fkey', array['org_id','reservation_id']::name[], 'c', 'tasks_reservation_id_fkey'),
      ('public.reservation_installments'::regclass, 'tasks_org_installment_fkey', array['org_id','installment_id']::name[], 'c', 'tasks_installment_id_fkey'),
      ('public.leads'::regclass,                    'tasks_org_lead_fkey',        array['org_id','lead_id']::name[],        'a', 'tasks_lead_id_fkey')
    ) as t(ref, name, cols, del, old)
  loop
    select count(*) into n from pg_constraint where conrelid = 'public.tasks'::regclass and confrelid = c.ref and contype = 'f';
    if n <> 1 then
      raise exception '0125 aborted: expected exactly one foreign key from tasks to %, found %', c.ref, n;
    end if;
    if not exists (
      select 1 from pg_constraint k
       where k.conrelid = 'public.tasks'::regclass and k.confrelid = c.ref and k.contype = 'f'
         and k.conname = c.name and k.convalidated
         and k.confdeltype::text = c.del and k.confupdtype = 'a' and k.confmatchtype = 's'
         and (select array_agg(a.attname order by x.ord) from unnest(k.conkey) with ordinality x(attnum, ord)
                join pg_attribute a on a.attrelid = k.conrelid and a.attnum = x.attnum) = c.cols
         and (select array_agg(a.attname order by x.ord) from unnest(k.confkey) with ordinality x(attnum, ord)
                join pg_attribute a on a.attrelid = k.confrelid and a.attnum = x.attnum) = array['org_id','id']::name[]) then
      raise exception '0125 aborted: % is not % -> % (org_id, id), validated, delete rule %, NO ACTION on update, MATCH SIMPLE', c.name, c.cols, c.ref, c.del;
    end if;
    if exists (select 1 from pg_constraint where conrelid = 'public.tasks'::regclass and conname = c.old) then
      raise exception '0125 aborted: the single-column % is still there (two relationships would make PostgREST embeds ambiguous)', c.old;
    end if;
  end loop;

  -- the referenced keys and the referencing indexes
  if (select count(*) from pg_constraint
        where contype = 'u' and pg_get_constraintdef(oid) = 'UNIQUE (org_id, id)'
          and ((conrelid = 'public.reservation_installments'::regclass and conname = 'reservation_installments_org_id_id_key')
            or (conrelid = 'public.reservations'::regclass             and conname = 'reservations_org_id_id_key')
            or (conrelid = 'public.leads'::regclass                    and conname = 'leads_org_id_id_key'))) <> 3 then
    raise exception '0125 aborted: a referenced (org_id, id) key is missing or wrong';
  end if;
  if (select count(*) from pg_indexes where schemaname = 'public' and tablename = 'tasks'
        and ((indexname = 'tasks_org_reservation_idx' and indexdef ~ 'USING btree \(org_id, reservation_id\) WHERE \(reservation_id IS NOT NULL\)$')
          or (indexname = 'tasks_org_installment_idx' and indexdef ~ 'USING btree \(org_id, installment_id\) WHERE \(installment_id IS NOT NULL\)$')
          or (indexname = 'tasks_org_lead_idx'        and indexdef ~ 'USING btree \(org_id, lead_id\) WHERE \(lead_id IS NOT NULL\)$'))) <> 3 then
    raise exception '0125 aborted: a referencing index is missing or has the wrong definition';
  end if;
  -- no unique index may answer (23505) before a key does: every unique index
  -- on tasks naming one of the three columns must name org_id too
  if exists (
    select 1 from pg_index i
     where i.indrelid = 'public.tasks'::regclass and i.indisunique
       and exists (select 1 from pg_attribute a where a.attrelid = i.indrelid and a.attnum = any (i.indkey)
                      and a.attname in ('reservation_id', 'installment_id', 'lead_id'))
       and not exists (select 1 from pg_attribute a where a.attrelid = i.indrelid and a.attnum = any (i.indkey) and a.attname = 'org_id')) then
    raise exception '0125 aborted: a unique index on tasks names a parent column without org_id — it would answer before the key';
  end if;
  -- MATCH SIMPLE skips a row with any null key column: the boundary rests on
  -- every org_id being NOT NULL
  if exists (select 1 from pg_attribute
              where attname = 'org_id' and not attnotnull
                and attrelid in ('public.tasks'::regclass, 'public.reservations'::regclass,
                                 'public.reservation_installments'::regclass, 'public.leads'::regclass)) then
    raise exception '0125 aborted: an org_id a key relies on is nullable';
  end if;
  -- 0119–0121's task keys and 0124's parent keys, untouched
  select count(*) into n from pg_constraint
   where convalidated
     and ((conname = 'tasks_org_deal_fkey'                            and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, deal_id) REFERENCES deals(org_id, id)')
       or (conname = 'tasks_org_viewing_fkey'                         and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, viewing_id) REFERENCES viewings(org_id, id)')
       or (conname = 'tasks_org_mandate_fkey'                         and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, mandate_id) REFERENCES mandates(org_id, id)')
       or (conname = 'reservations_org_property_fkey'                 and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, property_id) REFERENCES properties(org_id, id) ON DELETE RESTRICT')
       or (conname = 'reservation_installments_org_reservation_fkey'  and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, reservation_id) REFERENCES reservations(org_id, id) ON DELETE CASCADE')
       or (conname = 'leads_org_property_fkey'                        and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, property_id) REFERENCES properties(org_id, id)'));
  if n <> 6 then
    raise exception '0125 aborted: an earlier tenant-bound key (0119–0121, 0124) is missing, not validated, or changed';
  end if;

  -- the four sweeps: one overload each; definer, search_path, return type and
  -- volatility kept; nothing else moved relative to the old body; the ACLs
  for c in
    select * from (values
      ('warn_expiring_reservations', 'public.warn_expiring_reservations(uuid)',    'void', 'ad1f48646a22f8b1bd9ae0acdd8de11a'),
      ('remind_due_installments',    'public.remind_due_installments(uuid)',       'void', '8be21b0e317d1c46ff3a0316e9dff40c'),
      ('raise_lead_sla_tasks',       'public.raise_lead_sla_tasks(uuid, integer)', 'int4', '292c1cd4e14cdfe5fcb4d29ecf33d895'),
      ('expire_reservations',        'public.expire_reservations()',               'void', 'b7cdb54d68a76c5f2e1a3383391e85b4')
    ) as t(name, sig, ret, old_md5)
  loop
    select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public' and p.proname = c.name;
    if n <> 1 then
      raise exception '0125 aborted: expected one overload of %, found %', c.name, n;
    end if;
    select p.prosrc into src from pg_proc p
     where p.oid = to_regprocedure(c.sig)
       and p.prosecdef and p.proconfig = array['search_path=public']
       and p.prorettype::regtype::text = (c.ret)::regtype::text and p.provolatile = 'v';
    if src is null then
      raise exception '0125 aborted: % lost SECURITY DEFINER, its search_path, its return type or its volatility', c.name;
    end if;
    src := replace(src, E'\r', '');
    if md5(replace(replace(replace(replace(replace(replace(src, k_guard, ''), k_warn, ''), k_remind, ''), k_sla, ''), k_expire, ''), k_sla_new, k_sla_old)) <> c.old_md5 then
      raise exception '0125 aborted: % is not its old body plus exactly 0125''s lines', c.name;
    end if;
    if has_function_privilege('anon', to_regprocedure(c.sig), 'execute')
       or has_function_privilege('authenticated', to_regprocedure(c.sig), 'execute')
       or not has_function_privilege('service_role', to_regprocedure(c.sig), 'execute') then
      raise exception '0125 aborted: %''s EXECUTE grants changed', c.name;
    end if;
  end loop;

  -- each predicate where it belongs, counted (comments stripped for the
  -- shape, so a word in one can neither satisfy nor blind the check)
  src := replace((select prosrc from pg_proc where oid = 'public.warn_expiring_reservations(uuid)'::regprocedure), E'\r', '');
  if (length(src) - length(replace(src, k_guard, ''))) / length(k_guard) <> 1
     or (length(src) - length(replace(src, k_warn, ''))) / length(k_warn) <> 1
     or regexp_replace(src, '--[^\n]*', '', 'g') !~ 'select 1 from tasks t\s+where t\.reservation_id = d\.id\s+and t\.org_id = d\.org_id\s+and t\.kind = ''reservation_expiring'''
     or regexp_replace(src, '--[^\n]*', '', 'g') !~ 'from reservations r\s+where t\.reservation_id = r\.id\s+and t\.org_id = r\.org_id\s+and t\.kind = ''reservation_expiring''' then
    raise exception '0125 aborted: warn_expiring_reservations does not scope its guard and its self-heal to the hold''s organisation';
  end if;
  src := replace((select prosrc from pg_proc where oid = 'public.remind_due_installments(uuid)'::regprocedure), E'\r', '');
  if (length(src) - length(replace(src, k_guard, ''))) / length(k_guard) <> 1
     or (length(src) - length(replace(src, k_remind, ''))) / length(k_remind) <> 1
     or regexp_replace(src, '--[^\n]*', '', 'g') !~ 'select 1 from tasks t\s+where t\.installment_id = d\.id\s+and t\.org_id = d\.org_id\s+and t\.kind = ''installment_due'''
     or regexp_replace(src, '--[^\n]*', '', 'g') !~ 'where t\.installment_id = i\.id\s+and t\.org_id = i\.org_id\s+and t\.kind = ''installment_due''' then
    raise exception '0125 aborted: remind_due_installments does not scope its guard and its self-heal to the line''s organisation';
  end if;
  src := replace((select prosrc from pg_proc where oid = 'public.raise_lead_sla_tasks(uuid, integer)'::regprocedure), E'\r', '');
  if (length(src) - length(replace(src, k_sla_new, ''))) / length(k_sla_new) <> 1
     or (length(src) - length(replace(src, k_sla, ''))) / length(k_sla) <> 1
     or regexp_replace(src, '--[^\n]*', '', 'g') !~ 'from leads l\s+where t\.lead_id = l\.id\s+and t\.org_id = l\.org_id\s+and t\.kind = ''lead_unanswered''' then
    raise exception '0125 aborted: raise_lead_sla_tasks does not scope its guard and its self-heal to the lead''s organisation';
  end if;
  src := replace((select prosrc from pg_proc where oid = 'public.expire_reservations()'::regprocedure), E'\r', '');
  if (length(src) - length(replace(src, k_expire, ''))) / length(k_expire) <> 1
     or regexp_replace(src, '--[^\n]*', '', 'g') !~ 'from expired e\s+where t\.reservation_id = e\.id\s+and t\.org_id = e\.org_id\s+and t\.kind = ''reservation_still_live''' then
    raise exception '0125 aborted: expire_reservations does not scope its superseded arm to the hold''s organisation';
  end if;
  -- 0089 / 0090: this function must never learn about the properties table
  -- (the coupling DECLINED 2026-08-26) — the whole definition, comments too
  if pg_get_functiondef('public.expire_reservations()'::regprocedure) ~* '\mproperties\M' then
    raise exception '0125 aborted: expire_reservations() now references properties — the declined coupling';
  end if;

  -- the keys, exercised: two organisations; A's hold with one schedule line,
  -- and A's lead; then three cross-organisation tasks, each in its own
  -- sub-block and each refused by ITS key at ITS step. No column here needs a
  -- profile, so this runs on an empty database too.
  declare
    v_org_a uuid; v_org_b uuid; v_prop_a uuid; v_res_a uuid; v_line_a uuid; v_lead_a uuid;
    v_verdicts text[] := '{}';
  begin
    for c in
      select * from (values
        ('reservation', 'tasks_org_reservation_fkey'),  -- B's task naming A's hold
        ('installment', 'tasks_org_installment_fkey'),  -- B's task naming A's line
        ('lead',        'tasks_org_lead_fkey')          -- B's task naming A's lead
      ) as t(kind, expect)
    loop
      v_ok := null; v_con := null; v_step := 'setup';
      begin
        insert into organizations (name, slug)
          values ('0125 probe A (rolled back)', '0125-probe-a-' || replace(gen_random_uuid()::text, '-', ''))
          returning id into v_org_a;
        insert into organizations (name, slug)
          values ('0125 probe B (rolled back)', '0125-probe-b-' || replace(gen_random_uuid()::text, '-', ''))
          returning id into v_org_b;
        insert into properties (org_id, reference, property_type) values (v_org_a, 'ZZZ0125-probe-a', 'apartment') returning id into v_prop_a;
        insert into reservations (org_id, property_id, status, held_from, expires_at)
          values (v_org_a, v_prop_a, 'held', now(), now() + interval '1 day') returning id into v_res_a;
        insert into reservation_installments (org_id, reservation_id, sort_order, label, amount)
          values (v_org_a, v_res_a, 1, '0125 probe', 1) returning id into v_line_a;
        insert into leads (org_id, source) values (v_org_a, 'other') returning id into v_lead_a;
        -- the same-organisation links, and a task with none: all accepted
        v_step := 'own';
        insert into tasks (org_id, title, reservation_id, installment_id, lead_id)
          values (v_org_a, '0125 probe own', v_res_a, v_line_a, v_lead_a);
        insert into tasks (org_id, title) values (v_org_b, '0125 probe none');
        -- organisation B's task naming organisation A's parent: the
        -- single-column keys accepted each of these
        v_step := 'cross';
        if c.kind = 'reservation' then
          insert into tasks (org_id, title, reservation_id) values (v_org_b, '0125 probe cross', v_res_a);
        elsif c.kind = 'installment' then
          insert into tasks (org_id, title, installment_id) values (v_org_b, '0125 probe cross', v_line_a);
        else
          insert into tasks (org_id, title, lead_id) values (v_org_b, '0125 probe cross', v_lead_a);
        end if;
        raise exception using errcode = 'P0126', message = '0125 probe: a cross-organisation task was ACCEPTED';
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
        raise exception '0125 aborted: the % probe was not refused by % at the cross-organisation step (met % at the % step)',
          c.kind, c.expect, coalesce(v_con, 'no foreign-key violation'), v_step;
      end if;
      v_verdicts := v_verdicts || c.kind;
    end loop;
    raise notice '0125: probes refused by their keys: %', v_verdicts;
  end;

  raise notice '0125: tasks (org_id, reservation_id / installment_id / lead_id) tenant-bound; the four sweeps look for and complete only their parent''s organisation''s tasks';
end $$;
