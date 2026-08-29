-- 0073 — the public feed carries photos, and `published_at` is real (audit
-- 2026-08-29, FEED-1 + DB-02).
--
-- Two defects, one launch-readiness story:
--
--   FEED-1  `public_listings()` returned 34 columns and NO media — a
--           real-estate feed a marketing site cannot render — while the
--           watermarked public WebP renditions already sat in the public
--           `media` bucket. Three audit domains looked straight past it;
--           the completeness critic caught it.
--   DB-02   `properties.published_at` was written by NOTHING (repo-wide
--           grep: only the 0001 DDL and the ORDER BY here), so "newest
--           first" was dead and the feed was effectively alphabetical.
--
-- WHAT THE FEED NOW RETURNS, 35th column `images`: a jsonb ARRAY, cover
-- first then sort order, one object per PHOTO that has finished the
-- rendition pipeline — {thumb, card, full, alt, watermarked}, each path
-- bucket-relative under the public `media` bucket (the API route prefixes
-- the project URL; SQL does not know it). Only `kind = 'photo'`: floor
-- plans and virtual tours stay internal until deliberately wired
-- (audit MEDIA-K). A photo still mid-pipeline (no full rendition) is
-- withheld rather than half-shipped.
--
-- WHAT IT STILL NEVER RETURNS: the ORIGINAL upload — that file keeps its
-- EXIF (GPS included) and lives in the PRIVATE documents bucket; only the
-- stripped renditions are public. The assertion block greps the compiled
-- body for the original-path column name, 0041-style, which is why that
-- name appears nowhere below this header (a substring check cannot tell
-- documentation from SQL — keep the forbidden words OUT of the body).
--
-- `published_at` SEMANTICS, decided here: stamped by the app on every
-- transition INTO `public` (a relisting after months away is genuinely
-- news again), never cleared on unpublish — so the column also answers
-- "when was this last public". The backfill below prefers the audited
-- moment the visibility flip was EVENTED; `updated_at` is the fallback
-- for any public row whose event trail predates the diff shape.
--
-- ETAG: the old validator hashed (count | max updated_at) of the LISTINGS
-- and could not see media at all — adding, removing, reordering or
-- re-covering a photo changed the feed body without moving the validator,
-- and a polling site would cache the stale gallery for as long as nothing
-- else changed. It now folds in a fingerprint of the public listings'
-- photo set (id + sort + cover flag per row), so every media mutation
-- moves it.
--
-- RETURN TYPE CHANGES → DROP + CREATE in ONE call (the 0069 precedent:
-- between the two statements the RPC 404s, so they never split across
-- round trips). A DROP takes the ACL with it; restated and asserted.
--
-- Additive order: hosted BEFORE the merge. Old deployed code passes the
-- function's rows straight through, so the new key simply appears; new
-- code against an un-migrated database only misses images it never
-- promised. RLS test 49 pins the media shape; test 41 keeps the allowlist
-- honest.

-- ---------------------------------------------------------------- backfill --
update public.properties p
   set published_at = coalesce(
     (select max(e.occurred_at)
        from public.events e
       where e.entity_type = 'property'
         and e.entity_id   = p.id
         and e.event_type  = 'updated'
         and e.payload -> 'changed' -> 'visibility' ->> 'to' = 'public'),
     p.updated_at)
 where p.visibility = 'public'
   and p.published_at is null;

-- ------------------------------------------------------------------- feed ---
drop function if exists public.public_listings(text, int, int);

create function public.public_listings(
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
  district            jsonb,
  area                jsonb,
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
  updated_at          timestamptz,
  images              jsonb
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
         p.published_at, p.updated_at,
         -- public renditions only, cover first; a photo without its full
         -- rendition is still mid-pipeline and is withheld
         coalesce((
           select jsonb_agg(jsonb_build_object(
                    'thumb',       m.path_thumb,
                    'card',        m.path_card,
                    'full',        m.path_full,
                    'alt',         m.alt,
                    'watermarked', m.watermarked)
                  order by m.is_cover desc, m.sort_order, m.created_at)
             from property_media m
            where m.property_id = p.id
              and m.kind = 'photo'
              and m.path_full is not null
         ), '[]'::jsonb)
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
  '`properties` is withheld until someone edits this function deliberately. '
  'Never returns owner/developer contacts, internal notes, min_acceptable_price, '
  'owner_net_price, the exact location point, unit/block, quality_score or '
  'anything from mandates. `images` (0073) is a jsonb array, cover first: '
  '{thumb, card, full, alt, watermarked} of PUBLIC-bucket rendition paths, '
  'kind=photo only — never the EXIF-bearing original, which is private. '
  'Multilingual fields are jsonb {en, el, ru} (0069). Limit capped at 100.';

revoke execute on function public.public_listings(text, int, int) from public;
grant  execute on function public.public_listings(text, int, int) to anon, authenticated, service_role;

-- ------------------------------------------------------------------- etag ---
create or replace function public.public_listings_etag(p_org_slug text)
returns text
language sql stable security definer set search_path = public as $$
  select md5(
           count(*)::text
           || '|' || coalesce(max(p.updated_at)::text, 'never')
           || '|' || coalesce((
                select md5(string_agg(
                         m.id::text || ':' || m.sort_order::text || ':' || m.is_cover::text,
                         ',' order by m.property_id, m.is_cover desc, m.sort_order, m.created_at))
                  from property_media m
                  join properties    p2 on p2.id = m.property_id
                  join organizations o2 on o2.id = p2.org_id
                 where o2.slug = p_org_slug
                   and p2.visibility = 'public'
                   and p2.status     = 'available'
                   and m.kind = 'photo'
                   and m.path_full is not null
              ), 'no-media'))
    from properties p
    join organizations o on o.id = p.org_id
   where o.slug = p_org_slug
     and p.visibility = 'public'
     and p.status     = 'available';
$$;

comment on function public.public_listings_etag(text) is
  'Weak validator for the public feed: md5 of (row count | max updated_at | '
  'photo fingerprint). The COUNT catches an unpublish that lowers it without '
  'moving the maximum; the fingerprint (0073: media id + sort + cover per '
  'public listing) catches a photo being added, removed, reordered or '
  're-covered — none of which touch properties.updated_at.';

revoke execute on function public.public_listings_etag(text) from public;
grant  execute on function public.public_listings_etag(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------- prove it --
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
  src      text;
  n        int;
  backfilled int;
begin
  -- (a) the allowlist must not contain anything on the withheld list
  select array_agg(u.argname order by u.ord) into returned
    from pg_proc pr,
         lateral unnest(pr.proargnames, pr.proargmodes) with ordinality
                 as u(argname, argmode, ord)
   where pr.oid = 'public.public_listings(text,int,int)'::regprocedure
     and u.argmode = 't';

  select array_agg(w) into leaked
    from unnest(withheld) w
   where w = any(returned);
  if leaked is not null then
    raise exception '0073: the public feed returns withheld column(s): %', array_to_string(leaked, ', ');
  end if;

  -- (b) exactly 35 columns now, and images is jsonb
  if array_length(returned, 1) <> 35 then
    raise exception '0073: the feed returns % columns, expected 35', array_length(returned, 1);
  end if;
  if not exists (
    select 1
      from pg_proc pr,
           lateral unnest(pr.proargnames, pr.proargmodes, pr.proallargtypes)
                   with ordinality as u(argname, argmode, argtype, ord)
     where pr.oid = 'public.public_listings(text,int,int)'::regprocedure
       and u.argmode = 't' and u.argname = 'images' and u.argtype = 'jsonb'::regtype
  ) then
    raise exception '0073: images is missing or not jsonb';
  end if;

  -- (c) the compiled body must not touch the private original or external
  -- links — the 0041 lesson: a substring check cannot be argued past, which
  -- is why those column names appear only in this block and the header
  select prosrc into src
    from pg_proc where oid = 'public.public_listings(text,int,int)'::regprocedure;
  if src ~ ('storage_path' || '_original') or src ~ ('external' || '_url') then
    raise exception '0073: the feed body references a private media column';
  end if;

  -- (d) ACLs survived the drop/replace
  if has_function_privilege('public', 'public.public_listings(text,int,int)', 'execute') then
    raise exception '0073: public_listings is executable by PUBLIC';
  end if;
  if not has_function_privilege('anon', 'public.public_listings(text,int,int)', 'execute') then
    raise exception '0073: the DROP lost anon''s grant — the feed would be dead';
  end if;
  if not has_function_privilege('anon', 'public.public_listings_etag(text)', 'execute') then
    raise exception '0073: the etag lost anon''s grant — conditional GETs would die';
  end if;

  -- (e) no public listing is left unstamped — the ordering the feed promises
  select count(*) into backfilled
    from properties where visibility = 'public' and published_at is null;
  if backfilled <> 0 then
    raise exception '0073: % public listing(s) still have no published_at', backfilled;
  end if;

  select count(*) into n from properties where visibility = 'public';
  raise notice '0073: feed carries images (35 columns), etag sees media, % public listing(s) all stamped.', n;
end $$;
