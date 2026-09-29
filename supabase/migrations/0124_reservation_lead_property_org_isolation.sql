-- =============================================================================
-- 0124 — a reservation holds a property of its own organisation, an
--        instalment line belongs to a reservation of its own organisation, a
--        lead names a property of its own, and the reservation, instalment
--        and lead-SLA sweeps and the escalation preview read only their own
--        organisation's parents
--
-- THE GAP (BACKLOG "The reservation, instalment and lead-SLA sweeps copy
-- another organisation's property", found by T-viewing-parent-org-isolation's
-- review; reproduced 2026-09-28 against 78601af on the local stack at 0123,
-- through PostgREST with aal2 sessions of two throwaway organisations, and
-- pinned RED first by supabase/tests/reservation-lead-property-org-
-- isolation.test.ts — its 20 behavioural and catalogue tests failed at 0123;
-- its migration-file tests need this file itself):
--
--   * reservations.property_id (0044, ON DELETE RESTRICT),
--     reservation_installments.reservation_id (0050, ON DELETE CASCADE) and
--     leads.property_id (0001) referenced their parent by id ALONE, and
--     reservations_insert / _update (0044), the instalment policies (0050)
--     and leads_insert / leads_update (0030 / 0100) check only the CALLER's
--     organisation. So a member of organisation B who learned an
--     organisation-A id — B can read none of these rows — could:
--       - put a B hold on A's property; held live, it occupied
--         reservations_one_live_per_property (unique on property_id alone):
--         A could then not hold its own property (23505), and B's live hold
--         answered 23505 where A's property was held and was ACCEPTED where
--         not — an oracle on A's hold state;
--       - hang B instalment lines on A's reservation; unique
--         (reservation_id, sort_order) then refused A's own schedule
--         (applyPaymentPlan cannot see B's lines to delete them) — a denial,
--         and 23505 (a taken position) vs accepted (a free one) an oracle on
--         A's schedule;
--       - name A's property on a B lead;
--     and a real id (accepted) and a missing one (23503) told B whether the
--     A row exists.
--   * warn_expiring_reservations and remind_due_installments (0052) join
--     `properties p on p.id = r.property_id` — remind also `reservations r on
--     r.id = i.reservation_id`, in its mint and its self-heal — with no
--     organisation predicate, raise_lead_sla_tasks (0098) `left join
--     properties p on p.id = l.property_id`, and preview_lead_escalation
--     (0112) `left join properties pr on pr.id = c.property_id`. Measured:
--     B's tasks titled "Reservation on <A's reference> lapses …",
--     "Instalment … on <A's reference> …" and "Website enquiry unanswered …:
--     <A's reference>" carrying A's property id, B's chain holding events
--     whose ENTITY is A's property, the reminder on a B line planted on A's
--     reservation completed when A's hold ended (an oracle on A's hold), and
--     B's admin reading A's reference in the escalation preview. (A B TASK
--     naming A's hold, line or lead by id is a different route — through
--     the single-column tasks links — and stays open: see NOT CHANGED HERE.)
--
-- THE FIX — 0119–0123's two layers:
--
--   A. THE RELATIONSHIPS, each REPLACING its single-column key (one
--      relationship per table pair: every embed the app sends — leads →
--      properties(id, reference), reservations → properties / →
--      reservation_installments, reservation_installments → reservations —
--      stays unambiguous):
--        reservations (org_id, property_id) → properties (org_id, id)
--          reservations_org_property_fkey, ON DELETE RESTRICT as before
--        reservation_installments (org_id, reservation_id) → reservations (org_id, id)
--          reservation_installments_org_reservation_fkey, ON DELETE CASCADE as before
--        leads (org_id, property_id) → properties (org_id, id)
--          leads_org_property_fkey, NO ACTION as before
--      on 0088's properties_org_id_id_key and a NEW reservations_org_id_id_key.
--      MATCH SIMPLE: a lead with no property is not checked, exactly as
--      before; every other column involved is NOT NULL (asserted). Each key
--      gets a referencing index (the instalment key is covered by the unique
--      rule below); 0044's reservations_property_idx, 0050's
--      reservation_installments_reservation_idx and 0092's
--      leads_property_id_idx stay. New, as 0119–0123 did for their parents:
--      the update rules now also pin properties.org_id under its holds and
--      leads, and reservations.org_id under its lines — no application path
--      writes either.
--      THE TWO UNIQUE RULES THAT ANSWERED BEFORE THE KEYS (0122's lesson: a
--      unique index is checked at insert, a foreign key at the end of the
--      statement) are keyed by organisation too:
--        reservations_one_live_per_property: (property_id) → (org_id,
--          property_id), WHERE status in ('held', 'confirmed'), SAME NAME
--          (createReservation's friendly 23505 and rls.test.ts match it)
--        unique (reservation_id, sort_order) →
--          reservation_installments_org_reservation_sort_order_key
--          unique (org_id, reservation_id, sort_order)
--      With the keys every hold of a property and every line of a
--      reservation are of the parent's organisation, so for valid rows both
--      rules are unchanged; a foreign row can no longer collide, and every
--      cross-organisation attempt reads the same 23503.
--
--   B. THE READERS, row by row, never current_org_id():
--        warn_expiring_reservations: `and p.org_id = r.org_id`
--        remind_due_installments:    `and r.org_id = i.org_id` (mint AND
--                                    self-heal) and `and p.org_id = r.org_id`
--        raise_lead_sla_tasks:       `and p.org_id = l.org_id` in its LEFT
--                                    join, and it copies the property it READ
--                                    (`p.id as property_id`, was
--                                    `l.property_id`): a lead naming another
--                                    organisation's property is still chased —
--                                    it is the lead's own enquiry — without
--                                    that property or its reference
--        preview_lead_escalation:    `and pr.org_id = c.org_id` (STABLE kept)
--      With A validated none can fail to hold; they are defence in depth for
--      a row A could not stop (NOT VALID, or a replica-mode restore) and state
--      the contract in each reader's own text. NOTHING ELSE MOVES: each body
--      is the old one (0052 / 0052 / 0098 / 0112) plus exactly those lines
--      (asserted by md5 against the old body), same signature, return type,
--      volatility, SECURITY DEFINER, search_path and ACL (restated).
--      expire_reservations (0090) is NOT touched: it has no property join by
--      design (0089 / 0090), and with the key its copy of r.property_id is
--      the hold's own organisation's.
--
-- EXISTING DATA. The preflight below counts mismatches on all three links
-- and ABORTS THE WHOLE FILE before any DDL if there are any: nothing is
-- deleted, reassigned or repaired, and no key is added NOT VALID. Before the
-- counts it takes every lock the DDL needs, at its strongest, children first
-- and properties last (reservation_installments, reservations, leads,
-- properties — the order the lead-SLA sweep and a keyed public enquiry take
-- leads and properties), so nothing is written between the counts and the
-- keys' validation and no lock is upgraded mid-file; the LOCK sits inside
-- the preflight's DO block (a top-level LOCK TABLE is refused under the CLI —
-- 0123's lesson). No order avoids every cycle: the proposal-interest door,
-- and the enquiry door without an idempotency key, read properties BEFORE
-- leads (0114), so a request of theirs landing mid-apply can deadlock with
-- this file (40P01 after deadlock_timeout); whichever side is chosen rolls
-- back cleanly — this file changes nothing, a visitor's request answers 503
-- and can be sent again. Apply when the site is quiet.
-- The preflight also refuses when a function this file restates is not the
-- one it expects — its body (md5, CRs stripped) or the attributes CREATE OR
-- REPLACE and the restated grants would reset (SECURITY DEFINER, search_path,
-- volatility, EXECUTE grants) — so an unrecorded change on the target is
-- never silently overwritten. (Comments are restated, not guarded.)
--
-- DEPLOY ORDER: ADDITIVE — hosted before the merge. Every legitimate writer
-- is same-organisation (createReservation and applyPaymentPlan re-read the
-- parent under RLS; the public enquiry and proposal doors resolve the
-- property inside the organisation; createLead's picker lists only the
-- caller's properties); a crafted foreign id, accepted until now, is refused
-- with 23503 (createLead shows the database's message, which names the
-- constraint and nothing of the foreign row). The sweeps copy every parent
-- from the same rows, so no scheduled insert can be refused. No function
-- signature, return shape or grant changes — no release-compat entry.
-- database.types.ts is regenerated (the Relationships of reservations,
-- reservation_installments and leads).
--
-- ROLLBACK (DECISIONS T-reservation-lead-property-org-isolation): a FORWARD
-- migration that drops the three composite keys — reservation_installments_
-- org_reservation_fkey BEFORE reservations_org_id_id_key, which it depends
-- on — then reservations_org_id_id_key, reservation_installments_org_
-- reservation_sort_order_key and the two new indexes; re-adds
-- reservations_property_id_fkey (property_id) → properties(id) ON DELETE
-- RESTRICT, reservation_installments_reservation_id_fkey (reservation_id) →
-- reservations(id) ON DELETE CASCADE and leads_property_id_fkey (property_id)
-- → properties(id); re-creates reservations_one_live_per_property on
-- (property_id) WHERE live and unique (reservation_id, sort_order) (named
-- reservation_installments_reservation_id_sort_order_key, as 0050's default
-- was); re-creates the four functions from 0052 /
-- 0098 / 0112 with those files' comments (the two sweeps from 0052 had none:
-- `comment … is null`); regenerate the types, move the verify-restore pin
-- FORWARD, remove its 0124 rows and the new test file, revert the docs. No
-- data moves either way: every row valid at 0124 is valid at 0123.
--
-- NOT CHANGED HERE (BACKLOG): reservations.contact_id / deal_id / offer_id /
-- payment_plan_id (ON DELETE SET NULL needs `set null (col)`; offers and
-- payment_plans have no (org_id, id) key), leads.contact_id (a pinned FK-name
-- embed hint and a deliberate cross-organisation test fixture),
-- leads.converted_deal_id, the profile links (created_by, assigned_agent_id),
-- deals.property_id, and THE TASK LINKS: tasks.reservation_id /
-- installment_id / lead_id still point by id alone, and the three sweeps'
-- task guards and self-heals (and expire_reservations' superseded arm, 0090)
-- match tasks by those ids with no t.org_id predicate. So a B task naming A's
-- hold, line or lead can still suppress A's reminder, be completed by A's
-- state (an oracle on A's hold, expiry date, payment or first response —
-- the instalment self-heal also writes A's line label into B's chain), and
-- an A id vs a missing one still answers 201 vs 23503 on a task insert.
-- That is the next file, in 0121's shape (tasks (org_id, reservation_id) on
-- this file's reservations_org_id_id_key, (org_id, lead_id) on 0101's
-- leads_org_id_id_key, (org_id, installment_id) on a new
-- reservation_installments (org_id, id) key, and t.org_id in every guard and
-- self-heal). After THIS file every sweep writer of tasks.property_id reads
-- through a tenant-bound parent, so a tasks (org_id, property_id) key can
-- follow too. NOT so tasks.contact_id: both reservation sweeps copy
-- r.contact_id into it, and reservations.contact_id (ON DELETE SET NULL)
-- still points by id alone — a tasks (org_id, contact_id) key must wait for a
-- reservations (org_id, contact_id) key (`on delete set null (contact_id)`),
-- or one B hold naming an A contact would abort both sweeps for everyone.
--
-- Pins that move with this file: the migrations count (123 -> 124) and three
-- 0124 invariant rows in scripts/backup/verify-restore.sql. NO EXPLICIT
-- begin/commit — the CLI wraps the file (HANDOFF §3), as does one execute_sql
-- call.
-- =============================================================================

-- Bounded lock waits (0113's lesson). Apply outside 02:55–04:05 UTC (every
-- nightly job that reads these tables) and not within a minute of a :x0
-- minute (raise_lead_sla_tasks reads leads and properties every ten
-- minutes), when the site is quiet: a collision ends in a clean 55P03 (lock
-- wait) or 40P01 (deadlock with a public door — see EXISTING DATA) rollback —
-- then apply again, and do NOT write the ledger row. Run twice by mistake,
-- the file aborts in its preflight (the bodies are no longer the old ones)
-- and changes nothing.
set local lock_timeout = '5s';

-- The file must run as ONE transaction (the CLI's wrapper, or one
-- execute_sql call): otherwise SET LOCAL is a no-op, the preflight's LOCK is
-- released as soon as its statement ends, and a failed assertion would not
-- undo the DDL before it.
do $$
begin
  if current_setting('lock_timeout') <> '5s' then
    raise exception '0124 aborted: this file must run as ONE transaction (SET LOCAL lock_timeout did not take effect) — nothing was changed';
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
  -- every lock the DDL below needs, at its strongest, BEFORE the counts;
  -- children first, properties last (see the header)
  lock table public.reservation_installments, public.reservations, public.leads, public.properties in access exclusive mode;

  select count(*) into n_r from public.reservations r join public.properties p on p.id = r.property_id where r.org_id <> p.org_id;
  select count(*) into n_i from public.reservation_installments i join public.reservations r on r.id = i.reservation_id where i.org_id <> r.org_id;
  select count(*) into n_l from public.leads l join public.properties p on p.id = l.property_id where l.org_id <> p.org_id;
  if n_r + n_i + n_l > 0 then
    raise exception '0124 aborted: % reservation(s) hold a property of another organisation, % instalment line(s) belong to a reservation of another organisation, % lead(s) name a property of another organisation — nothing was changed. '
                    'List them with the three joins in this preflight (reservations/properties, reservation_installments/reservations, leads/properties) and decide before constraining',
                    n_r, n_i, n_l;
  end if;

  -- the functions this file restates must be the ones it restates them FROM:
  -- the body (md5) AND the attributes CREATE OR REPLACE and the grants below
  -- would silently reset — definer, search_path, volatility, EXECUTE grants
  for f in
    select * from (values
      ('warn_expiring_reservations', 'public.warn_expiring_reservations(uuid)',                                       '7d7c5420cf56897a509a886c37e2cda1', '0052', 'v', false),
      ('remind_due_installments',    'public.remind_due_installments(uuid)',                                          'fd8fa594e8493a71981d606818c820e8', '0052', 'v', false),
      ('raise_lead_sla_tasks',       'public.raise_lead_sla_tasks(uuid, integer)',                                    '58e1a6990a7c2271787d29b8f131279a', '0098', 'v', false),
      ('preview_lead_escalation',    'public.preview_lead_escalation(jsonb, integer, timestamp with time zone)',      '4728c4a6c9a8df72b6d0b83102d946ea', '0112', 's', true)
    ) as t(name, sig, expect, src, vol, auth_exec)
  loop
    select md5(replace(p.prosrc, E'\r', '')) into v_md5 from pg_proc p where p.oid = to_regprocedure(f.sig);
    if v_md5 is distinct from f.expect then
      raise exception '0124 aborted: % is not the body 0124 expects on this database (md5 %) — nothing was changed. '
                      'This file would overwrite it; diff the live body against %''s and decide before applying',
                      f.name, coalesce(v_md5, 'missing'), f.src;
    end if;
    if not exists (select 1 from pg_proc p
                    where p.oid = to_regprocedure(f.sig) and p.prosecdef
                      and p.proconfig = array['search_path=public'] and p.provolatile::text = f.vol)
       or has_function_privilege('anon', to_regprocedure(f.sig), 'execute')
       or has_function_privilege('authenticated', to_regprocedure(f.sig), 'execute') <> f.auth_exec
       or not has_function_privilege('service_role', to_regprocedure(f.sig), 'execute') then
      raise exception '0124 aborted: %''s attributes (SECURITY DEFINER, search_path, volatility or EXECUTE grants) are not the ones 0124 expects on this database — nothing was changed. '
                      'This file would reset them; compare them with %''s and decide before applying',
                      f.name, f.src;
    end if;
  end loop;
  raise notice '0124: preflight passed — no reservation, instalment line or lead names a parent of another organisation; the four bodies are the ones restated';
end $$;

-- ---------------------------------------------------------------------------
-- A. The relationships and the two unique rules
-- ---------------------------------------------------------------------------
-- the referenced side for instalment lines (properties has 0088's)
alter table public.reservations
  add constraint reservations_org_id_id_key unique (org_id, id);
comment on constraint reservations_org_id_id_key on public.reservations is
  '0124: the referenced side of organisation-bound links onto reservations (reservation_installments_org_reservation_fkey first). '
  'id is already unique; this only lets a referencing row name the organisation too.';

alter table public.reservations
  drop constraint reservations_property_id_fkey;
alter table public.reservations
  add constraint reservations_org_property_fkey
    foreign key (org_id, property_id) references public.properties (org_id, id) on delete restrict;
comment on constraint reservations_org_property_fkey on public.reservations is
  '0124: a reservation holds a property of its own organisation, by construction. '
  'Replaces the single-column FK on property_id (ON DELETE RESTRICT, as that one was).';
create index if not exists reservations_org_property_idx
  on public.reservations (org_id, property_id);

drop index public.reservations_one_live_per_property;
create unique index reservations_one_live_per_property
  on public.reservations (org_id, property_id)
  where status in ('held', 'confirmed');
comment on index public.reservations_one_live_per_property is
  '0044 / 0124: one live (held or confirmed) reservation per property. Keyed (org_id, property_id) since 0124 — '
  'with reservations_org_property_fkey the same rule for every valid row, and another organisation''s hold can no '
  'longer occupy it (which answered 23505: a denial, and an oracle on the property''s hold state).';

alter table public.reservation_installments
  drop constraint reservation_installments_reservation_id_fkey;
alter table public.reservation_installments
  add constraint reservation_installments_org_reservation_fkey
    foreign key (org_id, reservation_id) references public.reservations (org_id, id) on delete cascade;
comment on constraint reservation_installments_org_reservation_fkey on public.reservation_installments is
  '0124: an instalment line belongs to a reservation of its own organisation, by construction. '
  'Replaces the single-column FK on reservation_id (ON DELETE CASCADE, as that one was).';

alter table public.reservation_installments
  drop constraint reservation_installments_reservation_id_sort_order_key;
alter table public.reservation_installments
  add constraint reservation_installments_org_reservation_sort_order_key unique (org_id, reservation_id, sort_order);
comment on constraint reservation_installments_org_reservation_sort_order_key on public.reservation_installments is
  '0050 / 0124: one line per position of a schedule. Keyed (org_id, reservation_id, sort_order) since 0124 — the same rule '
  'for every valid row, and another organisation''s line can no longer take a position (which answered 23505 and '
  'blocked the schedule''s own lines). Its leading columns also serve reservation_installments_org_reservation_fkey.';

alter table public.leads
  drop constraint leads_property_id_fkey;
alter table public.leads
  add constraint leads_org_property_fkey
    foreign key (org_id, property_id) references public.properties (org_id, id);
comment on constraint leads_org_property_fkey on public.leads is
  '0124: a lead names a property of its own organisation, or none, by construction. '
  'Replaces the single-column FK on property_id (NO ACTION, as that one was); a lead with no property is not checked (MATCH SIMPLE).';
create index if not exists leads_org_property_idx
  on public.leads (org_id, property_id)
  where property_id is not null;

-- ---------------------------------------------------------------------------
-- B1. warn_expiring_reservations (0052's text + `and p.org_id = r.org_id`)
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
  'longer live. Since 0124 it reads only the hold''s own organisation''s property (p.org_id = r.org_id).';

-- ---------------------------------------------------------------------------
-- B2. remind_due_installments (0052's text + `and r.org_id = i.org_id` twice
--     and `and p.org_id = r.org_id`)
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
  '(r.org_id = i.org_id, in the mint and the self-heal) and that reservation''s own property (p.org_id = r.org_id).';

-- ---------------------------------------------------------------------------
-- B3. raise_lead_sla_tasks (0098's text + `and p.org_id = l.org_id`, and the
--     property it READ: `p.id as property_id`, was `l.property_id`)
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
       and not exists (select 1 from tasks t where t.lead_id = l.id and t.kind = 'lead_unanswered')
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
  ' Since 0124 it reads only the lead''s own organisation''s property (p.org_id = l.org_id) and copies the property it read (p.id), so a lead naming another organisation''s property is chased without it.';

-- ---------------------------------------------------------------------------
-- B4. preview_lead_escalation (0112's text + `and pr.org_id = c.org_id`)
-- ---------------------------------------------------------------------------
create or replace function public.preview_lead_escalation(
  p_policy jsonb,
  p_limit  int         default 50,
  p_now    timestamptz default now()
)
returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_uid        uuid := auth.uid();
  v_org        uuid;
  v_cfg        jsonb;
  v_recipients jsonb;
  v_eligible   uuid[];
  v_doc        jsonb;
begin
  -- who: the three gates of the recovery (0111), in the same words
  if v_uid is null then raise exception 'Not authenticated.'; end if;
  if not (select mfa_satisfied()) then raise exception 'Second factor required.'; end if;
  v_org := (select current_org_id());
  if v_org is null then raise exception 'Not authenticated.'; end if;
  if (select current_role_gnk()) <> 'admin' then raise exception 'Admins only.'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'The preview limit must be between 1 and 200.';
  end if;

  -- the proposed values as the sweep's reader sees them, evaluated as if ON
  v_cfg := public.lead_escalation_config(p_policy) || jsonb_build_object('enabled', true);

  -- every proposed recipient, in the order proposed (first occurrence),
  -- judged against THIS organisation's profiles by the worker's rule
  -- (lib/services/lead-escalation.ts escalationRecipients; 0111's count)
  with proposed as (
    select distinct on (e.val #>> '{}') (e.val #>> '{}')::uuid as id, e.ord
      from jsonb_array_elements(coalesce(p_policy -> 'recipients', '[]'::jsonb)) with ordinality as e(val, ord)
     where jsonb_typeof(e.val) = 'string'
       and (e.val #>> '{}') in (select x #>> '{}' from jsonb_array_elements(v_cfg -> 'recipients') x)
     order by e.val #>> '{}', e.ord
  ),
  judged as (
    select pr.id, pr.ord, p.full_name, p.role::text as role, p.is_active,
           case when p.id is null then null else coalesce(btrim(p.email), '') <> '' end as has_email,
           case
             when p.id is null                         then 'not_in_organisation'
             when not p.is_active                      then 'inactive'
             when p.role not in ('admin', 'agent')     then 'not_admin_or_agent'
             when coalesce(btrim(p.email), '') = ''    then 'no_email'
             else                                           'ok'
           end as reason
      from proposed pr
      left join profiles p on p.id = pr.id and p.org_id = v_org
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', j.id, 'full_name', j.full_name, 'role', j.role, 'is_active', j.is_active,
           'has_email', j.has_email, 'eligible', j.reason = 'ok', 'reason', j.reason) order by j.ord), '[]'::jsonb),
         coalesce(array_agg(j.id) filter (where j.reason = 'ok'), '{}'::uuid[])
    into v_recipients, v_eligible
    from judged j;

  -- the enquiries: the same rows the sweep reads, scored for THESE recipients
  with c as (
    select * from public.lead_escalation_candidates(v_org, v_cfg, p_now)
  ),
  scored as (
    select c.*,
           -- the worker never tells the assignee: the eligible set less them
           (cardinality(v_eligible)
              - case when coalesce(c.assigned_agent_id = any(v_eligible), false) then 1 else 0 end) as recipients_eligible,
           a.full_name as assignee_name,
           pr.reference as property_ref,
           case c.verdict when 'due' then 1 when 'not_yet_due' then 2 when 'past_cutoff' then 3 else 4 end as rank
      from c
      left join profiles a on a.id = c.assigned_agent_id and a.org_id = v_org
      left join properties pr on pr.id = c.property_id
       and pr.org_id = c.org_id
  ),
  page as (
    select s.* from scored s order by s.rank, s.due_at, s.lead_id limit p_limit
  )
  select jsonb_build_object(
    'counts', (
      select jsonb_build_object(
        'considered',                 count(*),
        'due',                        count(*) filter (where s.verdict = 'due'),
        'would_send',                 count(*) filter (where s.verdict = 'due' and s.recipients_eligible > 0),
        'no_recipient',               count(*) filter (where s.verdict = 'due' and s.recipients_eligible = 0),
        'only_recipient_is_assignee', count(*) filter (where s.verdict = 'due' and s.recipients_eligible = 0
                                                          and coalesce(s.assigned_agent_id = any(v_eligible), false)),
        'not_yet_due',                count(*) filter (where s.verdict = 'not_yet_due'),
        'past_cutoff',                count(*) filter (where s.verdict = 'past_cutoff'),
        'already_escalated',          count(*) filter (where s.verdict = 'already_escalated'))
        from scored s),
    'leads', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'lead_id', p.lead_id, 'received_at', p.received_at, 'due_at', p.due_at, 'verdict', p.verdict,
        'status', p.status, 'assignee_id', p.assigned_agent_id, 'assignee_name', p.assignee_name,
        'property_ref', p.property_ref, 'recipients_eligible', p.recipients_eligible,
        'only_recipient_is_assignee', p.recipients_eligible = 0 and coalesce(p.assigned_agent_id = any(v_eligible), false),
        'job_state', p.job_state) order by p.rank, p.due_at, p.lead_id), '[]'::jsonb)
        from page p),
    'truncated', (select count(*) from scored) > p_limit
  ) into v_doc;

  return v_doc || jsonb_build_object(
    'evaluated_at',             p_now,
    'evaluated_as_enabled',     true,
    'stored_enabled',           coalesce((public.lead_escalation_config() ->> 'enabled')::boolean, false),
    'policy',                   v_cfg,
    'recipients',               v_recipients,
    'eligible_recipient_count', cardinality(v_eligible),
    'limit',                    p_limit
  );
end $fn$;

revoke execute on function public.preview_lead_escalation(jsonb, int, timestamptz) from public, anon;
grant  execute on function public.preview_lead_escalation(jsonb, int, timestamptz) to authenticated, service_role;

comment on function public.preview_lead_escalation(jsonb, int, timestamptz) is
  'What switching the lead escalation ON with p_policy would do as of p_now '
  '(0112), for an aal2-satisfied admin of the caller''s own organisation: the '
  'policy as lead_escalation_config validates it (evaluated as if enabled; '
  'stored_enabled says what the row holds), every proposed recipient with a '
  'reason (ok / not_in_organisation / inactive / not_admin_or_agent / '
  'no_email), counts that keep the sweep''s jobs (due) apart from the worker''s '
  'e-mails (would_send; no_recipient; only_recipient_is_assignee), and at most '
  'p_limit (1..200) leads — due first, then not_yet_due, past_cutoff, '
  'already_escalated — as ids, times, status, assignee name, property '
  'reference and recipient count; never the enquirer. STABLE: it cannot '
  'write. Eligibility moves on after the preview; the sweep and the worker '
  'decide again at their own moment.'
  ' Since 0124 the property reference is read only from the lead''s own organisation (pr.org_id = c.org_id).';

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
  -- and the one select it swaps
  k_pr      constant text := E'\n       and p.org_id = r.org_id';
  k_ri      constant text := E'\n       and r.org_id = i.org_id';
  k_lead    constant text := E'\n       and p.org_id = l.org_id';
  k_prev    constant text := E'\n       and pr.org_id = c.org_id';
  k_sla_old constant text := 'l.assigned_agent_id, l.property_id, p.reference';
  k_sla_new constant text := 'l.assigned_agent_id, p.id as property_id, p.reference';
begin
  -- each link: exactly one foreign key for the pair, the composite one,
  -- validated, the stated delete rule, NO ACTION on update, MATCH SIMPLE;
  -- the old key gone
  for c in
    select * from (values
      ('public.reservations'::regclass,             'public.properties'::regclass,   'reservations_org_property_fkey',                array['org_id','property_id']::name[],    'r', 'reservations_property_id_fkey'),
      ('public.reservation_installments'::regclass, 'public.reservations'::regclass, 'reservation_installments_org_reservation_fkey', array['org_id','reservation_id']::name[], 'c', 'reservation_installments_reservation_id_fkey'),
      ('public.leads'::regclass,                    'public.properties'::regclass,   'leads_org_property_fkey',                       array['org_id','property_id']::name[],    'a', 'leads_property_id_fkey')
    ) as t(rel, ref, name, cols, del, old)
  loop
    select count(*) into n from pg_constraint where conrelid = c.rel and confrelid = c.ref and contype = 'f';
    if n <> 1 then
      raise exception '0124 aborted: expected exactly one foreign key from % to %, found %', c.rel, c.ref, n;
    end if;
    if not exists (
      select 1 from pg_constraint k
       where k.conrelid = c.rel and k.confrelid = c.ref and k.contype = 'f'
         and k.conname = c.name and k.convalidated
         and k.confdeltype::text = c.del and k.confupdtype = 'a' and k.confmatchtype = 's'
         and (select array_agg(a.attname order by x.ord) from unnest(k.conkey) with ordinality x(attnum, ord)
                join pg_attribute a on a.attrelid = k.conrelid and a.attnum = x.attnum) = c.cols
         and (select array_agg(a.attname order by x.ord) from unnest(k.confkey) with ordinality x(attnum, ord)
                join pg_attribute a on a.attrelid = k.confrelid and a.attnum = x.attnum) = array['org_id','id']::name[]) then
      raise exception '0124 aborted: % is not % -> % (org_id, id), validated, delete rule %, NO ACTION on update, MATCH SIMPLE', c.name, c.cols, c.ref, c.del;
    end if;
    if exists (select 1 from pg_constraint where conrelid = c.rel and conname = c.old) then
      raise exception '0124 aborted: the single-column % is still there (two relationships would make PostgREST embeds ambiguous)', c.old;
    end if;
  end loop;

  -- the referenced key, the two re-keyed unique rules, the referencing indexes
  if (select count(*) from pg_constraint
        where (conrelid = 'public.reservations'::regclass and conname = 'reservations_org_id_id_key'
               and contype = 'u' and pg_get_constraintdef(oid) = 'UNIQUE (org_id, id)')
           or (conrelid = 'public.reservation_installments'::regclass and conname = 'reservation_installments_org_reservation_sort_order_key'
               and contype = 'u' and pg_get_constraintdef(oid) = 'UNIQUE (org_id, reservation_id, sort_order)')) <> 2 then
    raise exception '0124 aborted: reservations_org_id_id_key or reservation_installments_org_reservation_sort_order_key is missing or wrong';
  end if;
  if exists (select 1 from pg_constraint where conrelid = 'public.reservation_installments'::regclass
                and conname = 'reservation_installments_reservation_id_sort_order_key') then
    raise exception '0124 aborted: unique (reservation_id, sort_order) is still there';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'reservations_one_live_per_property'
                    and indexdef = 'CREATE UNIQUE INDEX reservations_one_live_per_property ON public.reservations USING btree (org_id, property_id) WHERE (status = ANY (ARRAY[''held''::reservation_status, ''confirmed''::reservation_status]))') then
    raise exception '0124 aborted: reservations_one_live_per_property is not UNIQUE (org_id, property_id) WHERE live';
  end if;
  if (select count(*) from pg_indexes where schemaname = 'public'
        and ((indexname = 'reservations_org_property_idx' and indexdef ~ 'ON public\.reservations USING btree \(org_id, property_id\)$')
          or (indexname = 'leads_org_property_idx'        and indexdef ~ 'ON public\.leads USING btree \(org_id, property_id\) WHERE \(property_id IS NOT NULL\)$'))) <> 2 then
    raise exception '0124 aborted: a referencing index is missing or has the wrong definition';
  end if;
  -- no unique index may answer (23505) before a key does: every unique index
  -- on reservations naming property_id, and on reservation_installments
  -- naming reservation_id, must name org_id too
  if exists (
    select 1 from pg_index i
     where i.indisunique
       and ((i.indrelid = 'public.reservations'::regclass
             and exists (select 1 from pg_attribute a where a.attrelid = i.indrelid and a.attnum = any (i.indkey) and a.attname = 'property_id'))
         or (i.indrelid = 'public.reservation_installments'::regclass
             and exists (select 1 from pg_attribute a where a.attrelid = i.indrelid and a.attnum = any (i.indkey) and a.attname = 'reservation_id')))
       and not exists (select 1 from pg_attribute a where a.attrelid = i.indrelid and a.attnum = any (i.indkey) and a.attname = 'org_id')) then
    raise exception '0124 aborted: a unique index names a parent column without org_id — it would answer before the key';
  end if;
  -- MATCH SIMPLE skips a row with any null key column: the boundary rests on
  -- these being NOT NULL (leads.property_id is nullable by design: no property)
  if exists (select 1 from pg_attribute
              where not attnotnull
                and ((attrelid = 'public.reservations'::regclass             and attname in ('org_id', 'property_id'))
                  or (attrelid = 'public.reservation_installments'::regclass and attname in ('org_id', 'reservation_id'))
                  or (attrelid in ('public.leads'::regclass, 'public.properties'::regclass) and attname = 'org_id'))) then
    raise exception '0124 aborted: an org_id or parent column that a key relies on is nullable';
  end if;
  -- 0088's and 0119–0123's tenant-bound keys, untouched
  select count(*) into n from pg_constraint
   where convalidated
     and ((conname = 'tasks_org_deal_fkey'             and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, deal_id) REFERENCES deals(org_id, id)')
       or (conname = 'tasks_org_viewing_fkey'          and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, viewing_id) REFERENCES viewings(org_id, id)')
       or (conname = 'tasks_org_mandate_fkey'          and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, mandate_id) REFERENCES mandates(org_id, id)')
       or (conname = 'mandates_org_property_fkey'      and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, property_id) REFERENCES properties(org_id, id) ON DELETE CASCADE')
       or (conname = 'property_keys_org_property_fkey' and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, property_id) REFERENCES properties(org_id, id) ON DELETE CASCADE')
       or (conname = 'mandates_org_renewed_from_fkey'  and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, renewed_from_id) REFERENCES mandates(org_id, id)')
       or (conname = 'properties_org_id_id_key'        and pg_get_constraintdef(oid) = 'UNIQUE (org_id, id)')
       or (conname = 'viewings_org_id_id_key'          and pg_get_constraintdef(oid) = 'UNIQUE (org_id, id)')
       or (conname = 'viewings_org_property_fkey'      and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, property_id) REFERENCES properties(org_id, id)')
       or (conname = 'viewings_org_contact_fkey'       and pg_get_constraintdef(oid) = 'FOREIGN KEY (org_id, contact_id) REFERENCES contacts(org_id, id)')
       or (conname = 'contacts_org_id_id_key'          and pg_get_constraintdef(oid) = 'UNIQUE (org_id, id)'));
  if n <> 11 then
    raise exception '0124 aborted: an earlier tenant-bound key (0088 / 0119–0123) is missing, not validated, or changed';
  end if;

  -- the four readers: one overload each; definer, search_path, return type
  -- and volatility kept; each predicate in its place (comments stripped);
  -- nothing else moved relative to the old body; the ACLs
  for c in
    select * from (values
      ('warn_expiring_reservations', 'public.warn_expiring_reservations(uuid)',                                  'void',  'v', '7d7c5420cf56897a509a886c37e2cda1', false),
      ('remind_due_installments',    'public.remind_due_installments(uuid)',                                     'void',  'v', 'fd8fa594e8493a71981d606818c820e8', false),
      ('raise_lead_sla_tasks',       'public.raise_lead_sla_tasks(uuid, integer)',                               'int4',  'v', '58e1a6990a7c2271787d29b8f131279a', false),
      ('preview_lead_escalation',    'public.preview_lead_escalation(jsonb, integer, timestamp with time zone)', 'jsonb', 's', '4728c4a6c9a8df72b6d0b83102d946ea', true)
    ) as t(name, sig, ret, vol, old_md5, auth_exec)
  loop
    select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public' and p.proname = c.name;
    if n <> 1 then
      raise exception '0124 aborted: expected one overload of %, found %', c.name, n;
    end if;
    select p.prosrc into src from pg_proc p
     where p.oid = to_regprocedure(c.sig)
       and p.prosecdef and 'search_path=public' = any (p.proconfig)
       and p.prorettype::regtype::text = (c.ret)::regtype::text and p.provolatile::text = c.vol;
    if src is null then
      raise exception '0124 aborted: % lost SECURITY DEFINER, its search_path, its return type or its volatility', c.name;
    end if;
    src := replace(src, E'\r', '');
    if md5(replace(replace(replace(replace(replace(src, k_pr, ''), k_ri, ''), k_lead, ''), k_prev, ''), k_sla_new, k_sla_old)) <> c.old_md5 then
      raise exception '0124 aborted: % is not its old body plus exactly 0124''s lines', c.name;
    end if;
    if has_function_privilege('anon', to_regprocedure(c.sig), 'execute')
       or has_function_privilege('authenticated', to_regprocedure(c.sig), 'execute') <> c.auth_exec
       or not has_function_privilege('service_role', to_regprocedure(c.sig), 'execute') then
      raise exception '0124 aborted: %''s EXECUTE grants changed', c.name;
    end if;
  end loop;

  -- each predicate where it belongs, counted
  src := replace((select prosrc from pg_proc where oid = 'public.warn_expiring_reservations(uuid)'::regprocedure), E'\r', '');
  if (length(src) - length(replace(src, k_pr, ''))) / length(k_pr) <> 1
     or regexp_replace(src, '--[^\n]*', '', 'g') !~ 'join properties p on p\.id = r\.property_id\s+and p\.org_id = r\.org_id' then
    raise exception '0124 aborted: warn_expiring_reservations does not scope its property join to the hold''s organisation';
  end if;
  src := replace((select prosrc from pg_proc where oid = 'public.remind_due_installments(uuid)'::regprocedure), E'\r', '');
  if (length(src) - length(replace(src, k_ri, ''))) / length(k_ri) <> 2
     or (length(src) - length(replace(src, k_pr, ''))) / length(k_pr) <> 1
     or regexp_replace(src, '--[^\n]*', '', 'g') !~ 'join reservations r on r\.id = i\.reservation_id\s+and r\.org_id = i\.org_id\s+join properties\s+p on p\.id = r\.property_id\s+and p\.org_id = r\.org_id'
     or regexp_replace(src, '--[^\n]*', '', 'g') !~ 'from reservation_installments i\s+join reservations r on r\.id = i\.reservation_id\s+and r\.org_id = i\.org_id\s+where t\.installment_id = i\.id' then
    raise exception '0124 aborted: remind_due_installments does not scope both reservation joins and its property join to the line''s organisation';
  end if;
  src := replace((select prosrc from pg_proc where oid = 'public.raise_lead_sla_tasks(uuid, integer)'::regprocedure), E'\r', '');
  if (length(src) - length(replace(src, k_lead, ''))) / length(k_lead) <> 1
     or (length(src) - length(replace(src, k_sla_new, ''))) / length(k_sla_new) <> 1
     or regexp_replace(src, '--[^\n]*', '', 'g') !~ 'p\.id as property_id, p\.reference\s+from leads l\s+left join properties p on p\.id = l\.property_id\s+and p\.org_id = l\.org_id' then
    raise exception '0124 aborted: raise_lead_sla_tasks does not read and copy only the lead''s own organisation''s property';
  end if;
  src := replace((select prosrc from pg_proc where oid = 'public.preview_lead_escalation(jsonb, integer, timestamp with time zone)'::regprocedure), E'\r', '');
  if (length(src) - length(replace(src, k_prev, ''))) / length(k_prev) <> 1
     or regexp_replace(src, '--[^\n]*', '', 'g') !~ 'left join properties pr on pr\.id = c\.property_id\s+and pr\.org_id = c\.org_id' then
    raise exception '0124 aborted: preview_lead_escalation does not read the property reference from the lead''s own organisation';
  end if;

  -- the keys, exercised: two organisations, a property each; A's live hold
  -- with one schedule line; then five cross-organisation rows, each in its
  -- own sub-block and each refused by ITS key at ITS step — among them the
  -- two that a unique rule answered first (23505) until this file. No
  -- column here needs a profile, so this runs on an empty database too.
  declare
    v_org_a uuid; v_org_b uuid; v_prop_a uuid; v_prop_b uuid; v_res_a uuid;
    v_verdicts text[] := '{}';
  begin
    for c in
      select * from (values
        ('hold',       'reservations_org_property_fkey'),                 -- B's (released) hold on A's property
        ('live_hold',  'reservations_org_property_fkey'),                 -- B's LIVE hold on A's held property: the key, not the one-live rule
        ('line',       'reservation_installments_org_reservation_fkey'),  -- B's line on A's reservation
        ('taken_line', 'reservation_installments_org_reservation_fkey'),  -- B's line at a position A's schedule uses: the key, not the unique rule
        ('lead',       'leads_org_property_fkey')                         -- B's lead on A's property
      ) as t(kind, expect)
    loop
      v_ok := null; v_con := null; v_step := 'setup';
      begin
        insert into organizations (name, slug)
          values ('0124 probe A (rolled back)', '0124-probe-a-' || replace(gen_random_uuid()::text, '-', ''))
          returning id into v_org_a;
        insert into organizations (name, slug)
          values ('0124 probe B (rolled back)', '0124-probe-b-' || replace(gen_random_uuid()::text, '-', ''))
          returning id into v_org_b;
        insert into properties (org_id, reference, property_type) values (v_org_a, 'ZZZ0124-probe-a', 'apartment') returning id into v_prop_a;
        insert into properties (org_id, reference, property_type) values (v_org_b, 'ZZZ0124-probe-b', 'apartment') returning id into v_prop_b;
        -- the same-organisation links: all accepted
        v_step := 'own';
        insert into reservations (org_id, property_id, status, held_from, expires_at)
          values (v_org_a, v_prop_a, 'held', now(), now() + interval '1 day') returning id into v_res_a;
        insert into reservation_installments (org_id, reservation_id, sort_order, label, amount)
          values (v_org_a, v_res_a, 1, '0124 probe', 1);
        insert into leads (org_id, property_id, source) values (v_org_a, v_prop_a, 'other');
        -- organisation B's row naming organisation A's parent: the
        -- single-column keys accepted each of these (or a unique rule
        -- answered 23505 first)
        v_step := 'cross';
        if c.kind = 'hold' then
          insert into reservations (org_id, property_id, status, held_from, expires_at)
            values (v_org_b, v_prop_a, 'released', now(), now() + interval '1 day');
        elsif c.kind = 'live_hold' then
          insert into reservations (org_id, property_id, status, held_from, expires_at)
            values (v_org_b, v_prop_a, 'held', now(), now() + interval '1 day');
        elsif c.kind = 'line' then
          insert into reservation_installments (org_id, reservation_id, sort_order, label, amount)
            values (v_org_b, v_res_a, 2, '0124 probe', 1);
        elsif c.kind = 'taken_line' then
          insert into reservation_installments (org_id, reservation_id, sort_order, label, amount)
            values (v_org_b, v_res_a, 1, '0124 probe', 1);
        else
          insert into leads (org_id, property_id, source) values (v_org_b, v_prop_a, 'other');
        end if;
        raise exception using errcode = 'P0125', message = '0124 probe: a cross-organisation row was ACCEPTED';
      exception
        when foreign_key_violation then
          get stacked diagnostics v_con = constraint_name;
          v_ok := (v_con = c.expect and v_step = 'cross');
        when unique_violation then
          -- the 23505-before-23503 oracle this file closes: a verdict, not a crash
          get stacked diagnostics v_con = constraint_name;
          v_ok := false;
        when sqlstate 'P0125' then
          v_ok := false;
      end;
      if v_ok is distinct from true then
        raise exception '0124 aborted: the % probe was not refused by % at the cross-organisation step (met % at the % step)',
          c.kind, c.expect, coalesce(v_con, 'no foreign-key violation'), v_step;
      end if;
      v_verdicts := v_verdicts || c.kind;
    end loop;
    raise notice '0124: probes refused by their keys: %', v_verdicts;
  end;

  raise notice '0124: reservations / leads (org_id, property_id) and reservation_installments (org_id, reservation_id) tenant-bound; the four readers read only their own organisation''s parents';
end $$;
