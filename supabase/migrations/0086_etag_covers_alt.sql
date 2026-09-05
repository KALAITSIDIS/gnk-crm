-- 0086 — the feed's validator now sees the one part of a photograph a person
-- can edit.
--
-- WHY. `public_listings_etag` is the weak validator behind the feed's ETag, and
-- /api/public/listings answers a matching If-None-Match with 304 and NO BODY.
-- A validator is a promise: identical etag means identical body. Since 0073 it
-- has hashed (row count | max properties.updated_at | a fingerprint of the
-- photo set), and 0073's own comment states the property that made it correct —
-- "every media mutation moves it".
--
-- That sentence stopped being true in the same batch that shipped 0085.
-- `setMediaAlt` gave the alt text its first write path (it had been in the
-- schema since 0001 with nothing able to fill it, which is why every photograph
-- read `alt: {}`), and 0085 serves that alt INSIDE the feed body. So there is
-- now a sixth media mutation, it changes what the endpoint returns, and the
-- validator cannot see it:
--
--   * the fingerprint hashes id + sort_order + is_cover — not alt;
--   * the row count and max(updated_at) are over `properties`, and setMediaAlt
--     writes only `property_media`. It is the ONE media action that does not
--     call recomputeQualityScore, which is what incidentally moves
--     properties.updated_at for upload / set-cover / delete.
--
-- So an operator corrects the description on a published photograph, every
-- input to the hash is unchanged, and any cache that revalidates conditionally
-- is told "Not Modified" — renewing its freshness every 60s while serving the
-- previous text, indefinitely.
--
-- WHAT IS AND IS NOT AT RISK TODAY. The only consumer, gnk-web, fetches with
-- `next: { revalidate: 60 }` and sends no If-None-Match at all, so nothing is
-- currently stale anywhere; and the payload is alt text, which is accessibility
-- and SEO rather than price or availability. This is a validator that would lie
-- rather than one that is lying. It is fixed here anyway, because the endpoint's
-- OPTIONS response advertises If-None-Match to any client that cares to use it,
-- and a public API's promise about its own freshness is not a thing to leave
-- knowingly false until someone takes it up.
--
-- CREATE OR REPLACE, not drop + create: the signature is unchanged, so the ACL
-- survives (0069's lesson is about the RETURN TYPE changing). Grants are
-- restated and asserted regardless — cheap, and the restore pack pins them.
--
-- Either deploy order is safe. The function is only ever called by the feed
-- route, which passes the result straight through as an opaque string; old code
-- against the new function simply gets a different opaque string, which is what
-- a changed validator is supposed to be.

-- ------------------------------------------------------------------- etag ---
-- 0085's body, with `alt` folded into the per-photo fingerprint. Hashed rather
-- than concatenated raw so a 300-character description in three languages costs
-- 32 characters per row instead of 900.
create or replace function public.public_listings_etag(p_org_slug text)
returns text
language sql stable security definer set search_path = public as $$
  select md5(
           count(*)::text
           || '|' || coalesce(max(p.updated_at)::text, 'never')
           || '|' || coalesce((
                select md5(string_agg(
                         m.id::text || ':' || m.sort_order::text || ':' || m.is_cover::text
                           || ':' || md5(coalesce(m.alt::text, '')),
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
  'public listing; 0086: + a hash of alt, which 0085 serves in the feed body '
  'and setMediaAlt made editable) catches a photo being added, removed, '
  'reordered, re-covered or REDESCRIBED — none of which touch '
  'properties.updated_at. Every field the feed publishes from property_media '
  'is now covered; a field added to the images jsonb must be added here too.';

revoke execute on function public.public_listings_etag(text) from public;
grant  execute on function public.public_listings_etag(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------- prove it --
do $$
declare
  body        text;
  acl         text;
  probe_org   text;
  probe_media uuid;
  before_etag text;
  after_etag  text;
begin
  -- (a) the compiled body really reads alt. 0041's idiom: assert against what
  --     the database stored, not against what this file says.
  select prosrc into body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'public_listings_etag';
  if body is null then
    raise exception '0086 aborted: public_listings_etag is not there at all';
  end if;
  if position('m.alt' in body) = 0 then
    raise exception '0086 aborted: the compiled body does not reference m.alt';
  end if;

  -- (b) create-or-replace preserves the ACL, and the restore pack pins this
  --     function's grants as one of the deliberate anon surfaces. Prove the
  --     shape rather than assuming the replace was harmless.
  select array_to_string(proacl, ',') into acl
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'public_listings_etag';
  if acl is null or position('anon=X' in acl) = 0 then
    raise exception '0086 aborted: anon lost EXECUTE — the public feed cannot validate';
  end if;
  if position('=X/' in acl) > 0 and position('anon=X' in acl) = 0 then
    raise exception '0086 aborted: unexpected ACL shape %', acl;
  end if;

  -- (c) THE PROMISE ITSELF: change an alt, and the validator must move.
  --     A body assertion proves the column is mentioned; only this proves the
  --     hash actually depends on it.
  select o.slug, m.id into probe_org, probe_media
    from property_media m
    join properties     p2 on p2.id = m.property_id
    join organizations  o  on o.id  = p2.org_id
   where p2.visibility = 'public'
     and p2.status     = 'available'
     and m.kind = 'photo'
     and m.path_full is not null
   order by m.created_at
   limit 1;

  if probe_media is not null then
    -- Subtransaction, rolled back. property_media is not hash-chained, but this
    -- runs against a database holding REAL client listings and a migration has
    -- no business leaving a word of its own on a published photograph.
    -- PL/pgSQL variables are memory, so the two etags survive the unwind.
    begin
      before_etag := public.public_listings_etag(probe_org);
      update property_media
         set alt = jsonb_build_object('en', '0086 probe — rolled back')
       where id = probe_media;
      after_etag := public.public_listings_etag(probe_org);
      raise exception using errcode = 'GNK86', message = '0086 probe rollback';
    exception when sqlstate 'GNK86' then
      null; -- expected — the rollback IS the point
    end;

    if before_etag = after_etag then
      raise exception '0086 aborted: the validator did not move when an alt changed (%)', before_etag;
    end if;
    raise notice '0086: etag now covers alt — PROVEN on a real photograph (% -> %, probe rolled back)',
      left(before_etag, 8), left(after_etag, 8);
  else
    -- Say which it was. CI applies migrations to a fresh database with no
    -- published photograph, and a notice claiming a pass would be a claim with
    -- nothing behind it. RLS test 56 covers it unconditionally.
    raise notice '0086: etag now covers alt; the moves-when-alt-changes probe SKIPPED (no published photograph on this database) — RLS test 56 covers it';
  end if;
end $$;
