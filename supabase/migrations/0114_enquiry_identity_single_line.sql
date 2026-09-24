-- =============================================================================
-- 0114 — one line each: the enquiry doors refuse a line break in a value they
--        write onto one line of the header (T-enquiry-identity-single-line;
--        the enquiry-validation audit of e980575)
--
-- CONFIRMED, reproduced against 0113 with the real functions and the real
-- reader (supabase/tests/enquiry-single-line.test.ts): both doors write the
-- visitor's name, e-mail, phone and typed reference RAW onto one line each of
-- the block in `leads.message` —
--
--   Website enquiry
--   Name: …
--   Email: …
--   Phone: …
--   About: …
--   <blank>
--   <the visitor's own words>
--
-- — and everything that needs to know WHO enquired reads it back from those
-- lines (lib/services/lead-contact.ts): the desk alert's Reply-To, the
-- escalation, "Possible existing contact", "Create contact". Nothing refused
-- a line break inside a value, so one wrote a header line of its own:
--   A  p_phone '+35799123456' || chr(10) || 'Email: other@x.invalid' read back
--      as the e-mail other@x.invalid, not the e-mail the visitor gave;
--   B  a five-line p_name pushed the real Email and Phone lines out of the
--      reader's window — read back with no e-mail and no phone;
--   and a typed reference carrying 'Email: …' wrote an Email line after About.
-- Measured before this migration: submit_public_enquiry accepted all 37 of
-- the test's variants; submit_proposal_interest 27 of 36 (the other 9 only
-- because a reference with a break matched no property). properties.reference
-- has no shape rule, though, so a proposal CAN hold a reference with a break,
-- and 0106 would have written it onto the About line; the self-test below
-- plants one, and the new check is what refuses it.
--
-- THE RULE, in both functions and before anything is looked up or written:
-- p_name, p_email, p_phone and p_property_ref must not contain a line break —
-- Unicode's mandatory breaks, LF VT FF CR NEL LS PS, the set
-- lib/validators/single-line.ts refuses at the routes. A refusal is what
-- every other bad input already gets here: zero rows, and no lead, no event,
-- no notification job. The function trims SPACES only, as it always has, so
-- a break at either end of a value is refused too (the routes trim it away
-- before calling; a direct caller must). p_message is written BELOW the
-- header and stays multiline; p_meta goes to criteria, not the header.
--
-- REFUSE, NOT NORMALISE. BACKLOG's note on this defect suggested collapsing
-- CR/LF to a space at the door. That was a suggestion in a findings list, not
-- a decision (no DECISIONS entry adopts it), and it would store a value the
-- visitor did not type — a phone of '+357 99' || chr(10) || 'Email: x@y'
-- becomes the "phone" '+357 99 Email: x@y'. No real name or number contains
-- a line break (a browser's one-line input cannot even hold one), so the
-- only callers who meet the refusal are scripts, and they are told why.
--
-- UNCHANGED: both signatures and return shapes, SECURITY DEFINER with
-- search_path = public, EXECUTE for service_role alone, org resolution by
-- slug, the token-digest proposal lookup and property membership, the
-- idempotency replay and its race handling, the routing and proposal-owner
-- assignment, the events' shape, the desk-alert row in the lead's
-- transaction, and the block's format byte for byte (the self-test below
-- compares whole messages). Every line of both bodies is 0101's / 0106's
-- except the declaration of v_breaks and the four checks.
--
-- DEPLOY ORDER — either order is safe; the repo's (hosted migration, then
-- merge) is the one to use. Neither the parameters nor the return shape
-- move, so this is not deploy-coupled (see release-compat):
--   * new database, old app: the old routes pass a line break through and
--     get zero rows back, so they answer with their existing refusal — the
--     website door's 400 "Unknown `org`." and the proposal door's 404 — a
--     misleading sentence for a script's post until the app deploys, and
--     nothing written;
--   * new app, old database: the routes refuse with the field-specific 400
--     before calling; only a direct service_role call is unprotected until
--     this applies.
-- ROLLBACK is a forward migration re-creating both functions from 0101's and
-- 0106's bodies verbatim (the house stance, T-audit-2026-09-21-evening). It
-- reopens the direct-call path only; the routes keep refusing, and the
-- stricter reader stays — it refuses to guess, which is safe with either
-- body. No data moves either way, and no stored row is rewritten by this.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The website door: 0101's body, plus v_breaks and the four checks
-- ---------------------------------------------------------------------------
create or replace function public.submit_public_enquiry(
  p_org_slug        text,
  p_name            text,
  p_email           text,
  p_phone           text,
  p_message         text,
  p_property_ref    text default null,
  p_idempotency_key text default null,
  p_meta            jsonb default null
)
returns table (lead_id uuid, lead_org_id uuid, replayed boolean)
language plpgsql security definer set search_path = public as $fn$
declare
  v_org_id      uuid;
  v_property_id uuid;
  -- what the caller typed: reaches `message` only
  v_ref         text := nullif(btrim(coalesce(p_property_ref, '')), '');
  -- what the database knows: the one value allowed into criteria and the event
  v_listing_ref text;
  v_name        text := nullif(btrim(coalesce(p_name, '')), '');
  v_email       text := nullif(btrim(coalesce(p_email, '')), '');
  v_phone       text := nullif(btrim(coalesce(p_phone, '')), '');
  v_message     text := nullif(btrim(coalesce(p_message, '')), '');
  v_key         text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_lead_id     uuid;
  v_body        text;
  -- THE ALLOWLIST: key -> cap. Mirrors lib/services/enquiry-meta.ts
  -- ENQUIRY_META_KEYS key for key and cap for cap; the site's FIELD_CAPS are
  -- the source. Change both or neither.
  v_caps        jsonb := '{
    "looking_to":40, "budget":40, "buy_area":80, "buy_property_type":40,
    "bedrooms_min":20, "deed_required":40, "buy_timing":40,
    "district":60, "area":80, "property_type":40, "bedrooms":20,
    "covered_area_sqm":20, "plot_area_sqm":20, "year_built":20,
    "title_deed_status":40, "listed_elsewhere":40, "timing":40,
    "source_page":200, "utm_source":80, "utm_medium":80, "utm_campaign":120,
    "referrer_host":120, "consent_version":40
  }'::jsonb;
  v_meta        jsonb := '{}'::jsonb;
  v_k           text;
  v_v           text;
  v_routing     jsonb;
  v_agent       record;
  -- 0114: Unicode's mandatory line breaks (LF VT FF CR NEL LS PS) — the set
  -- lib/validators/single-line.ts refuses at the route. Change both or neither.
  v_breaks      text := '[' || chr(10) || chr(11) || chr(12) || chr(13)
                     || chr(133) || chr(8232) || chr(8233) || ']';
begin
  -- Length caps in the DATABASE, not only in the route: this function is the
  -- security boundary and must hold on its own terms. A refusal is no rows.
  if v_name is null or length(v_name) > 200 then return; end if;
  if v_email is not null and length(v_email) > 320 then return; end if;
  if v_phone is not null and length(v_phone) > 40  then return; end if;
  if v_message is not null and length(v_message) > 5000 then return; end if;
  if v_ref is not null and length(v_ref) > 40 then return; end if;
  if v_key is not null and v_key !~ '^[A-Za-z0-9-]{8,64}$' then return; end if;

  -- 0114: ONE LINE EACH. The name, e-mail and phone are written onto one
  -- line each of the header block below, and lib/services/lead-contact.ts
  -- reads the person back from those lines; a line break inside one wrote a
  -- line of its own (a phone's "Email: …" read back as the e-mail, a name's
  -- extra lines pushing the real ones out — T-enquiry-identity-single-line).
  -- So is the typed reference, written onto the About line.
  -- Refused like any other bad input: no rows, nothing written. The message
  -- is written BELOW the header and stays multiline. NULL matches nothing.
  if v_name  ~ v_breaks then return; end if;
  if v_email ~ v_breaks then return; end if;
  if v_phone ~ v_breaks then return; end if;
  if v_ref   ~ v_breaks then return; end if;

  -- A way to reply is the point of an enquiry.
  if v_email is null and v_phone is null then return; end if;
  -- …and something to reply ABOUT.
  if v_message is null and v_ref is null then return; end if;

  select o.id into v_org_id from organizations o where o.slug = p_org_slug;
  if v_org_id is null then return; end if;

  -- The replay (0096), answered before anything is written. The first post's
  -- meta stands, exactly as its message does — and so does its job (0101).
  if v_key is not null then
    select l.id into v_lead_id
      from leads l
     where l.org_id = v_org_id
       and l.idempotency_key = v_key;
    if v_lead_id is not null then
      return query select v_lead_id, v_org_id, true;
      return;
    end if;
  end if;

  -- Only an ALREADY-PUBLIC listing resolves, so this never answers "does
  -- PAF0007 exist" for a reference nobody published. RESOLUTION IS THE
  -- BINDING: v_listing_ref is the row's own spelling or null, never the
  -- caller's text (0087).
  if v_ref is not null then
    select p.id, p.reference into v_property_id, v_listing_ref
      from properties p
     where p.org_id = v_org_id
       and p.reference = v_ref
       and p.visibility = 'public'
       and p.status = 'available';
  end if;

  -- Shape only: allowlisted key, string value, trimmed, non-empty, capped.
  if p_meta is not null and jsonb_typeof(p_meta) = 'object' then
    for v_k, v_v in select key, value from jsonb_each_text(p_meta) loop
      if v_caps ? v_k
         and jsonb_typeof(p_meta -> v_k) = 'string'
         and length(btrim(v_v)) between 1 and (v_caps ->> v_k)::int then
        v_meta := v_meta || jsonb_build_object(v_k, btrim(v_v));
      end if;
    end loop;
  end if;

  -- The desk reads one block, in the order it needs: who, how to reach them,
  -- what they asked. Kept in `message` because erasure can rewrite this column
  -- — which is why the TYPED reference is allowed here and nowhere else.
  -- lib/services/lead-contact.ts parseWebsiteEnquiry reads this block back;
  -- the alert worker (0101) rebuilds the desk e-mail from it. Change both
  -- or neither.
  v_body := 'Website enquiry' || chr(10)
         || 'Name: '  || v_name || chr(10)
         || coalesce('Email: ' || v_email || chr(10), '')
         || coalesce('Phone: ' || v_phone || chr(10), '')
         || coalesce('About: ' || v_ref
              || case when v_property_id is null then ' (no published listing with that reference)' else '' end
              || chr(10), '')
         || coalesce(chr(10) || v_message, '');

  -- The race (0096): two identical posts in the same second. The second loses
  -- the partial unique index, writes nothing, and is answered as the replay it is.
  insert into leads (org_id, property_id, source, channel, message, status, criteria, idempotency_key)
  values (
    v_org_id,
    v_property_id,
    'website',
    -- 0092: the channel is the detail the visitor gave, not a constant.
    case when v_email is not null then 'email'::comm_channel else 'phone'::comm_channel end,
    v_body,
    'new',
    -- meta first, the function's own two keys LAST so meta can never override
    -- them; the reference is the resolved canonical value or null, never text
    v_meta || jsonb_build_object('channel', 'website_form', 'listing_reference', v_listing_ref),
    v_key
  )
  on conflict (org_id, idempotency_key) where idempotency_key is not null do nothing
  returning id into v_lead_id;

  if v_lead_id is null then
    select l.id into v_lead_id
      from leads l
     where l.org_id = v_org_id
       and l.idempotency_key = v_key;
    return query select v_lead_id, v_org_id, true;
    return;
  end if;

  -- Guardrail 1. actor_id is null because no user did this. The payload carries
  -- no name, email, phone, message — or typed text of any kind: an event cannot
  -- be redacted, so nothing erasable may enter one. A path and a campaign name
  -- are not a person.
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  values (
    v_org_id, null, 'lead', v_lead_id, 'created',
    jsonb_build_object(
      'source', 'website',
      'channel', 'website_form',
      'listing_reference', v_listing_ref,
      'matched_listing', v_property_id is not null,
      'has_email', v_email is not null,
      'has_phone', v_phone is not null,
      'has_meta', v_meta <> '{}'::jsonb,
      'source_page', v_meta ->> 'source_page',
      'utm_source', v_meta ->> 'utm_source'
    )
  );

  -- 0101: THE DESK ALERT, AS A ROW, IN THIS TRANSACTION. If this insert
  -- fails the whole enquiry rolls back and the visitor is told 503 — an
  -- accepted enquiry without its durable notification record cannot exist.
  -- The route's after() and the worker sweep both start from this row.
  insert into notification_jobs (org_id, lead_id, kind)
  values (v_org_id, v_lead_id, 'enquiry_desk_alert');

  -- 2. The routing rule. Off: the desk claims. round_robin: the named ACTIVE
  --    member of THIS org with the fewest open leads, then the one assigned
  --    longest ago (never, first), then the oldest profile — so two members
  --    alternate and a third who joins later catches up.
  select c.value into v_routing from cyprus_config c where c.key = 'lead_routing';
  if v_routing ->> 'mode' = 'round_robin' and jsonb_typeof(v_routing -> 'agents') = 'array' then
    select p.id, p.full_name into v_agent
      from profiles p
     where p.org_id = v_org_id
       and p.is_active
       and p.id::text in (select jsonb_array_elements_text(v_routing -> 'agents'))
     order by (select count(*) from leads l
                where l.assigned_agent_id = p.id
                  and l.status in ('new', 'contacted', 'qualified')) asc,
              (select max(e.occurred_at) from events e
                where e.entity_type = 'lead'
                  and e.event_type = 'assigned'
                  and e.payload ->> 'to' = p.id::text) asc nulls first,
              p.created_at asc
     limit 1;
    if found then
      update leads l set assigned_agent_id = v_agent.id where l.id = v_lead_id;
      insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
      values (
        v_org_id, null, 'lead', v_lead_id, 'assigned',
        jsonb_build_object('from', null, 'to', v_agent.id, 'to_name', v_agent.full_name,
                           'via', 'routing_rule')
      );
    end if;
  end if;

  return query select v_lead_id, v_org_id, false;
end $fn$;

comment on function public.submit_public_enquiry(text, text, text, text, text, text, text, jsonb) is
  'The public enquiry door (0084, rebuilt 0087, channel derived 0092, idempotent '
  '0096, meta + routing 0098, desk-alert outbox 0101). Creates a `website` lead, '
  'its event and its notification_jobs row in ONE transaction, never a contact. '
  'Returns one row: the lead id and org, and replayed=true when the key was seen '
  'before (nothing is written then). Zero rows is a refusal. p_meta: the site''s '
  'structured brief and provenance, admitted key by key from the allowlist in '
  'the body (shape only — criteria is not erasable) and merged into criteria '
  'under the function''s own channel/listing_reference. source stays website '
  'for every form fill: the retention sweep keys on it. Applies cyprus_config.'
  'lead_routing on arrival with a null-actor assigned event. EXECUTE is '
  'service_role-only since 0087: the Next route is the door. 0114: a line '
  'break in the name, e-mail, phone or reference is refused (zero rows) — each '
  'is one line of the message header the desk reads the person from.';

-- The 0087 lockdown, restated: `create or replace` keeps the ACL, and a
-- reader of this file should not have to trust that.
revoke execute on function public.submit_public_enquiry(text, text, text, text, text, text, text, jsonb)
  from public, anon, authenticated;
grant  execute on function public.submit_public_enquiry(text, text, text, text, text, text, text, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- 2. The proposal door: 0106's body, plus v_breaks and the four checks
-- ---------------------------------------------------------------------------
create or replace function public.submit_proposal_interest(
  p_token_sha256    text,
  p_property_ref    text,
  p_name            text,
  p_email           text,
  p_phone           text,
  p_message         text,
  p_idempotency_key text default null
)
returns table (lead_id uuid, lead_org_id uuid, replayed boolean)
language plpgsql security definer set search_path = public as $fn$
declare
  v_link        share_links;
  v_property_id uuid;
  v_listing_ref text;
  v_name        text := nullif(btrim(coalesce(p_name, '')), '');
  v_email       text := nullif(btrim(coalesce(p_email, '')), '');
  v_phone       text := nullif(btrim(coalesce(p_phone, '')), '');
  v_message     text := nullif(btrim(coalesce(p_message, '')), '');
  v_ref         text := nullif(btrim(coalesce(p_property_ref, '')), '');
  v_key         text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_lead_id     uuid;
  v_body        text;
  v_agent       record;
  -- 0114: Unicode's mandatory line breaks (LF VT FF CR NEL LS PS) — the set
  -- lib/validators/single-line.ts refuses at the route. Change both or neither.
  v_breaks      text := '[' || chr(10) || chr(11) || chr(12) || chr(13)
                     || chr(133) || chr(8232) || chr(8233) || ']';
begin
  -- Shape, on the function's own terms (the route's 400 is a courtesy).
  if p_token_sha256 is null or p_token_sha256 !~ '^[0-9a-f]{64}$' then return; end if;
  if v_name is null or length(v_name) > 200 then return; end if;
  if v_email is not null and length(v_email) > 320 then return; end if;
  if v_phone is not null and length(v_phone) > 40  then return; end if;
  if v_message is not null and length(v_message) > 5000 then return; end if;
  if v_ref is null or length(v_ref) > 40 then return; end if;
  if v_key is not null and v_key !~ '^[A-Za-z0-9-]{8,64}$' then return; end if;

  -- 0114: ONE LINE EACH. The name, e-mail and phone are written onto one
  -- line each of the header block below, and lib/services/lead-contact.ts
  -- reads the person back from those lines; a line break inside one wrote a
  -- line of its own (a phone's "Email: …" read back as the e-mail, a name's
  -- extra lines pushing the real ones out — T-enquiry-identity-single-line).
  -- The reference is resolved, never written as typed, but a reference with
  -- a break in it cannot be one: refused here as the route refuses it.
  -- Refused like any other bad input: no rows, nothing written. The message
  -- is written BELOW the header and stays multiline. NULL matches nothing.
  if v_name  ~ v_breaks then return; end if;
  if v_email ~ v_breaks then return; end if;
  if v_phone ~ v_breaks then return; end if;
  if v_ref   ~ v_breaks then return; end if;
  if v_email is null and v_phone is null then return; end if;

  -- The proposal: live, and a proposal. Unknown, expired and revoked are
  -- indistinguishable to the caller — as resolve_share_link answers them.
  select * into v_link
    from share_links
   where token_sha256 = p_token_sha256
     and kind = 'proposal'
     and revoked_at is null
     and expires_at > now();
  if not found then return; end if;

  -- The property: IN this proposal, in the LINK's org, not archived — the
  -- same rule the proposal page shows by. Resolution is the binding: the
  -- row's own spelling of the reference, never the caller's text.
  select p.id, p.reference into v_property_id, v_listing_ref
    from share_link_properties slp
    join properties p on p.id = slp.property_id
   where slp.share_link_id = v_link.id
     and p.org_id = v_link.org_id
     and p.reference = v_ref
     and p.visibility <> 'archived';
  if not found then return; end if;

  -- The replay (0096), answered before anything is written.
  if v_key is not null then
    select l.id into v_lead_id from leads l where l.org_id = v_link.org_id and l.idempotency_key = v_key;
    if v_lead_id is not null then
      return query select v_lead_id, v_link.org_id, true;
      return;
    end if;
  end if;

  -- The desk's block, exactly as the website door writes it (0084 → 0098):
  -- lib/services/lead-contact.ts parseWebsiteEnquiry reads the header and
  -- websiteEnquiryBody the words after the blank line; the alert worker
  -- rebuilds the desk e-mail from both. The proposal is named in the words.
  v_body := 'Website enquiry' || chr(10)
         || 'Name: '  || v_name || chr(10)
         || coalesce('Email: ' || v_email || chr(10), '')
         || coalesce('Phone: ' || v_phone || chr(10), '')
         || 'About: ' || v_listing_ref || chr(10)
         || chr(10)
         || 'Interested in ' || v_listing_ref || ' from the proposal'
         || coalesce(' "' || nullif(btrim(v_link.title), '') || '"', '') || '.'
         || coalesce(chr(10) || v_message, '');

  insert into leads (org_id, property_id, source, channel, message, status, criteria, idempotency_key)
  values (
    v_link.org_id,
    v_property_id,
    'website',
    case when v_email is not null then 'email'::comm_channel else 'phone'::comm_channel end,
    v_body,
    'new',
    jsonb_build_object('channel', 'proposal_interest',
                       'listing_reference', v_listing_ref,
                       'share_link_id', v_link.id),
    v_key
  )
  on conflict (org_id, idempotency_key) where idempotency_key is not null do nothing
  returning id into v_lead_id;

  -- The race (0096): two identical posts in the same second — the second
  -- writes nothing and is answered as the replay it is.
  if v_lead_id is null then
    select l.id into v_lead_id from leads l where l.org_id = v_link.org_id and l.idempotency_key = v_key;
    return query select v_lead_id, v_link.org_id, true;
    return;
  end if;

  -- Ids and words only: an event cannot be redacted, so nothing erasable
  -- may enter one.
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  values (
    v_link.org_id, null, 'lead', v_lead_id, 'created',
    jsonb_build_object(
      'source', 'website',
      'channel', 'proposal_interest',
      'listing_reference', v_listing_ref,
      'share_link_id', v_link.id,
      'matched_listing', true,
      'has_email', v_email is not null,
      'has_phone', v_phone is not null
    )
  );

  -- 0101: THE DESK ALERT, AS A ROW, IN THIS TRANSACTION.
  insert into notification_jobs (org_id, lead_id, kind)
  values (v_link.org_id, v_lead_id, 'enquiry_desk_alert');

  -- The proposal's author owns the enquiry while they are active.
  select p.id, p.full_name into v_agent
    from profiles p
   where p.id = v_link.created_by
     and p.org_id = v_link.org_id
     and p.is_active;
  if found then
    update leads l set assigned_agent_id = v_agent.id where l.id = v_lead_id;
    insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
    values (
      v_link.org_id, null, 'lead', v_lead_id, 'assigned',
      jsonb_build_object('from', null, 'to', v_agent.id, 'to_name', v_agent.full_name,
                         'via', 'proposal_owner')
    );
  end if;

  -- The proposal's own timeline: which listing drew interest, and the lead.
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  values (
    v_link.org_id, null, 'share_link', v_link.id, 'interest',
    jsonb_build_object('listing_reference', v_listing_ref, 'lead_id', v_lead_id)
  );

  return query select v_lead_id, v_link.org_id, false;
end $fn$;

comment on function public.submit_proposal_interest(text, text, text, text, text, text, text) is
  'A buyer''s explicit interest in ONE property of a shared proposal (0106): '
  'resolves the proposal from the token digest (live, kind proposal) and the '
  'property from the reference WITHIN it (not archived, the link''s org), '
  'refuses everything else with no rows, never attributes the link''s contact, '
  'writes the website-shaped lead bound to the property with the proposal in '
  'criteria, its created event, its desk-alert row, assigns the proposal''s '
  'author while active, and records interest on the link. A repeated '
  'idempotency key is the same lead, replayed. service_role-only. 0114: a '
  'line break in the name, e-mail, phone or reference is refused (zero rows).';

revoke execute on function public.submit_proposal_interest(text, text, text, text, text, text, text)
  from public, anon, authenticated;
grant  execute on function public.submit_proposal_interest(text, text, text, text, text, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- Apply-time assertions, INSIDE A SUBTRANSACTION THAT IS ALWAYS ROLLED BACK:
-- a throwaway organisation, property and proposal; every break in every
-- one-line value at both doors refused with nothing written; a valid enquiry
-- at each door (Greek and Russian names, an apostrophe, hyphens, an
-- international number, header-shaped words in a multiline message) still
-- written once — the whole message compared byte for byte — with its created
-- event and its desk-alert row, and replayed by its key. Then all of it is
-- undone: unlike 0084–0106's self-tests, not even an event survives, in any
-- database. Needs no existing organisation, so a fresh CI database runs the
-- same assertions as hosted.
-- ---------------------------------------------------------------------------
do $$
declare
  v_org    uuid := gen_random_uuid();
  v_slug   text := 'selftest-0114-' || substr(md5(clock_timestamp()::text), 1, 12);
  v_digest text := encode(sha256(('selftest-0114-' || clock_timestamp()::text)::bytea), 'hex');
  v_breaks text[] := array[chr(10), chr(11), chr(12), chr(13), chr(133), chr(8232), chr(8233),
                           chr(13) || chr(10), chr(10) || chr(10)];
  v_prop   uuid;
  v_broken uuid;
  v_link   uuid;
  v_br     text;
  v_row    record;
  v_lead   leads;
  n        int;
begin
  begin
    insert into organizations (id, name, slug) values (v_org, '0114 self-test', v_slug);
    insert into properties (org_id, reference, property_type, visibility, status, title, asking_price)
    values (v_org, 'SELFTEST-0114', 'villa', 'private', 'available', '{"en":"0114 self-test"}'::jsonb, 1)
    returning id into v_prop;
    -- properties.reference has no shape rule, so a proposal CAN hold one with a
    -- break — which the proposal door would write onto the About line
    insert into properties (org_id, reference, property_type, visibility, status, title, asking_price)
    values (v_org, 'SELFTEST-0114-B' || chr(10) || 'Email: x@example.invalid', 'villa', 'private', 'available',
            '{"en":"0114 self-test"}'::jsonb, 1)
    returning id into v_broken;
    insert into share_links (org_id, token_sha256, locale, title, expires_at)
    values (v_org, v_digest, 'en', '0114 self-test', now() + interval '1 day')
    returning id into v_link;
    insert into share_link_properties (share_link_id, property_id, sort_order) values (v_link, v_prop, 0), (v_link, v_broken, 1);

    -- every break, in every one-line value, at both doors
    foreach v_br in array v_breaks loop
      select count(*) into n from (
                  select 1 from submit_public_enquiry(v_slug, 'Ann' || v_br || 'Smith', 'a@example.invalid', null, 'words')
        union all select 1 from submit_public_enquiry(v_slug, 'Ann', 'a@example.invalid' || v_br || 'Phone: 1', null, 'words')
        union all select 1 from submit_public_enquiry(v_slug, 'Ann', null, '99' || v_br || 'Email: x@example.invalid', 'words')
        union all select 1 from submit_public_enquiry(v_slug, 'Ann', 'a@example.invalid', null, null,
                                                      'PAF0001' || v_br || 'Email: x@example.invalid')
        union all select 1 from submit_proposal_interest(v_digest, 'SELFTEST-0114', 'Ann' || v_br || 'Smith',
                                                         'a@example.invalid', null, null)
        union all select 1 from submit_proposal_interest(v_digest, 'SELFTEST-0114', 'Ann',
                                                         'a@example.invalid' || v_br || 'Phone: 1', null, null)
        union all select 1 from submit_proposal_interest(v_digest, 'SELFTEST-0114', 'Ann', null,
                                                         '99' || v_br || 'Email: x@example.invalid', null)
        union all select 1 from submit_proposal_interest(v_digest, 'SELFTEST-0114' || v_br, 'Ann',
                                                         'a@example.invalid', null, null)
      ) accepted;
      if n <> 0 then
        raise exception '0114 aborted: a value with a line break (U+%) was accepted', upper(lpad(to_hex(ascii(v_br)), 4, '0'));
      end if;
    end loop;
    -- a break at the END is still inside the header line: the function trims spaces only
    select count(*) into n from submit_public_enquiry(v_slug, 'Ann' || chr(10), 'a@example.invalid', null, 'words');
    if n <> 0 then raise exception '0114 aborted: a trailing line break was accepted'; end if;
    -- a reference the proposal DOES hold, with a break in it: the check refuses it, not the lookup
    select count(*) into n from submit_proposal_interest(v_digest, 'SELFTEST-0114-B' || chr(10) || 'Email: x@example.invalid',
                                                          'Ann', 'a@example.invalid', null, null);
    if n <> 0 then raise exception '0114 aborted: a proposal reference with a line break was accepted'; end if;
    if exists (select 1 from leads where org_id = v_org)
       or exists (select 1 from notification_jobs where org_id = v_org)
       or exists (select 1 from events where org_id = v_org and entity_type = 'lead') then
      raise exception '0114 aborted: a refused submission wrote a lead, a job or an event';
    end if;

    -- the website door still takes a real enquiry, whole, once
    select * into v_row from submit_public_enquiry(
      v_slug, 'Γιώργος O''Brien-Παπαδόπουλος', 'a@example.invalid', '+357 99 123456',
      'Line one' || chr(10) || 'Email: words, not a header', 'SELFTEST-0114', 'selftest-0114-door');
    if v_row.lead_id is null or v_row.replayed then raise exception '0114 aborted: a valid website enquiry was refused'; end if;
    select * into v_lead from leads where id = v_row.lead_id;
    if v_lead.message is distinct from
         'Website enquiry' || chr(10)
      || 'Name: Γιώργος O''Brien-Παπαδόπουλος' || chr(10)
      || 'Email: a@example.invalid' || chr(10)
      || 'Phone: +357 99 123456' || chr(10)
      || 'About: SELFTEST-0114 (no published listing with that reference)' || chr(10)
      || chr(10) || 'Line one' || chr(10) || 'Email: words, not a header' then
      raise exception '0114 aborted: the website door''s block changed shape';
    end if;
    select count(*) into n from events where entity_type = 'lead' and entity_id = v_lead.id and event_type = 'created';
    if n <> 1 then raise exception '0114 aborted: the website enquiry has % created events', n; end if;
    select count(*) into n from notification_jobs where lead_id = v_lead.id and kind = 'enquiry_desk_alert';
    if n <> 1 then raise exception '0114 aborted: the website enquiry has % desk-alert rows', n; end if;
    select * into v_row from submit_public_enquiry(
      v_slug, 'Γιώργος O''Brien-Παπαδόπουλος', 'a@example.invalid', '+357 99 123456',
      'typed again', 'SELFTEST-0114', 'selftest-0114-door');
    -- NOT FOUND leaves every field NULL, and NULL would slip past a plain `not`
    if not found or v_row.replayed is not true or v_row.lead_id is distinct from v_lead.id then
      raise exception '0114 aborted: the website replay did not answer with the first lead';
    end if;

    -- the proposal door too
    select * into v_row from submit_proposal_interest(
      v_digest, 'SELFTEST-0114', 'Анна-Мария Иванова', null, '+7 (495) 123-45-67',
      'Email: words, not a header', 'selftest-0114-proposal');
    if v_row.lead_id is null or v_row.replayed then raise exception '0114 aborted: a valid proposal interest was refused'; end if;
    select * into v_lead from leads where id = v_row.lead_id;
    if v_lead.message is distinct from
         'Website enquiry' || chr(10)
      || 'Name: Анна-Мария Иванова' || chr(10)
      || 'Phone: +7 (495) 123-45-67' || chr(10)
      || 'About: SELFTEST-0114' || chr(10)
      || chr(10) || 'Interested in SELFTEST-0114 from the proposal "0114 self-test".'
      || chr(10) || 'Email: words, not a header' then
      raise exception '0114 aborted: the proposal door''s block changed shape';
    end if;
    select count(*) into n from notification_jobs where lead_id = v_lead.id and kind = 'enquiry_desk_alert';
    if n <> 1 then raise exception '0114 aborted: the proposal interest has % desk-alert rows', n; end if;
    select * into v_row from submit_proposal_interest(
      v_digest, 'SELFTEST-0114', 'Анна-Мария Иванова', null, '+7 (495) 123-45-67', 'again', 'selftest-0114-proposal');
    if not found or v_row.replayed is not true or v_row.lead_id is distinct from v_lead.id then
      raise exception '0114 aborted: the proposal replay did not answer with the first lead';
    end if;
    select count(*) into n from leads where org_id = v_org;
    if n <> 2 then raise exception '0114 aborted: % leads for two enquiries and two replays', n; end if;

    raise exception 'selftest-0114-rollback';
  exception
    when raise_exception then
      if sqlerrm <> 'selftest-0114-rollback' then raise; end if;
  end;

  if exists (select 1 from organizations where id = v_org) then
    raise exception '0114 aborted: the self-test was not rolled back';
  end if;

  -- the signatures, the definer and the grants did not move
  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public'
     and ((p.proname = 'submit_public_enquiry' and p.pronargs = 8)
       or (p.proname = 'submit_proposal_interest' and p.pronargs = 7))
     and p.prosecdef
     and p.proconfig @> array['search_path=public'];
  if n <> 2 then raise exception '0114 aborted: a door lost its signature, SECURITY DEFINER or search_path'; end if;
  select count(*) into n
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname in ('submit_public_enquiry', 'submit_proposal_interest');
  if n <> 2 then raise exception '0114 aborted: a second overload of a door exists'; end if;
  if has_function_privilege('anon', 'public.submit_public_enquiry(text,text,text,text,text,text,text,jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.submit_public_enquiry(text,text,text,text,text,text,text,jsonb)', 'execute')
     or not has_function_privilege('service_role', 'public.submit_public_enquiry(text,text,text,text,text,text,text,jsonb)', 'execute')
     or has_function_privilege('anon', 'public.submit_proposal_interest(text,text,text,text,text,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.submit_proposal_interest(text,text,text,text,text,text,text)', 'execute')
     or not has_function_privilege('service_role', 'public.submit_proposal_interest(text,text,text,text,text,text,text)', 'execute') then
    raise exception '0114 aborted: grants are wrong';
  end if;

  raise notice '0114: both enquiry doors refuse a line break in a name, e-mail, phone or reference — nothing is written; the message stays multiline.';
end $$;
