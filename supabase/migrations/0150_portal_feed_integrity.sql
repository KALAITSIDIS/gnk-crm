-- =============================================================================
-- 0150 — portal feed integrity, EXPAND half (portal integrations audit
-- 2026-10-18; closes the portal half of ANON-1; DECISIONS T-portal-feed-integrity).
--
-- THE DEFECTS.
--   1. The stored digest was the credential. 0097's three anon-callable
--      functions compared their argument straight to
--      portal_connections.feed_token_sha256, so anyone holding a COPY of that
--      column — every nightly export and pg_dump since 0097, the offsite
--      archives, a dashboard read, any org member at aal2 (the select policy
--      has no role condition) — could call them through PostgREST with the
--      public anon key: the org slug, the contact settings, and the exact
--      coordinates and photographs of every selected listing.
--   2. Pull telemetry was forgeable. note_portal_pull was anon-callable and
--      wrote whatever user-agent and count it was sent, so a token or digest
--      holder could keep "Last pulled" fresh over a dead integration, or fake
--      a delisting.
--   3. A failed pull recorded nothing, and nothing recorded history, so the
--      desk could not tell a feed that fails from a portal that stopped asking.
--   4. A listing's export date was properties.updated_at, which a photo
--      reorder, a cover change, a photo removal, a JPEG backfill, a district
--      rename or a portal contact edit never moves — the XML changed and the
--      date did not.
--
-- THE FIX (this file adds; it changes and drops nothing the deployed
-- application calls).
--   A. portal_feed_connection(p_portal, p_token) and portal_feed_supplement(
--      p_token): 0097's two readers with the same return shapes, taking the
--      TOKEN from the URL and hashing it here (sha256 of its UTF-8 text, which
--      is lib/services/portals/token.ts's hashPortalToken). The stored column
--      is unchanged — it still holds sha256(token) — so EVERY EXISTING FEED
--      URL KEEPS WORKING, no row is rewritten, and every copy of the column
--      ever taken stops being a credential the moment 0151 drops the old
--      readers: a stored value hashed again is not the stored value.
--      Granted to anon and service_role only (the route uses the anon client).
--   B. record_portal_pull(...) and sync_portal_export(...): the route's two
--      writes, SERVICE_ROLE ONLY. The route holds the token and calls them
--      through the admin client (the 0087 enquiry door's precedent), so no
--      token holder can write telemetry or export state over PostgREST.
--   C. portal_connections gains last_pull_outcome / last_success_at /
--      last_error_at / last_error_reason, and portal_pull_log keeps a bounded
--      history (50 runs per connection; identical consecutive outcomes within
--      an hour fold into one run, so a hammered URL cannot grow it).
--   D. portal_export_state holds, per connection and listing, the sha256 of
--      the rendered listing with its date left out and when that last
--      changed. The route renders, hashes, syncs, and emits that time as the
--      listing's date: any change to what a portal receives moves the date,
--      nothing else does — pull telemetry included.
--
-- DEPLOY ORDER: EXPAND. Hosted BEFORE the merge; the deployed application
-- keeps calling 0097's functions, which this file does not touch. The new
-- application calls only the functions above. 0151 (CONTRACT) drops 0097's
-- three after the new application's deployment is confirmed — that is what
-- closes defect 1 and 2 for good. Release-compat: no function the deployed
-- application calls changes; database.types.ts gains the new objects.
--
-- ROLLBACK (DECISIONS T-portal-feed-integrity): a forward migration that
-- drops the four functions, the two tables and the four columns
-- (supabase/tests/revert-0150.ts holds the text). Telemetry history and
-- export dates are lost; nothing the desk wrote is. Only valid while 0151 has
-- not been applied (after it, revert 0151 first).
--
-- Pins that move with this file: scripts/backup/verify-restore.sql (the
-- migrations count, the function rows, the 0150/0151 SECURITY row),
-- scripts/backup/export-tables.mjs (the two new tables and their keys),
-- aal1-definer-boundary's map (no new exemption: nothing here is granted to
-- authenticated). NO EXPLICIT begin/commit — the CLI wraps the file, as does one
-- execute_sql call (applied hosted inside the md5-guarded DO, DECISIONS
-- T-unit-type-apply-atomic). The file's LAST result is a read-only summary.
-- =============================================================================

set local lock_timeout = '5s';

do $$
begin
  if current_setting('lock_timeout') <> '5s' then
    raise exception '0150 aborted: this file must run as ONE transaction (SET LOCAL lock_timeout did not take effect) — nothing was changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 0. Preflight — written against 0097's portal_connections and readers
-- ---------------------------------------------------------------------------
do $$
declare
  f     record;
  v_md5 text;
begin
  lock table public.portal_connections in access exclusive mode;

  if (select format_type(a.atttypid, a.atttypmod) from pg_attribute a
       where a.attrelid = 'public.portal_connections'::regclass and a.attname = 'feed_token_sha256' and not a.attisdropped)
     is distinct from 'text' then
    raise exception '0150 aborted: portal_connections.feed_token_sha256 (text) is missing — nothing was changed';
  end if;
  if not exists (select 1 from pg_constraint c
                  where c.conrelid = 'public.portal_connections'::regclass
                    and c.conname = 'portal_connections_feed_token_sha256_chk'
                    and pg_get_constraintdef(c.oid) = 'CHECK ((feed_token_sha256 ~ ''^[0-9a-f]{64}$''::text))') then
    raise exception '0150 aborted: the 64-hex CHECK on feed_token_sha256 (0097) is not there — nothing was changed';
  end if;

  -- 0097's readers are the deployed application's; this file leaves them be,
  -- but it was written against their bodies (md5 of prosrc, CR stripped; hosted
  -- read 2026-10-18 = the files). 0151 drops them, so on a replay after 0151
  -- they are simply absent.
  for f in
    select * from (values
      ('public.portal_connection_by_token(text, text)', 'cc700ca2a19bdb771d54ef1be1460fa8'),
      ('public.portal_supplement(text)',                '6f1e95e537ca667c117a648d13f2560c'),
      ('public.note_portal_pull(text, text, integer)',  'b9d0fc542c0611069cf9daf080a9340d')
    ) as x(sig, body_md5)
  loop
    select md5(replace(p.prosrc, chr(13), '')) into v_md5 from pg_proc p where p.oid = to_regprocedure(f.sig);
    if v_md5 is not null and v_md5 <> f.body_md5 then
      raise exception '0150 aborted: % is not 0097''s body (md5 %) — read it first; nothing was changed', f.sig, v_md5;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 1. What the connection says about its pulls
-- ---------------------------------------------------------------------------
alter table public.portal_connections
  add column if not exists last_pull_outcome text,
  add column if not exists last_success_at   timestamptz,
  add column if not exists last_error_at     timestamptz,
  add column if not exists last_error_reason text;

alter table public.portal_connections drop constraint if exists portal_connections_last_pull_outcome_chk;
alter table public.portal_connections add constraint portal_connections_last_pull_outcome_chk
  check (last_pull_outcome is null or last_pull_outcome in ('served', 'disabled', 'failed'));
alter table public.portal_connections drop constraint if exists portal_connections_last_error_reason_chk;
alter table public.portal_connections add constraint portal_connections_last_error_reason_chk
  check (last_error_reason is null or last_error_reason ~ '^[a-z_]{1,40}$');

-- the target of the two tables' composite tenant keys (0088's idiom); added
-- once — a replay must not drop it, which would take the two foreign keys
-- below with it
do $$
begin
  if not exists (select 1 from pg_constraint c
                  where c.conrelid = 'public.portal_connections'::regclass
                    and c.conname = 'portal_connections_org_id_id_key') then
    alter table public.portal_connections add constraint portal_connections_org_id_id_key unique (org_id, id);
  end if;
end $$;

-- The pull facts are the route's to write (record_portal_pull, below), not a
-- session's. 0095 granted authenticated INSERT and UPDATE on the whole row,
-- so an admin's session could write last_pulled_at / ua / count over
-- PostgREST. From here a session may write only the columns the CRM's own
-- actions write (lib/actions/portals.ts); `id` stays in the UPDATE list so
-- 0132's primary-key guard keeps answering a re-key (its catalogue test reads
-- which keys an API role may update).
revoke insert, update on table public.portal_connections from authenticated;
grant insert (id, org_id, portal, enabled, settings, feed_token_sha256, updated_by)
  on table public.portal_connections to authenticated;
grant update (id, enabled, settings, feed_token_sha256, updated_by)
  on table public.portal_connections to authenticated;

comment on column public.portal_connections.last_pulled_at is
  'When the portal last REQUESTED the feed with a valid token, whatever the outcome (0150: written only by record_portal_pull, service_role).';
comment on column public.portal_connections.last_pull_count is
  'Listings in the last document actually served (0150: unchanged by a failed pull).';
comment on column public.portal_connections.last_pull_outcome is
  'served | disabled (the empty document) | failed (503, a fault) — 0150.';
comment on column public.portal_connections.last_success_at is 'Last pull answered with a document (served or disabled) — 0150.';
comment on column public.portal_connections.last_error_at is 'Last pull answered 503 (a fault) — 0150.';
comment on column public.portal_connections.last_error_reason is 'Why the last 503 happened, as a code the settings page words — 0150.';

-- ---------------------------------------------------------------------------
-- 2. The pull history
-- ---------------------------------------------------------------------------
create table if not exists public.portal_pull_log (
  id             bigint generated always as identity primary key,
  org_id         uuid not null,
  connection_id  uuid not null,
  first_at       timestamptz not null default now(),
  last_at        timestamptz not null default now(),
  hits           int not null default 1 check (hits >= 1),
  outcome        text not null check (outcome in ('served', 'disabled', 'failed')),
  served         int check (served >= 0),
  selected       int check (selected >= 0),
  excluded       int check (excluded >= 0),
  reason         text check (reason is null or reason ~ '^[a-z_]{1,40}$'),
  detail         jsonb not null default '{}'::jsonb
                 check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 4096),
  ua             text not null default '' check (length(ua) <= 200),
  constraint portal_pull_log_connection_fkey
    foreign key (org_id, connection_id) references public.portal_connections (org_id, id) on delete cascade
);
create index if not exists portal_pull_log_org_connection_idx
  on public.portal_pull_log (org_id, connection_id, last_at desc, id desc);
comment on table public.portal_pull_log is
  'Pull history per portal connection (0150). One row per RUN of identical outcomes (folded within an hour), '
  'at most 50 per connection; written only by record_portal_pull (service_role). Admin-readable.';

alter table public.portal_pull_log enable row level security;
revoke all privileges on table public.portal_pull_log from anon;
revoke all privileges on table public.portal_pull_log from authenticated;
grant select on table public.portal_pull_log to authenticated;
drop policy if exists portal_pull_log_select on public.portal_pull_log;
create policy portal_pull_log_select on public.portal_pull_log for select
  using (org_id = (select public.current_org_id())
         and (select public.current_role_gnk()) = 'admin');
drop policy if exists require_aal2 on public.portal_pull_log;
create policy require_aal2 on public.portal_pull_log
  as restrictive for all to authenticated
  using ((select public.mfa_satisfied()))
  with check ((select public.mfa_satisfied()));

-- ---------------------------------------------------------------------------
-- 3. The export revision
-- ---------------------------------------------------------------------------
create table if not exists public.portal_export_state (
  org_id          uuid not null,
  connection_id   uuid not null,
  -- properties.reference has no length limit (a unit's is its project's plus
  -- block and number, up to ~55), so neither does this; 500 only bounds a row
  reference       text not null check (length(reference) between 1 and 500),
  content_sha256  text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  changed_at      timestamptz not null default now(),
  primary key (connection_id, reference),
  constraint portal_export_state_connection_fkey
    foreign key (org_id, connection_id) references public.portal_connections (org_id, id) on delete cascade
);
create index if not exists portal_export_state_org_connection_idx
  on public.portal_export_state (org_id, connection_id);
comment on table public.portal_export_state is
  'Per connection and listing: sha256 of the listing as last rendered for that portal with its date left out, '
  'and when it last changed — the listing''s export date (0150). Written only by sync_portal_export (service_role).';

alter table public.portal_export_state enable row level security;
revoke all privileges on table public.portal_export_state from anon;
revoke all privileges on table public.portal_export_state from authenticated;
drop policy if exists require_aal2 on public.portal_export_state;
create policy require_aal2 on public.portal_export_state
  as restrictive for all to authenticated
  using ((select public.mfa_satisfied()))
  with check ((select public.mfa_satisfied()));

-- ---------------------------------------------------------------------------
-- 4. The two readers, taking the token
-- ---------------------------------------------------------------------------
create or replace function public.portal_feed_connection(p_portal text, p_token text)
returns table (org_slug text, enabled boolean, settings jsonb, selected_count int)
language sql stable security definer set search_path = public as $$
  -- 0150: the argument is the TOKEN from the URL, hashed here. The column
  -- holds sha256(token) (0097), so a copy of the column is not a token.
  -- selected_count is how many rows portal_feed_supplement answers for this
  -- token, counted independently: the route refuses a supplement that comes
  -- back shorter, so a hollow or re-routed answer (postgrest-js turns an
  -- array-bodied 404 into `data: []`) cannot pass for an empty selection.
  select o.slug, c.enabled, c.settings,
         case when not c.enabled then 0 else (
           select count(*)::int
             from portal_listings pl
             join properties p on p.id = pl.property_id and p.org_id = c.org_id
            where pl.org_id = c.org_id
              and pl.portal = c.portal
              and p.visibility = 'public'
              and p.status     = 'available'
         ) end
    from portal_connections c
    join organizations o on o.id = c.org_id
   where p_token ~ '^[0-9a-f]{64}$'
     and c.portal = p_portal
     and c.feed_token_sha256 = encode(pg_catalog.sha256(convert_to(p_token, 'UTF8')), 'hex')
$$;

create or replace function public.portal_feed_supplement(p_token text)
returns table (
  reference       text,
  lat             double precision,
  lng             double precision,
  location_approx boolean,
  images          jsonb
)
language sql stable security definer set search_path = public as $$
  -- 0097's portal_supplement, authorised by the TOKEN (0150). The point of an
  -- approximate listing is withheld here, not left to a renderer (0097's note).
  -- Each photo now carries its ORIGINAL pixel size, from which the CRM derives
  -- the JPEG a portal receives and checks a portal's stated minimum
  -- (JamesEdition: 800×600) — the size of a public photograph, nothing more.
  -- The photo order ends on m.id: the export revision hashes the rendered
  -- listing, and a tie on (sort_order, created_at) resolved differently on
  -- two reads would move a listing's date with nothing changed.
  select p.reference,
         case when p.location_approx then null else st_y(p.location::geometry) end,
         case when p.location_approx then null else st_x(p.location::geometry) end,
         p.location_approx,
         coalesce((
           select jsonb_agg(jsonb_build_object('jpeg', m.path_jpeg, 'alt', m.alt,
                                               'width', m.width, 'height', m.height)
                            order by m.is_cover desc, m.sort_order, m.created_at, m.id)
             from property_media m
            where m.property_id = p.id
              and m.kind = 'photo'
              and m.path_jpeg is not null
         ), '[]'::jsonb)
    from portal_connections c
    join portal_listings pl on pl.org_id = c.org_id and pl.portal = c.portal
    join properties p on p.id = pl.property_id and p.org_id = c.org_id
   where p_token ~ '^[0-9a-f]{64}$'
     and c.feed_token_sha256 = encode(pg_catalog.sha256(convert_to(p_token, 'UTF8')), 'hex')
     and c.enabled
     -- the site feed's predicate (0088 public_listings), pinned together by portals.test.ts
     and p.visibility = 'public'
     and p.status     = 'available'
$$;

-- ---------------------------------------------------------------------------
-- 5. The route's two writes, service_role only
-- ---------------------------------------------------------------------------
create or replace function public.record_portal_pull(
  p_token    text,
  p_ua       text,
  p_outcome  text,
  p_served   int,
  p_selected int,
  p_excluded int,
  p_reason   text,
  p_detail   jsonb
)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare
  v_ok     boolean;
  v_conn   uuid;
  v_org    uuid;
  v_ua     text := left(coalesce(p_ua, ''), 200);
  v_detail jsonb := coalesce(p_detail, '{}'::jsonb);
  v_last   record;
  v_enabled boolean;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    return;
  end if;
  if p_outcome is null or p_outcome not in ('served', 'disabled', 'failed') then
    raise exception using errcode = '22023', message = 'record_portal_pull: unknown outcome';
  end if;
  if p_reason is not null and p_reason !~ '^[a-z_]{1,40}$' then
    raise exception using errcode = '22023', message = 'record_portal_pull: a reason is a lowercase code';
  end if;
  if jsonb_typeof(v_detail) <> 'object' or pg_column_size(v_detail) > 4096 then
    raise exception using errcode = '22023', message = 'record_portal_pull: detail is a small object';
  end if;
  if p_served < 0 or p_selected < 0 or p_excluded < 0 then
    raise exception using errcode = '22023', message = 'record_portal_pull: a count is never negative';
  end if;
  v_ok := p_outcome in ('served', 'disabled');

  update portal_connections c
     set last_pulled_at    = now(),
         last_pulled_ua    = v_ua,
         last_pull_outcome = p_outcome,
         last_pull_count   = case when v_ok then coalesce(p_served, 0) else c.last_pull_count end,
         last_success_at   = case when v_ok then now() else c.last_success_at end,
         last_error_at     = case when v_ok then c.last_error_at else now() end,
         last_error_reason = case when v_ok then c.last_error_reason else p_reason end
   where c.feed_token_sha256 = encode(pg_catalog.sha256(convert_to(p_token, 'UTF8')), 'hex')
  returning c.id, c.org_id, c.enabled into v_conn, v_org, v_enabled;
  if v_conn is null then
    return;
  end if;

  -- The empty document was served and the connection is still off: the
  -- portal is told to remove every listing, so their export revisions are
  -- forgotten — a listing offered again after re-enabling is new to the
  -- portal, and its date says so (sync_portal_export never runs while
  -- disabled). `not v_enabled` keeps a late record, landing after a quick
  -- re-enable and a served pull, from wiping fresh state.
  if p_outcome = 'disabled' and not v_enabled then
    delete from portal_export_state s where s.org_id = v_org and s.connection_id = v_conn;
  end if;

  -- One row per RUN: the same answer again within the hour folds into the
  -- latest row, so a URL pulled every minute (or hammered) writes one row.
  select l.id, l.outcome, l.served, l.selected, l.excluded, l.reason, l.detail, l.last_at
    into v_last
    from portal_pull_log l
   where l.org_id = v_org and l.connection_id = v_conn
   order by l.last_at desc, l.id desc
   limit 1;
  if v_last.id is not null
     and v_last.outcome = p_outcome
     and v_last.served   is not distinct from p_served
     and v_last.selected is not distinct from p_selected
     and v_last.excluded is not distinct from p_excluded
     and v_last.reason   is not distinct from p_reason
     and v_last.detail   = v_detail
     and v_last.last_at  > now() - interval '1 hour' then
    update portal_pull_log set last_at = now(), hits = hits + 1, ua = v_ua where id = v_last.id;
  else
    insert into portal_pull_log (org_id, connection_id, outcome, served, selected, excluded, reason, detail, ua)
    values (v_org, v_conn, p_outcome, p_served, p_selected, p_excluded, p_reason, v_detail, v_ua);
    delete from portal_pull_log l
     where l.org_id = v_org and l.connection_id = v_conn
       and l.id not in (select k.id from portal_pull_log k
                         where k.org_id = v_org and k.connection_id = v_conn
                         order by k.last_at desc, k.id desc
                         limit 50);
  end if;
end $$;

-- ONE jsonb object {reference: changed_at}, not a table: PostgREST caps a
-- set-returning answer at max_rows (1000), and a feed may hold 2500 listings.
-- An unknown token or a disabled connection answers {} and writes nothing
-- (a disabled connection's revisions are forgotten by record_portal_pull
-- when the empty document is served).
create or replace function public.sync_portal_export(p_token text, p_rows jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_conn uuid;
  v_org  uuid;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    return '{}'::jsonb;
  end if;
  select c.id, c.org_id into v_conn, v_org
    from portal_connections c
   where c.feed_token_sha256 = encode(pg_catalog.sha256(convert_to(p_token, 'UTF8')), 'hex')
     and c.enabled;
  if v_conn is null then
    return '{}'::jsonb;
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception using errcode = '22023', message = 'sync_portal_export: rows must be an array';
  end if;
  if jsonb_array_length(p_rows) > 2500 then
    raise exception using errcode = '22023', message = 'sync_portal_export: more rows than a feed can hold';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) e
              where jsonb_typeof(e) <> 'object'
                 or jsonb_typeof(e -> 'reference') is distinct from 'string'
                 or jsonb_typeof(e -> 'sha256') is distinct from 'string'
                 or length(e ->> 'reference') not between 1 and 500
                 or (e ->> 'sha256') !~ '^[0-9a-f]{64}$') then
    raise exception using errcode = '22023', message = 'sync_portal_export: each row is {reference, sha256}';
  end if;
  if (select count(*) from jsonb_array_elements(p_rows)) <>
     (select count(distinct e ->> 'reference') from jsonb_array_elements(p_rows) e) then
    raise exception using errcode = '22023', message = 'sync_portal_export: a reference appears twice';
  end if;

  -- a listing whose rendering is unchanged keeps its row untouched
  insert into portal_export_state as s (org_id, connection_id, reference, content_sha256, changed_at)
  select v_org, v_conn, e ->> 'reference', e ->> 'sha256', now()
    from jsonb_array_elements(p_rows) e
  on conflict on constraint portal_export_state_pkey do update
     set content_sha256 = excluded.content_sha256,
         changed_at     = now()
   where s.content_sha256 is distinct from excluded.content_sha256;

  -- a listing no longer in the feed forgets its revision: if it comes back it
  -- is new to the portal, and its date says so
  delete from portal_export_state s
   where s.org_id = v_org and s.connection_id = v_conn
     and not exists (select 1 from jsonb_array_elements(p_rows) e where e ->> 'reference' = s.reference);

  -- a separate statement, so it sees a row a concurrent pull committed while
  -- this one waited on the conflict above
  return coalesce((
    select jsonb_object_agg(s.reference, s.changed_at)
      from portal_export_state s
     where s.org_id = v_org and s.connection_id = v_conn
  ), '{}'::jsonb);
end $$;

-- ---------------------------------------------------------------------------
-- 6. Grants — hosted's default privileges hand new functions to anon and
--    authenticated (HANDOFF §4.3), so revoke first, then grant exactly
-- ---------------------------------------------------------------------------
revoke execute on function public.portal_feed_connection(text, text) from public, anon, authenticated;
revoke execute on function public.portal_feed_supplement(text) from public, anon, authenticated;
revoke execute on function public.record_portal_pull(text, text, text, int, int, int, text, jsonb) from public, anon, authenticated;
revoke execute on function public.sync_portal_export(text, jsonb) from public, anon, authenticated;
grant execute on function public.portal_feed_connection(text, text) to anon, service_role;
grant execute on function public.portal_feed_supplement(text) to anon, service_role;
grant execute on function public.record_portal_pull(text, text, text, int, int, int, text, jsonb) to service_role;
grant execute on function public.sync_portal_export(text, jsonb) to service_role;

comment on function public.portal_feed_connection(text, text) is
  'The portal feed''s connection lookup, authorised by the URL''s token hashed here (0150). anon + service_role.';
comment on function public.portal_feed_supplement(text) is
  'What a portal sees beyond the site feed for its selected listings, authorised by the URL''s token (0150). anon + service_role.';
comment on function public.record_portal_pull(text, text, text, int, int, int, text, jsonb) is
  'The feed route''s pull record: last_pull* columns and portal_pull_log (0150). service_role only — a token holder cannot write it.';
comment on function public.sync_portal_export(text, jsonb) is
  'The feed route''s export revision sync: per listing, the rendering''s sha256 and when it last changed (0150). service_role only.';

-- ---------------------------------------------------------------------------
-- 7. Postflight — asserted, not trusted
-- ---------------------------------------------------------------------------
do $$
begin
  -- the hash is Node's: createHash('sha256').update(token) of this token
  if encode(pg_catalog.sha256(convert_to('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'UTF8')), 'hex')
     <> 'a8ae6e6ee929abea3afcfc5258c8ccd6f85273e0d4626d26c7279f3250f77c8e' then
    raise exception '0150 postflight: SQL and Node disagree on sha256(token) — every feed would 404';
  end if;
  if not (has_function_privilege('anon', 'public.portal_feed_connection(text, text)', 'execute')
          and has_function_privilege('anon', 'public.portal_feed_supplement(text)', 'execute')
          and has_function_privilege('service_role', 'public.portal_feed_connection(text, text)', 'execute')
          and has_function_privilege('service_role', 'public.portal_feed_supplement(text)', 'execute')) then
    raise exception '0150 postflight: anon or service_role cannot call a feed reader — every pull would 404';
  end if;
  if has_function_privilege('authenticated', 'public.portal_feed_connection(text, text)', 'execute')
     or has_function_privilege('authenticated', 'public.portal_feed_supplement(text)', 'execute') then
    raise exception '0150 postflight: authenticated may call a feed reader';
  end if;
  if has_function_privilege('anon', 'public.record_portal_pull(text, text, text, integer, integer, integer, text, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.record_portal_pull(text, text, text, integer, integer, integer, text, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.sync_portal_export(text, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.sync_portal_export(text, jsonb)', 'execute')
     or not has_function_privilege('service_role', 'public.record_portal_pull(text, text, text, integer, integer, integer, text, jsonb)', 'execute')
     or not has_function_privilege('service_role', 'public.sync_portal_export(text, jsonb)', 'execute') then
    raise exception '0150 postflight: the route''s writes are not service_role-only';
  end if;
  if has_column_privilege('authenticated', 'public.portal_connections', 'last_pulled_at', 'update')
     or has_column_privilege('authenticated', 'public.portal_connections', 'last_pull_count', 'update')
     or has_column_privilege('authenticated', 'public.portal_connections', 'last_pull_outcome', 'insert')
     or not has_column_privilege('authenticated', 'public.portal_connections', 'enabled', 'update')
     or not has_column_privilege('authenticated', 'public.portal_connections', 'feed_token_sha256', 'update')
     or not has_column_privilege('authenticated', 'public.portal_connections', 'settings', 'insert') then
    raise exception '0150 postflight: a session may write the pull facts, or may not write what the actions write';
  end if;
  if exists (select 1 from public.rls_aal2_coverage()) then
    raise exception '0150 postflight: a table lacks require_aal2';
  end if;
  if has_table_privilege('anon', 'public.portal_pull_log', 'select')
     or has_table_privilege('anon', 'public.portal_export_state', 'select')
     or has_table_privilege('authenticated', 'public.portal_export_state', 'select')
     or has_table_privilege('authenticated', 'public.portal_pull_log', 'insert') then
    raise exception '0150 postflight: a new table is reachable beyond its design';
  end if;
end $$;

select 'portal feed integrity (expand)' as migration_0150,
       (select count(*) from public.portal_connections) as connections,
       (select count(*) from public.portal_connections where feed_token_sha256 is not null) as with_token;
