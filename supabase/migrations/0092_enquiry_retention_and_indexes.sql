-- =============================================================================
-- 0092 — Enquiry retention, the website lead's channel, and nine indexes
--        (audit 2026-09-13: DATA-01, DATA-02, PERF-02)
--
-- 1. THE PRIVACY PAGE PROMISED SOMETHING NOTHING PERFORMED. gnk-web's /legal
--    says an enquiry that does not lead to work is deleted within two years.
--    No job did that: a website lead with no linked contact could only be
--    redacted by hand (redactLead), and nobody was going to remember in 2028.
--    `redact_stale_enquiries(p_months default 24)` runs nightly at 03:10 and
--    redacts `leads.message` — the ONLY column a website enquiry's personal
--    data lives in (0084/0087 build the name, email, phone and text into it;
--    `criteria` and the event carry shape only) — for website leads with no
--    contact, not converted, received more than 24 months ago. The literal is
--    the app's own LEAD_MESSAGE_REDACTED so redactLead reads it as done. One
--    `redacted` event per row, actor null (nobody did this), payload
--    {reason: retention, months: 24}: the log says the promise was kept and
--    when, without carrying anything erasable. A lead WITH a contact is left
--    alone: its personal data is the contact's, and the contact's erasure
--    (0017) already redacts every lead it holds. 24 months is a matched pair
--    with the sentence on the site; the RLS test pins this side and the site's
--    test pins that side. Change both or neither.
--
-- 2. EVERY WEBSITE LEAD WAS CHANNEL 'email', EVEN A PHONE-ONLY ONE (0087
--    hard-coded it). The desk's channel filter and the response-time views
--    therefore filed a "call me" enquiry under email. Derived now from which
--    contact detail the visitor gave; email wins when both are present, as it
--    is the channel the alert's reply-to already uses.
--
-- 3. NINE INDEXES the advisor listed as missing foreign-key indexes, chosen
--    because a query actually walks them today or will the day the desk has
--    a month of leads: the lead inbox joins contacts and properties and
--    filters by assignee; the task buckets join their property and contact;
--    a deal's viewings and reservations and a property's offers are read on
--    every detail page. Plus one partial index for the sweep above, so it
--    stays a range scan over website leads without a contact rather than a
--    walk of the whole table every night.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The retention sweep
-- ---------------------------------------------------------------------------
create or replace function public.redact_stale_enquiries(p_months int default 24)
returns int
language plpgsql security definer set search_path = public as $fn$
declare
  v_count int;
begin
  if p_months is null or p_months < 1 then
    raise exception 'redact_stale_enquiries: p_months must be a positive number of months';
  end if;

  with due as (
    select id, org_id
      from leads
     where source = 'website'
       and contact_id is null
       and status in ('new', 'contacted', 'lost', 'spam')
       and received_at < now() - make_interval(months => p_months)
       and message is distinct from '[erased at the contact''s request]'
     for update skip locked
  ),
  done as (
    update leads l
       set message = '[erased at the contact''s request]'
      from due
     where l.id = due.id
    returning l.id, l.org_id
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select org_id, null, 'lead', id, 'redacted',
         jsonb_build_object('reason', 'retention', 'months', p_months)
    from done;

  get diagnostics v_count = row_count;
  return v_count;
end $fn$;

comment on function public.redact_stale_enquiries(int) is
  'Nightly (03:10): redacts leads.message for website enquiries with no linked '
  'contact that did not convert and are older than p_months (default 24 — the '
  'period the public privacy notice states; the site pins the same number). '
  'One `redacted` event per row with a null actor and a shape-only payload. '
  'Returns the number of rows redacted. A lead with a contact is the contact''s '
  'erasure''s business (0017). Idempotent: an already-redacted row is skipped.';

-- The 03:10 slot: after expire-mandates (03:00), before followup-nudges (03:15),
-- which must not raise a nudge on a row this sweep just emptied.
select cron.schedule('redact-stale-enquiries', '10 3 * * *',
                     $$select redact_stale_enquiries()$$);

-- LOCK DOWN EXECUTE — the 0044 lesson, every function since: a new function
-- carries a PUBLIC =X grant, `public` must be named to remove it, and naming
-- roles strips service_role's implicit grant, hence the re-grant. cron runs it
-- as postgres and needs no grant.
revoke execute on function public.redact_stale_enquiries(int) from public, anon, authenticated;
grant  execute on function public.redact_stale_enquiries(int) to service_role;

-- ---------------------------------------------------------------------------
-- 2. The website lead's channel is the contact detail the visitor gave
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
    -- 0092: the channel is the detail the visitor gave, not a constant. A
    -- reply goes to the email when there is one; a phone-only enquiry is a
    -- call, and the inbox's channel filter should say so.
    case when v_email is not null then 'email'::comm_channel else 'phone'::comm_channel end,
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
  'The public enquiry door (0084, rebuilt 0087, channel derived 0092). Creates '
  'a `website` lead and its event, never a contact — the desk links or creates '
  'one, with dedup, when it works the lead. Returns true when the enquiry was '
  'accepted. Identifying details live in leads.message, which GDPR erasure and '
  'the 24-month retention sweep can redact; criteria and the event payload '
  'carry shape only — the reference is the resolved canonical value or null, '
  'never the caller''s text. The channel is email when an email was given, '
  'otherwise phone. EXECUTE is service_role-only since 0087: the Next route is '
  'the door, and holds the counter, the honeypot and the alert.';

-- `create or replace` keeps the ACL (HANDOFF §3), but the 0087 lockdown is
-- restated so this file can be read on its own and so a future replace that
-- drops and recreates cannot quietly reopen the door.
revoke execute on function public.submit_public_enquiry(text, text, text, text, text, text)
  from public, anon, authenticated;
grant  execute on function public.submit_public_enquiry(text, text, text, text, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 3. Indexes
-- ---------------------------------------------------------------------------
create index if not exists leads_contact_id_idx        on public.leads (contact_id);
create index if not exists leads_property_id_idx       on public.leads (property_id);
create index if not exists leads_assigned_agent_id_idx on public.leads (assigned_agent_id);
create index if not exists tasks_property_id_idx       on public.tasks (property_id);
create index if not exists tasks_contact_id_idx        on public.tasks (contact_id);
create index if not exists viewings_deal_id_idx        on public.viewings (deal_id);
create index if not exists reservations_deal_id_idx    on public.reservations (deal_id);
create index if not exists offers_property_id_idx      on public.offers (property_id);
-- the sweep's own: website leads without a contact, by age
create index if not exists leads_website_unlinked_received_idx
  on public.leads (received_at)
  where source = 'website' and contact_id is null;

-- ---------------------------------------------------------------------------
-- 4. Self-check: grants, schedule, the period, the indexes — asserted, not
--    trusted (the 0044 advisor hole, the 0021 skipped-advisor lesson).
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text;
  v_missing text[];
begin
  if has_function_privilege('anon', 'public.redact_stale_enquiries(int)', 'execute')
     or has_function_privilege('authenticated', 'public.redact_stale_enquiries(int)', 'execute') then
    raise exception '0092: redact_stale_enquiries is executable by anon or authenticated';
  end if;
  if not has_function_privilege('service_role', 'public.redact_stale_enquiries(int)', 'execute') then
    raise exception '0092: redact_stale_enquiries lost its service_role grant';
  end if;
  if has_function_privilege('anon', 'public.submit_public_enquiry(text,text,text,text,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.submit_public_enquiry(text,text,text,text,text,text)', 'execute') then
    raise exception '0092: submit_public_enquiry reopened to anon or authenticated';
  end if;

  -- pg_get_functiondef renders the signature as "p_months integer DEFAULT 24"
  select pg_get_functiondef('public.redact_stale_enquiries(int)'::regprocedure) into v_def;
  if v_def !~* 'p_months integer default 24' then
    raise exception '0092: the retention default is not 24 months — the site states 24';
  end if;

  if not exists (select 1 from cron.job where jobname = 'redact-stale-enquiries' and schedule = '10 3 * * *') then
    raise exception '0092: redact-stale-enquiries is not scheduled at 03:10';
  end if;

  select array_agg(i) into v_missing
    from unnest(array[
      'leads_contact_id_idx','leads_property_id_idx','leads_assigned_agent_id_idx',
      'tasks_property_id_idx','tasks_contact_id_idx','viewings_deal_id_idx',
      'reservations_deal_id_idx','offers_property_id_idx','leads_website_unlinked_received_idx'
    ]) i
   where not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = i);
  if v_missing is not null then
    raise exception '0092: index(es) missing: %', array_to_string(v_missing, ', ');
  end if;

  raise notice '0092: retention sweep scheduled (03:10, 24 months), channel derived, 9 indexes present.';
end $$;
