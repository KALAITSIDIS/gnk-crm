-- =============================================================================
-- 0098 — the website enquiry carries its brief as DATA, a routing rule assigns
--        it on arrival, and a ten-minute sweep chases one that waits over an
--        hour (audit 2026-09-15, LR-01, LR-02, LR-05; plan
--        docs/superpowers/plans/2026-09-15-sprint-a-lead-routing.md)
--
-- BUILDS ON 0096 (integrations audit): the door is idempotent by key and
-- returns the lead it made or replayed. 0097 is the integrations session's
-- portal-token migration and does not touch this function; the gap between
-- 0096 and 0098, if 0097 lands later, is deliberate numbering, not a hole.
--
-- 1. p_meta ON THE DOOR. The site asks a buyer seven structured questions and
--    a seller ten (budget band, area, type, timing, deed position …) and until
--    now flattened the answers into sentences appended to `leads.message`,
--    where nothing could filter, match or report on them — production held
--    eight website leads and zero buyer_requirements. `submit_public_enquiry`
--    gains `p_meta jsonb default null` as an EIGHTH argument after 0096's
--    p_idempotency_key; the seven-argument overload is dropped (two overloads
--    with defaults make the shorter call ambiguous), and a caller that omits
--    p_meta gets exactly 0096's behaviour. The return table is 0096's.
--
--    THE ALLOWLIST LIVES HERE, because this function is the security boundary
--    (0084's principle) and `criteria` is NOT rewritten by erasure or by the
--    retention sweep. Only a key in v_caps, holding a STRING, trimmed, non-empty
--    and no longer than its cap, reaches `criteria`. Every admitted key is a
--    select value, a number-as-text, a path or a campaign name — the site's
--    own field names and its FIELD_CAPS to the character (gnk-web
--    lib/enquiry-fields.ts; the app's copy is lib/services/enquiry-meta.ts and
--    supabase/tests/enquiry-meta.test.ts pins this side). A name, an e-mail, a
--    phone or free prose has no key here and cannot be smuggled in under one.
--    The function's own two keys (`channel`, `listing_reference`) are written
--    LAST so meta can never override them. A REPLAY (same key) writes nothing,
--    so the first post's meta stands — exactly as its message does.
--
--    `source` STAYS `website` FOR EVERY FORM FILL, whatever utm_source says.
--    Deriving it from the campaign would file an Instagram-ad enquiry as
--    source=instagram — and `redact_stale_enquiries` (0092) sweeps
--    `source = 'website'`, so that lead would escape the 24-month erasure the
--    privacy page promises. The campaign travels in criteria; reports can read
--    it there. The `created` event gains has_meta, source_page and utm_source:
--    a path and an ad platform's name, never a person.
--
-- 2. THE ROUTING RULE. Every website lead arrived unassigned, on nobody's
--    dashboard, and the desk was expected to claim it. `cyprus_config.
--    lead_routing` = {mode: off|round_robin, agents: [profile ids]} — seeded
--    OFF, editable on Settings → Lead routing. Under round_robin the function
--    picks, among the named members who are ACTIVE in this org, the one with
--    the fewest open leads, then the one assigned longest ago, and writes an
--    `assigned` event with a null actor: nobody signed in did this. The rule
--    is applied here and not in the Next route because the function holds the
--    lead id at the moment of insert and the route only learns it afterwards.
--
-- 3. tasks.lead_id AND THE SLA SWEEP. The response clock (green < 5 min,
--    amber < 60, red beyond) was a colour on a chip: when it turned red
--    nothing was raised. `raise_lead_sla_tasks(p_org, p_minutes default 60)`
--    runs every ten minutes and mints one `lead_unanswered` task per website
--    lead still open with no first_response_at after the hour — assigned to
--    the lead's agent, else the oldest active admin (0020's fallback), due NOW
--    because it is already late. Keyed to the lead (one task per lead, ever:
--    a lead has one first response), superseded by the same sweep once the
--    lead is answered or closed, with a null-actor `superseded` event, exactly
--    as 0020's nudges self-heal. No e-mail leaves this sweep: pg_net is
--    available on the hosted project but not installed, and enabling it is an
--    operator decision — the e-mail escalation is trigger T1's second half.
--    The task title carries the listing reference and never the person.
--
-- Pins that move with this file: the migrations count and 14 task kinds in
-- scripts/backup/verify-restore.sql (+ a grants row for the new SECURITY
-- DEFINER function, + lead-sla in the cron list, exactly 10 jobs), RLS test 50
-- (ten jobs), EXPECTED_CRON_JOBS in lib/services/cron-health.ts, docs/10's
-- cron table, HANDOFF §0's Cron row.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The door, with p_meta (0096's signature plus one argument)
-- ---------------------------------------------------------------------------
drop function if exists public.submit_public_enquiry(text, text, text, text, text, text, text);

create function public.submit_public_enquiry(
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

  -- The replay (0096), answered before anything is written. The first post's
  -- meta stands, exactly as its message does.
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
  '0096, meta + routing 0098). Creates a `website` lead and its event, never a '
  'contact. Returns one row: the lead id and org, and replayed=true when the key '
  'was seen before (nothing is written then). Zero rows is a refusal. p_meta: the '
  'site''s structured brief and provenance, admitted key by key from the allowlist '
  'in the body (shape only — criteria is not erasable) and merged into criteria '
  'under the function''s own channel/listing_reference. source stays website for '
  'every form fill: the retention sweep keys on it. Applies cyprus_config.'
  'lead_routing on arrival (round_robin: fewest open leads, then longest ago '
  'assigned) with a null-actor assigned event. EXECUTE is service_role-only since '
  '0087: the Next route is the door.';

-- The 0087 lockdown, restated because the drop above took the ACL with it.
revoke execute on function public.submit_public_enquiry(text, text, text, text, text, text, text, jsonb)
  from public, anon, authenticated;
grant  execute on function public.submit_public_enquiry(text, text, text, text, text, text, text, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- 2. The routing row — off until the desk turns it on
-- ---------------------------------------------------------------------------
-- `on conflict do nothing`: re-running must never clobber a value the desk has
-- since chosen. The description is what the generic config editor renders.
insert into public.cyprus_config (key, value, description) values (
  'lead_routing',
  jsonb_build_object('mode', 'off', 'agents', '[]'::jsonb),
  'How a website enquiry is assigned on arrival: off (the desk claims it) or round_robin over the listed members. Editable on Settings → Lead routing.'
) on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 3. A task can point at a lead; the SLA sweep needs it
-- ---------------------------------------------------------------------------
alter table public.tasks add column if not exists lead_id uuid references public.leads(id);
create index if not exists tasks_lead_id_idx on public.tasks (lead_id) where lead_id is not null;

comment on column public.tasks.lead_id is
  'The lead this task concerns (0098) — the lead_unanswered sweep keys on it.';

insert into public.task_kinds (kind, description, added_in) values
  ('lead_unanswered', 'A website enquiry has waited over an hour for a first response', '0098')
on conflict (kind) do nothing;

create or replace function public.raise_lead_sla_tasks(p_org uuid default null, p_minutes int default 60)
returns int
language plpgsql security definer set search_path = public as $fn$
declare
  v_count  int := 0;
  v_closed int := 0;
begin
  if p_minutes is null or p_minutes < 1 then
    raise exception 'raise_lead_sla_tasks: p_minutes must be a positive number of minutes';
  end if;

  -- 1) mint: open website leads past the hour with no first response and no
  --    task yet. One task per lead, ever — a lead has one first response.
  with due as (
    select l.id, l.org_id, l.assigned_agent_id, l.property_id, p.reference
      from leads l
      left join properties p on p.id = l.property_id
     where l.source = 'website'
       and l.status in ('new', 'contacted', 'qualified')
       and l.first_response_at is null
       and l.received_at < now() - make_interval(mins => p_minutes)
       and (p_org is null or l.org_id = p_org)
       and not exists (select 1 from tasks t where t.lead_id = l.id and t.kind = 'lead_unanswered')
  ),
  created as (
    insert into tasks (org_id, title, due_at, assignee_id, lead_id, property_id, kind)
    select d.org_id,
           -- the reference, never the person: a title is read on every list
           'Website enquiry unanswered for over an hour' || coalesce(': ' || d.reference, ''),
           -- due NOW, not end of day: it is already late, and red is the truth
           now(),
           coalesce(d.assigned_agent_id,
                    (select pr.id from profiles pr
                      where pr.org_id = d.org_id and pr.role = 'admin' and pr.is_active
                      order by pr.created_at limit 1)),
           d.id, d.property_id, 'lead_unanswered'
      from due d
    returning org_id, lead_id, id, assignee_id
  ),
  logged as (
    insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
    select org_id, null, 'lead', lead_id, 'followup_task_created',
           jsonb_build_object('kind', 'lead_unanswered', 'task_id', id,
                              'assignee_id', assignee_id, 'minutes', p_minutes)
      from created
    returning 1
  )
  select count(*) into v_count from logged;

  -- 2) self-heal: the lead was answered or closed → the task is superseded.
  with superseded as (
    update tasks t
       set is_done = true, done_at = now()
      from leads l
     where t.lead_id = l.id
       and t.kind = 'lead_unanswered'
       and not t.is_done
       and (p_org is null or t.org_id = p_org)
       and (l.first_response_at is not null
            or l.status not in ('new', 'contacted', 'qualified'))
    returning t.org_id, t.id, t.lead_id
  ),
  logged as (
    insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
    select org_id, null, 'task', id, 'superseded',
           jsonb_build_object('kind', 'lead_unanswered', 'lead_id', lead_id,
                              'reason', 'lead_answered_or_closed')
      from superseded
    returning 1
  )
  select count(*) into v_closed from logged;

  return v_count;
end $fn$;

comment on function public.raise_lead_sla_tasks(uuid, int) is
  'Every ten minutes (0098): one lead_unanswered task per website lead still '
  'open with no first response after p_minutes (default 60), assigned to the '
  'lead''s agent or the oldest active admin, due now; superseded by the same '
  'sweep once the lead is answered or closed. Returns the number minted. '
  'p_org is for the tests; cron calls it for every org.';

-- LOCK DOWN EXECUTE — the 0044 lesson, every function since.
revoke execute on function public.raise_lead_sla_tasks(uuid, int) from public, anon, authenticated;
grant  execute on function public.raise_lead_sla_tasks(uuid, int) to service_role;

-- Ten minutes: the clock the inbox shows turns red at sixty, and a chase that
-- arrives an hour and ten minutes after the enquiry is the latest a desk that
-- sells on speed should tolerate.
select cron.schedule('lead-sla', '*/10 * * * *', $$select raise_lead_sla_tasks()$$);

-- ---------------------------------------------------------------------------
-- 4. Apply-time assertions. What this migration claims, proven here
--    (the 0084 idiom: a self-test lead, then removed; its events stay).
-- ---------------------------------------------------------------------------
do $$
declare
  v_org      uuid;
  v_slug     text;
  v_lead_id  uuid;
  v_again    uuid;
  v_replayed boolean;
  v_lead     record;
  n          int;
begin
  select id, slug into v_org, v_slug from organizations order by created_at limit 1;
  if v_org is null then
    raise notice '0098: no organization to self-test against — grants and schedule checked only';
  else
    -- allowlisted key lands, a smuggled identity key and an over-cap key do not
    select s.lead_id, s.replayed into v_lead_id, v_replayed
      from submit_public_enquiry(v_slug, '0098 selftest', 'selftest@example.invalid',
                                 null, '0098 self-test enquiry', null, 'selftest-0098-key-1',
                                 jsonb_build_object('budget', 'over_1m',
                                                    'email', 'smuggled@example.invalid',
                                                    'utm_campaign', repeat('x', 121),
                                                    'channel', 'portal')) s;
    if v_lead_id is null or v_replayed then
      raise exception '0098 aborted: a valid enquiry with meta was refused or read as a replay';
    end if;

    select * into v_lead from leads where id = v_lead_id;
    if v_lead.criteria ->> 'budget' is distinct from 'over_1m' then
      raise exception '0098 aborted: an allowlisted key did not reach criteria';
    end if;
    if v_lead.criteria ? 'email' or v_lead.criteria ? 'utm_campaign' then
      raise exception '0098 aborted: criteria admitted a key it must refuse';
    end if;
    if v_lead.criteria ->> 'channel' is distinct from 'website_form' then
      raise exception '0098 aborted: meta overrode the function''s own channel key';
    end if;
    if v_lead.source <> 'website' then
      raise exception '0098 aborted: source must stay website — the retention sweep keys on it';
    end if;

    select count(*) into n from events
     where entity_type = 'lead' and entity_id = v_lead_id and event_type = 'created'
       and (payload ->> 'has_meta')::boolean;
    if n <> 1 then raise exception '0098 aborted: the created event does not say has_meta'; end if;
    select count(*) into n from events
     where entity_id = v_lead_id and payload::text ilike '%smuggled%';
    if n <> 0 then
      raise exception '0098 aborted: an event payload carries a smuggled identity — it can never be erased';
    end if;

    -- a replay with different meta keeps the first post's criteria and writes nothing
    select s.lead_id, s.replayed into v_again, v_replayed
      from submit_public_enquiry(v_slug, '0098 selftest', 'selftest@example.invalid',
                                 null, '0098 self-test enquiry', null, 'selftest-0098-key-1',
                                 jsonb_build_object('budget', 'under_300k')) s;
    if v_again is distinct from v_lead_id or not v_replayed then
      raise exception '0098 aborted: the replay did not answer with the first lead';
    end if;
    if (select criteria ->> 'budget' from leads where id = v_lead_id) <> 'over_1m' then
      raise exception '0098 aborted: a replay rewrote criteria';
    end if;

    -- the seven-argument call (0096's shape, what the route sends until it learns p_meta) still works
    select s.lead_id into v_again
      from submit_public_enquiry(v_slug, '0098 selftest seven', 'seven@example.invalid',
                                 null, '0098 self-test enquiry', null, 'selftest-0098-key-2') s;
    if v_again is null then raise exception '0098 aborted: the seven-argument call was refused'; end if;
    if (select criteria from leads where id = v_again)
       <> jsonb_build_object('channel', 'website_form', 'listing_reference', null) then
      raise exception '0098 aborted: a call without meta changed the criteria shape';
    end if;

    -- the SLA sweep: mint once, never twice, close when answered
    update leads set received_at = now() - interval '61 minutes' where id = v_lead_id;
    perform raise_lead_sla_tasks(v_org);
    select count(*) into n from tasks where lead_id = v_lead_id and kind = 'lead_unanswered' and not is_done;
    if n <> 1 then raise exception '0098 aborted: expected one open lead_unanswered task, found %', n; end if;
    perform raise_lead_sla_tasks(v_org);
    select count(*) into n from tasks where lead_id = v_lead_id and kind = 'lead_unanswered';
    if n <> 1 then raise exception '0098 aborted: the sweep minted a second task for the same lead'; end if;
    update leads set first_response_at = now() where id = v_lead_id;
    perform raise_lead_sla_tasks(v_org);
    select count(*) into n from tasks where lead_id = v_lead_id and kind = 'lead_unanswered' and is_done;
    if n <> 1 then raise exception '0098 aborted: an answered lead did not close its task'; end if;

    -- clean the self-test up: tasks, then leads; the events stay, as 0084's do
    delete from tasks where lead_id in
      (select id from leads where org_id = v_org and message like '%0098 selftest%');
    delete from leads where org_id = v_org and message like '%0098 selftest%';
  end if;

  -- the routing row exists
  if (select value ->> 'mode' from cyprus_config where key = 'lead_routing') is null then
    raise exception '0098 aborted: the lead_routing row is missing';
  end if;

  -- exactly one overload, and it is the eight-argument one
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'submit_public_enquiry';
  if n <> 1 then raise exception '0098 aborted: expected one submit_public_enquiry, found %', n; end if;
  if not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname = 'public' and p.proname = 'submit_public_enquiry'
                    and p.pronargs = 8
                    and pg_get_function_identity_arguments(p.oid) like '%p_meta jsonb') then
    raise exception '0098 aborted: the surviving overload has no p_meta';
  end if;

  -- grants: both functions service_role-only
  if has_function_privilege('anon', 'public.submit_public_enquiry(text,text,text,text,text,text,text,jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.submit_public_enquiry(text,text,text,text,text,text,text,jsonb)', 'execute') then
    raise exception '0098 aborted: submit_public_enquiry is executable by anon or authenticated';
  end if;
  if not has_function_privilege('service_role', 'public.submit_public_enquiry(text,text,text,text,text,text,text,jsonb)', 'execute') then
    raise exception '0098 aborted: submit_public_enquiry lost its service_role grant';
  end if;
  if has_function_privilege('anon', 'public.raise_lead_sla_tasks(uuid,int)', 'execute')
     or has_function_privilege('authenticated', 'public.raise_lead_sla_tasks(uuid,int)', 'execute') then
    raise exception '0098 aborted: raise_lead_sla_tasks is executable by anon or authenticated';
  end if;
  if not has_function_privilege('service_role', 'public.raise_lead_sla_tasks(uuid,int)', 'execute') then
    raise exception '0098 aborted: raise_lead_sla_tasks lost its service_role grant';
  end if;

  -- the kind total (0049 = 7, 0051 = 8, 0053 = 9, 0075 = 10, 0076 = 11,
  -- 0078 = 12, 0089 = 13); the restore pack's task_kinds pin reads this line
  select count(*) into n from public.task_kinds;
  if n <> 14 then
    raise exception '0098 aborted: expected 14 task kinds, found %', n;
  end if;

  if not exists (select 1 from cron.job where jobname = 'lead-sla' and schedule = '*/10 * * * *') then
    raise exception '0098 aborted: lead-sla is not scheduled every ten minutes';
  end if;

  -- the invariant the mfa suite enforces: no RLS-enabled public table without
  -- require_aal2 — this file adds no table, and says so
  select count(*) into n from rls_aal2_coverage();
  if n <> 0 then
    raise exception '0098 aborted: % table(s) lack require_aal2', n;
  end if;

  raise notice '0098: enquiry meta on the door (allowlist, shape only), lead_routing seeded off, tasks.lead_id, lead_unanswered kind, lead-sla every 10 minutes.';
end $$;
