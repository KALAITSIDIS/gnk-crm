-- =============================================================================
-- 0095 — portal syndication: where a listing is advertised beyond the site
--        (docs/superpowers/specs/2026-09-14-portal-syndication-design.md)
--
-- WHAT THIS ADDS. Two tables and three anon-callable functions so that an
-- external portal can PULL a feed of exactly the listings the desk selected
-- for it, and one column so those feeds can hand out JPEG photographs.
--
--   portal_connections  one row per org per portal: enabled, a random feed
--                       token that IS the URL, non-secret settings, and the
--                       "last pulled" facts the route writes. Admin-write.
--   portal_listings     one row per listing per portal: selected by whom,
--                       when. Deselecting deletes the row; the events chain
--                       keeps the history. Writable by whoever may edit the
--                       listing (same rule as properties_update).
--   property_media.path_jpeg   a fourth rendition (1600 px JPEG), because
--                       RERA accepts JPEG/PNG only and four other portals
--                       leave the format undocumented. Null until backfilled.
--
-- THE PREDICATE IS THE SITE'S. portal_supplement() answers only for selected
-- rows that public_listings() would show (visibility public, status
-- available) — copied here rather than referenced because a SECURITY DEFINER
-- function cannot call the other's row filter, and RLS test portals.test.ts
-- pins the two together. So "on a portal" ⊆ "on the site", and a sale,
-- withdrawal or archive leaves every portal at its next pull.
--
-- COORDINATES LEAVE HERE AND NOWHERE ELSE. public_listings() carries none;
-- this function returns them for selected listings only, with the approx
-- flag the dialects honour (an approximate location is never emitted as an
-- exact point — spec §Coordinates).
--
-- public_listings() and public_listings_etag() are untouched: the site feed
-- stays byte-identical and RLS test 41's 36-column pin stays true.
--
-- Additive: apply to hosted BEFORE the merge.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. portal_connections
-- ---------------------------------------------------------------------------
create table if not exists public.portal_connections (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  -- a registry id (lib/services/portals/registry.ts PORTAL_ID_PATTERN); the shape is pinned here, the list there
  portal           text not null check (portal ~ '^[a-z_]{2,40}$'),
  enabled          boolean not null default false,
  -- the URL's secret: 32 random bytes as hex. Rotated by setting a new value, never null.
  feed_token       text not null unique default encode(gen_random_bytes(32), 'hex')
                   check (feed_token ~ '^[0-9a-f]{64}$'),
  -- non-secret per-portal fields (contact number, e-mail); validated by the registry's schema on write
  settings         jsonb not null default '{}'::jsonb,
  last_pulled_at   timestamptz,
  last_pulled_ua   text,
  last_pull_count  int,
  -- milestone 3: the JamesEdition leads pull's upper bound
  leads_pulled_to  timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  updated_by       uuid references public.profiles(id) on delete set null,
  unique (org_id, portal)
);
comment on table public.portal_connections is
  'One row per organisation per external portal (0095). enabled + feed_token '
  'make the pull URL /api/portals/<portal>/<token>; settings holds the '
  'portal''s non-secret fields; the last_pull* columns are written by the '
  'route on every pull. Secrets (a leads API token) live in the Vercel '
  'environment, never here.';

drop trigger if exists portal_connections_updated_at on public.portal_connections;
create trigger portal_connections_updated_at
  before update on public.portal_connections
  for each row execute function set_updated_at();

alter table public.portal_connections enable row level security;
revoke all privileges on table public.portal_connections from anon;
revoke all privileges on table public.portal_connections from authenticated;
-- No DELETE: a portal is disabled, not forgotten (its token would otherwise
-- come back different and the portal would be pointed at a dead URL).
grant select, insert, update on table public.portal_connections to authenticated;

drop policy if exists portal_connections_select on public.portal_connections;
create policy portal_connections_select on public.portal_connections for select
  using (org_id = (select public.current_org_id()));
drop policy if exists portal_connections_insert on public.portal_connections;
create policy portal_connections_insert on public.portal_connections for insert
  with check (org_id = (select public.current_org_id())
              and (select public.current_role_gnk()) = 'admin');
drop policy if exists portal_connections_update on public.portal_connections;
create policy portal_connections_update on public.portal_connections for update
  using (org_id = (select public.current_org_id())
         and (select public.current_role_gnk()) = 'admin')
  with check (org_id = (select public.current_org_id())
              and (select public.current_role_gnk()) = 'admin');
-- A TABLE CREATED AFTER 0029 DOES NOT INHERIT require_aal2; rls_aal2_coverage() must stay at 0.
drop policy if exists require_aal2 on public.portal_connections;
create policy require_aal2 on public.portal_connections
  as restrictive for all to authenticated
  using ((select public.mfa_satisfied()))
  with check ((select public.mfa_satisfied()));

-- ---------------------------------------------------------------------------
-- 2. portal_listings
-- ---------------------------------------------------------------------------
create table if not exists public.portal_listings (
  property_id  uuid not null references public.properties(id) on delete cascade,
  portal       text not null check (portal ~ '^[a-z_]{2,40}$'),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  selected_at  timestamptz not null default now(),
  selected_by  uuid references public.profiles(id) on delete set null,
  primary key (property_id, portal)
);
create index if not exists portal_listings_org_portal_idx
  on public.portal_listings (org_id, portal);
comment on table public.portal_listings is
  'A listing chosen for a portal (0095). Per listing only — no rules. '
  'Deselecting deletes the row; portal_selected / portal_removed events on '
  'the property carry the history. The feed shows a row only while the site '
  'feed would (portal_supplement).';

alter table public.portal_listings enable row level security;
revoke all privileges on table public.portal_listings from anon;
revoke all privileges on table public.portal_listings from authenticated;
grant select, insert, delete on table public.portal_listings to authenticated;

drop policy if exists portal_listings_select on public.portal_listings;
create policy portal_listings_select on public.portal_listings for select
  using (org_id = (select public.current_org_id()));
-- Whoever may UPDATE the property may put it on a portal: the properties_update
-- rule (0002) verbatim, evaluated against the listing's own row.
drop policy if exists portal_listings_insert on public.portal_listings;
create policy portal_listings_insert on public.portal_listings for insert
  with check (
    org_id = (select public.current_org_id())
    and selected_by = (select auth.uid())
    and exists (
      select 1 from public.properties p
       where p.id = property_id
         and p.org_id = (select public.current_org_id())
         and ((select public.current_role_gnk()) in ('admin', 'listing_manager')
              or ((select public.current_role_gnk()) = 'agent'
                  and p.assigned_agent_id = (select auth.uid())))
    )
  );
drop policy if exists portal_listings_delete on public.portal_listings;
create policy portal_listings_delete on public.portal_listings for delete
  using (
    org_id = (select public.current_org_id())
    and exists (
      select 1 from public.properties p
       where p.id = property_id
         and p.org_id = (select public.current_org_id())
         and ((select public.current_role_gnk()) in ('admin', 'listing_manager')
              or ((select public.current_role_gnk()) = 'agent'
                  and p.assigned_agent_id = (select auth.uid())))
    )
  );
drop policy if exists require_aal2 on public.portal_listings;
create policy require_aal2 on public.portal_listings
  as restrictive for all to authenticated
  using ((select public.mfa_satisfied()))
  with check ((select public.mfa_satisfied()));

-- ---------------------------------------------------------------------------
-- 3. The JPEG rendition
-- ---------------------------------------------------------------------------
alter table public.property_media add column if not exists path_jpeg text;
comment on column public.property_media.path_jpeg is
  'Fourth rendition (0095): 1600 px JPEG beside the WebP full, same watermark '
  'policy, for portal feeds. Null until scripts/media/backfill-jpeg.mts has run.';

-- ---------------------------------------------------------------------------
-- 4. The three anon-callable functions
-- ---------------------------------------------------------------------------
create or replace function public.portal_connection_by_token(p_portal text, p_token text)
returns table (org_slug text, enabled boolean, settings jsonb)
language sql stable security definer set search_path = public as $$
  select o.slug, c.enabled, c.settings
    from portal_connections c
    join organizations o on o.id = c.org_id
   where c.portal = p_portal
     and c.feed_token = p_token
$$;

create or replace function public.portal_supplement(p_token text)
returns table (
  reference       text,
  lat             double precision,
  lng             double precision,
  location_approx boolean,
  images          jsonb
)
language sql stable security definer set search_path = public as $$
  select p.reference,
         st_y(p.location::geometry),
         st_x(p.location::geometry),
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
    join properties p on p.id = pl.property_id
   where c.feed_token = p_token
     and c.enabled
     -- the site feed's predicate (0088 public_listings), pinned together by portals.test.ts
     and p.visibility = 'public'
     and p.status     = 'available'
$$;

create or replace function public.note_portal_pull(p_token text, p_ua text, p_count int)
returns void
language sql volatile security definer set search_path = public as $$
  update portal_connections
     set last_pulled_at  = now(),
         last_pulled_ua  = left(coalesce(p_ua, ''), 200),
         last_pull_count = p_count
   where feed_token = p_token
$$;

-- The feed is public by design (spec §Decisions); everything else stays off.
revoke execute on function public.portal_connection_by_token(text, text) from public;
grant  execute on function public.portal_connection_by_token(text, text) to anon, authenticated, service_role;
revoke execute on function public.portal_supplement(text) from public;
grant  execute on function public.portal_supplement(text) to anon, authenticated, service_role;
revoke execute on function public.note_portal_pull(text, text, int) from public;
grant  execute on function public.note_portal_pull(text, text, int) to anon, authenticated, service_role;
