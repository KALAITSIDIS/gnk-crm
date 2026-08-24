-- 0051 — chase a reservation instalment before (and after) it falls due.
--
-- 0050 froze a hold's payment schedule and gave each line a nullable `due_date`
-- and a `paid_at`, plus the partial index `reservation_installments_due_idx`
-- (`where paid_at is null and due_date is not null`) built for exactly this
-- sweep. Nothing has read that date until now, so a schedule has been a record
-- of what was agreed and never a reason for anyone to act.
--
-- THE FIFTH USE OF THE CRON IDIOM (0012 · 0020 · 0044 · 0047) and the FIRST new
-- task kind that is a one-line INSERT into `task_kinds` rather than a rewrite of
-- `tasks_kind_chk`. That is 0049 paying off, and it is the whole reason 0049
-- exists: adding a kind can no longer silently drop the kinds already there.
--
-- ============================================================================
-- WHAT COUNTS AS A RESERVATION WORTH CHASING — the one place this DIVERGES from
-- 0047, and the decision most likely to be got wrong by copying it.
--
-- 0047 warns on `status in ('held','confirmed')`, which is `LIVE_RESERVATION_
-- STATUSES` — the states that OCCUPY a property, and what the partial unique
-- index indexes. That is right for an expiry warning: only a hold that can
-- lapse has an expiry worth warning about.
--
-- IT IS WRONG HERE. `converted` is terminal and means the sale WENT AHEAD. A
-- Cyprus buyer paying 10/30/60 across two years of construction is `converted`
-- for almost the entire life of their payment schedule. Reusing the "live"
-- definition would have stopped chasing every instalment at the exact moment
-- the money started actually mattering — a sweep that runs nightly, reports
-- nothing, and is broken.
--
-- So this sweep uses its own predicate, named for what it means:
--   CHASEABLE = held · confirmed · converted
-- `expired` and `released` are excluded: the buyer walked away, and dunning
-- someone for money on a dead hold is worse than silence.
-- ============================================================================
--
-- OVERDUE LINES ARE IN SCOPE, and there is no floor on how old. 0047 only looks
-- FORWARD because the 03:45 expiry sweep deals with everything behind it — a
-- lapsed hold becomes `expired` and its warning is superseded. Nothing plays
-- that role here: an unpaid instalment that came due last March just sits
-- there. Ignoring it would mean the sweep goes quietest about the money most at
-- risk. One task per line per due date, so an old line is one row, not a nightly
-- pile.
--
-- IDEMPOTENCE KEYED TO A CYCLE, not to "does a task exist" — 0006's bug, which
-- 0012 and 0020 both had to fix. The cycle is the line's CURRENT `due_date`:
-- the task's due date is the Cyprus end-of-day of it, so re-agreeing a date
-- with the buyer moves the boundary, supersedes the old reminder and arms a new
-- one. That falls out of the key rather than needing its own branch.
--
-- THE KEY IGNORES `is_done`, deliberately, exactly as 0047's does. Filtering to
-- OPEN tasks would re-mint a reminder the night after an agent completed one
-- with the date unchanged — 0006's bug in its other direction, spam instead of
-- silence. Cost: re-date a line and then move it BACK to the same date and no
-- fresh reminder is raised, because one for that date already exists. Moving it
-- to any DIFFERENT date re-arms, which is the case that actually happens.
--
-- INVARIANT
--   an OPEN installment_due task exists iff its line is unpaid, has a date, that
--   date is within 7 days or already past, its reservation is CHASEABLE, and the
--   task's due date equals the line's current due_date.
--
-- Threshold hardcoded at 7 days, like 0020's 14 and 0047's 2: a second,
-- separately-editable copy could disagree silently about what "coming due"
-- means. Changing it is one `create or replace function`. Seven rather than
-- 0047's two because chasing money takes longer than extending a hold — a
-- buyer needs to instruct a bank, and a week is the shortest notice that is
-- actually actionable.
--
-- NO MONEY IN THE TASK TITLE, on purpose. Formatting an amount here would be a
-- SECOND money formatter, in SQL, free to drift from `formatMoney` in
-- `lib/utils/format.ts` — and the two would be compared side by side, because
-- the task links to the property whose schedule card shows the same figure. The
-- amount goes in the event payload, where the existing `asMoney` renders it.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

-- ---------- schema ----------------------------------------------------------

-- `reservation_id` (0047) is NOT enough to key on: a reservation has MANY
-- instalments and several can fall due in the same window, so keying by
-- reservation would mint one reminder and call the rest done.
--
-- `on delete cascade` matches 0047's choice, and here it is load-bearing rather
-- than theoretical: `clearSchedule` really does hard-delete lines. A reminder to
-- chase a line that no longer exists is noise, and the removal is already on the
-- record as `reservation_schedule_cleared`.
alter table public.tasks add column if not exists installment_id uuid
  references public.reservation_installments(id) on delete cascade;

create index if not exists tasks_installment_idx
  on public.tasks(installment_id) where installment_id is not null;

-- 0049's payoff: a new kind is an INSERT. An INSERT cannot drop the seven kinds
-- already there — a rewritten CHECK can, and 0046 nearly did.
insert into public.task_kinds (kind, description, added_in) values
  ('installment_due', 'A reservation instalment is due within 7 days, or is overdue', '0051')
on conflict (kind) do nothing;

-- ---------- the sweep -------------------------------------------------------

create or replace function public.remind_due_installments(p_org uuid default null)
returns void
language sql security definer set search_path = public as $$
  -- 1) mint a reminder for every unpaid, dated line that is due within 7 days
  --    or already past, on a reservation still worth chasing
  with due_soon as (
    select i.id, i.org_id, i.reservation_id, i.label, i.amount, i.due_date,
           i.due_date - (now() at time zone 'Asia/Nicosia')::date as days_out,
           r.property_id, r.contact_id, r.created_by,
           p.reference,
           p.assigned_agent_id
      from reservation_installments i
      join reservations r on r.id = i.reservation_id
      join properties    p on p.id = r.property_id
     where i.paid_at is null
       and i.due_date is not null
       -- CHASEABLE, not LIVE — see the header. `converted` is the state a
       -- buyer spends most of a payment plan in.
       and r.status in ('held', 'confirmed', 'converted')
       and i.due_date <= (now() at time zone 'Asia/Nicosia')::date + 7
       and (p_org is null or i.org_id = p_org)
  ),
  created as (
    insert into tasks (org_id, title, due_at, assignee_id, property_id,
                       contact_id, reservation_id, installment_id, kind)
    select d.org_id,
           'Instalment "' || d.label || '" on ' || d.reference
             || ' due ' || to_char(d.due_date, 'DD Mon'),
           -- the task falls due exactly when the instalment does, so /tasks
           -- shows it as overdue at the same moment the money is
           (d.due_date::timestamp + interval '23 hours 59 minutes') at time zone 'Asia/Nicosia',
           -- three-arm fallback, per 0012/0020/0047: a NULL assignee is
           -- invisible on every surface, because /tasks and the agent dashboard
           -- both filter on assignee_id = me.
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
          -- keyed to THIS due date, not to "any reminder for this line":
          -- re-agreeing the date with the buyer is a new cycle
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
                              -- NEGATIVE means already overdue; the renderer
                              -- splits on the sign rather than on a flag
                              'days', d.days_out)
      from created c join due_soon d on d.id = c.installment_id
    returning 1
  ),
  -- 2) self-heal: a reminder whose condition stopped holding is COMPLETED,
  --    never deleted, so history keeps its shape and "Recently done" stays
  --    honest. (A line that is DELETED takes its task with it — see the column
  --    comment; that is the one case with nothing left to complete.)
  superseded as (
    update tasks t
       set is_done = true, done_at = now()
      from reservation_installments i
      join reservations r on r.id = i.reservation_id
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
                              -- most specific first: a paid line is paid even
                              -- if the reservation also closed that night
                              when paid_at is not null then 'installment_paid'
                              when status not in ('held', 'confirmed', 'converted')
                                then 'reservation_no_longer_live'
                              else 'installment_rescheduled'
                            end)
    from superseded;
$$;

-- 03:55, behind warn-expiring-reservations at 03:50 and expire-reservations at
-- 03:45. Order is deliberate and is the same reasoning 0047 gave: a hold that
-- lapsed overnight is already `expired` by the time this runs, so its
-- instalment reminders are superseded in this pass rather than surviving until
-- tomorrow and chasing a buyer who has walked away.
select cron.schedule('remind-due-installments', '55 3 * * *',
                     $$select remind_due_installments()$$);

-- LOCK DOWN EXECUTE, in the migration rather than after an advisor run. A newly
-- created function carries a PUBLIC `=X` grant, so without this it is callable
-- over PostgREST by `anon`. T-C4 shipped exactly that hole on
-- `expire_reservations`. `public` must be named explicitly because naming roles
-- cannot remove a PUBLIC grant, and doing so also strips service_role's
-- implicit grant (0010's lesson), hence the re-grant — the RLS suite calls it.
revoke execute on function public.remind_due_installments(uuid) from public, anon, authenticated;
grant  execute on function public.remind_due_installments(uuid) to service_role;

do $$
declare
  n_kinds     int;
  probe_line  uuid;
  probe_org   uuid;
  minted      int;
  again       int;
begin
  -- the kind exists, and nothing already there was lost
  select count(*) into n_kinds from public.task_kinds;
  if n_kinds <> 8 then
    raise exception '0051 aborted: expected 8 task kinds, found %', n_kinds;
  end if;
  if not exists (select 1 from public.task_kinds where kind = 'installment_due') then
    raise exception '0051 aborted: installment_due was not added';
  end if;

  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='tasks'
                    and column_name='installment_id') then
    raise exception '0051 aborted: tasks.installment_id is missing';
  end if;

  if not exists (select 1 from cron.job where jobname = 'remind-due-installments') then
    raise exception '0051 aborted: remind-due-installments was not scheduled';
  end if;

  -- T-C4's check, asserted rather than trusted: a revoke that silently no-ops is
  -- a failure this repo has hit before (st_estimatedextent).
  if has_function_privilege('anon', 'public.remind_due_installments(uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.remind_due_installments(uuid)', 'execute') then
    raise exception '0051 aborted: remind_due_installments is callable over PostgREST';
  end if;
  if not has_function_privilege('service_role', 'public.remind_due_installments(uuid)', 'execute') then
    raise exception '0051 aborted: service_role lost EXECUTE (the RLS suite calls it)';
  end if;

  -- PROVE THE SWEEP MINTS AND IS IDEMPOTENT, on a real row, if this database
  -- has one to build from. Everything above checks that objects EXIST; none of
  -- it would notice a sweep that selects nothing.
  select i.id, i.org_id into probe_line, probe_org
    from reservation_installments i
    join reservations r on r.id = i.reservation_id
   where i.paid_at is null and r.status in ('held','confirmed','converted')
   limit 1;

  if probe_line is not null then
    -- RUN THE PROBE INSIDE A SUBTRANSACTION AND ROLL IT BACK.
    --
    -- The sweep writes to `events`, which is APPEND-ONLY AND HASH-CHAINED: each
    -- row's hash covers the previous row's, so deleting the probe's rows
    -- afterwards would either break `verify_events_chain()` or work only by the
    -- accident of those rows happening to be last. A `begin … exception` block
    -- is a real subtransaction, so raising at the end unwinds the tasks, the
    -- events and the borrowed due_date together, and the chain never sees them.
    --
    -- PL/pgSQL variables are memory, not transactional state, so `minted` and
    -- `again` survive the rollback and are asserted below.
    --
    -- The errcode is specific ON PURPOSE. `when others` here would swallow a
    -- genuine failure inside the sweep and report a pass — the exact shape of
    -- guard that spends a green run on nothing. Any other error propagates and
    -- fails the migration.
    begin
      update reservation_installments
         set due_date = (now() at time zone 'Asia/Nicosia')::date + 1
       where id = probe_line;

      perform remind_due_installments(probe_org);
      select count(*) into minted from tasks
       where installment_id = probe_line and kind = 'installment_due';

      perform remind_due_installments(probe_org);
      select count(*) into again from tasks
       where installment_id = probe_line and kind = 'installment_due';

      raise exception using errcode = 'GNK51', message = '0051 probe rollback';
    exception when sqlstate 'GNK51' then
      null; -- expected — the rollback IS the point
    end;

    if minted <> 1 then
      raise exception '0051 aborted: sweep minted % reminders, expected 1', minted;
    end if;
    if again <> 1 then
      raise exception '0051 aborted: a second sweep added % more', again - minted;
    end if;

    raise notice '0051: kind added (8 total), execute locked down, sweep PROVEN to mint once and no-op twice on a real line (probe rolled back)';
  else
    -- SAY WHICH IT WAS. On a fresh database — which is exactly what CI applies
    -- migrations to — there is no unpaid line on a chaseable reservation, the
    -- probe cannot run, and a message claiming it passed would be a claim with
    -- nothing behind it. RLS test 35 covers the sweep unconditionally.
    raise notice '0051: kind added (8 total), execute locked down; mint/idempotence probe SKIPPED (no chaseable instalment on this database) — RLS test 35 covers it';
  end if;
end $$;
