-- 0097 — portal feed tokens stored as digests
-- (integrations audit 2026-09-15, INT-10).
--
-- WHY. Share links have stored only sha256(token) since 0023 and resolve by
-- digest; 0095 stored the portal feed token in clear. Every dump, backup and
-- service-role read of `portal_connections` therefore held a live feed URL —
-- and with it, through `portal_supplement`, the exact coordinates of every
-- listing selected for that portal. The route already accepts that the token
-- lives in the URL and in the access log; the database need not be a third
-- copy.
--
-- WHAT CHANGES. `feed_token` becomes `feed_token_sha256`: the app mints the
-- token (lib/services/portals/token.ts), the row holds its digest, and the
-- plaintext exists only in the action's return value, shown once on the
-- settings page. The three anon functions take `p_token_sha256`; the route
-- hashes the path token once and passes the digest. A parameter cannot be
-- renamed with `create or replace`, hence drop and create — and the 0095
-- grants are restated because a drop takes the ACL with it.
--
-- NULLABLE, on purpose. A connection created by saving contact details before
-- the switch is flipped has no token yet; the switch is where the URL is
-- born (setPortalEnabled mints when the digest is null). A null digest
-- matches no lookup. Every row that exists at apply time carries a token, so
-- the backfill leaves none null.

-- ---------------------------------------------------------------------------
-- 1. The column: add, backfill from the plaintext, then drop the plaintext
-- ---------------------------------------------------------------------------
alter table public.portal_connections
  add column feed_token_sha256 text
  constraint portal_connections_feed_token_sha256_chk check (feed_token_sha256 ~ '^[0-9a-f]{64}$');

update public.portal_connections
   set feed_token_sha256 = encode(digest(feed_token, 'sha256'), 'hex');

alter table public.portal_connections
  add constraint portal_connections_feed_token_sha256_key unique (feed_token_sha256);

alter table public.portal_connections drop column feed_token;

comment on column public.portal_connections.feed_token_sha256 is
  'sha256 of the feed token (0097). The token itself is never stored: it is '
  'minted by the app, shown once, and lives in the portal''s crawler config. '
  'Null until the portal is first enabled.';

comment on table public.portal_connections is
  'One row per organisation per external portal (0095, token hashed 0097). '
  'enabled + feed_token_sha256 gate the pull feed; settings is the dialect''s '
  'contact block; last_pull* are written by the feed route on every pull.';

-- ---------------------------------------------------------------------------
-- 2. The three anon-callable functions, taking the digest
-- ---------------------------------------------------------------------------
drop function public.portal_connection_by_token(text, text);
drop function public.portal_supplement(text);
drop function public.note_portal_pull(text, text, int);

create function public.portal_connection_by_token(p_portal text, p_token_sha256 text)
returns table (org_slug text, enabled boolean, settings jsonb)
language sql stable security definer set search_path = public as $$
  select o.slug, c.enabled, c.settings
    from portal_connections c
    join organizations o on o.id = c.org_id
   where c.portal = p_portal
     and c.feed_token_sha256 = p_token_sha256
$$;

create function public.portal_supplement(p_token_sha256 text)
returns table (
  reference       text,
  lat             double precision,
  lng             double precision,
  location_approx boolean,
  images          jsonb
)
language sql stable security definer set search_path = public as $$
  -- The point of an approximate listing is withheld HERE, not left to a
  -- renderer: 0054's flag means "never publish this as the property's
  -- location" (the app stores an area centroid under it, but nothing in the
  -- schema stops an import or a direct write from flagging a surveyed point),
  -- and this function is reachable by anyone holding the token over
  -- PostgREST, so a renderer's own check is belt-and-braces. The flag still
  -- goes out so the assembler and the UI know why. A dialect that wants an
  -- approximate pin (RERA's show_approximate_location) must take the centroid
  -- from areas/districts, never this column.
  select p.reference,
         case when p.location_approx then null else st_y(p.location::geometry) end,
         case when p.location_approx then null else st_x(p.location::geometry) end,
         p.location_approx,
         coalesce((
           select jsonb_agg(jsonb_build_object('jpeg', m.path_jpeg, 'alt', m.alt)
                            order by m.is_cover desc, m.sort_order, m.created_at)
             from property_media m
            where m.property_id = p.id
              and m.kind = 'photo'
              and m.path_jpeg is not null
         ), '[]'::jsonb)
    from portal_connections c
    join portal_listings pl on pl.org_id = c.org_id and pl.portal = c.portal
    -- belt to the composite FK's braces: the org is re-checked on the way out,
    -- so this function cannot serve another tenant's property even if the
    -- constraint were ever dropped
    join properties p on p.id = pl.property_id and p.org_id = c.org_id
   where c.feed_token_sha256 = p_token_sha256
     and c.enabled
     -- the site feed's predicate (0088 public_listings), pinned together by portals.test.ts
     and p.visibility = 'public'
     and p.status     = 'available'
$$;

create function public.note_portal_pull(p_token_sha256 text, p_ua text, p_count int)
returns void
language sql volatile security definer set search_path = public as $$
  -- No `and enabled`: a disabled connection still records pulls — that the
  -- portal keeps hitting an empty feed is worth seeing on the settings page.
  update portal_connections
     set last_pulled_at  = now(),
         last_pulled_ua  = left(coalesce(p_ua, ''), 200),
         last_pull_count = greatest(0, coalesce(p_count, 0))
   where feed_token_sha256 = p_token_sha256
$$;

-- The feed is public by design (spec §Decisions); everything else stays off.
revoke execute on function public.portal_connection_by_token(text, text) from public;
grant  execute on function public.portal_connection_by_token(text, text) to anon, authenticated, service_role;
revoke execute on function public.portal_supplement(text) from public;
grant  execute on function public.portal_supplement(text) to anon, authenticated, service_role;
revoke execute on function public.note_portal_pull(text, text, int) from public;
grant  execute on function public.note_portal_pull(text, text, int) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Self-check — asserted, not trusted
-- ---------------------------------------------------------------------------
do $$
declare
  v_null_digests int;
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'portal_connections' and column_name = 'feed_token'
  ) then
    raise exception '0097: the plaintext feed_token column survived';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'portal_connections' and column_name = 'feed_token_sha256'
  ) then
    raise exception '0097: feed_token_sha256 is missing';
  end if;
  select count(*) into v_null_digests from public.portal_connections where feed_token_sha256 is null;
  if v_null_digests > 0 then
    raise exception '0097: % connection(s) lost their token in the backfill', v_null_digests;
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('portal_connection_by_token', 'portal_supplement', 'note_portal_pull')
       and pg_get_function_arguments(p.oid) like '%p_token %'
  ) then
    raise exception '0097: a function still takes the plaintext token';
  end if;
  if not has_function_privilege('anon', 'public.portal_connection_by_token(text,text)', 'execute')
     or not has_function_privilege('anon', 'public.portal_supplement(text)', 'execute')
     or not has_function_privilege('anon', 'public.note_portal_pull(text,text,int)', 'execute') then
    raise exception '0097: anon lost execute on a portal function — every pull would 404';
  end if;
end $$;
