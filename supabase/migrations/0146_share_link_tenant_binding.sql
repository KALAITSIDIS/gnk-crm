-- =============================================================================
-- 0146 — a share link shows only its own organisation's rows of these: the
--        property it names, the price list it pins, the tree its page walks
--        and the staff member it shows as its agent (T-share-link-tenant,
--        2026-10-14; an external audit's finding, verified independently
--        first; the agent from the review round). NOT the district / area
--        names — see NOT CHANGED.
--
-- THE GAP (measured on the local stack at 0145 by
-- supabase/tests/share-link-tenant-binding.test.ts, pinned RED first —
-- DECISIONS T-share-link-tenant has the count; hosted read READ-ONLY
-- 2026-10-14: one organisation, no cross-organisation row of any kind below):
--
--   * share_link_properties_insert (0023) checks only that the LINK is one of
--     the caller's organisation's. share_link_properties.property_id is a
--     single-column key onto properties(id), never checked against the
--     caller's organisation. Organisation B's staff could mint their own link
--     and add organisation A's property by uuid (an id travels: the public
--     rendition paths are properties/<id>/…, and the proposal payload's
--     photo paths carry it): B's anonymous page then showed A's non-archived
--     listing, private ones included, and an availability link aimed at A's
--     project showed A's whole non-draft unit tree with its prices.
--   * share_links.price_list_id (0041) is a single-column key onto
--     price_lists(id); share_links_insert / share_links_update (0100's
--     hoisted text) check only the link's organisation. B could pin A's price
--     list: A's version and effective date, and A's quoted prices for the
--     units it lists, on B's page.
--   * resolve_share_link() (0137's body; the SECURITY DEFINER every public
--     share page calls, anon included) read every one of those rows with no
--     organisation predicate — the target, the descendant walk (anchor AND
--     recursive member), the pinned list, its lines, the proposal's
--     properties and the linked-row count. properties.parent_id is a
--     single-column key and properties_insert / _update check only the
--     caller's own organisation and role, so B could also hang its own units
--     under A's project: A's own availability page then listed B's units at
--     B's prices.
--   * share_links.created_by (0023) is a single-column key onto profiles(id);
--     share_links_update's WITH CHECK never looked at it (authenticated holds
--     table-wide UPDATE; no trigger guards the column), and the resolver read
--     the page's `agent` by it with no organisation predicate. B's admin, or
--     the link's creator, could re-point B's link at A's staff member: B's
--     anonymous page then showed A's staff member's name, email and phone
--     (found by the review round of this file; measured at its first version:
--     the update accepted, a missing profile 23503 — an oracle).
--
-- THE FIX, two layers (a policy binds SESSIONS; the resolver binds what is
-- SHOWN, whoever wrote the row — the service role, a definer, a row from
-- before this file):
--   1. share_link_properties_insert gains `and exists (… properties p where
--      p.id = property_id and p.org_id = (select current_org_id()))`; its
--      0023 link clause is kept, now hoisted (0030's form — it was the one
--      bare helper call left on the table's insert path). There is no UPDATE
--      policy and no UPDATE grant on share_link_properties (asserted below),
--      so a row cannot be re-pointed: delete + insert is the only way, and
--      the insert is bound. An availability link's target IS its
--      share_link_properties row (0041: the first by sort_order), so this
--      binds the target too — there is no separate target column.
--   2. share_links_insert and share_links_update (WITH CHECK) gain `and
--      (price_list_id is null or exists (… price_lists pl where pl.id =
--      price_list_id and pl.org_id = (select current_org_id())))`, and
--      share_links_update also `and (created_by is null or exists (…
--      profiles pf where pf.id = created_by and pf.org_id = (select
--      current_org_id())))` (share_links_insert already pins created_by to
--      the caller, whose profile IS the caller's organisation's). A revoke
--      (revoked_at / revoked_by) of a link pinning its own organisation's
--      list, or none, made by its own organisation's staff, passes as
--      before. USING is unchanged.
--   3. resolve_share_link: 0137's text byte for byte but nine edits, each
--      with a `-- 0146:` comment line: `org_id = v_link.org_id` on the target
--      lookup, the walk's anchor and its recursive member (which closes the
--      parent_id route), the price-list lookup and the proposal's properties
--      join; the list's lines are joined on the list READ (v_pl.id), not on
--      the link's raw id; the linked-row count counts the link's own
--      organisation's rows — archived ones INCLUDED, as before, so the page
--      still reports a retired listing as a shortfall; and `pf.org_id =
--      v_link.org_id` on the agent block of each kind (a creator of another
--      organisation shows NO agent). Nothing else moves: `pinned means
--      pinned` is kept, so a link whose pinned list is not its own shows NO
--      price rather than a live one.
--   A cross-organisation id and a missing one now read the same 42501 at the
--   policy (WITH CHECK runs before the key's 23503) — no existence oracle
--   through these three columns for a session.
--
-- WHY POLICIES, NOT COMPOSITE KEYS (0123 / 0139's layer A): share_link_
-- properties has no org_id column and price_lists no (org_id, id) key, so a
-- composite key is a schema change on both sides, and it is the composite-key
-- series' to make (BACKLOG). The policies bind every session writer today;
-- the resolver's predicates make a row written by any other path harmless.
--
-- CONTRACT. Signature, return shape, grants, the view counter and the
-- `opened` line unchanged; for a link whose rows are all its own
-- organisation's, the payload is byte-identical (measured: proposal and
-- availability, live and pinned, archived and draft rows included). Types
-- identical; no release-compat entry. The deployed application inserts only
-- rows it has just read under RLS (createShareLink, createAvailabilityLink
-- check the property and the list first), so NOT deploy-coupled: hosted 0146
-- first, then merge.
--
-- LOCKS. ALTER POLICY takes ACCESS EXCLUSIVE on share_links and on
-- share_link_properties (measured): every read of them — the public share
-- page, the staff list — waits until this commits (milliseconds). Both are
-- taken FIRST, in ONE statement inside the preflight, share_links before
-- share_link_properties: resolve_share_link's order (the public page, the
-- hot path). An INSERT into share_link_properties takes the OTHER order —
-- its own table at parse, then share_links through the policy's subquery
-- and the key's check (measured: it holds share_link_properties and waits
-- on share_links) — so no order suits both: a link created in the same
-- instant can 40P01. CREATE OR REPLACE FUNCTION takes no table lock (a call
-- already running keeps the old body to its end). lock_timeout 5 s per
-- table: a 55P03 or a 40P01 keeps nothing — apply again, and do NOT write
-- the ledger row. ONE transaction (checked below).
--
-- PREFLIGHT refuses, changing nothing, unless: resolve_share_link is the only
-- function of that name, its body exactly 0137's (md5 of prosrc, carriage
-- returns ignored — local and hosted read 466cf76e… on 2026-10-14), SECURITY
-- DEFINER, owned by postgres, `search_path=public`, VOLATILE, returning
-- jsonb, with 0041's ACL exactly; the three policies' texts are exactly 0023's
-- / 0100's (read under the fixed search_path below), each permissive, for
-- PUBLIC, of its command, and each the ONLY permissive policy for its command
-- (permissive policies OR together: a sibling — or an ALL policy — would
-- undo every check this file adds); share_link_properties has no UPDATE (or
-- ALL) permissive policy and no API role holds UPDATE on it.
--
-- POSTFLIGHT, each guard before the md5 pin (so each can be seen to refuse
-- on its own): the body's nine predicates; 0137's two throttle predicates
-- still there; 0041's EXPOSURE GUARD (no forbidden column name in the body —
-- the list is in 0041's header, deliberately NOT repeated inside the
-- function); the definer's owner, search_path, volatility, return type and
-- ACL exactly as before; then the new body's md5; the three policies' exact
-- new texts, each still permissive, for PUBLIC, of its command, and still
-- the only permissive one for it; nothing else on the two tables changed
-- (their policy count).
--
-- EXISTING ROWS — READ-ONLY DIAGNOSTIC, NO REPAIR (the file's last row):
--   link_rows_across_orgs       share_link_properties rows whose property is
--                               not of the link's organisation;
--   pinned_lists_across_orgs    links pinning a price list of another
--                               organisation;
--   rows_under_a_foreign_parent properties whose parent is another
--                               organisation's;
--   creators_across_orgs        links whose created_by is a profile of
--                               another organisation.
-- None is shown by the resolver any more. A link pinning another
-- organisation's list, or naming another organisation's creator, can no
-- longer be UPDATED by a session (revoke included) until that column is
-- cleared or corrected — an operator decision per counted row. Hosted held
-- 0 / 0 / 0 / 0 on 2026-10-14 (read-only).
--
-- NOT CHANGED (BACKLOG, the composite-key series): properties.parent_id, the
-- area_id / district_id links (the proposal and the project block still name
-- a district or area by id with no organisation predicate — a foreign
-- district's NAME would show), deals.stage_id, price_list_items.unit_id,
-- price_lists.project_id — all still single-column; the keys onto profiles
-- (created_by is bound by share_links_update's check and the resolver, not
-- by a key; revoked_by is shown nowhere and stays unbound — BACKLOG's
-- profile-links entry). Who may call the resolver; what it returns; the
-- throttle; anything else in it.
--
-- ROLLBACK, a forward migration in one transaction: restore 0137's function
-- text and grants (supabase/tests/revert-0146.ts slices exactly that from
-- 0137's file) and the three policies' 0023 / 0100 texts (the same file
-- holds them). Revert 0147 FIRST if it has landed (the restored insert check
-- calls current_org_id() bare, which 0147's schema-wide guard and its
-- restore-pack row report). In the same change: delete the test file and helper; remove
-- the restore pack's 0146 row and move its migrations pin FORWARD; restore
-- the BACKLOG text. No data moves.
--
-- Pins that move with this file: scripts/backup/verify-restore.sql (the
-- migrations count, the 0146 SECURITY row); docs/04 (share_links,
-- share_link_properties). NO EXPLICIT begin/commit — the CLI wraps the file
-- (HANDOFF §3), as does one execute_sql call; applied hosted inside the
-- md5-guarded DO (DECISIONS T-unit-type-apply-atomic). The file's LAST
-- result is the read-only diagnostic.
-- =============================================================================

set local lock_timeout = '5s';
-- pg_get_expr's output depends on the session's search_path: read and pin
-- the policies under the FIXED path local and hosted both use (0138's idiom)
set local search_path = "$user", public, extensions;

do $$
begin
  if current_setting('lock_timeout') <> '5s' then
    raise exception '0146 aborted: this file must run as ONE transaction (SET LOCAL lock_timeout did not take effect) — nothing was changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Preflight: the function and the three policies are what this file was
-- written against
-- ---------------------------------------------------------------------------
do $$
declare
  v_sig constant text := 'public.resolve_share_link(text)';
  v_md5 text;
  v_txt text;
begin
  -- the locks ALTER POLICY needs, first (header, LOCKS)
  lock table public.share_links, public.share_link_properties in access exclusive mode;

  -- 1. the definer is 0137's, exactly
  if (select count(*) from pg_proc p
       where p.pronamespace = 'public'::regnamespace and p.proname = 'resolve_share_link') <> 1 then
    raise exception '0146 aborted: resolve_share_link is missing or overloaded — nothing was changed';
  end if;
  select md5(replace(p.prosrc, E'\r', '')) into v_md5
    from pg_proc p
   where p.oid = to_regprocedure(v_sig) and p.prosecdef
     and pg_get_userbyid(p.proowner) = 'postgres'
     and p.proconfig = array['search_path=public']
     and p.provolatile = 'v'
     and p.prorettype = 'jsonb'::regtype;
  if v_md5 is distinct from '466cf76e9326e96d6dc2ec6bc46f94ae' then
    raise exception '0146 aborted: resolve_share_link is not 0137''s definer body (md5 %) — nothing was changed', coalesce(v_md5, 'missing or not the definer it was');
  end if;
  select p.proacl::text into v_txt from pg_proc p where p.oid = to_regprocedure(v_sig);
  if v_txt is distinct from '{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}' then
    raise exception '0146 aborted: resolve_share_link''s ACL is not 0041''s (%) — nothing was changed', coalesce(v_txt, 'default');
  end if;

  -- 2. the three policies are 0023's / 0100's, permissive, for PUBLIC
  if (select count(*) from pg_policy p
       where p.polrelid = 'public.share_link_properties'::regclass and p.polname = 'share_link_properties_insert'
         and p.polcmd = 'a' and p.polpermissive and p.polroles = array[0::oid] and p.polqual is null
         and pg_get_expr(p.polwithcheck, p.polrelid) = E'(EXISTS ( SELECT 1\n   FROM share_links s\n  WHERE ((s.id = share_link_properties.share_link_id) AND (s.org_id = current_org_id()))))') <> 1 then
    raise exception '0146 aborted: share_link_properties_insert is not 0023''s check — nothing was changed';
  end if;
  if (select count(*) from pg_policy p
       where p.polrelid = 'public.share_links'::regclass and p.polname = 'share_links_insert'
         and p.polcmd = 'a' and p.polpermissive and p.polroles = array[0::oid] and p.polqual is null
         and pg_get_expr(p.polwithcheck, p.polrelid) = '((org_id = ( SELECT current_org_id() AS current_org_id)) AND (created_by = ( SELECT auth.uid() AS uid)))') <> 1 then
    raise exception '0146 aborted: share_links_insert is not 0100''s check — nothing was changed';
  end if;
  if (select count(*) from pg_policy p
       where p.polrelid = 'public.share_links'::regclass and p.polname = 'share_links_update'
         and p.polcmd = 'w' and p.polpermissive and p.polroles = array[0::oid]
         and pg_get_expr(p.polqual, p.polrelid) = '((org_id = ( SELECT current_org_id() AS current_org_id)) AND ((created_by = ( SELECT auth.uid() AS uid)) OR (( SELECT current_role_gnk() AS current_role_gnk) = ''admin''::user_role)))'
         and pg_get_expr(p.polwithcheck, p.polrelid) = '(org_id = ( SELECT current_org_id() AS current_org_id))') <> 1 then
    raise exception '0146 aborted: share_links_update is not 0100''s policy — nothing was changed';
  end if;
  -- ... and each is the ONLY permissive policy for its command: permissive
  -- policies OR together, so a sibling (or an ALL policy) would undo the
  -- check this file adds while every text above still read as pinned
  if (select count(*) from pg_policy p
       where p.polrelid = 'public.share_link_properties'::regclass and p.polpermissive and p.polcmd in ('a', '*')) <> 1 then
    raise exception '0146 aborted: share_link_properties_insert is not the only permissive INSERT policy on share_link_properties — nothing was changed';
  end if;
  if (select count(*) from pg_policy p
       where p.polrelid = 'public.share_links'::regclass and p.polpermissive and p.polcmd in ('a', '*')) <> 1
     or (select count(*) from pg_policy p
          where p.polrelid = 'public.share_links'::regclass and p.polpermissive and p.polcmd in ('w', '*')) <> 1 then
    raise exception '0146 aborted: share_links_insert / share_links_update are not the only permissive INSERT / UPDATE policies on share_links — nothing was changed';
  end if;

  -- 3. a share_link_properties row cannot be re-pointed: no UPDATE path
  if exists (select 1 from pg_policy p
              where p.polrelid = 'public.share_link_properties'::regclass and p.polpermissive and p.polcmd in ('w', '*'))
     or has_table_privilege('authenticated', 'public.share_link_properties', 'update')
     or has_table_privilege('anon', 'public.share_link_properties', 'update') then
    raise exception '0146 aborted: share_link_properties has an UPDATE path (a permissive UPDATE / ALL policy or an API role''s UPDATE grant) — nothing was changed';
  end if;

  -- the two tables' policy count the postflight must find unchanged
  perform set_config('gnk.m0146_policies',
    (select count(*) from pg_policy p
      where p.polrelid in ('public.share_links'::regclass, 'public.share_link_properties'::regclass))::text, true);

  -- EXISTING ROWS (read-only; header) — under the locks just taken: exact
  perform set_config('gnk.m0146_existing',
    format('link_rows_across_orgs=%s pinned_lists_across_orgs=%s rows_under_a_foreign_parent=%s creators_across_orgs=%s',
           (select count(*) from public.share_link_properties slp
              join public.share_links l on l.id = slp.share_link_id
              join public.properties p on p.id = slp.property_id
             where p.org_id <> l.org_id),
           (select count(*) from public.share_links l
              join public.price_lists pl on pl.id = l.price_list_id
             where pl.org_id <> l.org_id),
           (select count(*) from public.properties c
              join public.properties p on p.id = c.parent_id
             where c.org_id <> p.org_id),
           (select count(*) from public.share_links l
              join public.profiles pf on pf.id = l.created_by
             where pf.org_id <> l.org_id)),
    true);

  raise notice '0146: preflight passed — resolve_share_link is 0137''s definer body with 0041''s ACL; the three policies are 0023''s / 0100''s';
end $$;

-- ---------------------------------------------------------------------------
-- 1. a share link names only its own organisation's properties
-- ---------------------------------------------------------------------------
alter policy share_link_properties_insert on public.share_link_properties
  with check (
    -- 0023: the link is one of the caller's organisation's
    exists (select 1 from share_links s
             where s.id = share_link_properties.share_link_id and s.org_id = (select current_org_id()))
    -- 0146: and so is the property it names (an availability link's target too)
    and exists (select 1 from properties p
                 where p.id = share_link_properties.property_id and p.org_id = (select current_org_id()))
  );

-- ---------------------------------------------------------------------------
-- 2. a share link pins only its own organisation's price list, and names
--    only its own organisation's staff member as its creator
-- ---------------------------------------------------------------------------
alter policy share_links_insert on public.share_links
  with check (
    -- 0023 (hoisted by 0100)
    org_id = (select current_org_id())
    and created_by = (select auth.uid())
    -- 0146: a pinned price list is the caller's organisation's
    and (price_list_id is null
         or exists (select 1 from price_lists pl
                     where pl.id = share_links.price_list_id and pl.org_id = (select current_org_id())))
  );

alter policy share_links_update on public.share_links
  with check (
    -- 0023 (hoisted by 0100)
    org_id = (select current_org_id())
    -- 0146: a pinned price list is the caller's organisation's
    and (price_list_id is null
         or exists (select 1 from price_lists pl
                     where pl.id = share_links.price_list_id and pl.org_id = (select current_org_id())))
    -- 0146: and so is the profile it names as its creator (the page shows it as the link's agent)
    and (created_by is null
         or exists (select 1 from profiles pf
                     where pf.id = share_links.created_by and pf.org_id = (select current_org_id())))
  );

-- ---------------------------------------------------------------------------
-- 3. the public share page reads only the link's own organisation's target,
-- tree, price list, properties and agent (0137's text; the nine edits and
-- their `-- 0146:` comment lines are this
-- file's)
-- ---------------------------------------------------------------------------
create or replace function resolve_share_link(p_token_sha256 text) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_link  share_links;
  v_today date := (now() at time zone 'Asia/Nicosia')::date;
  v_props jsonb;
  v_count int;
  -- availability (0041)
  v_target     uuid;
  v_project    properties;
  v_pl         price_lists;
  v_unit_ids   uuid[];
  v_phase_ids  uuid[];
  v_units      jsonb;
  v_phases     jsonb;
  v_unit_count int;
  v_avail      int;
  v_unpriced   int;
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

  -- ======================= availability (0041) ===============================
  if v_link.kind = 'availability' then
    -- exactly one property: the project or the phase this link names
    select slp.property_id into v_target
      from share_link_properties slp
     where slp.share_link_id = v_link.id
     order by slp.sort_order
     limit 1;

    -- 0146: the target is a property of the link's own organisation, or none
    select * into v_project from properties where id = v_target and org_id = v_link.org_id;
    -- A link whose target no longer exists is structurally broken, not merely
    -- empty, so it reads as unavailable. An ARCHIVED target is different and is
    -- NOT special-cased: its units drop out one by one and the page renders an
    -- honest empty matrix, exactly as 0023 refuses to 404 a whole proposal
    -- because one listing was retired.
    if not found then
      return null;
    end if;

    if v_link.price_list_id is not null then
      -- 0146: only a price list of the link's own organisation is read
      select * into v_pl from price_lists where id = v_link.price_list_id and org_id = v_link.org_id;
    end if;

    -- Descendants, at any depth. `depth > 0` keeps the named property itself
    -- out of its own matrix.
    with recursive tree as (
      select p.id, p.kind, 0 as depth
        from properties p
       where p.id = v_target
         -- 0146: the walk starts inside the link's own organisation...
         and p.org_id = v_link.org_id
      union all
      select c.id, c.kind, t.depth + 1
        from properties c
        join tree t on c.parent_id = t.id
       where t.depth < 8
         and c.kind in ('phase', 'unit')
         and c.visibility <> 'archived'
         -- 0146: ...and stays there: another organisation's row hung under ours is not walked
         and c.org_id = v_link.org_id
    )
    select coalesce(array_agg(t.id) filter (where t.kind = 'unit'  and t.depth > 0), '{}'::uuid[]),
           coalesce(array_agg(t.id) filter (where t.kind = 'phase' and t.depth > 0), '{}'::uuid[])
      into v_unit_ids, v_phase_ids
      from tree t;

    -- A `draft` unit is an unfinished record rather than a market statement, so
    -- it is not inventory and does not appear. Every other status does: sold
    -- and reserved rows are what an absorption picture is made of.
    select coalesce(jsonb_agg(u.j order by u.blk nulls first, u.unum, u.ref), '[]'::jsonb),
           count(*)::int,
           count(*) filter (where u.st = 'available')::int,
           count(*) filter (where u.price is null)::int
      into v_units, v_unit_count, v_avail, v_unpriced
      from (
        select jsonb_build_object(
                 'reference',        pr.reference,
                 'unit_number',      pr.unit_number,
                 'block',            pr.block,
                 'floor_number',     pr.floor_number,
                 'property_type',    pr.property_type,
                 'bedrooms',         pr.bedrooms,
                 'bathrooms',        pr.bathrooms,
                 'covered_area_sqm', pr.covered_area_sqm,
                 'veranda_sqm',      pr.veranda_sqm,
                 'status',           pr.status,
                 'price',            case when v_link.price_list_id is null
                                          then pr.asking_price else pli.list_price end,
                 'phase_reference',  case when par.kind = 'phase' then par.reference end
               ) as j,
               pr.block as blk, pr.unit_number as unum, pr.reference as ref,
               pr.status::text as st,
               case when v_link.price_list_id is null
                    then pr.asking_price else pli.list_price end as price
          from properties pr
          left join properties par on par.id = pr.parent_id
          left join price_list_items pli
                 -- 0146: the lines of the list read above, never of the link's raw id
                 on pli.price_list_id = v_pl.id
                and pli.unit_id       = pr.id
         where pr.id = any(v_unit_ids)
           and pr.status <> 'draft'
      ) u;

    -- `unpriced_count` answers ONE question: how many units the pinned version
    -- omits. In live mode a null price is not a shortfall, it is a unit with no
    -- asking price yet, and the row already says "on application" — so counting
    -- those would put a sentence about a price list on a page that has none.
    -- Found by reading the rendered page against a real 75-unit project, not by
    -- reading this function.
    if v_link.price_list_id is null then
      v_unpriced := 0;
    end if;

    -- Phase metadata, keyed by reference because a public payload exposes no
    -- internal uuids. `unique (org_id, reference)` makes that key safe.
    select coalesce(jsonb_agg(jsonb_build_object(
             'reference',           ph.reference,
             'title',               coalesce(ph.title ->> v_link.locale, ph.title ->> 'en'),
             'status',              ph.status,
             'delivery_date',       ph.delivery_date,
             'construction_status', ph.construction_status
           ) order by ph.reference), '[]'::jsonb)
      into v_phases
      from properties ph
     where ph.id = any(v_phase_ids);

    -- Same throttle as 0023: the counter is exact, the EVENT is one per link
    -- per Cyprus day. A developer refreshing on a train must not grow the
    -- evidence chain without bound, and the payload records what they were
    -- shown on the day, which is the granularity a later dispute argues over.
    --
    -- (The first draft of this comment used a word from the forbidden-column
    -- list below and the assertion block rejected the whole migration. The
    -- guard is a substring match on `prosrc` and cannot tell prose from SQL —
    -- that is the cost of it being impossible to talk your way past.)
    if not exists (
      select 1 from events
       where entity_type = 'share_link'
         and entity_id   = v_link.id
         and event_type  = 'opened'
         -- 0137: only this organisation's own system line (a null actor) counts
         and org_id      = v_link.org_id
         and actor_id    is null
         and (occurred_at at time zone 'Asia/Nicosia')::date = v_today
    ) then
      insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
      values (v_link.org_id, null, 'share_link', v_link.id, 'opened',
              jsonb_build_object('kind', 'availability', 'locale', v_link.locale,
                                 'unit_count', v_unit_count, 'available_count', v_avail));
    end if;

    return jsonb_build_object(
      'kind',            'availability',
      'title',           v_link.title,
      'message',         v_link.message,
      'locale',          v_link.locale,
      'expires_at',      v_link.expires_at,
      'project', jsonb_build_object(
        'reference',           v_project.reference,
        'kind',                v_project.kind,
        'title',               coalesce(v_project.title ->> v_link.locale,
                                        v_project.title ->> 'en'),
        'short_description',   coalesce(v_project.short_description ->> v_link.locale,
                                        v_project.short_description ->> 'en'),
        'public_description',  coalesce(v_project.public_description ->> v_link.locale,
                                        v_project.public_description ->> 'en'),
        'property_type',       v_project.property_type,
        'currency',            v_project.currency,
        'energy_class',        v_project.energy_class,
        'features',            to_jsonb(v_project.features),
        'delivery_date',       v_project.delivery_date,
        'construction_status', v_project.construction_status,
        'district', (select coalesce(d.name ->> v_link.locale, d.name ->> 'en')
                       from districts d where d.id = v_project.district_id),
        'area',     (select coalesce(a.name ->> v_link.locale, a.name ->> 'en')
                       from areas a where a.id = v_project.area_id)
      ),
      'phases',          v_phases,
      'units',           v_units,
      'unit_count',      v_unit_count,
      'available_count', v_avail,
      'unpriced_count',  v_unpriced,
      'price_source',    case when v_link.price_list_id is null then 'live' else 'price_list' end,
      'price_list',      case when v_pl.id is null then null::jsonb
                              else jsonb_build_object('version', v_pl.version,
                                                      'effective_date', v_pl.effective_date) end,
      'agent', (
        select jsonb_build_object('name', pf.full_name, 'email', pf.email, 'phone', pf.phone_e164)
          -- 0146: only a member of the link's own organisation is shown as its agent
          from profiles pf where pf.id = v_link.created_by and pf.org_id = v_link.org_id),
      'org', (
        select jsonb_build_object('name', o.name) from organizations o where o.id = v_link.org_id)
    );
  end if;
  -- ===================== end availability (0041) =============================

  -- 0146: every linked row of the link's own organisation, archived ones
  -- included (the page reports the shortfall); another organisation's is not
  select count(*) into v_count
    from share_link_properties slp
   where slp.share_link_id = v_link.id
     and exists (select 1 from properties p
                  where p.id = slp.property_id and p.org_id = v_link.org_id);

  -- throttle: one `opened` event per link per Cyprus day (see header)
  if not exists (
    select 1 from events
     where entity_type = 'share_link'
       and entity_id   = v_link.id
       and event_type  = 'opened'
       -- 0137: only this organisation's own system line (a null actor) counts
       and org_id      = v_link.org_id
       and actor_id    is null
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
        -- 0146: only the link's own organisation's properties are shown
        join properties pr on pr.id = slp.property_id and pr.org_id = v_link.org_id
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
        -- 0146: only a member of the link's own organisation is shown as its agent
        from profiles pf where pf.id = v_link.created_by and pf.org_id = v_link.org_id),
    'org', (
      select jsonb_build_object('name', o.name) from organizations o where o.id = v_link.org_id)
  );
end $fn$;

-- `create or replace function` PRESERVES the existing ACL (HANDOFF §3) — it
-- does not reset grants — so 0023's revoke-from-public and the anon grant both
-- still stand. Restated anyway rather than assumed, and re-read in the
-- assertion block below. `resolve_share_link` remains the deliberate, pinned
-- exception to 0007's lockdown (scripts/backup/verify-restore.sql).
revoke execute on function resolve_share_link(text) from public;
grant  execute on function resolve_share_link(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Postflight: the body as written, its predicates, 0137's throttles, 0041's
-- exposure guard, the definer's shape and ACL, the three policies exactly
-- ---------------------------------------------------------------------------
do $$
declare
  v_sig constant text := 'public.resolve_share_link(text)';
  v_src text;
  v_md5 text;
  v_txt text;
  bad   text;
begin
  select regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), md5(replace(p.prosrc, E'\r', '')) into v_src, v_md5
    from pg_proc p
   where p.oid = to_regprocedure(v_sig) and p.prosecdef
     and pg_get_userbyid(p.proowner) = 'postgres'
     and p.proconfig = array['search_path=public']
     and p.provolatile = 'v'
     and p.prorettype = 'jsonb'::regtype;
  if v_src is null then
    raise exception '0146 postflight: resolve_share_link is not the volatile definer owned by postgres with search_path public returning jsonb';
  end if;
  if (select count(*) from pg_proc p
       where p.pronamespace = 'public'::regnamespace and p.proname = 'resolve_share_link') <> 1 then
    raise exception '0146 postflight: resolve_share_link is overloaded';
  end if;

  -- the nine predicates (header, THE FIX 3), comments stripped — each guard
  -- below runs BEFORE the md5 pin, so each can be seen to refuse on its own
  if v_src !~ 'select \* into v_project from properties where id = v_target and org_id = v_link\.org_id;'
     or v_src !~ 'select \* into v_pl from price_lists where id = v_link\.price_list_id and org_id = v_link\.org_id;'
     or v_src !~ 'where p\.id = v_target\s+and p\.org_id = v_link\.org_id\s+union all'
     or v_src !~ 'and c\.visibility <> ''archived''\s+and c\.org_id = v_link\.org_id\s+\)'
     or v_src !~ 'on pli\.price_list_id = v_pl\.id\s+and pli\.unit_id\s+= pr\.id'
     or v_src ~ 'pli\.price_list_id\s*=\s*v_link\.price_list_id'
     or v_src !~ 'select count\(\*\) into v_count\s+from share_link_properties slp\s+where slp\.share_link_id = v_link\.id\s+and exists \(select 1 from properties p\s+where p\.id = slp\.property_id and p\.org_id = v_link\.org_id\);'
     or v_src !~ 'join properties pr on pr\.id = slp\.property_id and pr\.org_id = v_link\.org_id'
     or regexp_count(v_src, 'from profiles pf where pf\.id = v_link\.created_by and pf\.org_id = v_link\.org_id\)') <> 2
     or v_src ~ 'pf\.id = v_link\.created_by\)' then
    raise exception '0146 postflight: resolve_share_link does not carry every organisation predicate this file writes';
  end if;

  -- 0137's two throttles, kept
  if regexp_count(v_src, 'event_type\s+=\s+''opened''\s+and org_id\s+=\s+v_link\.org_id\s+and actor_id\s+is null') <> 2 then
    raise exception '0146 postflight: the two `opened` throttles are not both bounded by the link''s organisation and a null actor (0137)';
  end if;

  -- 0041's EXPOSURE GUARD, on the body as it now is (comments included)
  foreach bad in array array['owner_net_price', 'min_acceptable_price', 'internal_notes',
                             'amenities_notes', 'title_deed_status', 'postal_code',
                             'owner_contact_id', 'developer_contact_id', 'commission']
  loop
    if (select prosrc from pg_proc where oid = to_regprocedure(v_sig)) like '%' || bad || '%' then
      raise exception '0146 postflight: resolve_share_link names the forbidden column %', bad;
    end if;
  end loop;

  select p.proacl::text into v_txt from pg_proc p where p.oid = to_regprocedure(v_sig);
  if v_txt is distinct from '{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}' then
    raise exception '0146 postflight: resolve_share_link''s ACL changed (%)', coalesce(v_txt, 'default');
  end if;

  -- and the body is exactly this file's (last: any edit the guards above miss)
  if v_md5 is distinct from 'aa14a6657e4414b83c9c5b21a9fc521a' then
    raise exception '0146 postflight: resolve_share_link''s body is not this file''s (md5 %)', v_md5;
  end if;

  -- the three policies, exactly
  if (select count(*) from pg_policy p
       where p.polrelid = 'public.share_link_properties'::regclass and p.polname = 'share_link_properties_insert'
         and p.polcmd = 'a' and p.polpermissive and p.polroles = array[0::oid] and p.polqual is null
         and pg_get_expr(p.polwithcheck, p.polrelid) = E'((EXISTS ( SELECT 1\n   FROM share_links s\n  WHERE ((s.id = share_link_properties.share_link_id) AND (s.org_id = ( SELECT current_org_id() AS current_org_id))))) AND (EXISTS ( SELECT 1\n   FROM properties p\n  WHERE ((p.id = share_link_properties.property_id) AND (p.org_id = ( SELECT current_org_id() AS current_org_id))))))') <> 1 then
    raise exception '0146 postflight: share_link_properties_insert is not this file''s check';
  end if;
  if (select count(*) from pg_policy p
       where p.polrelid = 'public.share_links'::regclass and p.polname = 'share_links_insert'
         and p.polcmd = 'a' and p.polpermissive and p.polroles = array[0::oid] and p.polqual is null
         and pg_get_expr(p.polwithcheck, p.polrelid) = E'((org_id = ( SELECT current_org_id() AS current_org_id)) AND (created_by = ( SELECT auth.uid() AS uid)) AND ((price_list_id IS NULL) OR (EXISTS ( SELECT 1\n   FROM price_lists pl\n  WHERE ((pl.id = share_links.price_list_id) AND (pl.org_id = ( SELECT current_org_id() AS current_org_id)))))))') <> 1 then
    raise exception '0146 postflight: share_links_insert is not this file''s check';
  end if;
  if (select count(*) from pg_policy p
       where p.polrelid = 'public.share_links'::regclass and p.polname = 'share_links_update'
         and p.polcmd = 'w' and p.polpermissive and p.polroles = array[0::oid]
         and pg_get_expr(p.polqual, p.polrelid) = '((org_id = ( SELECT current_org_id() AS current_org_id)) AND ((created_by = ( SELECT auth.uid() AS uid)) OR (( SELECT current_role_gnk() AS current_role_gnk) = ''admin''::user_role)))'
         and pg_get_expr(p.polwithcheck, p.polrelid) = E'((org_id = ( SELECT current_org_id() AS current_org_id)) AND ((price_list_id IS NULL) OR (EXISTS ( SELECT 1\n   FROM price_lists pl\n  WHERE ((pl.id = share_links.price_list_id) AND (pl.org_id = ( SELECT current_org_id() AS current_org_id)))))) AND ((created_by IS NULL) OR (EXISTS ( SELECT 1\n   FROM profiles pf\n  WHERE ((pf.id = share_links.created_by) AND (pf.org_id = ( SELECT current_org_id() AS current_org_id)))))))') <> 1 then
    raise exception '0146 postflight: share_links_update is not this file''s policy (its USING is 0100''s)';
  end if;
  if (select count(*) from pg_policy p
       where p.polrelid = 'public.share_link_properties'::regclass and p.polpermissive and p.polcmd in ('a', '*')) <> 1
     or (select count(*) from pg_policy p
          where p.polrelid = 'public.share_links'::regclass and p.polpermissive and p.polcmd in ('a', '*')) <> 1
     or (select count(*) from pg_policy p
          where p.polrelid = 'public.share_links'::regclass and p.polpermissive and p.polcmd in ('w', '*')) <> 1 then
    raise exception '0146 postflight: a permissive INSERT / UPDATE policy sits beside the three this file binds (permissive policies OR together)';
  end if;
  if (select count(*) from pg_policy p
       where p.polrelid in ('public.share_links'::regclass, 'public.share_link_properties'::regclass))::text
     is distinct from current_setting('gnk.m0146_policies', true) then
    raise exception '0146 postflight: the policy count on share_links / share_link_properties moved';
  end if;
  if exists (select 1 from pg_policy p
              where p.polrelid = 'public.share_link_properties'::regclass and p.polpermissive and p.polcmd in ('w', '*'))
     or has_table_privilege('authenticated', 'public.share_link_properties', 'update')
     or has_table_privilege('anon', 'public.share_link_properties', 'update') then
    raise exception '0146 postflight: share_link_properties has an UPDATE path';
  end if;

  raise notice '0146: postflight passed — a share link names, pins and shows only its own organisation''s properties, price list and agent';
  raise notice '0146: existing rows (read-only, nothing changed) — %', current_setting('gnk.m0146_existing', true);
end $$;

-- EXISTING ROWS (header) — read-only, nothing repaired; the file's LAST result
select current_setting('gnk.m0146_existing', true) as existing_rows;
