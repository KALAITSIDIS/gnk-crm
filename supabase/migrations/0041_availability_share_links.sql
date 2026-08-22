-- 0041 — project availability share links (HANDOFF §0a, BACKLOG "Project
-- availability share link, M").
--
-- Today a developer or a partner agent is sent yesterday's availability as a
-- PDF. `share_links` already mints, opens, throttles, counts and revokes a
-- tokenised page with full evidence; this points that same machinery at a
-- PROJECT so they open a LIVE unit matrix instead. Read 0023 first — it is the
-- design, and almost nothing here is new machinery.
--
-- WHAT THIS MIGRATION IS NOT: it is not a new table. `share_link_properties`
-- already joins a link to properties and an availability link names exactly one
-- (the project or the phase). **So the revoke-before-grant rule that 0039 broke
-- and 0040 corrected has nothing to bite on here** — that is stated rather than
-- left silent, because "no revoke in this migration" should read as a checked
-- fact and not as an omission. The one new COLUMN is covered by 0023's existing
-- table-level grant to `authenticated`; column privileges follow the table.
--
-- ---------------------------------------------------------------------------
-- THE EXPOSURE BOUNDARY MOVES HERE, DELIBERATELY, AND ONLY FOR THE NEW KIND
-- ---------------------------------------------------------------------------
-- 0023's proposal allowlist omits `status` on purpose. An availability matrix
-- exists to show `status` — "40 available · 12 sold" IS the product — so for
-- `kind = 'availability'` it is exposed, and for `kind = 'proposal'` it is
-- still not. RLS test 29 asserts BOTH halves of that sentence against the same
-- project, which is the only way to prove the widening is scoped rather than
-- global.
--
-- `visibility` does NOT move, for either kind, and the difference from `status`
-- is the point. Status is market truth about a unit: can this flat be bought.
-- Visibility is the desk's channel strategy — `off_market`, `vip`, `partner` —
-- which tells a reader nothing about availability while inviting exactly the
-- questions the desk does not want asked.
--
-- Still forbidden for BOTH kinds, unchanged from 0023: the owner net and
-- minimum acceptable prices, internal notes, amenity notes, VAT and deed
-- status, address/postal code/coordinates, any mandate, commission, the owner
-- or developer contact, KYC, documents. The assertion block at the foot of this
-- file greps the compiled function body for those column names, so **do not
-- name them in a comment INSIDE the function** — `prosrc` would carry the
-- comment and the guard would fire on its own documentation.
--
-- New relative to the proposal allowlist, and why each is defensible: `status`
-- (above); `delivery_date` and `construction_status` (BACKLOG finding 10
-- shipped both as public-facing facts about an off-plan unit, and delivery is
-- the first question anybody asks); `veranda_sqm`, `floor_number`, `block`,
-- `unit_number` (the matrix's own axes, and none of them is a secret from
-- somebody being invited to sell the units).
--
-- ---------------------------------------------------------------------------
-- A PHASED PROJECT'S UNITS HANG OFF THE PHASE, NOT THE PROJECT
-- ---------------------------------------------------------------------------
-- `app/(app)/properties/[id]/units/page.tsx` reads `parent_id = <project>` and
-- is right to: staff navigate INTO a phase to see its units. A share link has
-- no "navigate into", so the same query would hand a developer an empty matrix
-- for exactly the projects big enough to need one. Phases shipped 2026-08-21,
-- so this is a live trap and not a hypothetical.
--
-- The resolver therefore walks DESCENDANTS, not children: every `kind = 'unit'`
-- beneath the named property, each tagged with the phase it belongs to. Four
-- consequences, all wanted:
--   * a link naming a phased project shows every phase's units — one link, the
--     whole development;
--   * a link may name a PHASE and the same code serves it, which is the scoping
--     control: to share Phase 2 only, mint a Phase 2 link. No extra column;
--   * a phase created after minting appears by itself. Live is the feature;
--   * units carry `phase_reference` so the page can group them. That is not
--     cosmetic — a phase's delivery date is its OWN, severed from the project
--     at creation (BACKLOG finding 11), so a flat table would put a 2028 and a
--     2029 handover in one list with nothing to tell them apart.
--
-- The walk is RECURSIVE rather than hardcoded to depth 2. "A phase cannot
-- contain a phase" is enforced in `createPhase`, NOT in the database —
-- `phase_has_parent` (0001) only requires the parent to be non-null. A depth-2
-- query would silently drop the units under a nested phase that arrived by SQL
-- or by a future action. The depth ceiling is a runaway guard, since
-- `parent_id` is a self-reference with nothing forbidding a cycle.
--
-- ---------------------------------------------------------------------------
-- WHICH PRICE IS THE HONEST ONE
-- ---------------------------------------------------------------------------
-- `properties.asking_price` is today's number; a `price_lists` version records
-- what was actually quoted. A link may pin one, and then PINNED MEANS PINNED: a
-- unit absent from that version shows NO price rather than falling back to the
-- live one, because silently mixing the two defeats the only reason to pin.
-- The payload carries `unpriced_count` so the page can say so out loud.
--
-- `on delete restrict` is deliberate. `price_lists_delete` (0002) permits
-- deleting any non-latest version, and a version somebody was quoted must not
-- vanish out from under a live link. Nothing in the app deletes price lists
-- today, so this closes a hole rather than breaking a flow.
--
-- NO EXPLICIT begin/commit — the CLI wraps the file (HANDOFF §3).

-- ---------- 1. the discriminator ---------------------------------------------
-- 0023 wrote `check (kind in ('proposal'))` and called the widening out in its
-- own comment. Postgres stored it simplified to `kind = 'proposal'`; drop by
-- name and restate rather than trying to edit it.
alter table public.share_links drop constraint if exists share_links_kind_check;
alter table public.share_links add constraint share_links_kind_check
  check (kind in ('proposal', 'availability'));

-- ---------- 2. the optional pinned price list --------------------------------
alter table public.share_links
  add column if not exists price_list_id uuid
  references public.price_lists(id) on delete restrict;

comment on column public.share_links.price_list_id is
  'Availability links only. NULL = live asking price. Set = that version''s quoted prices, with no fallback for units the version does not list (0041).';

-- ---------- 3. the resolver --------------------------------------------------
-- ONE anon-callable function, branched on `kind`, rather than a second RPC. The
-- public page holds only a token hash and cannot know the kind before it
-- resolves; two functions would force try-one-then-the-other, which leaks the
-- kind through behaviour, or encoding the kind into the token, which is worse.
-- One function also keeps 0023's rule intact — the allowlist is enumerated
-- HERE, in SQL — and strengthens it: both allowlists now sit side by side in
-- one body where a reviewer reads them together.
--
-- THE PROPOSAL PATH BELOW IS 0023's, UNTOUCHED, AT ITS ORIGINAL INDENTATION.
-- The availability branch early-returns above it. That is why RLS test 25 needs
-- no edit and keeps proving the old boundary byte for byte, and it is worth the
-- one asymmetry it buys: the availability payload carries a `kind` key and the
-- proposal payload does not, so `app/p/[token]` dispatches on its presence.
-- Adding `kind` to both would have been tidier and would have required editing
-- the very test that guards the boundary that must not move.

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

-- ---------- 4. assertions ----------------------------------------------------
do $$
declare
  src text;
  acl text;
  bad text;
begin
  -- The discriminator accepts exactly the two kinds and nothing else. The probe
  -- needs a real org to reference; skipping it on an org-less database is
  -- deliberate, because "0 rows inserted" would otherwise read as "the
  -- constraint let it through" and raise a false alarm.
  if exists (select 1 from organizations) then
    begin
      insert into share_links (org_id, kind, token_sha256, expires_at)
      select id, 'lawyer_pack', '0041-probe', now() + interval '1 day'
        from organizations limit 1;
      raise exception '0041 aborted: share_links_kind_check admitted an unknown kind';
    exception when check_violation then
      null;
    end;
  end if;

  if (select count(*) from pg_constraint
       where conrelid = 'public.share_links'::regclass
         and conname  = 'share_links_kind_check'
         and pg_get_constraintdef(oid) like '%availability%') <> 1 then
    raise exception '0041 aborted: share_links_kind_check does not admit availability';
  end if;

  -- the pinned price list cannot be deleted out from under a live link
  if (select confdeltype from pg_constraint c
       where c.conrelid = 'public.share_links'::regclass
         and c.contype  = 'f'
         and c.confrelid = 'public.price_lists'::regclass) is distinct from 'r' then
    raise exception '0041 aborted: price_list_id is not ON DELETE RESTRICT';
  end if;

  -- THE EXPOSURE GUARD. The compiled body must not name a forbidden column, for
  -- either kind. This is why the forbidden list lives in the file header and
  -- never inside the function — prosrc would carry the comment and this would
  -- fire on its own documentation.
  select prosrc into src from pg_proc
   where proname = 'resolve_share_link' and pronamespace = 'public'::regnamespace;
  foreach bad in array array['owner_net_price', 'min_acceptable_price', 'internal_notes',
                             'amenities_notes', 'title_deed_status', 'postal_code',
                             'owner_contact_id', 'developer_contact_id', 'commission']
  loop
    if src like '%' || bad || '%' then
      raise exception '0041 aborted: resolve_share_link names the forbidden column %', bad;
    end if;
  end loop;

  -- anon may still call it, and PUBLIC still may not (0007)
  if not has_function_privilege('anon', 'public.resolve_share_link(text)', 'execute') then
    raise exception '0041 aborted: anon lost execute on resolve_share_link';
  end if;
  if has_function_privilege('public', 'public.resolve_share_link(text)', 'execute') then
    raise exception '0041 aborted: PUBLIC holds execute on resolve_share_link';
  end if;

  -- and no table grant moved: anon still reaches share_links only through the RPC
  if has_table_privilege('anon', 'public.share_links', 'select')
     or has_table_privilege('anon', 'public.share_links', 'insert')
     or has_table_privilege('anon', 'public.share_link_properties', 'select') then
    raise exception '0041 aborted: anon holds a table grant it must not have';
  end if;

  select relacl::text into acl from pg_class where relname = 'share_links';
  raise notice '0041 ok: kind widened, price_list_id added, share_links acl %', acl;
end $$;
