-- 0049 — replace `tasks_kind_chk` with a `task_kinds` lookup table.
--
-- WHY: 0045, 0046, 0047 and 0048 each exist largely to add ONE STRING to that
-- CHECK. Four migrations, four rewrites of the same constraint, and each
-- rewrite is a chance to drop a value that a live sweep still filters on.
-- 0046 demonstrated the risk exactly: its assertion block aborted on a variable
-- shadowing `tasks.kind`, and the constraint went in UNVERIFIED.
--
-- WHAT THIS DOES AND DOES NOT BUY, stated honestly because the BACKLOG line
-- that proposed it slightly oversold the case. Adding a kind still needs a
-- migration — it must, since a kind without a sweep or an action behind it is
-- an orphan nobody writes. What changes is the SHAPE of that migration: a
-- one-line INSERT instead of a full constraint rewrite. An INSERT cannot
-- silently drop the six kinds already there; a rewritten CHECK can, and that is
-- the whole risk being removed.
--
-- THE PROTECTION MUST SURVIVE. The CHECK earned its keep — 0045 exists only
-- because it refused a typo'd kind loudly instead of writing an orphan row no
-- sweep would ever match. A foreign key refuses the same thing just as loudly,
-- and the assertion block below PROVES it rather than assuming it: it attempts
-- an insert with a nonsense kind and fails the migration if that succeeds.
--
-- `kind is null` still means "a human made this" — a FK permits NULL, exactly
-- as the CHECK's `kind is null or ...` did. That semantics is read in two
-- places already (the /tasks "auto" badge and the CSV "Auto" column).
--
-- NOT org-scoped, like `cyprus_config`: the vocabulary is the system's, the
-- same for every org. Unlike cyprus_config it is NOT operator-editable — the
-- app gets SELECT and nothing else, because adding a kind is a code change.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

create table if not exists public.task_kinds (
  kind        text primary key,
  description text not null,
  /** the migration that introduced it — so the next reader can find its sweep */
  added_in    text not null
);

-- Seeded BEFORE the FK is added, or validating it against existing rows fails.
insert into public.task_kinds (kind, description, added_in) values
  ('mandate_renewal',       'A mandate is approaching its expiry date',                    '0012'),
  ('deal_no_contact',       'An open deal has had no activity for 14 days',                '0020'),
  ('viewing_feedback',      'A completed viewing still has no feedback after 48 hours',    '0020'),
  ('price_drop_match',      'A price drop brought a property inside a buyer''s budget',    '0045'),
  ('new_listing_match',     'A property came onto the market and matches saved searches',  '0046'),
  ('reservation_expiring',  'A live hold lapses within 2 days',                            '0047'),
  ('bulk_price_drop_match', 'A block reprice brought buyers into range across many units', '0048')
on conflict (kind) do nothing;

alter table public.tasks drop constraint if exists tasks_kind_chk;

alter table public.tasks
  add constraint tasks_kind_fkey foreign key (kind)
  references public.task_kinds(kind)
  -- a rename carries; a delete of a kind still in use is refused, which is right
  on update cascade;

create index if not exists tasks_kind_idx on public.tasks(kind) where kind is not null;

alter table public.task_kinds enable row level security;

-- REVOKE BEFORE GRANT — 0040's rule.
revoke all privileges on table public.task_kinds from anon;
revoke all privileges on table public.task_kinds from authenticated;

-- SELECT only. Adding a kind is a code change, so there is deliberately no
-- insert/update/delete policy and no write grant: not even an admin edits this
-- from the app.
grant select on table public.task_kinds to authenticated;

create policy task_kinds_select on public.task_kinds for select
  using ((select auth.uid()) is not null);

create policy require_aal2 on public.task_kinds
  as restrictive for all to authenticated
  using ((select public.mfa_satisfied()))
  with check ((select public.mfa_satisfied()));

do $$
declare
  n_kinds   int;
  n_orphans int;
  probe_org uuid;
  refused   boolean := false;
begin
  select count(*) into n_kinds from public.task_kinds;
  if n_kinds <> 7 then
    raise exception '0049 aborted: expected 7 task kinds, found %', n_kinds;
  end if;

  if exists (select 1 from pg_constraint
              where conrelid = 'public.tasks'::regclass and conname = 'tasks_kind_chk') then
    raise exception '0049 aborted: the old CHECK is still present';
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.tasks'::regclass and conname = 'tasks_kind_fkey') then
    raise exception '0049 aborted: tasks_kind_fkey was not created';
  end if;

  select count(*) into n_orphans
    from tasks t left join task_kinds k on k.kind = t.kind
   where t.kind is not null and k.kind is null;
  if n_orphans <> 0 then
    raise exception '0049 aborted: % task(s) hold a kind the table does not list', n_orphans;
  end if;

  -- THE ASSERTION THAT MATTERS. The CHECK's value was a LOUD refusal; prove the
  -- FK refuses too, rather than trusting that it does. A guard that cannot fail
  -- spends a green run on nothing.
  select id into probe_org from organizations order by created_at limit 1;
  if probe_org is not null then
    begin
      insert into tasks (org_id, title, kind)
      values (probe_org, '0049 probe — must be refused', 'definitely_not_a_real_kind');
    exception when foreign_key_violation then
      refused := true;
    end;
    if not refused then
      raise exception '0049 aborted: the FK did NOT refuse an unknown kind';
    end if;
  end if;

  -- and NULL must still be allowed: it is how a human-made task is recognised
  if probe_org is not null then
    begin
      insert into tasks (org_id, title, kind) values (probe_org, '0049 null-kind probe', null);
      -- roll the probe row back out again; it was only ever a check
      delete from tasks where title = '0049 null-kind probe';
    exception when others then
      raise exception '0049 aborted: a NULL kind is no longer accepted';
    end;
  end if;

  raise notice '0049: 7 kinds, FK refuses unknown, NULL still allowed, 0 orphans';
end $$;
