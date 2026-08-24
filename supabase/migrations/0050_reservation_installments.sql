-- 0050 — a reservation's payment schedule, frozen from a payment plan.
--
-- `payment_plans` has existed since 0001 and IS read: the units page lists a
-- project's plans, and 0001's form creates them. What has never existed is
-- anything downstream — no reservation refers to a plan, and no plan is ever
-- applied to a price. (A BACKLOG line of mine said "nothing reads them"; that
-- was wrong, and this is the corrected statement of the gap.)
--
-- WHAT A PLAN CAN AND CANNOT SAY. `installments` is `{label, pct, due}` where
-- **`due` is FREE TEXT** — "On contract signing" — not a date. A plan therefore
-- describes proportions and milestones. It cannot describe a dated schedule,
-- and nothing here invents one: `due_date` below is nullable and entered per
-- reservation. That is also why instalment reminders will read THIS table and
-- not `payment_plans`.
--
-- THE SCHEDULE IS FROZEN, which is the reason amounts are stored rather than
-- recomputed on read. A unit's asking price moves — `applyPriceUplift` moves
-- sixty at once — and a schedule already quoted to a buyer must not move with
-- it. Same reasoning that makes `price_lists` versioned snapshots.
--
-- `reservations.payment_plan_id` is PROVENANCE ONLY. The frozen rows are the
-- truth; the link just records which plan they came from, and is `on delete set
-- null` so retiring a plan cannot destroy a live schedule.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

alter table public.reservations add column if not exists payment_plan_id uuid
  references public.payment_plans(id) on delete set null;

create table if not exists public.reservation_installments (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id),
  reservation_id uuid not null references public.reservations(id) on delete cascade,

  sort_order     int not null,
  label          text not null,
  /** as quoted; kept so the schedule can explain itself, not to recompute from */
  pct            numeric(6,3),
  /** FROZEN at apply time — see the header */
  amount         numeric(14,2) not null,
  /** the plan's free-text milestone, e.g. "On contract signing" */
  milestone      text,
  /** entered per reservation; what instalment reminders will read */
  due_date       date,

  paid_at        timestamptz,
  paid_amount    numeric(14,2),
  note           text,

  created_by     uuid references public.profiles(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- one line per position, so re-applying a plan cannot interleave two schedules
  unique (reservation_id, sort_order),
  constraint installment_amount_non_negative check (amount >= 0),
  constraint installment_paid_non_negative check (paid_amount is null or paid_amount >= 0),
  -- a paid line must say how much; an unpaid one must not pretend to
  constraint installment_paid_coherent
    check ((paid_at is null and paid_amount is null)
        or (paid_at is not null and paid_amount is not null))
);

create index if not exists reservation_installments_reservation_idx
  on public.reservation_installments(reservation_id);
-- the reminder sweep will read unpaid lines with a date, org-wide
create index if not exists reservation_installments_due_idx
  on public.reservation_installments(due_date) where paid_at is null and due_date is not null;

alter table public.reservation_installments enable row level security;

-- REVOKE BEFORE GRANT — 0040's rule.
revoke all privileges on table public.reservation_installments from anon;
revoke all privileges on table public.reservation_installments from authenticated;

grant select, insert, update, delete on table public.reservation_installments to authenticated;

-- Mirrors `reservations` (0044) exactly: taking and servicing a hold is ordinary
-- agent work, and DELETE is narrowed to admin/listing_manager because a removed
-- schedule line is a removed record of what a buyer was quoted.
create policy reservation_installments_select on public.reservation_installments for select
  using (org_id = (select public.current_org_id()));

create policy reservation_installments_insert on public.reservation_installments for insert
  with check (org_id = (select public.current_org_id()));

create policy reservation_installments_update on public.reservation_installments for update
  using (org_id = (select public.current_org_id()))
  with check (org_id = (select public.current_org_id()));

create policy reservation_installments_delete on public.reservation_installments for delete
  using (org_id = (select public.current_org_id())
         and (select public.current_role_gnk()) in ('admin','listing_manager'));

-- 0029 put require_aal2 on every RLS table; a table created after it does not
-- inherit that, and rls_aal2_coverage() exists to catch the omission.
create policy require_aal2 on public.reservation_installments
  as restrictive for all to authenticated
  using ((select public.mfa_satisfied()))
  with check ((select public.mfa_satisfied()));

do $$
declare
  policies  int;
  uncovered int;
  probe_res uuid;
  refused   boolean := false;
begin
  select count(*) into policies from pg_policies
   where schemaname = 'public' and tablename = 'reservation_installments';
  if policies <> 5 then
    raise exception '0050 aborted: expected 5 policies, found %', policies;
  end if;

  if has_table_privilege('anon', 'public.reservation_installments', 'select')
     or has_table_privilege('anon', 'public.reservation_installments', 'insert') then
    raise exception '0050 aborted: anon still holds a grant on reservation_installments';
  end if;

  select count(*) into uncovered from public.rls_aal2_coverage();
  if uncovered <> 0 then
    raise exception '0050 aborted: rls_aal2_coverage() lists % table(s)', uncovered;
  end if;

  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='reservations'
                    and column_name='payment_plan_id') then
    raise exception '0050 aborted: reservations.payment_plan_id is missing';
  end if;

  -- PROVE the paid-coherence constraint bites, rather than trusting it. A line
  -- marked paid with no amount is the shape that makes "what is outstanding?"
  -- unanswerable, which is the whole reason the constraint is there.
  select r.id into probe_res from reservations r limit 1;
  if probe_res is not null then
    begin
      insert into reservation_installments
        (org_id, reservation_id, sort_order, label, amount, paid_at)
      select r.org_id, r.id, 9999, '0050 probe', 100, now()
        from reservations r where r.id = probe_res;
    exception when check_violation then
      refused := true;
    end;
    if not refused then
      raise exception '0050 aborted: a paid line with no amount was accepted';
    end if;
  end if;

  -- SAY WHICH IT WAS. On a fresh database — which is exactly what CI applies
  -- migrations to — there are no reservations, the probe above cannot run, and
  -- a message claiming it "passed" would be a claim with nothing behind it.
  -- RLS test 34 covers the constraint unconditionally; this notice only reports
  -- what THIS apply actually managed to check.
  if probe_res is null then
    raise notice '0050: 5 policies, aal2 clean; paid-coherence probe SKIPPED (no reservations on this database) — RLS test 34 covers it';
  else
    raise notice '0050: 5 policies, aal2 clean, paid-coherence PROVEN on a real row';
  end if;
end $$;
