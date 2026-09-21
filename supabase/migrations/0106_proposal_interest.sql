-- =============================================================================
-- 0106 — "I'm interested" on a shared proposal: submit_proposal_interest()
--        (audit 2026-09-21, finding 4: proposals had e-mail and telephone
--        links but no property-level action that recorded interest in the CRM)
--
-- CONFIRMED MISSING. components/features/share-links/proposal.tsx rendered
-- each property with a mailto: and a tel: link on the agent card and nothing
-- else; a buyer's interest in ONE property of the selection reached the CRM
-- only if they wrote an e-mail and someone typed it in.
--
-- THIS FUNCTION is the one door for that action, in the construction the
-- website door already uses (submit_public_enquiry, 0084 → 0101):
--   * the ORGANISATION, the PROPOSAL and the PROPERTY are resolved HERE from
--     the token's digest — the caller names a reference, never an id, and
--     names no org; an expired, revoked or unknown token, a `kind` that is
--     not a proposal, a reference the proposal does not hold, and an
--     archived property (the one thing a proposal withholds) are all refused
--     the same way: no rows, nothing written;
--   * a forwarded link proves nothing about who is typing: the link's
--     contact is NEVER attributed. The enquirer gives their own name and a
--     way to reply, exactly as on the website form; the desk links or
--     creates the contact as it does for every website lead;
--   * the lead is the website door's lead: `source = website`, the SAME
--     message block the desk e-mail is rebuilt from (lib/services/
--     lead-contact.ts reads it; the alert worker needs nothing new), the
--     proposal named in the visitor-facing part of the message and in
--     `criteria` (`channel: proposal_interest`, `listing_reference`,
--     `share_link_id`); the property is bound because membership in the
--     proposal proved it — a private listing in a proposal is exactly the
--     case, so the door's "public listings only" rule does not apply here;
--   * the proposal's author owns the enquiry: assigned to `created_by`
--     while that profile is active, with the `assigned` event (via
--     `proposal_owner`); otherwise it lands on the desk unassigned;
--   * the durable desk-alert row (0101) is written with the lead, in this
--     transaction; the route's after() accelerates it, the sweep finishes;
--   * the idempotency key makes a retry the same lead (0096's partial unique
--     index and race handling, reused verbatim);
--   * events carry ids and words only — no name, e-mail, phone, message or
--     token; the token digest is stored nowhere.
--
-- Grants: EXECUTE for service_role alone, like the website door since 0087
-- — the route app/api/public/proposals/interest/route.ts calls it with the
-- admin client after the enquiry door's rate meter and the honeypot. Pins
-- that move: verify-restore.sql (a grants row, the migrations count).
-- =============================================================================

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
begin
  -- Shape, on the function's own terms (the route's 400 is a courtesy).
  if p_token_sha256 is null or p_token_sha256 !~ '^[0-9a-f]{64}$' then return; end if;
  if v_name is null or length(v_name) > 200 then return; end if;
  if v_email is not null and length(v_email) > 320 then return; end if;
  if v_phone is not null and length(v_phone) > 40  then return; end if;
  if v_message is not null and length(v_message) > 5000 then return; end if;
  if v_ref is null or length(v_ref) > 40 then return; end if;
  if v_key is not null and v_key !~ '^[A-Za-z0-9-]{8,64}$' then return; end if;
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
  'idempotency key is the same lead, replayed. service_role-only.';

revoke execute on function public.submit_proposal_interest(text, text, text, text, text, text, text)
  from public, anon, authenticated;
grant  execute on function public.submit_proposal_interest(text, text, text, text, text, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- Apply-time assertions (0084 idiom): a throwaway property and proposal in
-- the first org, the happy path, a refusal, a replay; then removed (the
-- events stay, as every self-test's do).
-- ---------------------------------------------------------------------------
do $$
declare
  v_org      uuid;
  v_agent    uuid;
  v_prop     uuid;
  v_link     uuid;
  v_digest   text := encode(sha256(('selftest-0106-' || clock_timestamp()::text)::bytea), 'hex');
  v_row      record;
  v_lead     leads;
  n          int;
begin
  select id into v_org from organizations order by created_at limit 1;
  if v_org is null then
    raise notice '0106: no organization to self-test against — grants and shape checked only';
  else
    select id into v_agent from profiles where org_id = v_org and is_active order by created_at limit 1;

    insert into properties (org_id, reference, property_type, visibility, status, title, asking_price)
    values (v_org, 'SELFTEST-0106', 'villa', 'private', 'available', '{"en":"0106 self-test"}'::jsonb, 1)
    returning id into v_prop;
    insert into share_links (org_id, token_sha256, locale, title, expires_at, created_by)
    values (v_org, v_digest, 'en', '0106 self-test selection', now() + interval '1 day', v_agent)
    returning id into v_link;
    insert into share_link_properties (share_link_id, property_id, sort_order) values (v_link, v_prop, 0);

    -- a reference outside the proposal: refused, nothing written
    select count(*) into n from submit_proposal_interest(v_digest, 'SELFTEST-0106-NOT', 'Self Test',
                                                          'selftest-0106@example.invalid', null, null, 'selftest-0106-out');
    if n <> 0 then raise exception '0106 aborted: a reference outside the proposal was accepted'; end if;

    -- the happy path
    select * into v_row from submit_proposal_interest(v_digest, 'SELFTEST-0106', 'Self Test',
                                                       'selftest-0106@example.invalid', null, 'self-test words', 'selftest-0106-ok');
    if v_row.lead_id is null or v_row.replayed then raise exception '0106 aborted: the happy path made no lead'; end if;
    select * into v_lead from leads where id = v_row.lead_id;
    if v_lead.org_id <> v_org or v_lead.property_id <> v_prop or v_lead.source <> 'website'
       or v_lead.contact_id is not null
       or v_lead.criteria ->> 'channel' <> 'proposal_interest'
       or (v_lead.criteria ->> 'share_link_id')::uuid <> v_link
       or v_lead.message not like 'Website enquiry' || chr(10) || '%'
       or v_lead.message not like '%About: SELFTEST-0106' || chr(10) || '%' then
      raise exception '0106 aborted: the lead is not shaped like a website lead bound to the proposal''s property';
    end if;
    if v_agent is not null and v_lead.assigned_agent_id is distinct from v_agent then
      raise exception '0106 aborted: the proposal''s author was not assigned';
    end if;
    if not exists (select 1 from notification_jobs where lead_id = v_row.lead_id and state = 'pending') then
      raise exception '0106 aborted: no desk-alert row was written with the lead';
    end if;
    if exists (select 1 from events where entity_type = 'lead' and entity_id = v_row.lead_id
                  and payload::text like '%selftest-0106@example.invalid%') then
      raise exception '0106 aborted: an event carries the enquirer''s e-mail';
    end if;
    if not exists (select 1 from events where entity_type = 'share_link' and entity_id = v_link and event_type = 'interest') then
      raise exception '0106 aborted: the proposal''s timeline did not record the interest';
    end if;

    -- the replay
    select * into v_row from submit_proposal_interest(v_digest, 'SELFTEST-0106', 'Self Test',
                                                       'selftest-0106@example.invalid', null, 'typed again', 'selftest-0106-ok');
    if not v_row.replayed or v_row.lead_id <> v_lead.id then raise exception '0106 aborted: the replay made a second lead'; end if;

    delete from tasks where lead_id = v_lead.id;
    delete from leads where id = v_lead.id;
    delete from share_link_properties where share_link_id = v_link;
    delete from share_links where id = v_link;
    delete from properties where id = v_prop;
  end if;

  if has_function_privilege('anon', 'public.submit_proposal_interest(text,text,text,text,text,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.submit_proposal_interest(text,text,text,text,text,text,text)', 'execute')
     or not has_function_privilege('service_role', 'public.submit_proposal_interest(text,text,text,text,text,text,text)', 'execute') then
    raise exception '0106 aborted: grants are wrong';
  end if;
  -- the website door is untouched
  if not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname = 'public' and p.proname = 'submit_public_enquiry' and p.pronargs = 8) then
    raise exception '0106 aborted: the website door changed — it must not';
  end if;

  raise notice '0106: submit_proposal_interest live — a buyer''s interest in one proposal property is a website-shaped lead with its desk alert.';
end $$;
