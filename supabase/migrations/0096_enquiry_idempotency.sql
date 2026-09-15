-- 0096 — the enquiry door is idempotent, and says which lead it made
-- (integrations audit 2026-09-15, INT-02 and INT-01).
--
-- WHY. The marketing site gives the CRM eight seconds; the enquiry counter
-- RPC was measured at 3.3 s under a build burst on 2026-09-13. A row that
-- commits after the site has given up looks like a failure to the visitor
-- and a lead to the desk, and the visitor's second attempt makes a second
-- lead that nothing can tell from the first. A key the site mints per form
-- makes the second attempt answer with the FIRST lead and write nothing —
-- no row, no event, and (in the route) no second desk alert.
--
-- AND the door now returns the lead it made or replayed, so the route can
-- write the alert's OUTCOME as an event on that lead's timeline. Until now
-- `sendEnquiryAlert`'s word was discarded: a failed or skipped alert left a
-- lead in the inbox with nothing anywhere saying nobody had been told.
--
-- RETURN SHAPE CHANGE. `returns boolean` becomes `returns table (lead_id,
-- lead_org_id, replayed)`. A refusal is ZERO rows (the old `false`), so the
-- route's "unknown org" branch keeps its meaning. A return type cannot be
-- changed with `create or replace`, hence the drop — and a drop takes the
-- ACL with it, so the 0087 lockdown is restated below and asserted.
--
-- The key is random and per form, never personal: erasure and the retention
-- sweep leave it alone. It is unique per organisation, partially: leads the
-- desk types have no key, and null must never collide with null.

-- ---------------------------------------------------------------------------
-- 1. The column and its index
-- ---------------------------------------------------------------------------
alter table public.leads
  add column if not exists idempotency_key text
  constraint leads_idempotency_key_chk check (idempotency_key ~ '^[A-Za-z0-9-]{8,64}$');

comment on column public.leads.idempotency_key is
  'Caller-minted key that makes a repeated website submission answer with the '
  'same lead (0096). Random, not personal; unique per org where present.';

create unique index if not exists leads_idempotency_key_uidx
  on public.leads (org_id, idempotency_key)
  where idempotency_key is not null;

-- ---------------------------------------------------------------------------
-- 2. The door
-- ---------------------------------------------------------------------------
drop function if exists public.submit_public_enquiry(text, text, text, text, text, text);

create function public.submit_public_enquiry(
  p_org_slug        text,
  p_name            text,
  p_email           text,
  p_phone           text,
  p_message         text,
  p_property_ref    text default null,
  p_idempotency_key text default null
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
begin
  -- Length caps in the DATABASE, not only in the route: this function is the
  -- security boundary and must hold on its own terms. A refusal is no rows.
  if v_name is null or length(v_name) > 200 then return; end if;
  if v_email is not null and length(v_email) > 320 then return; end if;
  if v_phone is not null and length(v_phone) > 40  then return; end if;
  if v_message is not null and length(v_message) > 5000 then return; end if;
  if v_ref is not null and length(v_ref) > 40 then return; end if;
  if v_key is not null and v_key !~ '^[A-Za-z0-9-]{8,64}$' then return; end if;

  -- A way to reply is the point of an enquiry.
  if v_email is null and v_phone is null then return; end if;
  -- …and something to reply ABOUT.
  if v_message is null and v_ref is null then return; end if;

  select o.id into v_org_id from organizations o where o.slug = p_org_slug;
  if v_org_id is null then return; end if;

  -- The replay, answered before anything is written.
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
  -- caller's text (0087 — the typed value used to reach the immutable event).
  if v_ref is not null then
    select p.id, p.reference into v_property_id, v_listing_ref
      from properties p
     where p.org_id = v_org_id
       and p.reference = v_ref
       and p.visibility = 'public'
       and p.status = 'available';
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

  -- The race: two identical posts in the same second. The second loses the
  -- partial unique index, writes nothing, and is answered as the replay it is.
  insert into leads (org_id, property_id, source, channel, message, status, criteria, idempotency_key)
  values (
    v_org_id,
    v_property_id,
    'website',
    -- 0092: the channel is the detail the visitor gave, not a constant.
    case when v_email is not null then 'email'::comm_channel else 'phone'::comm_channel end,
    v_body,
    'new',
    -- shape only, never content: `criteria` is NOT reachable by erasure, so
    -- only the canonical reference may enter it
    jsonb_build_object('channel', 'website_form', 'listing_reference', v_listing_ref),
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

  return query select v_lead_id, v_org_id, false;
end $fn$;

comment on function public.submit_public_enquiry(text, text, text, text, text, text, text) is
  'The public enquiry door (0084, rebuilt 0087, channel derived 0092, idempotent '
  '0096). Creates a `website` lead and its event, never a contact — the desk '
  'links or creates one, with dedup, when it works the lead. Returns one row: '
  'the lead id and org, and replayed=true when the key was seen before (nothing '
  'is written then). Zero rows is a refusal. Identifying details live in '
  'leads.message, which GDPR erasure and the 24-month retention sweep can '
  'redact; criteria and the event payload carry shape only. EXECUTE is '
  'service_role-only since 0087: the Next route is the door, and holds the '
  'counter, the honeypot and the alert.';

-- The 0087 lockdown, restated because the drop above took the ACL with it.
revoke execute on function public.submit_public_enquiry(text, text, text, text, text, text, text)
  from public, anon, authenticated;
grant  execute on function public.submit_public_enquiry(text, text, text, text, text, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 3. Self-check: the grants, the index, and that the old signature is gone —
--    asserted, not trusted (the 0044 advisor hole, the 0021 skipped-advisor
--    lesson).
-- ---------------------------------------------------------------------------
do $$
begin
  if has_function_privilege('anon', 'public.submit_public_enquiry(text,text,text,text,text,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.submit_public_enquiry(text,text,text,text,text,text,text)', 'execute') then
    raise exception '0096: submit_public_enquiry is executable by anon or authenticated';
  end if;
  if not has_function_privilege('service_role', 'public.submit_public_enquiry(text,text,text,text,text,text,text)', 'execute') then
    raise exception '0096: service_role lost execute on submit_public_enquiry';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'submit_public_enquiry' and p.pronargs <> 7
  ) then
    raise exception '0096: an older submit_public_enquiry signature survived';
  end if;
  if not exists (
    select 1 from pg_indexes where schemaname = 'public' and indexname = 'leads_idempotency_key_uidx'
  ) then
    raise exception '0096: leads_idempotency_key_uidx missing';
  end if;
end $$;
