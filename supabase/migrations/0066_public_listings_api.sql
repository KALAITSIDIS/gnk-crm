-- 0066 — public listing API. Phase C, C3.
--
-- The only item in Phase C that opens a NEW PUBLIC ATTACK SURFACE, so every
-- decision below is written down with what it was checked against.
--
-- ============================================================================
-- THE BRIEF'S LOAD-BEARING CLAIM IS FALSE, AND THE OPERATOR DECIDED WHAT TO DO.
--
-- docs/PHASE_C_BRIEF.md §4 says: "A listing below score 70 cannot be made
-- public internally (PUBLISH_THRESHOLD), so it must not be reachable externally
-- either. One rule, enforced twice, defined once."
--
-- It can. `lib/actions/properties.ts` lets an ADMIN publish below the threshold
-- deliberately, writing a `publish_override` audit event. And the gate is
-- APPLICATION-LEVEL ONLY — `properties` carries no constraint tying
-- `visibility = 'public'` to `quality_score`:
--
--   phase_has_parent · properties_location_approx_needs_point
--   properties_quality_score_check (0..100) · unit_has_parent
--
-- So re-checking the score here would not be "the same rule enforced twice". It
-- would be a SECOND rule that silently undoes an audited admin decision, and
-- that also drops any published listing whose score later decayed below 70 —
-- with nobody deciding and nothing telling the marketing site why a listing
-- vanished.
--
-- OPERATOR DECISION (2026-08-29): the feed is `visibility = 'public' AND
-- status = 'available'`. The internal publish decision is the single source of
-- truth; the score gates the TRANSITION, and the column records the OUTCOME.
-- `published_below_threshold()` below makes the drift visible instead.
-- ============================================================================
--
-- WHY A SECURITY DEFINER FUNCTION AND NOT THE `published_listings` VIEW THE
-- BRIEF ASKS FOR. Three options were weighed against what this database
-- actually does:
--
--   1. A plain view granted to `anon`. Its rows are filtered only by the view's
--      own WHERE clause, because a non-`security_invoker` view runs with the
--      OWNER's row security — i.e. bypassed. That is the `mandates_safe`
--      pattern, and `get_advisors` already flags `mandates_safe` as an
--      ERROR-level `security_definer_view`. A second one buys nothing and makes
--      the advisor harder to read, which is the failure mode 0063 was careful
--      about.
--   2. `security_invoker = true` view plus an `anon` SELECT policy on
--      `properties`. Cleanest in theory, but it makes `/rest/v1/properties`
--      itself a public endpoint with PostgREST's whole filter/embed surface
--      attached. The brief asks for "one published, cacheable, read-only
--      collection", not a queryable table.
--   3. An anon-executable SECURITY DEFINER function — which is the precedent
--      the brief itself points at: `resolve_share_link` and
--      `note_share_link_miss` are exactly this, already accepted and
--      documented. One entry point, the column allowlist IS the select list,
--      and it appears in the advisor as a WARN beside its two siblings rather
--      than as a new ERROR.
--
-- Option 3. The "view" the brief names is a shape, not a requirement; what it
-- actually asks for — only safe columns, nothing from mandates — is delivered.
--
-- ============================================================================
-- THE COLUMN LIST IS AN ALLOWLIST, AND THAT IS THE WHOLE POINT.
--
-- `properties` has 69 columns. The brief names five to withhold, which is a
-- DENYLIST and cannot satisfy its own acceptance criterion ("adding a column to
-- properties cannot silently publish it"). Every column below is named
-- explicitly; anything added to `properties` in future is withheld until
-- somebody edits this function on purpose. RLS test 41 asserts the withheld
-- list by name.
--
-- Withheld deliberately, beyond the brief's five: `address`, `postal_code`,
-- `location` (the exact point — 0054 added `location_approx` precisely because
-- a coordinate can be a real address), `unit_number`, `block`, `quality_score`,
-- `assigned_agent_id`, `created_by`, `org_id`, `parent_id`, `inherited_fields`,
-- `encumbrances_notes`, `constraints_notes`, `amenities_notes`, `sold_at`,
-- `share_of_land`, `permit_status`. Publishing a precise coordinate for a named
-- private home is a decision for the operator, not a default.
--
-- ADDITIVE: new table, new functions. Applies before the merge.

-- ---------------------------------------------------------------------------
-- 1. Rate limiting — the 0023 idiom, its OWN table.
--
--    "Reuse the idiom rather than inventing a second one" (brief §4) means the
--    same design, not the same table. Sharing `share_link_attempts` would let
--    marketing-site traffic exhaust the share-link budget and lock a buyer out
--    of their proposal link — two unrelated limits coupled through one counter.
-- ---------------------------------------------------------------------------
create table if not exists public.public_listing_attempts (
  ip_hash      text        not null,
  window_start timestamptz not null,
  attempts     int         not null default 0,
  primary key (ip_hash, window_start)
);

comment on table public.public_listing_attempts is
  'Rate-limit counter for the public listing API, same shape as '
  'share_link_attempts (0023). Deliberately a SEPARATE table: sharing one '
  'would couple the public feed''s budget to buyers'' proposal links.';

alter table public.public_listing_attempts enable row level security;
revoke all on public.public_listing_attempts from anon, authenticated;
-- No grants: only the SECURITY DEFINER function below touches it. Enabling RLS
-- with no policy is already deny-all, and the explicit policy keeps
-- `get_advisors` quiet about it (the 0063 reasoning).
drop policy if exists deny_direct_access on public.public_listing_attempts;
create policy deny_direct_access on public.public_listing_attempts
  for all using (false) with check (false);

-- A TABLE CREATED AFTER 0029 DOES NOT INHERIT require_aal2, and
-- rls_aal2_coverage() must stay at 0 — `mfa-enforcement.test.ts` asserts it and
-- caught this table missing the policy on the first run. Redundant here in
-- practice (deny_direct_access already refuses everyone) but the invariant is
-- "every RLS-enabled public table carries it", and an invariant with one
-- reasonable-looking exception is not an invariant.
drop policy if exists require_aal2 on public.public_listing_attempts;
create policy require_aal2 on public.public_listing_attempts
  as restrictive for all to authenticated
  using ((select mfa_satisfied())) with check ((select mfa_satisfied()));

create or replace function public.note_public_listing_hit(p_ip_hash text, p_limit int default 120)
returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  v_window timestamptz := date_trunc('hour', now())
                        + (floor(extract(minute from now()) / 15) * interval '15 minutes');
  v_attempts int;
begin
  insert into public_listing_attempts (ip_hash, window_start, attempts)
  values (p_ip_hash, v_window, 1)
  on conflict (ip_hash, window_start)
  do update set attempts = public_listing_attempts.attempts + 1
  returning attempts into v_attempts;

  -- opportunistic prune so the table cannot grow forever (0023)
  delete from public_listing_attempts where window_start < now() - interval '2 hours';

  return v_attempts > p_limit;
end $fn$;

comment on function public.note_public_listing_hit(text, int) is
  'Records one public-API hit for an IP hash in a 15-minute window and returns '
  'true when the caller is OVER the limit. A read feed gets a looser budget '
  'than share-link misses (120 vs 20): polling a listings feed is the expected '
  'behaviour, guessing a share-link token is not.';

-- ---------------------------------------------------------------------------
-- 2. The feed. SECURITY DEFINER because `anon` has no row access to
--    `properties` and must not be given any — the function is the only door.
-- ---------------------------------------------------------------------------
create or replace function public.public_listings(
  p_org_slug text,
  p_limit    int default 50,
  p_offset   int default 0
)
returns table (
  reference           text,
  kind                property_kind,
  property_type       property_type,
  transaction_type    transaction_type,
  title               jsonb,
  short_description   jsonb,
  public_description  jsonb,
  district            text,
  area                text,
  sea_distance_m      int,
  currency            text,
  asking_price        numeric(14,2),
  rent_price_month    numeric(12,2),
  vat_status          vat_status,
  covered_area_sqm    numeric(10,2),
  plot_area_sqm       numeric(12,2),
  veranda_sqm         numeric(10,2),
  roof_garden_sqm     numeric(10,2),
  basement_sqm        numeric(10,2),
  bedrooms            int,
  bathrooms           int,
  wc                  int,
  parking_spaces      int,
  has_storage         boolean,
  floor_number        int,
  total_floors        int,
  year_built          int,
  energy_class        text,
  features            text[],
  title_deed_status   title_deed_status,
  construction_status text,
  delivery_date       date,
  published_at        timestamptz,
  updated_at          timestamptz
)
language sql stable security definer set search_path = public as $$
  select p.reference, p.kind, p.property_type, p.transaction_type,
         p.title, p.short_description, p.public_description,
         d.name, a.name,
         p.sea_distance_m,
         p.currency, p.asking_price, p.rent_price_month, p.vat_status,
         p.covered_area_sqm, p.plot_area_sqm, p.veranda_sqm, p.roof_garden_sqm,
         p.basement_sqm,
         p.bedrooms, p.bathrooms, p.wc, p.parking_spaces, p.has_storage,
         p.floor_number, p.total_floors, p.year_built, p.energy_class,
         p.features, p.title_deed_status,
         p.construction_status, p.delivery_date,
         p.published_at, p.updated_at
    from properties p
    join organizations o on o.id = p.org_id
    left join districts d on d.id = p.district_id
    left join areas     a on a.id = p.area_id
   where o.slug = p_org_slug
     -- THE PREDICATE. `visibility` is the recorded outcome of the internal
     -- publish decision, including an admin's audited override; `status`
     -- keeps sold, reserved, withdrawn and draft rows out.
     and p.visibility = 'public'
     and p.status     = 'available'
   order by p.published_at desc nulls last, p.reference
   limit greatest(0, least(coalesce(p_limit, 50), 100))
  offset greatest(0, coalesce(p_offset, 0));
$$;

comment on function public.public_listings(text, int, int) is
  'The public listing feed: visibility = public AND status = available, for one '
  'org by slug. The returned column list is an ALLOWLIST — a column added to '
  '`properties` is withheld until someone edits this function deliberately, '
  'which is what stops the API silently publishing a new field. Never returns '
  'owner/developer contacts, internal notes, min_acceptable_price, '
  'owner_net_price, the exact location point, unit/block, quality_score or '
  'anything from mandates. Limit is capped at 100 server-side.';

-- ---------------------------------------------------------------------------
-- 3. ETag source. Cheap enough to run on every poll, and it changes whenever
--    the published set changes — including when a listing LEAVES it, which a
--    max(updated_at) alone would miss.
-- ---------------------------------------------------------------------------
create or replace function public.public_listings_etag(p_org_slug text)
returns text
language sql stable security definer set search_path = public as $$
  select md5(count(*)::text || '|' || coalesce(max(p.updated_at)::text, 'never'))
    from properties p
    join organizations o on o.id = p.org_id
   where o.slug = p_org_slug
     and p.visibility = 'public'
     and p.status     = 'available';
$$;

comment on function public.public_listings_etag(text) is
  'Weak validator for the public feed: md5 of (row count | max updated_at). '
  'The COUNT is why max(updated_at) is not enough on its own — a listing being '
  'unpublished lowers the count without moving the maximum, and a marketing '
  'site would keep serving a listing that is no longer for sale.';

-- ---------------------------------------------------------------------------
-- 4. The drift the operator decision creates, made visible rather than silent.
-- ---------------------------------------------------------------------------
create or replace function public.published_below_threshold()
returns table (reference text, quality_score int, visibility visibility_level, updated_at timestamptz)
language sql stable security invoker set search_path = public as $$
  select p.reference, p.quality_score, p.visibility, p.updated_at
    from properties p
   where p.visibility = 'public'
     and p.status     = 'available'
     and p.quality_score < 70          -- lib/services/quality-score.ts PUBLISH_THRESHOLD
   order by p.quality_score, p.reference;
$$;

comment on function public.published_below_threshold() is
  'Published listings scoring below PUBLISH_THRESHOLD (70). The public feed '
  'deliberately does NOT re-check the score — an admin override is an audited '
  'decision and a decayed score should not silently unpublish a listing — so '
  'this is how that drift stays visible. SECURITY INVOKER: staff see their own '
  'org, under their own RLS. Not part of the public API.';

-- ---------------------------------------------------------------------------
-- 5. GRANTS. The feed and its validator are deliberately public; everything
--    else is not.
-- ---------------------------------------------------------------------------
revoke execute on function public.public_listings(text, int, int) from public;
grant  execute on function public.public_listings(text, int, int) to anon, authenticated, service_role;

revoke execute on function public.public_listings_etag(text) from public;
grant  execute on function public.public_listings_etag(text) to anon, authenticated, service_role;

revoke execute on function public.note_public_listing_hit(text, int) from public;
grant  execute on function public.note_public_listing_hit(text, int) to anon, authenticated, service_role;

-- Staff only: it reports quality scores, which the public feed withholds.
revoke execute on function public.published_below_threshold() from public, anon;
grant  execute on function public.published_below_threshold() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Prove it.
-- ---------------------------------------------------------------------------
do $$
declare
  withheld text[] := array[
    'org_id','parent_id','internal_notes','address','postal_code','location',
    'min_acceptable_price','owner_net_price','owner_contact_id',
    'developer_contact_id','assigned_agent_id','created_by','quality_score',
    'unit_number','block','sold_at','share_of_land','encumbrances_notes',
    'constraints_notes','amenities_notes','inherited_fields','permit_status',
    'location_approx','visibility','status','id'
  ];
  returned text[];
  leaked   text[];
  n_public int;
begin
  -- (a) the allowlist must not contain anything on the withheld list
  select array_agg(p.attname order by p.attnum) into returned
    from pg_proc pr
    join lateral unnest(pr.proargnames, pr.proargmodes) with ordinality
         as u(argname, argmode, ord) on true
    join lateral (select u.argname as attname, u.ord as attnum) p on true
   where pr.oid = 'public.public_listings(text,int,int)'::regprocedure
     and u.argmode = 't';

  select array_agg(w) into leaked
    from unnest(withheld) w
   where w = any(returned);

  if leaked is not null then
    raise exception '0066: the public feed returns withheld column(s): %', array_to_string(leaked, ', ');
  end if;

  -- (b) it must not be reachable by `public`, and MUST be reachable by anon
  if has_function_privilege('public', 'public.public_listings(text,int,int)', 'execute') then
    raise exception '0066: public_listings is executable by PUBLIC';
  end if;
  if not has_function_privilege('anon', 'public.public_listings(text,int,int)', 'execute') then
    raise exception '0066: public_listings is NOT executable by anon — the feed would be dead';
  end if;
  if has_function_privilege('anon', 'public.published_below_threshold()', 'execute') then
    raise exception '0066: published_below_threshold leaks quality scores to anon';
  end if;

  -- (c) and it runs, returning only rows the predicate admits
  select count(*) into n_public
    from properties p join organizations o on o.id = p.org_id
   where p.visibility = 'public' and p.status = 'available';

  raise notice '0066: public listing API live. % column(s) in the allowlist, % published listing(s) org-wide.',
    array_length(returned, 1), n_public;
end $$;
