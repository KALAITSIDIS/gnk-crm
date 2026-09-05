-- 0085 — the adviser's view becomes a field somebody can actually fill in.
--
-- WHY. The marketing site leads each listing with a block headed "Our view" —
-- the firm's own judgement, and the one thing a portal structurally cannot
-- produce, since a portal is paid by whoever lists. That block was rendering
-- the feed's `short_description`, which is a SUMMARY: on PAF0003 it was the
-- first sentence of the paragraph printed directly beneath it. The site stopped
-- claiming it on 2026-09-04 and shows an honest "Summary" heading instead.
--
-- The replacement was a TypeScript file keyed on reference. Wrong place:
-- filling it needs a developer and a deploy, and this firm is two people with
-- no developer. Same defect as property_media.alt, which sat in the schema from
-- 0001 with nothing able to write it — a field the people who own the words
-- cannot reach is a field that stays empty.
--
-- NOT short_description. That column is a one-line summary and doubles as the
-- page's meta description and og:description, where 80-120 words of judgement
-- would be truncated mid-sentence in every search result and shared link.
--
-- THE ALLOWLIST IS THE POINT. public_listings returns a hand-written column
-- list so that adding a column to `properties` does NOT publish it — its own
-- comment says a new field is withheld "until someone edits this function
-- deliberately". This is that edit.
--
-- BUILT FROM 0073, NOT 0069, AND THAT DISTINCTION ALMOST SHIPPED A DISASTER.
-- The first draft of this migration copied 0069's function body, which predates
-- 0073's `images` column — so recreating the function would have silently
-- DELETED every photograph from the public feed, and all three live listings
-- would have rendered "Photography to follow". The count assertion did not
-- catch it: 0069's 34 columns plus adviser_view is 35, which is exactly what
-- the pre-0085 function had, so adding one and dropping one balanced. A COUNT
-- IS NOT A SHAPE. The assertion below therefore checks the count AND names the
-- columns that must still be there.
--
-- Caught by applying to the LOCAL database first and diffing the regenerated
-- types, where `- images: Json` appeared. Nothing else would have shown it.
--
-- THE RETURN TYPE CHANGES, SO THIS IS DROP + CREATE, not create-or-replace, and
-- both statements must reach hosted in ONE call: between them the public
-- endpoint 404s at the RPC layer.

alter table properties
  add column if not exists adviser_view jsonb not null default '{}'::jsonb;

comment on column properties.adviser_view is
  'The firm''s own written view on this property, {en, el, ru}. Public: it is '
  'in the feed allowlist (0085). Distinct from short_description, which is a '
  'summary and serves as the meta description — this is judgement, and the '
  'listing page renders it behind an accent rule under "Our view". Empty means '
  'no view has been written and the page falls back to the summary.';

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
  adviser_view        jsonb,
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
         p.title, p.short_description, p.adviser_view, p.public_description,
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

-- ---------------------------------------------------------------------------
-- Prove the SHAPE, not just the size. 0085's first draft passed a count check
-- while having dropped `images`, because it also added one.
-- ---------------------------------------------------------------------------
do $$
declare
  returned text[];
  missing  text[];
  bad      text[];
begin
  select array_agg(u.argname order by u.ord) into returned
    from pg_proc pr,
         lateral unnest(pr.proargnames, pr.proargmodes) with ordinality as u(argname, argmode, ord)
   where pr.oid = 'public.public_listings(text,int,int)'::regprocedure
     and u.argmode = 't';

  -- (a) every column the site actually consumes is still there, BY NAME
  select array_agg(c) into missing
    from unnest(array[
      'reference','title','short_description','adviser_view','public_description',
      'district','area','asking_price','rent_price_month','images',
      'title_deed_status','construction_status','delivery_date','published_at'
    ]) as c
   where c <> all(returned);
  if missing is not null then
    raise exception '0085: the feed lost column(s): %', array_to_string(missing, ', ');
  end if;

  -- (b) 36 now: 0073's 35 plus adviser_view
  if array_length(returned, 1) <> 36 then
    raise exception '0085: the feed returns % columns, expected 36', array_length(returned, 1);
  end if;

  -- (c) every multilingual field is jsonb, adviser_view included
  select array_agg(u.argname order by u.ord) into bad
    from pg_proc pr,
         lateral unnest(pr.proargnames, pr.proargmodes, pr.proallargtypes)
                 with ordinality as u(argname, argmode, argtype, ord)
   where pr.oid = 'public.public_listings(text,int,int)'::regprocedure
     and u.argmode = 't'
     and u.argname in ('title','short_description','adviser_view','public_description','district','area','images')
     and u.argtype <> 'jsonb'::regtype;
  if bad is not null then
    raise exception '0085: field(s) not jsonb: %', array_to_string(bad, ', ');
  end if;

  -- (d) and the drop did not widen or narrow access
  if has_function_privilege('public', 'public.public_listings(text,int,int)', 'execute') then
    raise exception '0085: public_listings is executable by PUBLIC';
  end if;
  if not has_function_privilege('anon', 'public.public_listings(text,int,int)', 'execute') then
    raise exception '0085: anon lost execute on public_listings';
  end if;

  raise notice '0085: feed carries adviser_view and still carries images (36 columns).';
end $$;
