-- 0039 — unit type templates: define a layout once, stamp it onto many units.
--
-- BACKLOG proposal, follow-on to the bulk generator. A real project sells four
-- or five layouts repeated across every floor — "A1, two-bed corner, 85 m²" —
-- and the generator currently makes the desk retype beds, baths and area for
-- each block, then price every unit by hand.
--
-- A TYPE IS A STAMP, NOT AN INHERITANCE LINK, and that is deliberate. Bedrooms,
-- area and price are listed in `DELIBERATELY_NOT_INHERITED` (0035's service)
-- precisely because they are the unit's own: two units of the same layout can
-- diverge legitimately — one gets a bigger veranda, one is repriced for a view.
-- Applying a type COPIES its values; it does not bind the unit to them, and
-- there is deliberately no drift panel for types.
--
-- Scoped to a project rather than the org. Layout codes are a project's own
-- vocabulary — every developer has an "A1" and they are not the same flat.
--
-- PRICE IS COMPUTED FROM COVERED AREA ONLY. Veranda is recorded on the type but
-- not priced, because how a desk prices a veranda (half rate, quarter, not at
-- all) is a commercial decision that varies by project — inventing a convention
-- here would put a wrong number on a quote. `price_per_sqm` is labelled as
-- covered-area rate in the UI and the computed price stays editable.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

create table if not exists public.unit_types (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id),
  project_id    uuid not null references public.properties(id) on delete cascade,
  code          text not null,
  name          text,
  bedrooms      int,
  bathrooms     int,
  covered_area_sqm numeric(10,2),
  veranda_sqm      numeric(10,2),
  -- rate applied to COVERED area only; see the note above
  price_per_sqm    numeric(10,2),
  created_by    uuid references public.profiles(id),
  created_at    timestamptz not null default now(),
  unique (project_id, code)
);

create index if not exists unit_types_project_idx on public.unit_types(project_id);

alter table public.unit_types enable row level security;

grant select, insert, update, delete on public.unit_types to authenticated;

-- Mirrors price_lists exactly (0002): everyone in the org reads, admins and
-- listing managers write. A type carries a price rate, and a price rate is not
-- an agent's to set for a project.
create policy unit_types_select on public.unit_types for select
  using (org_id = current_org_id());
create policy unit_types_insert on public.unit_types for insert
  with check (org_id = current_org_id() and current_role_gnk() in ('admin','listing_manager'));
create policy unit_types_update on public.unit_types for update
  using (org_id = current_org_id() and current_role_gnk() in ('admin','listing_manager'))
  with check (org_id = current_org_id());
create policy unit_types_delete on public.unit_types for delete
  using (org_id = current_org_id() and current_role_gnk() in ('admin','listing_manager'));

-- 0029 put a require_aal2 policy on every RLS table so an aal1 session holding
-- a stolen JWT reads nothing. A table created AFTER that migration does not get
-- it for free, and `rls_aal2_coverage()` exists precisely to catch the omission
-- — an RLS test asserts it returns empty. Same shape as every other: RESTRICTIVE,
-- ALL, to authenticated, both USING and WITH CHECK.
create policy require_aal2 on public.unit_types
  as restrictive for all to authenticated
  using ((select public.mfa_satisfied()))
  with check ((select public.mfa_satisfied()));

do $$
declare
  policies int;
  uncovered text[];
begin
  select count(*) into policies from pg_policies
   where schemaname = 'public' and tablename = 'unit_types';
  if policies <> 5 then
    raise exception '0039 aborted: expected 5 policies on unit_types (4 + require_aal2), found %', policies;
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.unit_types'::regclass) then
    raise exception '0039 aborted: RLS is not enabled on unit_types';
  end if;

  -- 0029 put require_aal2 on every RLS table; a new one must not be the gap.
  -- Checked rather than assumed: a table added after that migration does not
  -- get it for free, and "all 29 RLS tables" is a claim HANDOFF makes.
  -- the whole point of the check above: prove the new table did not become the
  -- one gap in 2FA enforcement, using the repo's own coverage function
  select array_agg(t) into uncovered from public.rls_aal2_coverage() t;
  if uncovered is not null then
    raise exception '0039 aborted: table(s) missing require_aal2: %', uncovered;
  end if;

  raise notice '0039 ok: unit_types created, 4 policies + require_aal2, aal2 coverage still complete';
end $$;
