-- 0023: buyer proposal magic links (IMPROVEMENTS B3).
--
-- Completes `share_links`, listed in doc 01 §6.1 since v2 but never built —
-- only the `share_link` slot in ENTITY_TYPES existed. Doc 01 §0.1 names this
-- exactly: buyer portal logins were REMOVED and replaced with "no-login
-- magic-link proposal pages (tokenized URL, expiry date, per-open view
-- tracking)". CLAUDE.md guardrail 4 forbids buyer logins ever; this is the
-- sanctioned alternative and deliberately goes no wider.
--
-- THE TOKEN IS NEVER STORED. Only sha256(token), so a database leak yields no
-- working links — the same reasoning as password hashing. Lookup stays a single
-- indexed equality probe on the hash.
--
-- WHY A PUBLIC TOKEN MAY APPEND TO `events` (and /api/csp-report may not)
-- HANDOFF constraint 1 forbids the CSP endpoint from ever writing to the
-- hash-chained log: an ANONYMOUS caller appending to it is indefensible. A share
-- link differs in kind — the token is a bearer credential the agency minted, so
-- the append is authorised by something the org issued, and an invalid token
-- appends nothing. The THROTTLE is what keeps that true in practice: the
-- counter is exact (every open), but the EVENT is one per link per Cyprus day.
-- A buyer refreshing on a train must not be able to grow the evidence chain
-- without bound, and "shown on the 14th" is the granularity a commission
-- dispute argues over anyway.

create table if not exists share_links (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id),
  -- widened later for doc 01's lawyer/bank document links; same discriminator
  -- pattern as tasks.kind (0020)
  kind            text not null default 'proposal' check (kind in ('proposal')),
  token_sha256    text not null unique,
  contact_id      uuid references contacts(id),
  locale          text not null default 'en' check (locale in ('en','el','ru')),
  title           text,
  message         text,
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  revoked_by      uuid references profiles(id),
  view_count      int not null default 0,
  first_opened_at timestamptz,
  last_opened_at  timestamptz,
  created_by      uuid references profiles(id),
  created_at      timestamptz not null default now()
);
create index if not exists share_links_org_idx on share_links(org_id, created_at desc);

create table if not exists share_link_properties (
  share_link_id uuid not null references share_links(id) on delete cascade,
  property_id   uuid not null references properties(id),
  sort_order    int not null default 0,
  primary key (share_link_id, property_id)
);

-- Failed-lookup counter (see the design's §5). Brute-forcing a 32-byte token is
-- infeasible, so this is NOT anti-brute-force: it exists to stop scanning and
-- log-flooding, which only ever produce FAILED lookups. A legitimate open never
-- touches this table.
create table if not exists share_link_attempts (
  ip_hash      text not null,
  window_start timestamptz not null,
  attempts     int not null default 1,
  primary key (ip_hash, window_start)
);

alter table share_links           enable row level security;
alter table share_link_properties enable row level security;
alter table share_link_attempts   enable row level security;

-- Table-level GRANTs, which RLS policies do NOT imply. 0002 grants every table
-- to `authenticated` one by one; a table created later inherits nothing from
-- that, so without these the app gets "permission denied for table share_links"
-- even though the policies are correct. (Caught by the E2E, not by reading —
-- the same class of miss as 0021.)
--
-- `anon` is deliberately granted NOTHING. A buyer reaches this data only
-- through resolve_share_link, whose allowlist is the exposure boundary; no
-- SELECT grant means a mistake in a future policy still cannot open the table
-- to the public. RLS test 25 asserts exactly that.
grant select, insert, update         on share_links           to authenticated;
grant select, insert, delete         on share_link_properties to authenticated;
-- share_link_attempts: no grants to any app role. Only the security-definer
-- functions below touch it.

-- ---------- RLS (doc 04 conventions) ----------------------------------------
-- Staff read their org's links; anyone on staff may mint one; only the creator
-- or an admin may revoke. No DELETE for anyone — revoked, never deleted, like
-- every other retire in this schema.

drop policy if exists share_links_select on share_links;
create policy share_links_select on share_links
  for select using (org_id = current_org_id());

drop policy if exists share_links_insert on share_links;
create policy share_links_insert on share_links
  for insert with check (org_id = current_org_id() and created_by = auth.uid());

drop policy if exists share_links_update on share_links;
create policy share_links_update on share_links
  for update using (
    org_id = current_org_id()
    and (created_by = auth.uid() or current_role_gnk() = 'admin')
  ) with check (org_id = current_org_id());

drop policy if exists share_link_properties_select on share_link_properties;
create policy share_link_properties_select on share_link_properties
  for select using (exists (
    select 1 from share_links s
     where s.id = share_link_id and s.org_id = current_org_id()));

drop policy if exists share_link_properties_insert on share_link_properties;
create policy share_link_properties_insert on share_link_properties
  for insert with check (exists (
    select 1 from share_links s
     where s.id = share_link_id and s.org_id = current_org_id()));

drop policy if exists share_link_properties_delete on share_link_properties;
create policy share_link_properties_delete on share_link_properties
  for delete using (exists (
    select 1 from share_links s
     where s.id = share_link_id and s.org_id = current_org_id()
       and (s.created_by = auth.uid() or current_role_gnk() = 'admin')));

-- share_link_attempts is written only by the security-definer functions below.
-- No policy = no app role reaches it, which is what we want.

-- ---------- resolve: the ONLY thing anon may call ---------------------------
-- Returns the allowlisted payload for a live token, or null. The allowlist is
-- enumerated HERE, in SQL, so the exposure boundary cannot drift with a
-- component edit. `select *` must never appear in this function.
--
-- Never exposed: owner_net_price, min_acceptable_price, internal_notes,
-- amenities_notes, vat_status, title_deed_status, address/postal_code/location,
-- any mandate, commission, owner contact, KYC or document.

create or replace function resolve_share_link(p_token_sha256 text) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_link  share_links;
  v_today date := (now() at time zone 'Asia/Nicosia')::date;
  v_props jsonb;
  v_count int;
begin
  select * into v_link
    from share_links
   where token_sha256 = p_token_sha256
     and revoked_at is null
     and expires_at > now();

  -- Expired, revoked, unknown and malformed all land here and are
  -- indistinguishable to the caller — a prober learns nothing.
  if not found then
    return null;
  end if;

  update share_links
     set view_count      = view_count + 1,
         first_opened_at = coalesce(first_opened_at, now()),
         last_opened_at  = now()
   where id = v_link.id;

  select count(*) into v_count
    from share_link_properties where share_link_id = v_link.id;

  -- throttle: one `opened` event per link per Cyprus day (see header)
  if not exists (
    select 1 from events
     where entity_type = 'share_link'
       and entity_id   = v_link.id
       and event_type  = 'opened'
       and (occurred_at at time zone 'Asia/Nicosia')::date = v_today
  ) then
    insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
    values (v_link.org_id, null, 'share_link', v_link.id, 'opened',
            jsonb_build_object('locale', v_link.locale, 'property_count', v_count));
  end if;

  -- A property archived AFTER the link was made drops out rather than 404-ing
  -- the whole proposal — retiring one listing must not silently break an
  -- unrelated buyer's link. The page reports the shortfall.
  select coalesce(jsonb_agg(x.p order by x.sort_order), '[]'::jsonb) into v_props
    from (
      select slp.sort_order,
             jsonb_build_object(
               'reference',          pr.reference,
               'property_type',      pr.property_type,
               'transaction_type',   pr.transaction_type,
               'title',              coalesce(pr.title ->> v_link.locale, pr.title ->> 'en'),
               'short_description',  coalesce(pr.short_description ->> v_link.locale, pr.short_description ->> 'en'),
               'public_description', coalesce(pr.public_description ->> v_link.locale, pr.public_description ->> 'en'),
               'currency',           pr.currency,
               'asking_price',       pr.asking_price,
               'rent_price_month',   pr.rent_price_month,
               'covered_area_sqm',   pr.covered_area_sqm,
               'plot_area_sqm',      pr.plot_area_sqm,
               'bedrooms',           pr.bedrooms,
               'bathrooms',          pr.bathrooms,
               'parking_spaces',     pr.parking_spaces,
               'year_built',         pr.year_built,
               'energy_class',       pr.energy_class,
               'features',           to_jsonb(pr.features),
               'district',           coalesce(d.name ->> v_link.locale, d.name ->> 'en'),
               'area',               coalesce(a.name ->> v_link.locale, a.name ->> 'en'),
               'media',              coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'card', m.path_card, 'full', m.path_full,
                          'alt',  coalesce(m.alt ->> v_link.locale, m.alt ->> 'en'))
                        order by m.is_cover desc, m.sort_order)
                   from property_media m
                  where m.property_id = pr.id
                    and m.kind = 'photo'
                    and m.path_card is not null), '[]'::jsonb)
             ) as p
        from share_link_properties slp
        join properties pr on pr.id = slp.property_id
        left join districts d on d.id = pr.district_id
        left join areas     a on a.id = pr.area_id
       where slp.share_link_id = v_link.id
         and pr.visibility <> 'archived'
    ) x;

  return jsonb_build_object(
    'title',          v_link.title,
    'message',        v_link.message,
    'locale',         v_link.locale,
    'expires_at',     v_link.expires_at,
    'property_count', v_count,
    'properties',     v_props,
    'agent', (
      select jsonb_build_object('name', pf.full_name, 'email', pf.email, 'phone', pf.phone_e164)
        from profiles pf where pf.id = v_link.created_by),
    'org', (
      select jsonb_build_object('name', o.name) from organizations o where o.id = v_link.org_id)
  );
end $fn$;

-- Deliberately callable by anon: this is the buyer-facing entry point and the
-- ONLY thing a public visitor may invoke. The Supabase advisor
-- 0028_anon_security_definer_function_executable WILL flag it — that flag is
-- expected here and is pinned in scripts/backup/verify-restore.sql so it reads
-- as an intended grant rather than a regression of 0007's lockdown.
revoke execute on function resolve_share_link(text) from public;
grant  execute on function resolve_share_link(text) to anon, authenticated, service_role;

-- ---------- failed-lookup limiter -------------------------------------------
-- Returns true when the caller is over budget. Only ever called on a MISS.

create or replace function note_share_link_miss(p_ip_hash text, p_limit int default 20)
returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  v_window timestamptz := date_trunc('hour', now())
                        + (floor(extract(minute from now()) / 15) * interval '15 minutes');
  v_attempts int;
begin
  insert into share_link_attempts (ip_hash, window_start, attempts)
  values (p_ip_hash, v_window, 1)
  on conflict (ip_hash, window_start)
  do update set attempts = share_link_attempts.attempts + 1
  returning attempts into v_attempts;

  -- opportunistic prune so the table cannot grow forever
  delete from share_link_attempts where window_start < now() - interval '2 hours';

  return v_attempts > p_limit;
end $fn$;

revoke execute on function note_share_link_miss(text, int) from public;
grant  execute on function note_share_link_miss(text, int) to anon, authenticated, service_role;
