-- =============================================================================
-- 0136 — the website enquiry's round-robin routing counts only its own
--        organisation's leads and `assigned` events
--
-- THE GAP (BACKLOG "`submit_public_enquiry`'s round-robin routing counts
-- another organisation's leads and `assigned` events", found by
-- T-redact-notes-own-org's review; re-verified 2026-10-03 on the local stack
-- at 0135 by supabase/tests/routing-own-org.test.ts, pinned RED first —
-- DECISIONS T-routing-own-org has the count):
--
--   * submit_public_enquiry() (latest 0114; a SECURITY DEFINER the Next route
--     calls as the service role for every website enquiry) applies
--     cyprus_config.lead_routing: in `round_robin` mode it picks, among THIS
--     organisation's active routed agents, the one with the fewest open leads,
--     then the one assigned longest ago. Both counts were unbounded by
--     organisation: `leads l where l.assigned_agent_id = p.id` and the latest
--     `events e where … e.payload ->> 'to' = p.id::text`. Another
--     organisation's session may write both — `events_insert` admits a
--     session's `assigned` lead event with any payload in its own
--     organisation, and `leads.assigned_agent_id` references profiles(id)
--     alone — and the agent ids are readable (cyprus_config.lead_routing.agents,
--     readable by any signed-in user). So organisation B could starve or flood
--     one of our agents of new website enquiries: a write steered into our
--     organisation (the new lead's assignee and its `assigned` event).
--     Destroys nothing; needs a second tenant. Hosted on 2026-10-03
--     (read-only): one organisation, routing `off` — nothing was or can yet be
--     reached.
--
-- THE FIX: the same function — its text is 0114's, byte for byte, but the two
-- predicates `l.org_id = v_org_id` and `e.org_id = v_org_id` (with their
-- comment) and one sentence added to the function's comment. CREATE OR
-- REPLACE keeps the oid, the owner (postgres) and the EXECUTE grants; SECURITY
-- DEFINER and `search_path = public` are restated as 0114 wrote them, and so
-- is 0087's lockdown (revoke from public / anon / authenticated, grant to the
-- service role). `e.org_id` also lets the events lookup lead with the
-- organisation (events_entity_idx).
--
-- NOT the wider issue: `leads.assigned_agent_id` (and every other agent /
-- `*_by` column) may name another organisation's profile — BACKLOG's profiles
-- `(org_id, id)` decision. This file only stops such rows from counting here.
--
-- CONTRACT. Signature, defaults, return (lead_id, lead_org_id, replayed) and
-- every write unchanged; database.types.ts regenerates identically; no
-- release-compat entry. NOT deploy-coupled: hosted 0136 first, then merge.
--
-- LOCKS: CREATE OR REPLACE FUNCTION takes no table lock (a call already
-- running keeps the old body to its end); the closing diagnostic reads leads,
-- events and profiles (ACCESS SHARE). ONE transaction (checked below). Apply
-- in the usual window (outside 02:55–04:05 UTC, away from 06:00).
--
-- PREFLIGHT refuses, changing nothing, unless submit_public_enquiry is the
-- only function of that name, its body exactly 0114's (md5, carriage returns
-- ignored — hosted's read 2026-10-03 is identical), SECURITY DEFINER, owned by
-- postgres, `search_path=public`, executable by the service role and by no
-- session role.
--
-- EXISTING ROWS — READ-ONLY DIAGNOSTIC, NO REPAIR (the file's last row):
--   leads_assigned_across_orgs     leads whose assignee is another
--                                  organisation's profile;
--   assigned_events_across_orgs    `assigned` lead events naming another
--                                  organisation's profile in their `to`.
-- Either is the shape a steering attempt leaves (or a profile moved between
-- organisations); an operator decision per counted row.
--
-- NOT CHANGED: who may call it (the service role); what it writes; the
-- refusal rules; `off` mode; the proposal door (submit_proposal_interest
-- assigns the link's own author, already bound by organisation).
--
-- ROLLBACK, a forward migration in one transaction: restore 0114's function
-- text, comment and grants (supabase/tests/revert-0136.ts slices exactly that
-- from 0114's file, and the test file replays it). In the same change: delete
-- the test file and helper; remove the restore pack's 0136 row and move its
-- migrations pin FORWARD; restore the BACKLOG entry. No data moves.
--
-- Pins that move with this file: scripts/backup/verify-restore.sql (the
-- migrations count, the 0136 SECURITY row).
-- =============================================================================

set local lock_timeout = '5s';

do $$
begin
  if current_setting('lock_timeout') <> '5s' then
    raise exception '0136 aborted: this file must run as ONE transaction (SET LOCAL lock_timeout did not take effect) — nothing was changed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Preflight: the function is exactly what this file was written against
-- ---------------------------------------------------------------------------
do $$
declare
  v_sig constant text := 'public.submit_public_enquiry(text, text, text, text, text, text, text, jsonb)';
  v_md5 text;
begin
  if (select count(*) from pg_proc p
       where p.pronamespace = 'public'::regnamespace and p.proname = 'submit_public_enquiry') <> 1 then
    raise exception '0136 aborted: submit_public_enquiry is overloaded — nothing was changed';
  end if;
  select md5(replace(p.prosrc, E'\r', '')) into v_md5
    from pg_proc p
   where p.oid = to_regprocedure(v_sig) and p.prosecdef
     and pg_get_userbyid(p.proowner) = 'postgres'
     and p.proconfig = array['search_path=public'];
  if v_md5 is distinct from '65da4d2d2efb3762dbca32277971a0a6' then
    raise exception '0136 aborted: submit_public_enquiry is not 0114''s definer body (md5 %) — nothing was changed', coalesce(v_md5, 'missing or not the definer it was');
  end if;
  if has_function_privilege('anon', v_sig, 'execute') or has_function_privilege('authenticated', v_sig, 'execute') then
    raise exception '0136 aborted: a session role may execute submit_public_enquiry — nothing was changed';
  end if;
  if not has_function_privilege('service_role', v_sig, 'execute') then
    raise exception '0136 aborted: the service role may not execute submit_public_enquiry (its grants are not 0087''s) — nothing was changed';
  end if;
  raise notice '0136: preflight passed — submit_public_enquiry is 0114''s definer body, executable by the service role and no session role';
end $$;

-- ---------------------------------------------------------------------------
-- The door, its round-robin counts bounded by the enquiry's organisation
-- (0114's text; the two predicates, their comment and the comment's last
-- sentence are this file's)
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
     -- 0136: both counts are THIS organisation's — another organisation's
     -- sessions may write leads naming our agents and `assigned` events about
     -- them, and must not steer which of our agents is next.
     order by (select count(*) from leads l
                where l.org_id = v_org_id
                  and l.assigned_agent_id = p.id
                  and l.status in ('new', 'contacted', 'qualified')) asc,
              (select max(e.occurred_at) from events e
                where e.org_id = v_org_id
                  and e.entity_type = 'lead'
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
  'is one line of the message header the desk reads the person from. 0136: '
  'round-robin counts only this organisation''s open leads and `assigned` events.';

-- The 0087 lockdown, restated: `create or replace` keeps the ACL, and a
-- reader of this file should not have to trust that.
revoke execute on function public.submit_public_enquiry(text, text, text, text, text, text, text, jsonb)
  from public, anon, authenticated;
grant  execute on function public.submit_public_enquiry(text, text, text, text, text, text, text, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- Postflight: the shape kept, both predicates present
-- ---------------------------------------------------------------------------
do $$
declare
  v_sig constant text := 'public.submit_public_enquiry(text, text, text, text, text, text, text, jsonb)';
  v_src text;
begin
  select regexp_replace(p.prosrc, '--[^\n]*', '', 'g') into v_src
    from pg_proc p
   where p.oid = to_regprocedure(v_sig) and p.prosecdef
     and pg_get_userbyid(p.proowner) = 'postgres'
     and p.proconfig = array['search_path=public'];
  if v_src is null then
    raise exception '0136 postflight: submit_public_enquiry is not the definer owned by postgres with search_path public';
  end if;
  if v_src !~ 'from leads l\s+where l\.org_id = v_org_id\s+and l\.assigned_agent_id = p\.id'
     or v_src !~ 'from events e\s+where e\.org_id = v_org_id\s+and e\.entity_type = ''lead''' then
    raise exception '0136 postflight: the round-robin counts are not bounded by the enquiry''s organisation';
  end if;
  if has_function_privilege('anon', v_sig, 'execute') or has_function_privilege('authenticated', v_sig, 'execute')
     or not has_function_privilege('service_role', v_sig, 'execute') then
    raise exception '0136 postflight: submit_public_enquiry''s EXECUTE grants changed';
  end if;
  raise notice '0136: postflight passed — round-robin counts only the enquiry''s own organisation''s leads and assigned events';
end $$;

-- EXISTING ROWS (header) — read-only, nothing repaired; the file's LAST result
select format('leads_assigned_across_orgs=%s assigned_events_across_orgs=%s',
              (select count(*) from public.leads l join public.profiles p on p.id = l.assigned_agent_id
                where p.org_id <> l.org_id),
              (select count(*) from public.events e join public.profiles p on p.id::text = e.payload ->> 'to'
                where e.entity_type = 'lead' and e.event_type = 'assigned' and p.org_id <> e.org_id)) as existing_rows;
