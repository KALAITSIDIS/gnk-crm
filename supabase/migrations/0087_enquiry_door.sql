-- 0087 — the enquiry door is the route, and the database now says so.
--
-- Two findings from the outside audit of 2026-09-06 (A01 and A05 — verified
-- and planned in docs/AUDIT_2026-09-06_RESPONSE.md, Now #2), plus one rider.
--
-- A01. 0084 granted EXECUTE on submit_public_enquiry and note_public_enquiry_hit
-- to `anon` "by name, exactly as 0066 did it" — but 0066 grants a READ and this
-- is a WRITE, and every control that makes the write safe lives in the Next
-- route (app/api/public/enquiries/route.ts): the per-IP counter, the honeypot,
-- the e-mail format check and the desk alert. Anyone holding the publishable
-- key could call the function over PostgREST and skip all four — one lead per
-- call, silently, with no ceiling of any kind, and (the A05 overlap) one
-- permanent hash-chained event per call. What bounded it was that the
-- publishable key reaches no browser, no commit and no CI. That is an accident
-- of this deployment, not a control, and it lasts exactly until the first
-- client-side Supabase call.
--
-- THE FIX IS A REVOKE, NOT A NEW ROLE. The route already assumes it is the only
-- door; the database now agrees. EXECUTE on both functions is service_role-only
-- and the route calls them with the server-only admin client every admin action
-- already uses. No new secret, no new role, the marketing site untouched and
-- still credential-free. The audit's dedicated-role adapter with a custom-signed
-- JWT would be a new credential class for one function.
--
-- A05. The function copied whatever text arrived in p_property_ref — up to 40
-- characters, no format check — into leads.criteria AND the immutable event
-- payload whether or not it resolved, under comments promising "shape only". A
-- reference alone satisfies completeness, so that argument was a second
-- free-text input into the one store nothing can rewrite. The site never lets a
-- person type a reference (a hidden field prefilled with the canonical published
-- one), so the only way an e-mail address reached an event was a crafted call —
-- which, until this migration, anyone holding the key could make. Resolution
-- now happens FIRST, and only the CANONICAL reference (or null) reaches criteria
-- and the event; the typed text stays where it always was, in the erasable
-- "About:" line of `message`. Not a reference-shape regex: that would be a
-- second copy of the shape 0033 asserts, and resolution against `properties`
-- already IS the binding.
--
-- RIDER (B03-b). `properties.currency` defaults to 'EUR' and no application path
-- writes anything else — the validators omit it, inserts never name it, units
-- inherit it — but nothing enforced it, so a raw-SQL GBP row would have printed
-- € in the CRM's lists and £ in its share links before the site ever saw it. A
-- validated CHECK makes the invariant a fact where the data is written; the
-- site's CURRENCY constant reads it as one.
--
-- DEPLOY ORDER IS THE 0055/0057 ONE, REVERSED FROM THE ADDITIVE RULE. A revoke
-- is destructive to the OLD route, which holds the anon client. Deploy the new
-- route first (service_role already has EXECUTE, so it works against the old
-- grants), confirm READY, THEN apply this on hosted. The other order answers
-- every enquiry 503 until the deploy lands.
--
-- 0084 is not rewritten (applied migrations never are). Its §4 block asserting
-- anon EXECUTE is history; §4 below supersedes it.

-- ---------------------------------------------------------------------------
-- 1. The door, rebuilt from 0084's body with one change: resolve first, and
--    let only the canonical reference travel.
-- ---------------------------------------------------------------------------
create or replace function public.submit_public_enquiry(
  p_org_slug     text,
  p_name         text,
  p_email        text,
  p_phone        text,
  p_message      text,
  p_property_ref text default null
)
returns boolean
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
  v_lead_id     uuid;
  v_body        text;
begin
  -- Length caps in the DATABASE, not only in the route: this function is the
  -- security boundary and must hold on its own terms.
  if v_name is null or length(v_name) > 200 then return false; end if;
  if v_email is not null and length(v_email) > 320 then return false; end if;
  if v_phone is not null and length(v_phone) > 40  then return false; end if;
  if v_message is not null and length(v_message) > 5000 then return false; end if;
  if v_ref is not null and length(v_ref) > 40 then return false; end if;

  -- A way to reply is the point of an enquiry.
  if v_email is null and v_phone is null then return false; end if;
  -- …and something to reply ABOUT.
  if v_message is null and v_ref is null then return false; end if;

  select id into v_org_id from organizations where slug = p_org_slug;
  if v_org_id is null then return false; end if;

  -- Only an ALREADY-PUBLIC listing resolves, so this never answers "does
  -- PAF0007 exist" for a reference nobody published. RESOLUTION IS THE
  -- BINDING: v_listing_ref is the row's own spelling or null, never the
  -- caller's text (0087 — the typed value used to reach the immutable event).
  if v_ref is not null then
    select id, reference into v_property_id, v_listing_ref
      from properties
     where org_id = v_org_id
       and reference = v_ref
       and visibility = 'public'
       and status = 'available';
  end if;

  -- The desk reads one block, in the order it needs: who, how to reach them,
  -- what they asked. Kept in `message` because erasure can rewrite this column
  -- — which is why the TYPED reference is allowed here and nowhere else.
  v_body := 'Website enquiry' || chr(10)
         || 'Name: '  || v_name || chr(10)
         || coalesce('Email: ' || v_email || chr(10), '')
         || coalesce('Phone: ' || v_phone || chr(10), '')
         || coalesce('About: ' || v_ref
              || case when v_property_id is null then ' (no published listing with that reference)' else '' end
              || chr(10), '')
         || coalesce(chr(10) || v_message, '');

  insert into leads (org_id, property_id, source, channel, message, status, criteria)
  values (
    v_org_id,
    v_property_id,
    'website',
    'email',
    v_body,
    'new',
    -- shape only, never content: `criteria` is NOT reachable by erasure, so
    -- only the canonical reference may enter it
    jsonb_build_object('channel', 'website_form', 'listing_reference', v_listing_ref)
  )
  returning id into v_lead_id;

  -- Guardrail 1. actor_id is null because no user did this. The payload carries
  -- no name, email, phone, message — or typed text of any kind: an event cannot
  -- be redacted, so nothing erasable may enter one.
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  values (
    v_org_id, null, 'lead', v_lead_id, 'created',
    jsonb_build_object(
      'source', 'website',
      'channel', 'website_form',
      'listing_reference', v_listing_ref,
      'matched_listing', v_property_id is not null,
      'has_email', v_email is not null,
      'has_phone', v_phone is not null
    )
  );

  return true;
end $fn$;

comment on function public.submit_public_enquiry(text, text, text, text, text, text) is
  'The public enquiry door (0084, rebuilt 0087). Creates a `website` lead and '
  'its event, never a contact — the desk links or creates one, with dedup, '
  'when it works the lead. Returns true when the enquiry was accepted. '
  'Identifying details live in leads.message, which GDPR erasure can redact; '
  'criteria and the event payload carry shape only — since 0087 that includes '
  'the reference, which is the resolved canonical value or null, never the '
  'caller''s text. EXECUTE is service_role-only since 0087: the Next route is '
  'the door, and holds the counter, the honeypot and the alert.';

-- ---------------------------------------------------------------------------
-- 2. Grants: the route is the only caller, so only its role may call.
-- ---------------------------------------------------------------------------
revoke execute on function public.submit_public_enquiry(text, text, text, text, text, text)
  from public, anon, authenticated;
grant  execute on function public.submit_public_enquiry(text, text, text, text, text, text)
  to service_role;

revoke execute on function public.note_public_enquiry_hit(text, int)
  from public, anon, authenticated;
grant  execute on function public.note_public_enquiry_hit(text, int)
  to service_role;

comment on function public.note_public_enquiry_hit(text, int) is
  'Records one enquiry submission for an IP hash in a 15-minute window and '
  'returns true when the caller is OVER the limit. service_role-only since '
  '0087: the caller chooses both the hash and the limit, so an anon-callable '
  'counter was a five-call primitive to burn any visitor''s budget.';

-- ---------------------------------------------------------------------------
-- 3. Rider: the currency invariant, enforced where the data is written.
-- ---------------------------------------------------------------------------
do $$
declare n int;
begin
  select count(*) into n from properties where currency <> 'EUR';
  if n > 0 then
    raise exception '0087 aborted: % properties carry a non-EUR currency — decide before constraining', n;
  end if;
end $$;

-- Validated on apply (never NOT VALID — the 0026 stance): the preflight above
-- has just proven there is nothing to invalidate.
alter table public.properties
  add constraint properties_currency_eur check (currency = 'EUR');

comment on constraint properties_currency_eur on public.properties is
  'The desk trades in EUR and nothing in the application writes another '
  'currency (BACKLOG rules the column vestigial). Enforced here so that a row '
  'written past the application cannot make the CRM disagree with itself — or '
  'with the public site, whose CURRENCY constant assumes this (0087).';

-- ---------------------------------------------------------------------------
-- 4. Prove it.
-- ---------------------------------------------------------------------------
do $$
declare
  v_org   uuid;
  v_slug  text;
  v_pub   text;
  v_ok    boolean;
  v_lead  record;
  n       int;
begin
  -- (a) the grants: anon and authenticated refused, service_role kept
  if has_function_privilege('anon', 'public.submit_public_enquiry(text, text, text, text, text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.submit_public_enquiry(text, text, text, text, text, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.note_public_enquiry_hit(text, int)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.note_public_enquiry_hit(text, int)', 'EXECUTE') then
    raise exception '0087 aborted: anon or authenticated can still execute an enquiry function';
  end if;
  if not has_function_privilege('service_role', 'public.submit_public_enquiry(text, text, text, text, text, text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.note_public_enquiry_hit(text, int)', 'EXECUTE') then
    raise exception '0087 aborted: service_role lost EXECUTE — the route would answer 503 on every enquiry';
  end if;

  -- (b) the currency CHECK exists and is validated
  select count(*) into n from pg_constraint
   where conname = 'properties_currency_eur' and conrelid = 'public.properties'::regclass and convalidated;
  if n <> 1 then
    raise exception '0087 aborted: properties_currency_eur is missing or not validated';
  end if;

  -- (c) THE POINT: typed reference text reaches nothing immutable.
  select id, slug into v_org, v_slug from organizations order by created_at limit 1;
  if v_org is null then
    raise notice '0087: no organization on this database — grants and CHECK asserted; the reference probe is covered by RLS test 55';
  else
    -- an e-mail address typed into the reference field, with no message: it
    -- satisfies completeness, which is exactly what made this a second input
    v_ok := submit_public_enquiry(v_slug, '0087 selftest', 'selftest@example.invalid',
                                  null, null, 'probe@example.invalid');
    if not v_ok then raise exception '0087 aborted: an enquiry with a reply channel and a reference was refused'; end if;

    select * into v_lead from leads
     where org_id = v_org and source = 'website' and message like '%0087 selftest%'
     order by received_at desc limit 1;
    if not found then raise exception '0087 aborted: no lead was created'; end if;

    if v_lead.criteria ->> 'listing_reference' is not null then
      raise exception '0087 aborted: an unresolved reference reached leads.criteria';
    end if;
    select count(*) into n from events
     where entity_type = 'lead' and entity_id = v_lead.id
       and (payload::text ilike '%probe@example.invalid%' or payload ->> 'listing_reference' is not null);
    if n <> 0 then
      raise exception '0087 aborted: typed reference text reached the immutable event';
    end if;
    -- …and the desk still sees what was typed, where erasure can reach it
    if v_lead.message not like '%About: probe@example.invalid%' then
      raise exception '0087 aborted: the typed reference did not reach the erasable message';
    end if;
    -- clean up as 0084 did: the lead goes, the event stays (it is in the chain)
    delete from leads where id = v_lead.id;

    -- (d) a published reference resolves to the row's own spelling
    select reference into v_pub from properties
     where org_id = v_org and visibility = 'public' and status = 'available'
     order by created_at limit 1;
    if v_pub is null then
      raise notice '0087: no published listing in % — the canonical-reference half is covered by RLS test 55', v_slug;
    else
      v_ok := submit_public_enquiry(v_slug, '0087 selftest', 'selftest@example.invalid',
                                    null, null, v_pub);
      if not v_ok then raise exception '0087 aborted: an enquiry about a published listing was refused'; end if;
      select * into v_lead from leads
       where org_id = v_org and source = 'website' and message like '%0087 selftest%'
       order by received_at desc limit 1;
      if v_lead.property_id is null or v_lead.criteria ->> 'listing_reference' is distinct from v_pub then
        raise exception '0087 aborted: a published reference did not resolve to its canonical spelling';
      end if;
      select count(*) into n from events
       where entity_type = 'lead' and entity_id = v_lead.id
         and payload ->> 'listing_reference' = v_pub
         and (payload ->> 'matched_listing')::boolean;
      if n <> 1 then
        raise exception '0087 aborted: the event does not carry the canonical reference';
      end if;
      delete from leads where id = v_lead.id;
    end if;

    raise notice '0087: enquiry door is service_role-only; typed reference text PROVEN to reach only the erasable message; currency = EUR enforced';
  end if;
end $$;
