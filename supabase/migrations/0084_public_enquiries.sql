-- 0084 — inbound enquiries: the first PUBLIC WRITE path into this system.
--
-- WHY. Everything outward is built and idle: `public_listings` (0066) serves a
-- 34-column trilingual feed with image renditions, and nothing consumes it,
-- because there is no way for a person who reads a listing to reach the desk.
-- Measured 2026-09-04, production had 4 properties, 3 leads, and ZERO
-- viewings, offers, reservations or tasks — the daily loop has never run for
-- want of anything arriving at the top of it. This is that door.
--
-- THE DIFFERENCE FROM 0066, AND WHY IT IS THE WHOLE DESIGN. That feed READS
-- already-public data; this WRITES. An unauthenticated write into a CRM is a
-- spam funnel and a GDPR surface at the same time, so:
--
--   * Its own counter table and its own budget. 0066's comment already makes
--     the point about not sharing one — a flood here must not exhaust a
--     buyer's share-link budget, nor a site's feed polling. And the budget is
--     5 per 15 minutes, not 120: polling a feed is expected behaviour,
--     submitting five enquiries in a quarter of an hour is not.
--   * NO CONTACT IS CREATED. A contact is the desk's core asset and its dedup
--     surface; letting anonymous traffic mint contacts pollutes it with a
--     bot's random addresses. `leads.status = 'spam'` already exists as the
--     designed containment, and the desk's own flow creates or links a
--     contact (with dedup) when it decides the enquiry is real.
--   * THE ENQUIRER'S DETAILS GO IN `message`, NOT `criteria`. GDPR erasure
--     redacts `leads.message` (contact-erasure.ts) and never touches
--     `criteria`, so putting a name or an email in the jsonb would create
--     personal data the erasure flow cannot reach. Residual, and recorded
--     rather than hidden: that redaction is scoped `.eq(contact_id, …)`, so
--     an enquiry NOBODY HAS LINKED YET is not reachable by an erasure request
--     either. It becomes reachable the moment the desk links a contact, which
--     is also the moment there is a contact to erase against.
--   * NOTHING IDENTIFYING GOES IN THE EVENT. Events are hash-chained and
--     immutable by design — the erasure code says so out loud where it
--     explains why a lead message may be rewritten and a payload may not. A
--     name in a payload could never be erased, so the payload carries shape
--     (source, whether an email or phone came with it) and never content.
--   * A PROPERTY REFERENCE RESOLVES ONLY IF IT IS ALREADY PUBLIC. Otherwise
--     the endpoint answers "which of my private references exist" to anyone
--     who asks. An unresolved reference is not an error — it is kept as text
--     in the message so the desk can see what the person typed.
--
-- The function is the only door: `anon` gets EXECUTE on it by name and no
-- table privileges, exactly as 0066 did it.

-- ---------------------------------------------------------------------------
-- 1. The counter. Its own table, so its budget is its own.
-- ---------------------------------------------------------------------------
create table if not exists public.public_enquiry_attempts (
  ip_hash      text        not null,
  window_start timestamptz not null,
  attempts     int         not null default 0,
  primary key (ip_hash, window_start)
);

alter table public.public_enquiry_attempts enable row level security;
-- No grants: only the SECURITY DEFINER function below touches it. RLS is on so
-- a future grant cannot silently open the table.
revoke all on public.public_enquiry_attempts from anon, authenticated;

drop policy if exists deny_direct_access on public.public_enquiry_attempts;
create policy deny_direct_access on public.public_enquiry_attempts
  for all using (false) with check (false);

-- A TABLE CREATED AFTER 0029 DOES NOT INHERIT require_aal2, and
-- rls_aal2_coverage() must stay at 0. 0066 learned this the same way — its
-- counter table failed `mfa-enforcement.test.ts` on the first run, and so did
-- this one. Redundant against deny_direct_access, and kept anyway: an
-- invariant with one reasonable-looking exception is not an invariant.
drop policy if exists require_aal2 on public.public_enquiry_attempts;
create policy require_aal2 on public.public_enquiry_attempts
  as restrictive for all to authenticated
  using ((select mfa_satisfied())) with check ((select mfa_satisfied()));

comment on table public.public_enquiry_attempts is
  'Per-IP-hash submission counter for the public enquiry endpoint (0084). '
  'Separate from public_listing_attempts and share_link_attempts on purpose: '
  'a write surface must not be able to exhaust a read budget, or be exhausted '
  'by one.';

create or replace function public.note_public_enquiry_hit(p_ip_hash text, p_limit int default 5)
returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  v_window timestamptz := date_trunc('hour', now())
                        + (floor(extract(minute from now()) / 15) * interval '15 minutes');
  v_attempts int;
begin
  insert into public_enquiry_attempts (ip_hash, window_start, attempts)
  values (p_ip_hash, v_window, 1)
  on conflict (ip_hash, window_start)
  do update set attempts = public_enquiry_attempts.attempts + 1
  returning attempts into v_attempts;

  -- opportunistic prune, the 0023 idiom
  delete from public_enquiry_attempts where window_start < now() - interval '2 hours';

  return v_attempts > p_limit;
end $fn$;

comment on function public.note_public_enquiry_hit(text, int) is
  'Records one enquiry submission for an IP hash in a 15-minute window and '
  'returns true when the caller is OVER the limit. The default budget is 5, '
  'far tighter than the feed''s 120: polling a listings feed is the expected '
  'behaviour of a marketing site, submitting five enquiries in a quarter of '
  'an hour is not the behaviour of a buyer.';

-- ---------------------------------------------------------------------------
-- 2. The door. SECURITY DEFINER because `anon` has no reach into `leads`,
--    `properties` or `events` and must not be given any.
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
  v_ref         text := nullif(btrim(coalesce(p_property_ref, '')), '');
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

  -- Only an ALREADY-PUBLIC listing resolves. Anything else stays text, so this
  -- never answers "does PAF0007 exist" for a reference nobody published.
  if v_ref is not null then
    select id into v_property_id
      from properties
     where org_id = v_org_id
       and reference = v_ref
       and visibility = 'public'
       and status = 'available';
  end if;

  -- The desk reads one block, in the order it needs: who, how to reach them,
  -- what they asked. Kept in `message` because erasure can rewrite this column.
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
    -- shape only, never content: `criteria` is NOT reachable by erasure
    jsonb_build_object('channel', 'website_form', 'listing_reference', v_ref)
  )
  returning id into v_lead_id;

  -- Guardrail 1. actor_id is null because no user did this — the same shape
  -- the importers use. The payload carries no name, email, phone or message:
  -- an event cannot be redacted, so nothing erasable may enter one.
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  values (
    v_org_id, null, 'lead', v_lead_id, 'created',
    jsonb_build_object(
      'source', 'website',
      'channel', 'website_form',
      'listing_reference', v_ref,
      'matched_listing', v_property_id is not null,
      'has_email', v_email is not null,
      'has_phone', v_phone is not null
    )
  );

  return true;
end $fn$;

comment on function public.submit_public_enquiry(text, text, text, text, text, text) is
  'The public enquiry door (0084). Creates a `website` lead and its event, '
  'never a contact — the desk links or creates one, with dedup, when it works '
  'the lead. Returns true when the enquiry was accepted. Identifying details '
  'live in leads.message, which GDPR erasure can redact; the event payload '
  'carries shape only, because a hash-chained row can never be rewritten.';

-- ---------------------------------------------------------------------------
-- 3. Grants: the function by name, nothing else. Mirrors 0066.
-- ---------------------------------------------------------------------------
revoke execute on function public.note_public_enquiry_hit(text, int) from public;
grant  execute on function public.note_public_enquiry_hit(text, int) to anon, authenticated, service_role;

revoke execute on function public.submit_public_enquiry(text, text, text, text, text, text) from public;
grant  execute on function public.submit_public_enquiry(text, text, text, text, text, text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Apply-time assertions. What this migration claims, proven here.
-- ---------------------------------------------------------------------------
do $$
declare
  v_org   uuid;
  v_slug  text;
  v_ok    boolean;
  v_lead  record;
  n       int;
begin
  select id, slug into v_org, v_slug from organizations order by created_at limit 1;
  if v_org is null then
    raise notice '0084: no organization to self-test against — grants checked only';
  else
    -- accepted: a name, a way to reply, something to say
    v_ok := submit_public_enquiry(v_slug, '0084 selftest', 'selftest@example.invalid',
                                  null, '0084 self-test enquiry', null);
    if not v_ok then raise exception '0084 aborted: a valid enquiry was refused'; end if;

    select * into v_lead from leads
     where org_id = v_org and source = 'website' and message like '%0084 selftest%'
     order by received_at desc limit 1;
    -- `not found`, not `v_lead is null`: a record is IS NULL only when every
    -- one of its columns is, which a real row never satisfies
    if not found then raise exception '0084 aborted: no lead was created'; end if;

    -- the event exists, and carries NO identifying content
    select count(*) into n from events
     where entity_type = 'lead' and entity_id = v_lead.id and event_type = 'created';
    if n <> 1 then raise exception '0084 aborted: expected exactly 1 lead event, found %', n; end if;

    select count(*) into n from events
     where entity_id = v_lead.id
       and (payload::text ilike '%selftest@example.invalid%'
         or payload::text ilike '%0084 selftest%');
    if n <> 0 then
      raise exception '0084 aborted: the event payload carries identifying content — it can never be erased';
    end if;

    -- refusals: no way to reply, and nothing to say
    if submit_public_enquiry(v_slug, 'No contact', null, null, 'hello', null) then
      raise exception '0084 aborted: accepted an enquiry with no email and no phone';
    end if;
    if submit_public_enquiry(v_slug, 'No subject', 'a@example.invalid', null, null, null) then
      raise exception '0084 aborted: accepted an enquiry with no message and no reference';
    end if;
    if submit_public_enquiry('no-such-org-0084', 'Nobody', 'a@example.invalid', null, 'hi', null) then
      raise exception '0084 aborted: accepted an enquiry for an unknown org';
    end if;

    -- clean the self-test up: its event first would break the chain, so the
    -- lead row goes and the event stays, exactly as a real lead's would
    delete from leads where id = v_lead.id;
  end if;

  -- anon reaches the two functions and NEITHER table
  if not has_function_privilege('anon', 'public.submit_public_enquiry(text, text, text, text, text, text)', 'EXECUTE')
     or not has_function_privilege('anon', 'public.note_public_enquiry_hit(text, int)', 'EXECUTE') then
    raise exception '0084 aborted: anon cannot execute the enquiry functions';
  end if;
  if has_table_privilege('anon', 'public.public_enquiry_attempts', 'SELECT')
     or has_table_privilege('anon', 'public.public_enquiry_attempts', 'INSERT')
     or has_table_privilege('anon', 'public.leads', 'INSERT') then
    raise exception '0084 aborted: anon has table reach it must not have';
  end if;

  -- the invariant the mfa suite enforces: no RLS-enabled public table without
  -- require_aal2, this one included
  select count(*) into n from rls_aal2_coverage();
  if n <> 0 then
    raise exception '0084 aborted: % table(s) lack require_aal2', n;
  end if;

  raise notice '0084: public enquiry door live — own 5/15min budget, no contact minted, no PII in the event';
end $$;
