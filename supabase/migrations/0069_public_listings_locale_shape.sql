-- 0069 — the public feed returns `district` and `area` as jsonb, not text.
--
-- A defect in 0066, found the moment the feed had a real row in it and NOT by
-- any test, because every test asserted which KEYS come back and none asserted
-- their SHAPE.
--
-- WHAT IT LOOKED LIKE. `districts.name` and `areas.name` are jsonb — the
-- multilingual `{en, el, ru}` shape every marketing field in this schema uses.
-- 0066 declared them `text` in the return type, so Postgres cast the jsonb to
-- text and the API answered with a STRING CONTAINING ESCAPED JSON, while the
-- other multilingual fields came back as objects:
--
--   title              dict  ->  {"en": "Sea front villa"}
--   short_description  dict  ->  {"en": "..."}
--   district           str   ->  "{\"el\": \"Πάφος\", \"en\": \"Paphos\", ...}"
--   area               str   ->  "{\"el\": \"Πέγεια / Κόραλ Μπέι\", ...}"
--
-- A consumer would have had to JSON.parse() two of the four and not the others,
-- which is the kind of inconsistency that gets worked around once and then
-- depended on forever.
--
-- FIXED NOW BECAUSE NOW IS WHEN IT IS FREE. The first listing was published
-- minutes ago and nothing consumes the feed yet. Once a marketing site parses
-- these as strings, changing the shape becomes a breaking change to somebody
-- else's code.
--
-- THE RETURN TYPE CHANGES, SO THIS IS DROP + CREATE, not create-or-replace:
-- Postgres refuses "cannot change return type of existing function". Both
-- statements are in ONE migration and must be applied in ONE call to hosted —
-- between them the public endpoint 404s at the RPC layer, and there is no
-- reason to widen that gap across two round trips.
--
-- Nothing else changes: same predicate, same 34 columns, same allowlist, same
-- grants restated below because a DROP takes the ACL with it.

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
  -- jsonb, not text (0069): these are the same {en, el, ru} shape as `title`,
  -- and casting them to text handed the caller escaped JSON in a string.
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
  'anything from mandates. Limit is capped at 100 server-side. `title`, '
  '`short_description`, `public_description`, `district` and `area` are all '
  'jsonb {en, el, ru} — district and area were text until 0069, which handed '
  'callers escaped JSON in a string.';

-- A DROP TAKES THE ACL WITH IT. Restated, not assumed — this is the function
-- the open internet reaches.
revoke execute on function public.public_listings(text, int, int) from public;
grant  execute on function public.public_listings(text, int, int) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Prove the shape AND that the drop did not quietly widen or narrow access.
-- ---------------------------------------------------------------------------
do $$
declare
  bad text[];
  n   int;
begin
  -- every multilingual field must be jsonb in the signature
  select array_agg(u.argname order by u.ord) into bad
    from pg_proc pr,
         lateral unnest(pr.proargnames, pr.proargmodes, pr.proallargtypes)
                 with ordinality as u(argname, argmode, argtype, ord)
   where pr.oid = 'public.public_listings(text,int,int)'::regprocedure
     and u.argmode = 't'
     and u.argname in ('title','short_description','public_description','district','area')
     and u.argtype <> 'jsonb'::regtype;

  if bad is not null then
    raise exception '0069: multilingual field(s) not jsonb: %', array_to_string(bad, ', ');
  end if;

  -- the allowlist is still 34 columns — a drop/create is where one goes missing
  select count(*) into n
    from pg_proc pr,
         lateral unnest(pr.proargnames, pr.proargmodes) with ordinality as u(argname, argmode, ord)
   where pr.oid = 'public.public_listings(text,int,int)'::regprocedure
     and u.argmode = 't';
  if n <> 34 then
    raise exception '0069: the feed returns % columns, expected 34', n;
  end if;

  -- and access is exactly as 0066 left it
  if has_function_privilege('public', 'public.public_listings(text,int,int)', 'execute') then
    raise exception '0069: public_listings is executable by PUBLIC';
  end if;
  if not has_function_privilege('anon', 'public.public_listings(text,int,int)', 'execute') then
    raise exception '0069: the DROP lost anon''s grant — the feed would be dead';
  end if;

  raise notice '0069: district and area are jsonb; % columns; anon can execute, PUBLIC cannot.', n;
end $$;
