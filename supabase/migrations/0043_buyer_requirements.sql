-- 0043 — buyer requirements as rows, not as a JSON blob.
--
-- `contacts.preferences` holds ONE unstructured search per contact. A real
-- buyer has several — "2-bed under €300k in Kato Paphos" AND "any plot over
-- 500 m² in Tala" — and a blob can hold neither the plurality nor an index.
-- Matching in either direction (buyer → properties, property → buyers) needs
-- both. Raised by the 2026-08-23 outside review; buyer matching was already
-- Phase 2–3 scope in doc 01 §10, so this needs no new decision.
--
-- WHY NOW rather than later: it is the cheap-now/expensive-later item. Hosted
-- holds 2 contacts. Restructuring criteria today is a migration; at two
-- thousand contacts it is a project with a backfill nobody wants to own.
--
-- THE MATCH SCORE IS NOT STORED, AND THAT IS THE POINT. `quality_score` is
-- stored and carries a standing warning in lib/services/quality-score.ts that
-- changing a weight makes every stored value stale, plus
-- scripts/recompute-scores.mts to repair it. Match scores are computed on read
-- in lib/services/matching.ts, so that failure mode cannot exist here and
-- weights may change freely. There is deliberately no score column below.
--
-- `contacts.preferences` IS NOT DROPPED HERE. It stays until the conversion has
-- been reviewed against real data and no surface reads it; dropping a column in
-- the same migration that introduces its replacement leaves no way back if the
-- conversion is wrong. Removal is a BACKLOG line, not this file's business.
--
-- ARRAYS, NOT JOIN TABLES, for districts/areas/property types. A requirement is
-- read whole, always, and is never joined from the other side; `&&` over a GIN
-- index is exactly the operator matching needs, and three join tables would buy
-- nothing but ceremony.
--
-- PORTAL ROLES: `user_role` carries owner_portal / developer_portal /
-- partner_portal. They are UNUSED — 0 profiles hold one, and doc 04's matrix
-- does not mention them — so the policies below mirror `contacts` (0002)
-- exactly rather than inventing a posture for a role that does not exist yet.
-- This was considered, not overlooked: when those roles are built, `contacts`
-- and `buyer_requirements` must be revisited TOGETHER, because a developer who
-- can read the desk's buyer list is the same leak either way.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

create table if not exists public.buyer_requirements (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id),
  contact_id    uuid not null references public.contacts(id) on delete cascade,

  -- what the desk calls this search, e.g. "Sea view 2-bed, Kato Paphos"
  label         text,
  -- archived rather than deleted: a search that stopped mattering is history,
  -- and the matching sweep reads only the active ones
  is_active     boolean not null default true,

  transaction_type transaction_type not null default 'sale',
  property_types   property_type[] not null default '{}',
  district_ids     uuid[] not null default '{}',
  area_ids         uuid[] not null default '{}',

  currency      text not null default 'EUR',
  budget_min    numeric(14,2),
  budget_max    numeric(14,2),

  bedrooms_min  int,
  bedrooms_max  int,
  bathrooms_min int,
  covered_area_min_sqm numeric(10,2),
  plot_area_min_sqm    numeric(12,2),

  -- Cyprus criteria the desk is actually asked for
  title_deed_required  boolean not null default false,
  vat_preference       vat_status,
  max_sea_distance_m   int,
  delivery_by          date,
  -- keys from lib/constants/features.ts, same vocabulary as properties.features
  features_required    text[] not null default '{}',

  notes         text,
  created_by    uuid references public.profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- A band whose floor is above its ceiling matches nothing and is always a
  -- data-entry slip. The validator catches it first; this is the backstop.
  constraint budget_band_ordered
    check (budget_min is null or budget_max is null or budget_min <= budget_max),
  constraint bedrooms_band_ordered
    check (bedrooms_min is null or bedrooms_max is null or bedrooms_min <= bedrooms_max),
  constraint budget_non_negative
    check ((budget_min is null or budget_min >= 0) and (budget_max is null or budget_max >= 0))
);

create index if not exists buyer_requirements_contact_idx
  on public.buyer_requirements(contact_id);
-- the property → buyers sweep reads active requirements org-wide
create index if not exists buyer_requirements_active_idx
  on public.buyer_requirements(org_id) where is_active;
create index if not exists buyer_requirements_districts_idx
  on public.buyer_requirements using gin (district_ids);
create index if not exists buyer_requirements_areas_idx
  on public.buyer_requirements using gin (area_ids);

alter table public.buyer_requirements enable row level security;

-- REVOKE BEFORE GRANT — 0040's rule, and 0023 documented the same trap before
-- it. Supabase sets default privileges on `public` that fire at CREATE TABLE
-- and `grant` is ADDITIVE, so a migration that only grants ends up with the
-- platform's grants plus its own, invisibly, unless somebody reads `relacl`.
revoke all privileges on table public.buyer_requirements from anon;
revoke all privileges on table public.buyer_requirements from authenticated;

grant select, insert, update, delete on table public.buyer_requirements to authenticated;

-- Mirrors `contacts` (0002), NOT price_lists: a requirement is CRM knowledge
-- about a buyer, so any agent in the org may record and edit one. It carries no
-- price the office has to stand behind, which is what gates unit_types and
-- price_lists to admin/listing_manager.
create policy buyer_requirements_select on public.buyer_requirements for select
  using (org_id = (select public.current_org_id()));

create policy buyer_requirements_insert on public.buyer_requirements for insert
  with check (org_id = (select public.current_org_id()));

create policy buyer_requirements_update on public.buyer_requirements for update
  using (org_id = (select public.current_org_id()))
  with check (org_id = (select public.current_org_id()));

-- DELETE is narrower than UPDATE on purpose. `is_active = false` is the normal
-- way to retire a search and any agent can do it; a hard delete removes the
-- record that a buyer ever wanted this, so it stays with admin and the listing
-- manager. Same shape as unit_types.
create policy buyer_requirements_delete on public.buyer_requirements for delete
  using (org_id = (select public.current_org_id())
         and (select public.current_role_gnk()) in ('admin','listing_manager'));

-- 0029 put a require_aal2 policy on every RLS table so an aal1 session holding
-- a stolen JWT reads nothing. A table created AFTER that migration does NOT get
-- it for free, and rls_aal2_coverage() exists precisely to catch the omission —
-- an RLS test asserts it returns nothing. RESTRICTIVE, ALL, to authenticated,
-- both USING and WITH CHECK: the same shape as every other.
create policy require_aal2 on public.buyer_requirements
  as restrictive for all to authenticated
  using ((select public.mfa_satisfied()))
  with check ((select public.mfa_satisfied()));

do $$
declare
  policies  int;
  uncovered int;
  idx       int;
begin
  select count(*) into policies from pg_policies
   where schemaname = 'public' and tablename = 'buyer_requirements';
  if policies <> 5 then
    raise exception '0043 aborted: expected 5 policies on buyer_requirements (4 + require_aal2), found %', policies;
  end if;

  if has_table_privilege('anon', 'public.buyer_requirements', 'select')
     or has_table_privilege('anon', 'public.buyer_requirements', 'insert')
     or has_table_privilege('anon', 'public.buyer_requirements', 'update')
     or has_table_privilege('anon', 'public.buyer_requirements', 'delete') then
    raise exception '0043 aborted: anon still holds a grant on buyer_requirements';
  end if;

  if not (has_table_privilege('authenticated', 'public.buyer_requirements', 'select')
          and has_table_privilege('authenticated', 'public.buyer_requirements', 'insert')
          and has_table_privilege('authenticated', 'public.buyer_requirements', 'update')
          and has_table_privilege('authenticated', 'public.buyer_requirements', 'delete')) then
    raise exception '0043 aborted: authenticated lost a grant it needs on buyer_requirements';
  end if;

  -- rls_aal2_coverage() returns TABLE(missing_table text) — a SET, not an
  -- array. An earlier draft of this migration asserted array_length() on it and
  -- would have aborted with "function array_length(text, integer) does not
  -- exist"; the plan carried that error and it was caught by reading
  -- pg_get_function_result before writing this file.
  select count(*) into uncovered from public.rls_aal2_coverage();
  if uncovered <> 0 then
    raise exception '0043 aborted: rls_aal2_coverage() lists % table(s)', uncovered;
  end if;

  select count(*) into idx from pg_indexes
   where schemaname = 'public' and tablename = 'buyer_requirements';
  -- 4 declared above + the primary key
  if idx <> 5 then
    raise exception '0043 aborted: expected 5 indexes on buyer_requirements, found %', idx;
  end if;
end $$;

comment on table public.buyer_requirements is
  '0043. One row per saved buyer search; several per contact. Replaces the single '
  'contacts.preferences blob, which is retained until the conversion is reviewed. '
  'Match scores are NOT stored — computed on read in lib/services/matching.ts.';
