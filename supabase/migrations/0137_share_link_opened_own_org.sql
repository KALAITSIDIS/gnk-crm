-- =============================================================================
-- 0137 — a share link's once-a-day `opened` line is throttled only by its own
--        organisation's system line
--
-- THE GAP (BACKLOG "`resolve_share_link`'s once-a-day `opened` throttle counts
-- an `opened` event of any organisation and any actor for the link id", split
-- out of T-redact-notes-own-org and corrected by its review; re-verified
-- 2026-10-03 on the local stack at 0136 by
-- supabase/tests/share-link-opened-own-org.test.ts, pinned RED first —
-- DECISIONS T-share-link-opened-own-org has the count):
--
--   * resolve_share_link() (latest 0041; the SECURITY DEFINER every public
--     share page calls, anon included) counts the view and writes ONE
--     `opened` event per link per Cyprus day — the evidence a later dispute
--     argues over. Both throttle blocks (the availability branch and the
--     proposal branch) skip the write when an `opened` share_link event for
--     the link's id already exists today, matched by entity_type, entity_id,
--     event_type and day ONLY — no organisation, no actor. `events_insert`
--     lets any aal2 session write an `opened` share_link event in its OWN
--     organisation at any entity_id: another organisation that knows one of
--     our live link ids suppresses our system line for that day, and a staff
--     session of our own organisation can pre-empt it with a payload of its
--     choosing; a link inserted at an id whose `opened` history is another
--     organisation's (0133 lets that id through) loses it too. No row of
--     another organisation is written — a missing evidence line. Hosted on
--     2026-10-03 (read-only): one organisation — nothing was reached.
--
-- THE FIX: the same function — 0041's text byte for byte, but
-- `and org_id = v_link.org_id and actor_id is null` (with a comment line) in
-- BOTH throttle blocks: only this organisation's own system line (the
-- function writes it with a null actor) stops today's write. CREATE OR
-- REPLACE keeps the oid, the owner (postgres) and the grants; SECURITY
-- DEFINER and `search_path = public` are restated as 0041 wrote them, and so
-- are 0041's grants (revoke from public; execute to anon, authenticated and
-- the service role — the deliberate exception to 0007's lockdown).
--
-- CONTRACT. Signature, return (the payload), the view counter, every write
-- and the payloads unchanged; types identical; no release-compat entry. NOT
-- deploy-coupled: hosted 0137 first, then merge.
--
-- LOCKS: CREATE OR REPLACE FUNCTION takes no table lock (a call already
-- running keeps the old body to its end); the closing diagnostic reads events
-- and share_links (ACCESS SHARE). ONE transaction (checked below). Apply in
-- the usual window.
--
-- PREFLIGHT refuses, changing nothing, unless resolve_share_link is the only
-- function of that name, its body exactly 0041's (md5, carriage returns
-- ignored — hosted's read 2026-10-03 is identical), SECURITY DEFINER, owned by
-- postgres, `search_path=public`, executable by anon, authenticated and the
-- service role.
--
-- POSTFLIGHT re-runs 0041's EXPOSURE GUARD on the new body (none of the
-- forbidden column names may appear in it — the list is in 0041's header,
-- deliberately NOT repeated inside the function), checks both throttles carry
-- both predicates, and the grants.
--
-- EXISTING ROWS — READ-ONLY DIAGNOSTIC, NO REPAIR (the file's last row):
--   opened_events_across_orgs   `opened` share_link events whose organisation
--                               is not the link's;
--   opened_events_by_a_session  `opened` share_link events with an actor (the
--                               system writes them with none).
-- Either is a line the throttle will no longer honour; an operator decision.
--
-- NOT CHANGED: who may call it; what it returns; the view counter; anything
-- else in the function.
--
-- ROLLBACK, a forward migration in one transaction: restore 0041's function
-- text and grants (supabase/tests/revert-0137.ts slices exactly that from
-- 0041's file, and the test file replays it). In the same change: delete the
-- test file and helper; remove the restore pack's 0137 row and move its
-- migrations pin FORWARD; restore the BACKLOG entry. No data moves.
--
-- Pins that move with this file: scripts/backup/verify-restore.sql (the
-- migrations count, the 0137 SECURITY row).
-- =============================================================================

set local lock_timeout = '5s';

do $$
begin
  if current_setting('lock_timeout') <> '5s' then
    raise exception '0137 aborted: this file must run as ONE transaction (SET LOCAL lock_timeout did not take effect) — nothing was changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Preflight: the function is exactly what this file was written against
-- ---------------------------------------------------------------------------
do $$
declare
  v_sig constant text := 'public.resolve_share_link(text)';
  v_md5 text;
begin
  if (select count(*) from pg_proc p
       where p.pronamespace = 'public'::regnamespace and p.proname = 'resolve_share_link') <> 1 then
    raise exception '0137 aborted: resolve_share_link is missing or overloaded — nothing was changed';
  end if;
  select md5(replace(p.prosrc, E'\r', '')) into v_md5
    from pg_proc p
   where p.oid = to_regprocedure(v_sig) and p.prosecdef
     and pg_get_userbyid(p.proowner) = 'postgres'
     and p.proconfig = array['search_path=public'];
  if v_md5 is distinct from '529134eb853faf9aa3b0c9a63257a35e' then
    raise exception '0137 aborted: resolve_share_link is not 0041''s definer body (md5 %) — nothing was changed', coalesce(v_md5, 'missing or not the definer it was');
  end if;
  if not (has_function_privilege('anon', v_sig, 'execute') and has_function_privilege('authenticated', v_sig, 'execute')
          and has_function_privilege('service_role', v_sig, 'execute')) then
    raise exception '0137 aborted: resolve_share_link''s grants are not 0041''s (anon, authenticated, service_role) — nothing was changed';
  end if;
  raise notice '0137: preflight passed — resolve_share_link is 0041''s definer body with 0041''s grants';
end $$;

-- ---------------------------------------------------------------------------
-- The public share page, its `opened` throttle bounded by the link's own
-- organisation's system line (0041's text; the two predicates in each
-- throttle and their comment lines are this file's)
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

    select * into v_project from properties where id = v_target;
    -- A link whose target no longer exists is structurally broken, not merely
    -- empty, so it reads as unavailable. An ARCHIVED target is different and is
    -- NOT special-cased: its units drop out one by one and the page renders an
    -- honest empty matrix, exactly as 0023 refuses to 404 a whole proposal
    -- because one listing was retired.
    if not found then
      return null;
    end if;

    if v_link.price_list_id is not null then
      select * into v_pl from price_lists where id = v_link.price_list_id;
    end if;

    -- Descendants, at any depth. `depth > 0` keeps the named property itself
    -- out of its own matrix.
    with recursive tree as (
      select p.id, p.kind, 0 as depth
        from properties p
       where p.id = v_target
      union all
      select c.id, c.kind, t.depth + 1
        from properties c
        join tree t on c.parent_id = t.id
       where t.depth < 8
         and c.kind in ('phase', 'unit')
         and c.visibility <> 'archived'
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
                 on pli.price_list_id = v_link.price_list_id
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
          from profiles pf where pf.id = v_link.created_by),
      'org', (
        select jsonb_build_object('name', o.name) from organizations o where o.id = v_link.org_id)
    );
  end if;
  -- ===================== end availability (0041) =============================

  select count(*) into v_count
    from share_link_properties where share_link_id = v_link.id;

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

-- `create or replace function` PRESERVES the existing ACL (HANDOFF §3) — it
-- does not reset grants — so 0023's revoke-from-public and the anon grant both
-- still stand. Restated anyway rather than assumed, and re-read in the
-- assertion block below. `resolve_share_link` remains the deliberate, pinned
-- exception to 0007's lockdown (scripts/backup/verify-restore.sql).
revoke execute on function resolve_share_link(text) from public;
grant  execute on function resolve_share_link(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Postflight: the shape kept, both throttles bounded, 0041's exposure guard
-- ---------------------------------------------------------------------------
do $$
declare
  v_sig constant text := 'public.resolve_share_link(text)';
  v_src text;
  bad   text;
begin
  select regexp_replace(p.prosrc, '--[^\n]*', '', 'g') into v_src
    from pg_proc p
   where p.oid = to_regprocedure(v_sig) and p.prosecdef
     and pg_get_userbyid(p.proowner) = 'postgres'
     and p.proconfig = array['search_path=public']
     and p.prorettype = 'jsonb'::regtype;
  if v_src is null then
    raise exception '0137 postflight: resolve_share_link is not the definer owned by postgres with search_path public returning jsonb';
  end if;
  if regexp_count(v_src, 'event_type\s+=\s+''opened''\s+and org_id\s+=\s+v_link\.org_id\s+and actor_id\s+is null') <> 2 then
    raise exception '0137 postflight: the two `opened` throttles are not both bounded by the link''s organisation and a null actor';
  end if;
  -- 0041's EXPOSURE GUARD, on the body as it now is
  foreach bad in array array['owner_net_price', 'min_acceptable_price', 'internal_notes',
                             'amenities_notes', 'title_deed_status', 'postal_code',
                             'owner_contact_id', 'developer_contact_id', 'commission']
  loop
    if (select prosrc from pg_proc where oid = to_regprocedure(v_sig)) like '%' || bad || '%' then
      raise exception '0137 postflight: resolve_share_link names the forbidden column %', bad;
    end if;
  end loop;
  if not (has_function_privilege('anon', v_sig, 'execute') and has_function_privilege('authenticated', v_sig, 'execute')
          and has_function_privilege('service_role', v_sig, 'execute')) then
    raise exception '0137 postflight: resolve_share_link''s grants changed';
  end if;
  raise notice '0137: postflight passed — only the link''s own organisation''s system line throttles today''s `opened` write';
end $$;

-- EXISTING ROWS (header) — read-only, nothing repaired; the file's LAST result
select format('opened_events_across_orgs=%s opened_events_by_a_session=%s',
              count(*) filter (where e.org_id <> l.org_id),
              count(*) filter (where e.actor_id is not null)) as existing_rows
  from public.events e
  join public.share_links l on l.id = e.entity_id
 where e.entity_type = 'share_link' and e.event_type = 'opened';
