-- =============================================================================
-- 0101 — the desk alert is a ROW before it is an e-mail: a transactional
--        outbox for the website enquiry's desk notification
--
-- WHAT WAS TRUE UNTIL NOW. `submit_public_enquiry` commits the lead; the Next
-- route then answers the visitor 202 and, inside `after()`, calls the mail
-- provider once and writes an `enquiry_alert` event with the word that came
-- back — sent, skipped or failed. Nothing was persisted BEFORE the send, and
-- nothing retried AFTER it. So an invocation killed between the commit and the
-- callback, a provider that answered 503, a network that dropped the answer,
-- or the platform's own timeout each left the same thing: a saved lead in the
-- inbox with its response clock running and nobody told. The event on the
-- timeline (0096, INT-01) records that it happened; it cannot make it happen.
--
-- WHAT THIS MIGRATION DOES. One table, three functions, one trigger, and one
-- extra INSERT inside the door:
--
-- 1. `notification_jobs` — one row per lead per notification kind, written by
--    `submit_public_enquiry` IN THE SAME TRANSACTION as the lead. If the row
--    cannot be written, the lead is not written either and the visitor is
--    told 503 and retries with the same key (0096). The self-test at the
--    bottom proves that pairing by refusing the insert and reading no lead.
--    A replay (same key) writes nothing, so it makes no second job; and the
--    unique (lead_id, kind) index makes a second job impossible by any path.
--
--    THE ROW HOLDS NO PERSON. Ids, a state machine, counters, timestamps, a
--    lease, and two short diagnostic words (a category and an HTTP status or
--    provider error NAME — never a body). The e-mail is rebuilt from the lead
--    at send time — `leads.message` is the block the door writes, and
--    `criteria` the brief — so erasure and the 24-month sweep (0092) need no
--    new step: a redacted lead has nothing to send, and the trigger below
--    cancels its pending job the moment the literal lands. Nothing here is
--    added to the restore pack's PII surface.
--
-- 2. `claim_notification_jobs(worker, limit, lease, lead)` — the ATOMIC claim:
--    `for update skip locked` over the due rows, so two workers running at
--    once receive disjoint sets; a lease (`claimed_until`) so an interrupted
--    worker's job comes back to the pool when it lapses; and the attempt is
--    counted AT THE CLAIM, so a worker that dies every time is bounded by
--    max_attempts rather than immortal. A lapsed lease with no attempts left
--    is closed as failed with an event.
--
-- 3. `complete_notification_job(job, worker, outcome, …)` — the only way a
--    claim ends, and only for the worker that holds it (a stale worker whose
--    lease lapsed and whose job was re-claimed changes nothing and is told
--    so). `accepted` records the provider's message id — the provider ACCEPTED
--    the message; delivery is not confirmed by anything here and the word is
--    chosen to say so. `retry` backs off for the seconds the worker asks
--    (the arithmetic lives in lib/services/enquiry-alert-jobs.ts where a
--    unit test reaches it), or, when the attempt was the last allowed, is
--    terminal. `failed` and `cancelled` are terminal at once. Terminal
--    outcomes and nothing else write the lead's `enquiry_alert` event: the
--    intermediate attempts are STATE on the row, not history.
--
-- 4. `request_enquiry_alert_retry(lead)` — the staff action. SECURITY DEFINER
--    so it can rewrite a row no browser session may touch, and therefore it
--    checks everything itself: a signed-in, aal2-satisfied member of the
--    lead's own org (any other org reads "not found"), an admin or the lead's
--    assigned agent or anyone while unassigned (the doc 04 lead rule), not
--    while a worker holds a live claim, not for an alert already accepted,
--    not for a redacted lead. It resets the job to pending with a fresh
--    attempt budget and signs an event with the caller's id. The provider's
--    idempotency key is `<job>/<key_serial>`; the serial moves ONLY when the
--    old key is no longer safe to reuse — the provider forgets a key after 24
--    hours, and a `conflict` means it refused the key with a different
--    payload. Inside the window the same key is reused on purpose: that is
--    what makes a retry after an ambiguous timeout not a second e-mail.
--
-- 5. `trg_cancel_lead_notification_jobs` — the moment `leads.message` becomes
--    the erasure literal (redactLead, contact erasure 0017, the retention
--    sweep 0092 — all three write the same string), a PENDING job is
--    cancelled with an event. A job mid-send is left to its own outcome: the
--    e-mail may already be on its way, and the record must say what happened,
--    not what we wished.
--
-- WHAT DOES NOT CHANGE. The door's signature, defaults, return shape and
-- grants are exactly 0098's — `create or replace` keeps the ACL and the
-- lockdown is restated anyway. The site sends the same body and reads the
-- same 202. No cron job is scheduled here: the sweep is an authenticated
-- application route (`/api/internal/enquiry-alerts`), and calling it every
-- few minutes from this database needs `pg_net`, which is available on the
-- hosted project and NOT installed — an operator decision that BACKLOG
-- already carries. Until then the route's `after()` accelerator sends
-- immediately as before, and the sweep can be called by hand or by a
-- once-a-day Vercel cron (the most a Hobby plan allows); the row is what
-- makes either recoverable.
--
-- Pins that move with this file: the migrations count in
-- scripts/backup/verify-restore.sql, its grants table (four SECURITY DEFINER
-- functions), scripts/backup/export.mjs (the new table), docs/04's matrix
-- row, docs/10's environment and cron sections, HANDOFF §0. The cron count
-- stays TEN.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The outbox
-- ---------------------------------------------------------------------------
-- The tenant guard 0088 gave property_media and 0095 portal_listings: a job
-- can never name a lead of another org, even outside RLS.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leads_org_id_id_key') then
    alter table public.leads add constraint leads_org_id_id_key unique (org_id, id);
  end if;
end $$;

create table if not exists public.notification_jobs (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.organizations(id) on delete cascade,
  lead_id              uuid not null references public.leads(id) on delete cascade,
  kind                 text not null check (kind in ('enquiry_desk_alert')),
  state                text not null default 'pending'
                       check (state in ('pending', 'sending', 'accepted', 'failed', 'cancelled')),
  attempts             int  not null default 0 check (attempts >= 0),
  max_attempts         int  not null default 8 check (max_attempts between 1 and 50),
  next_attempt_at      timestamptz not null default now(),
  claimed_by           text,
  claimed_until        timestamptz,
  -- the provider idempotency key is <id>/<key_serial>; see request_enquiry_alert_retry
  key_serial           int  not null default 1 check (key_serial >= 1),
  -- diagnostics, SHAPE ONLY: a category and a status code or provider error
  -- name. Never a response body, never a person.
  last_category        text check (last_category in ('transient', 'permanent', 'timeout', 'conflict')),
  last_result          text check (last_result is null or length(last_result) <= 80),
  provider             text not null default 'resend',
  provider_message_id  text check (provider_message_id is null or length(provider_message_id) <= 120),
  first_attempted_at   timestamptz,
  last_attempted_at    timestamptz,
  accepted_at          timestamptz,
  finished_at          timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  -- one logical desk notification per enquiry, by any path
  unique (lead_id, kind),
  constraint notification_jobs_org_lead_fkey
    foreign key (org_id, lead_id) references public.leads (org_id, id) on delete cascade
);

comment on table public.notification_jobs is
  'The transactional outbox for a lead''s notifications (0101). One row per lead '
  'per kind, written by submit_public_enquiry in the lead''s own transaction. '
  'States: pending → sending (claimed, leased) → accepted | failed | cancelled; a '
  'retry goes back to pending with next_attempt_at in the future. Holds NO '
  'personal data: the message is rebuilt from the lead at send time. accepted '
  'means the provider accepted the message, not that it was delivered.';
comment on column public.notification_jobs.key_serial is
  'Increments only when the provider idempotency key must change: after a '
  'conflict, or when the first attempt is older than the provider''s 24-hour '
  'memory. Inside the window a retry reuses the key on purpose.';
comment on column public.notification_jobs.last_result is
  'An HTTP status, a provider error NAME, or a worker word (timeout, network, '
  'lease_expired, lead_redacted, legacy_sender). Never a response body.';

-- the sweep's own: due rows only, smallest first
create index if not exists notification_jobs_due_idx
  on public.notification_jobs (next_attempt_at)
  where state in ('pending', 'sending');

drop trigger if exists notification_jobs_updated_at on public.notification_jobs;
create trigger notification_jobs_updated_at
  before update on public.notification_jobs
  for each row execute function set_updated_at();

alter table public.notification_jobs enable row level security;
revoke all privileges on table public.notification_jobs from anon;
revoke all privileges on table public.notification_jobs from authenticated;
-- READ ONLY for a session: the inbox shows the status. Every write goes
-- through the functions below, which check what a policy cannot express
-- (a live lease, a redacted lead, the assignee rule).
grant select on table public.notification_jobs to authenticated;

drop policy if exists notification_jobs_select on public.notification_jobs;
create policy notification_jobs_select on public.notification_jobs for select
  using (org_id = (select public.current_org_id()));
-- A TABLE CREATED AFTER 0029 DOES NOT INHERIT require_aal2; rls_aal2_coverage() must stay at 0.
drop policy if exists require_aal2 on public.notification_jobs;
create policy require_aal2 on public.notification_jobs
  as restrictive for all to authenticated
  using ((select public.mfa_satisfied()))
  with check ((select public.mfa_satisfied()));

-- ---------------------------------------------------------------------------
-- 2. The door: 0098's body plus one INSERT, in the lead's transaction
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
  'service_role-only since 0087: the Next route is the door.';

-- The 0087 lockdown, restated: `create or replace` keeps the ACL, and a
-- reader of this file should not have to trust that.
revoke execute on function public.submit_public_enquiry(text, text, text, text, text, text, text, jsonb)
  from public, anon, authenticated;
grant  execute on function public.submit_public_enquiry(text, text, text, text, text, text, text, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- 3. The claim: atomic, leased, counted
-- ---------------------------------------------------------------------------
create or replace function public.claim_notification_jobs(
  p_worker        text,
  p_limit         int  default 5,
  p_lease_seconds int  default 90,
  p_lead_id       uuid default null
)
returns setof public.notification_jobs
language plpgsql security definer set search_path = public as $fn$
declare
  v_lease interval := make_interval(secs => greatest(coalesce(p_lease_seconds, 90), 1));
begin
  if p_worker is null or btrim(p_worker) = '' then
    raise exception 'claim_notification_jobs: p_worker is required';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'claim_notification_jobs: p_limit must be between 1 and 100';
  end if;

  -- 1) An interrupted worker whose job has no attempts left: terminal with an
  --    event, not a row that stays "sending" forever and shows as nothing.
  with dead as (
    update notification_jobs j
       set state         = 'failed',
           last_category = 'timeout',
           last_result   = 'lease_expired',
           claimed_by    = null,
           claimed_until = null,
           finished_at   = now()
     where j.state = 'sending'
       and j.claimed_until < now()
       and j.attempts >= j.max_attempts
       and (p_lead_id is null or j.lead_id = p_lead_id)
     returning j.*
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select d.org_id, null, 'lead', d.lead_id, 'enquiry_alert',
         jsonb_build_object('outcome', 'failed', 'provider', d.provider, 'job_id', d.id,
                            'attempt', d.attempts, 'category', 'timeout',
                            'result', 'lease_expired', 'exhausted', true)
    from dead d;

  -- 2) The claim. `for update skip locked`: a row another worker holds is
  --    stepped over, never waited on and never handed out twice. The attempt
  --    is counted HERE so a worker that dies mid-send still spends one.
  return query
  with due as (
    select j.id
      from notification_jobs j
     where ((j.state = 'pending' and j.next_attempt_at <= now())
            or (j.state = 'sending' and j.claimed_until < now()))
       and j.attempts < j.max_attempts
       and (p_lead_id is null or j.lead_id = p_lead_id)
     order by j.next_attempt_at
     limit p_limit
     for update skip locked
  )
  update notification_jobs j
     set state              = 'sending',
         claimed_by         = p_worker,
         claimed_until      = now() + v_lease,
         attempts           = j.attempts + 1,
         first_attempted_at = coalesce(j.first_attempted_at, now()),
         last_attempted_at  = now()
    from due
   where j.id = due.id
  returning j.*;
end $fn$;

comment on function public.claim_notification_jobs(text, int, int, uuid) is
  'Claims up to p_limit due notification jobs for p_worker under a lease of '
  'p_lease_seconds (0101): pending rows whose next_attempt_at has passed and '
  'sending rows whose lease lapsed, attempts < max_attempts, for update skip '
  'locked. Counts the attempt at the claim. p_lead_id narrows to one lead (the '
  'route''s accelerator and the staff retry). A lapsed lease with no attempts '
  'left is closed as failed with an event. service_role-only.';

-- ---------------------------------------------------------------------------
-- 4. Completion: only the holder, one terminal event
-- ---------------------------------------------------------------------------
create or replace function public.complete_notification_job(
  p_job_id              uuid,
  p_worker              text,
  p_outcome             text,
  p_category            text default null,
  p_result              text default null,
  p_provider_message_id text default null,
  p_retry_in_seconds    int  default null
)
returns boolean
language plpgsql security definer set search_path = public as $fn$
declare
  v_job     notification_jobs;
  v_state   text;
  v_result  text := left(coalesce(p_result, p_outcome), 80);
begin
  if p_outcome is null or p_outcome not in ('accepted', 'retry', 'failed', 'cancelled') then
    raise exception 'complete_notification_job: unknown outcome %', coalesce(p_outcome, '<null>');
  end if;
  if p_category is not null and p_category not in ('transient', 'permanent', 'timeout', 'conflict') then
    raise exception 'complete_notification_job: unknown category %', p_category;
  end if;

  select * into v_job from notification_jobs where id = p_job_id for update;
  -- Not found, not in flight, or held by someone else: nothing changes and
  -- the caller is told so. A worker whose lease lapsed and whose job was
  -- re-claimed lands here — its outcome belongs to nobody now.
  if not found or v_job.state <> 'sending' or v_job.claimed_by is distinct from p_worker then
    return false;
  end if;

  if p_outcome = 'retry' and v_job.attempts < v_job.max_attempts then
    update notification_jobs
       set state           = 'pending',
           next_attempt_at = now() + make_interval(secs => greatest(coalesce(p_retry_in_seconds, 60), 1)),
           last_category   = p_category,
           last_result     = v_result,
           claimed_by      = null,
           claimed_until   = null
     where id = p_job_id;
    return true;
  end if;

  v_state := case p_outcome when 'accepted' then 'accepted'
                            when 'cancelled' then 'cancelled'
                            else 'failed' end;

  update notification_jobs
     set state               = v_state,
         last_category       = case when p_outcome = 'accepted' then null else p_category end,
         last_result         = v_result,
         provider_message_id = case when p_outcome = 'accepted'
                                    then left(p_provider_message_id, 120) else provider_message_id end,
         accepted_at         = case when p_outcome = 'accepted' then now() else accepted_at end,
         finished_at         = now(),
         claimed_by          = null,
         claimed_until       = null
   where id = p_job_id;

  -- The terminal outcome on the lead's timeline (INT-01's event, now written
  -- by the database that owns the state). Ids and words only.
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  values (
    v_job.org_id, null, 'lead', v_job.lead_id, 'enquiry_alert',
    jsonb_build_object(
      'outcome', v_state,
      'provider', v_job.provider,
      'job_id', v_job.id,
      'attempt', v_job.attempts,
      'category', case when p_outcome = 'accepted' then null else p_category end,
      'result', v_result,
      'provider_message_id', case when p_outcome = 'accepted' then left(p_provider_message_id, 120) end,
      'exhausted', p_outcome = 'retry'
    )
  );
  return true;
end $fn$;

comment on function public.complete_notification_job(uuid, text, text, text, text, text, int) is
  'Ends a claim (0101), only for the worker that holds it. accepted: the '
  'provider accepted the message (its id is kept; delivery is not confirmed). '
  'retry: back to pending after p_retry_in_seconds, or terminal failed when the '
  'attempt was the last allowed. failed / cancelled: terminal now. Terminal '
  'outcomes write the lead''s enquiry_alert event. Returns false when the row '
  'is not in flight under p_worker. service_role-only.';

-- ---------------------------------------------------------------------------
-- 5. The staff retry
-- ---------------------------------------------------------------------------
create or replace function public.request_enquiry_alert_retry(p_lead_id uuid)
returns setof public.notification_jobs
language plpgsql security definer set search_path = public as $fn$
declare
  v_uid    uuid := auth.uid();
  v_org    uuid;
  v_lead   leads;
  v_job    notification_jobs;
  v_serial int;
begin
  if v_uid is null then raise exception 'Not authenticated.'; end if;
  -- The same gate require_aal2 puts on every table: a definer function must
  -- apply it by hand.
  if not (select mfa_satisfied()) then raise exception 'Second factor required.'; end if;
  v_org := (select current_org_id());
  if v_org is null then raise exception 'Not authenticated.'; end if;

  -- Another org's lead reads "not found" — the same words as no lead at all.
  select * into v_lead from leads where id = p_lead_id and org_id = v_org;
  if not found then raise exception 'Lead not found.'; end if;

  -- Doc 04's lead rule: admin, the assigned agent, or anyone while unassigned.
  if (select current_role_gnk()) <> 'admin'
     and v_lead.assigned_agent_id is not null
     and v_lead.assigned_agent_id <> v_uid then
    raise exception 'Lead is assigned to another agent.';
  end if;

  if v_lead.message = '[erased at the contact''s request]' then
    raise exception 'This enquiry has been redacted — there is nothing left to send.';
  end if;

  select * into v_job
    from notification_jobs
   where lead_id = p_lead_id and kind = 'enquiry_desk_alert'
   for update;
  if not found then raise exception 'No desk alert is recorded for this lead.'; end if;

  if v_job.state = 'sending' and v_job.claimed_until > now() then
    raise exception 'The alert is being sent right now — try again in a minute.';
  end if;
  if v_job.state = 'accepted' then
    raise exception 'The desk was already alerted for this enquiry.';
  end if;

  -- The provider remembers a key for 24 hours and refuses it with another
  -- payload. Inside the window, and with no conflict, the SAME key is reused
  -- on purpose: a retry after an ambiguous timeout must not be a second
  -- e-mail. Otherwise a fresh serial — and a fresh key.
  v_serial := v_job.key_serial
            + case when v_job.last_category = 'conflict'
                     or v_job.first_attempted_at < now() - interval '24 hours'
                   then 1 else 0 end;

  update notification_jobs
     set state           = 'pending',
         attempts        = 0,
         next_attempt_at = now(),
         claimed_by      = null,
         claimed_until   = null,
         key_serial      = v_serial,
         last_category   = null,
         last_result     = null,
         finished_at     = null
   where id = v_job.id;

  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  values (
    v_job.org_id, v_uid, 'lead', v_job.lead_id, 'enquiry_alert',
    jsonb_build_object(
      'outcome', 'retry_requested',
      'provider', v_job.provider,
      'job_id', v_job.id,
      'key_serial', v_serial,
      'previous_state', v_job.state,
      'previous_result', v_job.last_result
    )
  );

  return query select * from notification_jobs where id = v_job.id;
end $fn$;

comment on function public.request_enquiry_alert_retry(uuid) is
  'A staff member asks for the desk alert of a website lead to be sent again '
  '(0101): a signed-in, aal2-satisfied member of the lead''s own org, admin or '
  'the assigned agent or anyone while unassigned; refused while a worker holds '
  'a live claim, for an accepted alert, and for a redacted lead. Resets the job '
  'to pending with a fresh attempt budget, rotates the provider key only when '
  'the old one is unsafe (conflict, or older than 24h), and signs an event with '
  'the caller. Returns the job. The route''s after() then sends at once.';

-- ---------------------------------------------------------------------------
-- 6. Erasure cancels queued work
-- ---------------------------------------------------------------------------
create or replace function public.cancel_lead_notification_jobs()
returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  with cancelled as (
    update notification_jobs j
       set state         = 'cancelled',
           last_category = null,
           last_result   = 'lead_redacted',
           claimed_by    = null,
           claimed_until = null,
           finished_at   = now()
     where j.lead_id = new.id
       and j.state = 'pending'
     returning j.*
  )
  insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
  select c.org_id, null, 'lead', c.lead_id, 'enquiry_alert',
         jsonb_build_object('outcome', 'cancelled', 'provider', c.provider, 'job_id', c.id,
                            'attempt', c.attempts, 'result', 'lead_redacted')
    from cancelled c;
  return null;
end $fn$;

drop trigger if exists trg_cancel_lead_notification_jobs on public.leads;
create trigger trg_cancel_lead_notification_jobs
  after update of message on public.leads
  for each row
  when (new.message = '[erased at the contact''s request]'
        and old.message is distinct from new.message)
  execute function public.cancel_lead_notification_jobs();

-- ---------------------------------------------------------------------------
-- 7. Grants — the 0044 lesson, every function since
-- ---------------------------------------------------------------------------
revoke execute on function public.claim_notification_jobs(text, int, int, uuid) from public, anon, authenticated;
grant  execute on function public.claim_notification_jobs(text, int, int, uuid) to service_role;
revoke execute on function public.complete_notification_job(uuid, text, text, text, text, text, int) from public, anon, authenticated;
grant  execute on function public.complete_notification_job(uuid, text, text, text, text, text, int) to service_role;
-- the staff action: a session calls it; the function does its own checks
revoke execute on function public.request_enquiry_alert_retry(uuid) from public, anon;
grant  execute on function public.request_enquiry_alert_retry(uuid) to authenticated, service_role;
-- a trigger body: callable by nobody over PostgREST (0007/0021)
revoke execute on function public.cancel_lead_notification_jobs() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. Apply-time assertions. What this migration claims, proven here
--    (the 0084 idiom: self-test leads, then removed; their events stay).
-- ---------------------------------------------------------------------------
do $$
declare
  v_org      uuid;
  v_slug     text;
  v_lead_id  uuid;
  v_again    uuid;
  v_replayed boolean;
  v_job      public.notification_jobs;
  v_claimed  public.notification_jobs;
  v_ok       boolean;
  n          int;
begin
  select id, slug into v_org, v_slug from organizations order by created_at limit 1;
  if v_org is null then
    raise notice '0101: no organization to self-test against — grants and shape checked only';
  else
    -- (a) one enquiry, one lead, one pending job, in one call
    select s.lead_id, s.replayed into v_lead_id, v_replayed
      from submit_public_enquiry(v_slug, '0101 selftest', 'selftest-0101@example.invalid',
                                 null, '0101 self-test enquiry', null, 'selftest-0101-key-1', null) s;
    if v_lead_id is null or v_replayed then
      raise exception '0101 aborted: a valid enquiry was refused or read as a replay';
    end if;
    select * into v_job from notification_jobs where lead_id = v_lead_id and kind = 'enquiry_desk_alert';
    if not found then raise exception '0101 aborted: the door wrote a lead without its alert job'; end if;
    if v_job.state <> 'pending' or v_job.attempts <> 0 or v_job.org_id <> v_org then
      raise exception '0101 aborted: the new job is not a pending, unattempted row of the lead''s org';
    end if;

    -- (b) a replay writes no second job
    select s.lead_id, s.replayed into v_again, v_replayed
      from submit_public_enquiry(v_slug, '0101 selftest', 'selftest-0101@example.invalid',
                                 null, '0101 self-test enquiry', null, 'selftest-0101-key-1', null) s;
    if v_again is distinct from v_lead_id or not v_replayed then
      raise exception '0101 aborted: the replay did not answer with the first lead';
    end if;
    select count(*) into n from notification_jobs where lead_id = v_lead_id;
    if n <> 1 then raise exception '0101 aborted: a replay made a second job (found %)', n; end if;

    -- (c) THE ATOMICITY PROOF: refuse every job insert, knock, read no lead.
    --     `not valid` spares existing rows and binds new ones; the failure
    --     inside the door rolls its lead back with it.
    alter table public.notification_jobs add constraint selftest_0101_refuse check (false) not valid;
    begin
      perform submit_public_enquiry(v_slug, '0101 selftest atomic', 'selftest-0101-atomic@example.invalid',
                                    null, '0101 self-test atomic', null, 'selftest-0101-atomic', null);
      raise exception '0101 aborted: the door accepted an enquiry whose alert job could not be written';
    exception
      when check_violation then
        null; -- expected: the job insert was refused and the whole call rolled back
    end;
    alter table public.notification_jobs drop constraint selftest_0101_refuse;
    select count(*) into n from leads where org_id = v_org and idempotency_key = 'selftest-0101-atomic';
    if n <> 0 then
      raise exception '0101 aborted: a lead survived the refusal of its alert job — the pair is not atomic';
    end if;

    -- (d) the claim by lead: sending, leased, one attempt spent
    select * into v_claimed from claim_notification_jobs('selftest-0101', 1, 60, v_lead_id);
    if not found or v_claimed.state <> 'sending' or v_claimed.attempts <> 1
       or v_claimed.claimed_by <> 'selftest-0101' or v_claimed.claimed_until <= now() then
      raise exception '0101 aborted: the claim did not lease the job to the worker';
    end if;
    select count(*) into n from claim_notification_jobs('selftest-0101-other', 1, 60, v_lead_id);
    if n <> 0 then raise exception '0101 aborted: a leased job was handed out twice'; end if;

    -- (e) a stranger cannot complete it; the holder can, and one event says so
    if complete_notification_job(v_claimed.id, 'somebody-else', 'accepted', null, '200', 'msg', null) then
      raise exception '0101 aborted: a worker that does not hold the claim completed the job';
    end if;
    v_ok := complete_notification_job(v_claimed.id, 'selftest-0101', 'accepted', null, '200', 're_selftest', null);
    if not v_ok then raise exception '0101 aborted: the holder could not complete its own claim'; end if;
    select * into v_job from notification_jobs where id = v_claimed.id;
    if v_job.state <> 'accepted' or v_job.provider_message_id <> 're_selftest'
       or v_job.accepted_at is null or v_job.claimed_by is not null then
      raise exception '0101 aborted: acceptance did not land on the row';
    end if;
    select count(*) into n from events
     where entity_type = 'lead' and entity_id = v_lead_id and event_type = 'enquiry_alert'
       and payload ->> 'outcome' = 'accepted' and payload ->> 'provider_message_id' = 're_selftest';
    if n <> 1 then raise exception '0101 aborted: expected one accepted enquiry_alert event, found %', n; end if;
    select count(*) into n from events
     where entity_id = v_lead_id and payload::text ilike '%example.invalid%';
    if n <> 0 then
      raise exception '0101 aborted: an event payload carries an address — it can never be erased';
    end if;

    -- (f) erasure cancels a pending job, with an event
    select s.lead_id into v_again
      from submit_public_enquiry(v_slug, '0101 selftest erased', 'selftest-0101-erased@example.invalid',
                                 null, '0101 self-test erased', null, 'selftest-0101-key-2', null) s;
    update leads set message = '[erased at the contact''s request]' where id = v_again;
    select * into v_job from notification_jobs where lead_id = v_again;
    if v_job.state <> 'cancelled' or v_job.last_result <> 'lead_redacted' then
      raise exception '0101 aborted: redacting the lead did not cancel its pending job';
    end if;
    select count(*) into n from events
     where entity_type = 'lead' and entity_id = v_again and event_type = 'enquiry_alert'
       and payload ->> 'outcome' = 'cancelled';
    if n <> 1 then raise exception '0101 aborted: the cancellation wrote no event'; end if;

    -- clean the self-test up: tasks, then leads (jobs cascade); the events stay
    delete from tasks where lead_id in
      (select id from leads where org_id = v_org and idempotency_key like 'selftest-0101-%');
    delete from leads where org_id = v_org and idempotency_key like 'selftest-0101-%';
    select count(*) into n from notification_jobs j
     where not exists (select 1 from leads l where l.id = j.lead_id);
    if n <> 0 then raise exception '0101 aborted: a job outlived its lead'; end if;
  end if;

  -- the door: still exactly one overload, still the eight-argument one, same return
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'submit_public_enquiry';
  if n <> 1 then raise exception '0101 aborted: expected one submit_public_enquiry, found %', n; end if;
  if not exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                  where ns.nspname = 'public' and p.proname = 'submit_public_enquiry'
                    and p.pronargs = 8
                    and pg_get_function_result(p.oid) = 'TABLE(lead_id uuid, lead_org_id uuid, replayed boolean)') then
    raise exception '0101 aborted: the door''s signature or return shape changed — that is deploy-coupled';
  end if;

  -- grants
  if has_function_privilege('anon', 'public.submit_public_enquiry(text,text,text,text,text,text,text,jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.submit_public_enquiry(text,text,text,text,text,text,text,jsonb)', 'execute') then
    raise exception '0101 aborted: submit_public_enquiry is executable by anon or authenticated';
  end if;
  if not has_function_privilege('service_role', 'public.submit_public_enquiry(text,text,text,text,text,text,text,jsonb)', 'execute') then
    raise exception '0101 aborted: submit_public_enquiry lost its service_role grant';
  end if;
  if has_function_privilege('anon', 'public.claim_notification_jobs(text,int,int,uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.claim_notification_jobs(text,int,int,uuid)', 'execute')
     or not has_function_privilege('service_role', 'public.claim_notification_jobs(text,int,int,uuid)', 'execute') then
    raise exception '0101 aborted: claim_notification_jobs grants are wrong';
  end if;
  if has_function_privilege('anon', 'public.complete_notification_job(uuid,text,text,text,text,text,int)', 'execute')
     or has_function_privilege('authenticated', 'public.complete_notification_job(uuid,text,text,text,text,text,int)', 'execute')
     or not has_function_privilege('service_role', 'public.complete_notification_job(uuid,text,text,text,text,text,int)', 'execute') then
    raise exception '0101 aborted: complete_notification_job grants are wrong';
  end if;
  if has_function_privilege('anon', 'public.request_enquiry_alert_retry(uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.request_enquiry_alert_retry(uuid)', 'execute') then
    raise exception '0101 aborted: request_enquiry_alert_retry grants are wrong';
  end if;
  if has_function_privilege('anon', 'public.cancel_lead_notification_jobs()', 'execute')
     or has_function_privilege('authenticated', 'public.cancel_lead_notification_jobs()', 'execute') then
    raise exception '0101 aborted: the trigger body is callable over PostgREST';
  end if;

  -- table privileges: a session reads, nothing more
  if has_table_privilege('authenticated', 'public.notification_jobs', 'insert')
     or has_table_privilege('authenticated', 'public.notification_jobs', 'update')
     or has_table_privilege('authenticated', 'public.notification_jobs', 'delete')
     or has_table_privilege('anon', 'public.notification_jobs', 'select') then
    raise exception '0101 aborted: notification_jobs is writable by a session or readable by anon';
  end if;
  if not exists (select 1 from pg_policies where tablename = 'notification_jobs' and policyname = 'require_aal2') then
    raise exception '0101 aborted: notification_jobs lacks require_aal2';
  end if;
  select count(*) into n from rls_aal2_coverage();
  if n <> 0 then raise exception '0101 aborted: % table(s) lack require_aal2', n; end if;

  -- no new cron job: the sweep is an application route (see the header)
  select count(*) into n from cron.job;
  if n <> 10 then raise exception '0101 aborted: expected ten cron jobs, found %', n; end if;

  raise notice '0101: notification_jobs outbox written by the door in its own transaction; atomic claim with lease; holder-only completion; staff retry; erasure cancels pending work.';
end $$;
