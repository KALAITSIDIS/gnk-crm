-- 0088 — one hosted apply for three findings of the 2026-09-06 audit
-- (docs/AUDIT_2026-09-06_RESPONSE.md, Next #4): the feed answers for one
-- reference, property_media is tenant-safe by construction, and a photograph
-- carries a content hash so the desk can see when one is used twice.
--
-- ADDITIVE. Hosted apply BEFORE the merge (the additive rule; 0055/0057 is the
-- other order and applies to revokes). Every deployed caller keeps working
-- against this schema: `public_listings` gains a DEFAULTED fourth parameter,
-- and PostgREST resolves a three-argument call to it; the new FK admits every
-- row the old one admitted (preflight below); the new column is nullable.
--
-- 1. p_reference. The site's listing page reads the WHOLE feed and finds one
--    row in it — every page view of PAF0001 fetched every published listing
--    (all pages, since gnk-web Now #5). One parameter lets it ask for one.
--    Case-insensitive, because the site matches case-insensitively and then
--    redirects to the canonical spelling; the feed must find what the site
--    finds. DROP+CREATE because the signature changes; the returned column
--    list is the SAME allowlist, and the prove-it block below pins it by name
--    and count exactly as 0085 did — it is still one allowlist.
--
-- 2. Composite tenant FK (A03). property_media.org_id and property_id were two
--    independent foreign keys, so a row could name org B and a property of
--    org A and both FKs would be satisfied. RLS on property_media keys on
--    org_id; such a row is visible to the wrong tenant. Nothing in the app
--    writes it (every insert copies org_id from the property it just read),
--    and this database has one organization — but a guarantee that rests on
--    every future insert path being careful is not a guarantee.
--    (org_id, property_id) → properties (org_id, id) makes the pair a fact the
--    database checks. A UNIQUE on properties (org_id, id) is the referenced
--    side; id is already the primary key, so it costs an index and nothing
--    else. The other nine tenant tables are the "composite tenant FK sweep"
--    in the response's Later section, gated on a second organization.
--
-- 3. content_sha256. A photograph's bytes, hashed at upload, so "this picture
--    is already on another listing" becomes a fact the quality worklist can
--    state (the 2026-09-06 review found a stock image reused; A07's cousin).
--    WARN, NEVER BLOCK: a development's units legitimately share exteriors,
--    so the score does not move — the worklist names the other reference and
--    a person decides. Nullable: rows uploaded before this have no hash until
--    scripts/media/backfill-hashes.mjs computes it from the original.
--
-- NOT HERE: F3's computed container columns (units_available, price_from,
-- price_to) — gated on PAF0002's units being ready to publish, which they are
-- not; the response's Later section keeps them.

-- ---------------------------------------------------------------------------
-- 1. The feed, with p_reference. Body identical to 0085's but for one predicate.
-- ---------------------------------------------------------------------------
drop function if exists public.public_listings(text, int, int);

create function public.public_listings(
  p_org_slug  text,
  p_limit     int  default 50,
  p_offset    int  default 0,
  p_reference text default null
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
     -- 0088: one listing by reference, case-insensitively — the site matches
     -- that way and then redirects to the canonical spelling. Null = the feed.
     and (p_reference is null or upper(p.reference) = upper(btrim(p_reference)))
   order by p.published_at desc nulls last, p.reference
   limit greatest(0, least(coalesce(p_limit, 50), 100))
  offset greatest(0, coalesce(p_offset, 0));
$$;

comment on function public.public_listings(text, int, int, text) is
  'The public listing feed: visibility = public AND status = available, for one '
  'org by slug. The returned column list is an ALLOWLIST — a column added to '
  '`properties` is withheld until someone edits this function deliberately. '
  'Never returns owner/developer contacts, internal notes, min_acceptable_price, '
  'owner_net_price, the exact location point, unit/block, quality_score or '
  'anything from mandates. `images` (0073) is a jsonb array, cover first: '
  '{thumb, card, full, alt, watermarked} of PUBLIC-bucket rendition paths, '
  'kind=photo only — never the EXIF-bearing original, which is private. '
  'Multilingual fields are jsonb {en, el, ru} (0069). Limit capped at 100. '
  'p_reference (0088) narrows to one listing, case-insensitively; null is the feed.';

revoke execute on function public.public_listings(text, int, int, text) from public;
grant  execute on function public.public_listings(text, int, int, text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. The composite tenant FK on property_media.
-- ---------------------------------------------------------------------------
do $$
declare n int;
begin
  select count(*) into n
    from property_media m
    join properties p on p.id = m.property_id
   where p.org_id <> m.org_id;
  if n > 0 then
    raise exception '0088 aborted: % property_media row(s) name a different org than their property — decide before constraining', n;
  end if;
end $$;

alter table properties
  add constraint properties_org_id_id_key unique (org_id, id);

alter table property_media
  drop constraint property_media_property_id_fkey;

alter table property_media
  add constraint property_media_org_property_fkey
    foreign key (org_id, property_id) references properties (org_id, id) on delete cascade;

comment on constraint property_media_org_property_fkey on property_media is
  '0088: a media row belongs to the org its property belongs to, by construction. '
  'Replaces the single-column FK on property_id; org_id still references '
  'organizations(id) as well.';

-- ---------------------------------------------------------------------------
-- 3. content_sha256.
-- ---------------------------------------------------------------------------
alter table property_media
  add column if not exists content_sha256 text
    check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$');

comment on column property_media.content_sha256 is
  '0088: sha256 of the ORIGINAL upload bytes, hex, computed at upload. Null for '
  'rows uploaded before 0088 until scripts/media/backfill-hashes.mjs fills them. '
  'Read by the quality worklist to say "this photograph is also on <reference>" '
  '— a warning, never a score change: a development''s units share exteriors.';

create index if not exists property_media_org_sha256_idx
  on property_media (org_id, content_sha256)
  where content_sha256 is not null;

-- ---------------------------------------------------------------- prove it --

-- (1) The allowlist: same 36 names, every consumed column present, jsonb where
--     it must be, access unchanged — 0085's block against the new signature.
do $$
declare
  returned text[];
  missing  text[];
  bad      text[];
begin
  select array_agg(u.argname order by u.ord) into returned
    from pg_proc pr,
         lateral unnest(pr.proargnames, pr.proargmodes) with ordinality as u(argname, argmode, ord)
   where pr.oid = 'public.public_listings(text,int,int,text)'::regprocedure
     and u.argmode = 't';

  select array_agg(c) into missing
    from unnest(array[
      'reference','title','short_description','adviser_view','public_description',
      'district','area','asking_price','rent_price_month','images',
      'title_deed_status','construction_status','delivery_date','published_at'
    ]) as c
   where c <> all(returned);
  if missing is not null then
    raise exception '0088 aborted: the feed lost column(s): %', array_to_string(missing, ', ');
  end if;

  if array_length(returned, 1) <> 36 then
    raise exception '0088 aborted: the feed returns % columns, expected 36', array_length(returned, 1);
  end if;

  select array_agg(u.argname order by u.ord) into bad
    from pg_proc pr,
         lateral unnest(pr.proargnames, pr.proargmodes, pr.proallargtypes)
                 with ordinality as u(argname, argmode, argtype, ord)
   where pr.oid = 'public.public_listings(text,int,int,text)'::regprocedure
     and u.argmode = 't'
     and u.argname in ('title','short_description','adviser_view','public_description','district','area','images')
     and u.argtype <> 'jsonb'::regtype;
  if bad is not null then
    raise exception '0088 aborted: field(s) not jsonb: %', array_to_string(bad, ', ');
  end if;

  if has_function_privilege('public', 'public.public_listings(text,int,int,text)', 'execute') then
    raise exception '0088 aborted: public_listings is executable by PUBLIC';
  end if;
  if not has_function_privilege('anon', 'public.public_listings(text,int,int,text)', 'execute') then
    raise exception '0088 aborted: anon lost execute on public_listings';
  end if;
  if exists (select 1 from pg_proc where proname = 'public_listings' and pronamespace = 'public'::regnamespace and pronargs = 3) then
    raise exception '0088 aborted: the three-argument public_listings still exists — two overloads would be two allowlists';
  end if;
end $$;

-- (2) The FK refuses a cross-org media row, and the probe leaves nothing
--     behind: everything it inserts lives inside a sub-block that is rolled
--     back by the very exception it is looking for.
do $$
declare
  v_org_a uuid;
  v_ok    boolean := false;
begin
  select id into v_org_a from organizations order by created_at limit 1;
  if v_org_a is null then
    raise notice '0088: no organization on this database — the FK probe is covered by RLS test 58';
    return;
  end if;
  begin
    declare
      v_org_b uuid;
      v_prop  uuid;
    begin
      insert into organizations (name, slug)
        values ('0088 probe (rolled back)', '0088-probe-' || replace(gen_random_uuid()::text, '-', ''))
        returning id into v_org_b;
      insert into properties (org_id, reference, property_type, visibility, status)
        values (v_org_a, 'ZZZ0088-probe', 'apartment', 'private', 'draft')
        returning id into v_prop;
      -- org B's row pointing at org A's property: both single-column FKs
      -- would have accepted this
      insert into property_media (org_id, property_id, kind)
        values (v_org_b, v_prop, 'photo');
      raise exception using errcode = 'P0088', message = '0088 probe: a cross-org media row was ACCEPTED';
    exception
      when foreign_key_violation then
        v_ok := true;   -- refused, and the sub-block's inserts are gone
      when sqlstate 'P0088' then
        v_ok := false;  -- accepted, and the sub-block's inserts are gone too
    end;
  end;
  if not v_ok then
    raise exception '0088 aborted: the composite FK did not refuse a cross-org media row';
  end if;
  if exists (select 1 from properties where reference = 'ZZZ0088-probe') then
    raise exception '0088 aborted: the probe left a property behind';
  end if;
end $$;

-- (3) The hash column exists, its shape check is attached, and the check
--     refuses an ill-shaped value — probed on a row that the sub-block
--     inserts and the violation rolls back, never on a real one.
do $$
declare
  v_org uuid;
  v_ok  boolean := false;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'property_media' and column_name = 'content_sha256'
  ) then
    raise exception '0088 aborted: content_sha256 is missing';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.property_media'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) like '%content_sha256%[0-9a-f]{64}%'
  ) then
    raise exception '0088 aborted: the content_sha256 shape check is not attached';
  end if;
  select id into v_org from organizations order by created_at limit 1;
  if v_org is null then
    raise notice '0088: no organization on this database — the shape probe is covered by RLS test 58';
    return;
  end if;
  begin
    declare v_prop uuid;
    begin
      insert into properties (org_id, reference, property_type, visibility, status)
        values (v_org, 'ZZZ0088-hash', 'apartment', 'private', 'draft')
        returning id into v_prop;
      insert into property_media (org_id, property_id, kind, content_sha256)
        values (v_org, v_prop, 'photo', 'not-a-hash');
      raise exception using errcode = 'P0088', message = '0088 probe: an ill-shaped hash was ACCEPTED';
    exception
      when check_violation then v_ok := true;
      when sqlstate 'P0088' then v_ok := false;
    end;
  end;
  if not v_ok then
    raise exception '0088 aborted: the content_sha256 shape check did not refuse an ill-shaped value';
  end if;
  if exists (select 1 from properties where reference = 'ZZZ0088-hash') then
    raise exception '0088 aborted: the hash probe left a property behind';
  end if;
end $$;
