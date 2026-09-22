-- =============================================================================
-- 0112 — an admin previews what switching the lead escalation ON would do
--        (audit 2026-09-22, sixth brief; the one finding of the fifth still
--        standing: Settings → Lead escalation had no preview of the affected
--        enquiries and the eligible recipients)
--
-- THE GAP. Since 0107 an admin activates the escalation by ticking a box and
-- saving; since 0110 the age cutoff decides which enquiries already waiting
-- are swept up at that moment. Nothing on the page said how many, which,
-- or whether the people ticked could actually be e-mailed — a colleague
-- deactivated, a listing manager (who cannot work a lead), an address left
-- blank, or the one recipient who is also the enquiry's assignee (the
-- worker never tells the assignee, so that enquiry is cancelled as
-- `no_recipient` and nobody knows why). The only way to know was a SQL
-- session against the live database.
--
-- WHAT THIS FILE DOES, AND HOW LITTLE.
--   1. `lead_escalation_candidates(p_org, p_cfg, p_now)` — the sweep's
--      eligibility rule, moved out of `raise_lead_escalations` so that TWO
--      readers share ONE definition: every open, unanswered, unredacted
--      website lead inside the 0110 index bound, with its due time and a
--      VERDICT — `due` (the sweep would mint it), `not_yet_due`,
--      `past_cutoff`, `already_escalated`. STABLE, service_role-only.
--   2. `raise_lead_escalations(p_org, p_now)` — the same signature, the same
--      events, the same unique-index guarantee, the same cron command; its
--      `due` CTE now reads `verdict = 'due'` from the function above. The
--      self-test below proves the set it mints is exactly the candidates'
--      `due` set on fixed dates, in a subtransaction that is rolled back.
--   3. `preview_lead_escalation(p_policy, p_limit, p_now)` — the preview:
--      an aal2-satisfied ADMIN of the caller's own organisation (the three
--      gates of 0111, in the same words) hands in the values on the form and
--      receives one jsonb document: the policy as the reader validates it,
--      evaluated AS IF ON (`evaluated_as_enabled: true`, `stored_enabled`
--      says what the row holds); every proposed recipient with one reason
--      word (`ok`, `not_in_organisation`, `inactive`, `not_admin_or_agent`,
--      `no_email`); counts that keep the sweep's jobs apart from the
--      worker's e-mails (`due` vs `would_send`, the difference being
--      `no_recipient`, of which `only_recipient_is_assignee` is the case a
--      person most needs pointed out); and a BOUNDED page of leads (`due`
--      first, then `not_yet_due`, `past_cutoff`, `already_escalated`) with
--      ids, times, status, the assignee's name, the property reference and
--      the recipient count — never the enquirer's name, address or message.
--      It is declared STABLE: Postgres refuses INSERT/UPDATE inside a
--      non-volatile function, so "the preview writes nothing" is enforced by
--      the engine, not promised by a comment. Authenticated-callable like
--      `request_lead_escalation_recovery`, so the advisor count moves by ONE
--      security-definer WARN, by design (the 0111 precedent).
--
-- NOT DONE HERE: no policy write, no job, no event, no e-mail, no key
-- movement, no "activate from the preview" (Save is the activation and
-- stays the only one), no digest, no cron, no table.
--
-- Pins that move with this file: the migrations count in
-- scripts/backup/verify-restore.sql (112) and two rows in its grants table;
-- database.types.ts regenerated. The cron count stays TWELVE.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The one eligibility rule
-- ---------------------------------------------------------------------------
create or replace function public.lead_escalation_candidates(
  p_org uuid        default null,
  p_cfg jsonb       default null,
  p_now timestamptz default now()
)
returns table (
  lead_id           uuid,
  org_id            uuid,
  received_at       timestamptz,
  due_at            timestamptz,
  status            text,
  assigned_agent_id uuid,
  property_id       uuid,
  verdict           text,
  job_id            uuid,
  job_state         text
)
language sql stable security definer set search_path = public as $fn$
  with cfg as (
    select public.lead_escalation_config(p_cfg) as v
  ),
  age as (
    select make_interval(hours => (cfg.v ->> 'max_age_hours')::int) as i from cfg
  )
  -- the eligibility rule, in one place (0107, cutoff 0110): a website lead,
  -- open, unanswered, not redacted, inside the bound the index can use —
  -- and then, per lead, WHY it would or would not be minted
  select l.id,
         l.org_id,
         l.received_at,
         w.at,
         l.status::text,
         l.assigned_agent_id,
         l.property_id,
         case
           when j.id is not null        then 'already_escalated'
           when w.at > p_now            then 'not_yet_due'
           when w.at <= p_now - age.i   then 'past_cutoff'
           else                              'due'
         end,
         j.id,
         j.state
    from leads l
    cross join cfg
    cross join age
    cross join lateral (select public.lead_escalation_due_at(l.received_at, cfg.v) as at) w
    left join notification_jobs j on j.lead_id = l.id and j.kind = 'lead_escalation'
   where l.source = 'website'
     and l.status in ('new', 'contacted', 'qualified')
     and l.first_response_at is null
     and l.message is distinct from '[erased at the contact''s request]'
     -- the bound the index can use (0110): nothing due inside the window
     -- arrived earlier than this
     and l.received_at > p_now - age.i - interval '61 days'
     and (p_org is null or l.org_id = p_org)
$fn$;

comment on function public.lead_escalation_candidates(uuid, jsonb, timestamptz) is
  'The lead escalation''s eligibility rule in one place (0112): every open, '
  'unanswered, unredacted website lead inside the 0110 bound, with its '
  'working-time due time under the policy (the row, or p_cfg) and a verdict '
  'as of p_now — due (the sweep would mint it), not_yet_due, past_cutoff '
  '(its wait ended more than max_age_hours ago), already_escalated (with the '
  'job''s id and state). raise_lead_escalations mints the due ones; '
  'preview_lead_escalation shows an admin all four. p_org null = every '
  'organisation. STABLE; service_role-only.';

-- ---------------------------------------------------------------------------
-- 2. The sweep mints from it — same signature, same events, same cron call
-- ---------------------------------------------------------------------------
create or replace function public.raise_lead_escalations(p_org uuid default null, p_now timestamptz default now())
returns int
language plpgsql security definer set search_path = public as $fn$
declare
  cfg     jsonb := public.lead_escalation_config();
  v_count int := 0;
begin
  if not (cfg ->> 'enabled')::boolean then return 0; end if;

  with due as (
    -- the eligibility rule lives in lead_escalation_candidates (0112): the
    -- preview reads the same rows, the sweep mints the ones it calls due
    select c.lead_id as id, c.org_id
      from public.lead_escalation_candidates(p_org, cfg, p_now) c
     where c.verdict = 'due'
  ),
  minted as (
    -- two sweeps at once: the second loses the unique index, inserts nothing,
    -- and logs nothing — `returning` names only the rows this call wrote
    insert into notification_jobs (org_id, lead_id, kind)
    select d.org_id, d.id, 'lead_escalation' from due d
    on conflict (lead_id, kind) do nothing
    returning org_id, lead_id, id
  ),
  logged as (
    -- Guardrail 1: ids and numbers only, never the person
    insert into events (org_id, actor_id, entity_type, entity_id, event_type, payload)
    select m.org_id, null, 'lead', m.lead_id, 'lead_escalation',
           jsonb_build_object('outcome', 'scheduled', 'job_id', m.id,
                              'after_minutes', (cfg ->> 'after_minutes')::int,
                              'working_hours', jsonb_typeof(cfg -> 'working_hours') = 'object',
                              'timezone', cfg ->> 'timezone')
      from minted m
    returning 1
  )
  select count(*) into v_count from logged;

  return v_count;
end $fn$;

comment on function public.raise_lead_escalations(uuid, timestamptz) is
  'Every five minutes (0107, cutoff 0110, one rule 0112): one lead_escalation '
  'notification job per lead that lead_escalation_candidates calls due as of '
  'p_now — a website lead still open, unanswered, not redacted, with no such '
  'job yet, whose working-time wait ended at or before p_now and within the '
  'last max_age_hours. A lead_escalation: scheduled event per row. Nothing '
  'while the policy is off. The unique (lead_id, kind) index makes a second '
  'job impossible; concurrent sweeps mint one. The worker re-checks '
  'eligibility and resolves recipients at send time. Returns the number '
  'minted. p_org and p_now (default now()) are for the tests; cron calls it '
  'bare. service_role-only.';

-- ---------------------------------------------------------------------------
-- 3. The preview
-- ---------------------------------------------------------------------------
create or replace function public.preview_lead_escalation(
  p_policy jsonb,
  p_limit  int         default 50,
  p_now    timestamptz default now()
)
returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare
  v_uid        uuid := auth.uid();
  v_org        uuid;
  v_cfg        jsonb;
  v_recipients jsonb;
  v_eligible   uuid[];
  v_doc        jsonb;
begin
  -- who: the three gates of the recovery (0111), in the same words
  if v_uid is null then raise exception 'Not authenticated.'; end if;
  if not (select mfa_satisfied()) then raise exception 'Second factor required.'; end if;
  v_org := (select current_org_id());
  if v_org is null then raise exception 'Not authenticated.'; end if;
  if (select current_role_gnk()) <> 'admin' then raise exception 'Admins only.'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'The preview limit must be between 1 and 200.';
  end if;

  -- the proposed values as the sweep's reader sees them, evaluated as if ON
  v_cfg := public.lead_escalation_config(p_policy) || jsonb_build_object('enabled', true);

  -- every proposed recipient, in the order proposed (first occurrence),
  -- judged against THIS organisation's profiles by the worker's rule
  -- (lib/services/lead-escalation.ts escalationRecipients; 0111's count)
  with proposed as (
    select distinct on (e.val #>> '{}') (e.val #>> '{}')::uuid as id, e.ord
      from jsonb_array_elements(coalesce(p_policy -> 'recipients', '[]'::jsonb)) with ordinality as e(val, ord)
     where jsonb_typeof(e.val) = 'string'
       and (e.val #>> '{}') in (select x #>> '{}' from jsonb_array_elements(v_cfg -> 'recipients') x)
     order by e.val #>> '{}', e.ord
  ),
  judged as (
    select pr.id, pr.ord, p.full_name, p.role::text as role, p.is_active,
           case when p.id is null then null else coalesce(btrim(p.email), '') <> '' end as has_email,
           case
             when p.id is null                         then 'not_in_organisation'
             when not p.is_active                      then 'inactive'
             when p.role not in ('admin', 'agent')     then 'not_admin_or_agent'
             when coalesce(btrim(p.email), '') = ''    then 'no_email'
             else                                           'ok'
           end as reason
      from proposed pr
      left join profiles p on p.id = pr.id and p.org_id = v_org
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', j.id, 'full_name', j.full_name, 'role', j.role, 'is_active', j.is_active,
           'has_email', j.has_email, 'eligible', j.reason = 'ok', 'reason', j.reason) order by j.ord), '[]'::jsonb),
         coalesce(array_agg(j.id) filter (where j.reason = 'ok'), '{}'::uuid[])
    into v_recipients, v_eligible
    from judged j;

  -- the enquiries: the same rows the sweep reads, scored for THESE recipients
  with c as (
    select * from public.lead_escalation_candidates(v_org, v_cfg, p_now)
  ),
  scored as (
    select c.*,
           -- the worker never tells the assignee: the eligible set less them
           (cardinality(v_eligible)
              - case when coalesce(c.assigned_agent_id = any(v_eligible), false) then 1 else 0 end) as recipients_eligible,
           a.full_name as assignee_name,
           pr.reference as property_ref,
           case c.verdict when 'due' then 1 when 'not_yet_due' then 2 when 'past_cutoff' then 3 else 4 end as rank
      from c
      left join profiles a on a.id = c.assigned_agent_id and a.org_id = v_org
      left join properties pr on pr.id = c.property_id
  ),
  page as (
    select s.* from scored s order by s.rank, s.due_at, s.lead_id limit p_limit
  )
  select jsonb_build_object(
    'counts', (
      select jsonb_build_object(
        'considered',                 count(*),
        'due',                        count(*) filter (where s.verdict = 'due'),
        'would_send',                 count(*) filter (where s.verdict = 'due' and s.recipients_eligible > 0),
        'no_recipient',               count(*) filter (where s.verdict = 'due' and s.recipients_eligible = 0),
        'only_recipient_is_assignee', count(*) filter (where s.verdict = 'due' and s.recipients_eligible = 0
                                                          and coalesce(s.assigned_agent_id = any(v_eligible), false)),
        'not_yet_due',                count(*) filter (where s.verdict = 'not_yet_due'),
        'past_cutoff',                count(*) filter (where s.verdict = 'past_cutoff'),
        'already_escalated',          count(*) filter (where s.verdict = 'already_escalated'))
        from scored s),
    'leads', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'lead_id', p.lead_id, 'received_at', p.received_at, 'due_at', p.due_at, 'verdict', p.verdict,
        'status', p.status, 'assignee_id', p.assigned_agent_id, 'assignee_name', p.assignee_name,
        'property_ref', p.property_ref, 'recipients_eligible', p.recipients_eligible,
        'only_recipient_is_assignee', p.recipients_eligible = 0 and coalesce(p.assigned_agent_id = any(v_eligible), false),
        'job_state', p.job_state) order by p.rank, p.due_at, p.lead_id), '[]'::jsonb)
        from page p),
    'truncated', (select count(*) from scored) > p_limit
  ) into v_doc;

  return v_doc || jsonb_build_object(
    'evaluated_at',             p_now,
    'evaluated_as_enabled',     true,
    'stored_enabled',           coalesce((public.lead_escalation_config() ->> 'enabled')::boolean, false),
    'policy',                   v_cfg,
    'recipients',               v_recipients,
    'eligible_recipient_count', cardinality(v_eligible),
    'limit',                    p_limit
  );
end $fn$;

comment on function public.preview_lead_escalation(jsonb, int, timestamptz) is
  'What switching the lead escalation ON with p_policy would do as of p_now '
  '(0112), for an aal2-satisfied admin of the caller''s own organisation: the '
  'policy as lead_escalation_config validates it (evaluated as if enabled; '
  'stored_enabled says what the row holds), every proposed recipient with a '
  'reason (ok / not_in_organisation / inactive / not_admin_or_agent / '
  'no_email), counts that keep the sweep''s jobs (due) apart from the worker''s '
  'e-mails (would_send; no_recipient; only_recipient_is_assignee), and at most '
  'p_limit (1..200) leads — due first, then not_yet_due, past_cutoff, '
  'already_escalated — as ids, times, status, assignee name, property '
  'reference and recipient count; never the enquirer. STABLE: it cannot '
  'write. Eligibility moves on after the preview; the sweep and the worker '
  'decide again at their own moment.';

-- ---------------------------------------------------------------------------
-- 4. Grants — the 0044 lesson, every function since
-- ---------------------------------------------------------------------------
revoke execute on function public.lead_escalation_candidates(uuid, jsonb, timestamptz) from public, anon, authenticated;
grant  execute on function public.lead_escalation_candidates(uuid, jsonb, timestamptz) to service_role;
-- restated for the redefined sweep: create or replace keeps the ACL, and a
-- reader of this file should not have to trust that
revoke execute on function public.raise_lead_escalations(uuid, timestamptz) from public, anon, authenticated;
grant  execute on function public.raise_lead_escalations(uuid, timestamptz) to service_role;
revoke execute on function public.preview_lead_escalation(jsonb, int, timestamptz) from public, anon;
grant  execute on function public.preview_lead_escalation(jsonb, int, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Apply-time assertions. The preview needs a session and is proven by
--    supabase/tests/lead-escalation-preview.test.ts; here its shape, its
--    volatility, its grants and its first refusal are checked, and the ONE
--    RULE is exercised in a SUBTRANSACTION that is rolled back (0061's
--    idiom): the sweep mints exactly the candidates' due set on fixed dates,
--    and nothing is left on the first organisation — on hosted, the live one.
-- ---------------------------------------------------------------------------
do $$
declare
  v_org     uuid;
  v_slug    text;
  v_friday  uuid;
  v_monday  uuid;
  v_backlog uuid;
  v_before  jsonb;
  n         int;
  probed    text := 'skipped (no organizations)';
  hours     jsonb := jsonb_build_object('days', '[1,2,3,4,5]'::jsonb, 'start', '09:00', 'end', '18:00');
  sample    jsonb := jsonb_build_object('enabled', true, 'after_minutes', 30, 'recipients', '["11111111-1111-1111-1111-111111111111"]'::jsonb, 'working_hours', hours, 'timezone', 'Europe/Athens');
begin
  -- exactly one function of each name: the cron's bare call and PostgREST's
  -- named-argument calls are not ambiguous
  for n in
    select count(*) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public' and p.proname = 'raise_lead_escalations'
  loop
    if n <> 1 then raise exception '0112 aborted: expected one raise_lead_escalations, found %', n; end if;
  end loop;
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname in ('lead_escalation_candidates', 'preview_lead_escalation');
  if n <> 2 then raise exception '0112 aborted: expected the two new functions once each, found %', n; end if;

  -- STABLE, both: the engine refuses a write inside them
  if exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
              where ns.nspname = 'public' and p.proname in ('lead_escalation_candidates', 'preview_lead_escalation')
                and p.provolatile <> 's') then
    raise exception '0112 aborted: the preview and the candidates must be STABLE';
  end if;

  if has_function_privilege('anon', 'public.lead_escalation_candidates(uuid,jsonb,timestamptz)', 'execute')
     or has_function_privilege('authenticated', 'public.lead_escalation_candidates(uuid,jsonb,timestamptz)', 'execute')
     or not has_function_privilege('service_role', 'public.lead_escalation_candidates(uuid,jsonb,timestamptz)', 'execute')
     or has_function_privilege('anon', 'public.raise_lead_escalations(uuid,timestamptz)', 'execute')
     or has_function_privilege('authenticated', 'public.raise_lead_escalations(uuid,timestamptz)', 'execute')
     or not has_function_privilege('service_role', 'public.raise_lead_escalations(uuid,timestamptz)', 'execute')
     or has_function_privilege('anon', 'public.preview_lead_escalation(jsonb,int,timestamptz)', 'execute')
     or not has_function_privilege('authenticated', 'public.preview_lead_escalation(jsonb,int,timestamptz)', 'execute')
     or not has_function_privilege('service_role', 'public.preview_lead_escalation(jsonb,int,timestamptz)', 'execute') then
    raise exception '0112 aborted: grants are wrong';
  end if;

  if not exists (select 1 from cron.job where jobname = 'lead-escalation' and command = 'select raise_lead_escalations()') then
    raise exception '0112 aborted: the lead-escalation cron command changed — it must stay the bare call';
  end if;
  select count(*) into n from cron.job;
  if n <> 12 then raise exception '0112 aborted: expected 12 cron jobs, found %', n; end if;

  -- the reader is idempotent, so the sweep re-validating its own validated
  -- policy inside the candidates function changes nothing
  if public.lead_escalation_config(public.lead_escalation_config(sample)) <> public.lead_escalation_config(sample) then
    raise exception '0112 aborted: lead_escalation_config is not idempotent';
  end if;

  -- without a session the preview refuses before it reads anything
  begin
    perform public.preview_lead_escalation('{}'::jsonb);
    raise exception '0112 aborted: the preview ran without a session';
  exception
    when raise_exception then
      if sqlerrm <> 'Not authenticated.' then raise; end if;
  end;

  if (public.lead_escalation_config() ->> 'enabled')::boolean then
    raise exception '0112 aborted: the policy is ON on this database; apply with it off, or verify by hand';
  end if;

  select id, slug into v_org, v_slug from organizations order by created_at limit 1;
  if v_org is not null then
    begin
      select value into v_before from cyprus_config where key = 'lead_escalation';
      update cyprus_config
         set value = value || jsonb_build_object('enabled', true, 'after_minutes', 15, 'max_age_hours', 48,
                                                 'working_hours', hours, 'timezone', 'Asia/Nicosia',
                                                 'recipients', '["11111111-1111-1111-1111-111111111111"]'::jsonb)
       where key = 'lead_escalation';

      select s.lead_id into v_friday
        from submit_public_enquiry(v_slug, '0112 selftest friday', 'selftest-0112-friday@example.invalid',
                                   null, '0112 self-test friday night', null, 'selftest-0112-friday', null) s;
      select s.lead_id into v_monday
        from submit_public_enquiry(v_slug, '0112 selftest monday', 'selftest-0112-monday@example.invalid',
                                   null, '0112 self-test monday control', null, 'selftest-0112-monday', null) s;
      select s.lead_id into v_backlog
        from submit_public_enquiry(v_slug, '0112 selftest backlog', 'selftest-0112-backlog@example.invalid',
                                   null, '0112 self-test backlog', null, 'selftest-0112-backlog', null) s;
      if v_friday is null or v_monday is null or v_backlog is null then
        raise exception '0112 aborted: the door refused a self-test enquiry';
      end if;
      update leads set received_at = '2026-09-25 19:00:00+00' where id = v_friday;  -- Friday 22:00 local
      update leads set received_at = '2026-09-28 06:00:00+00' where id = v_monday;  -- Monday 09:00 local
      update leads set received_at = '2026-09-01 07:00:00+00' where id = v_backlog; -- weeks earlier

      -- the candidates' verdicts on Monday 09:20 local
      if (select verdict from lead_escalation_candidates(v_org, null, '2026-09-28 06:20:00+00') where lead_id = v_friday) <> 'due'
         or (select verdict from lead_escalation_candidates(v_org, null, '2026-09-28 06:20:00+00') where lead_id = v_monday) <> 'due'
         or (select verdict from lead_escalation_candidates(v_org, null, '2026-09-28 06:20:00+00') where lead_id = v_backlog) <> 'past_cutoff'
         or (select verdict from lead_escalation_candidates(v_org, null, '2026-09-27 12:00:00+00') where lead_id = v_friday) <> 'not_yet_due' then
        raise exception '0112 aborted: the candidates'' verdicts are wrong on the 0110 scenario';
      end if;

      -- the sweep mints exactly the due set, and the verdicts move to already_escalated
      if raise_lead_escalations(v_org, '2026-09-28 06:20:00+00') <> 2 then
        raise exception '0112 aborted: expected two escalations minted';
      end if;
      select count(*) into n from notification_jobs where kind = 'lead_escalation' and lead_id in (v_friday, v_monday);
      if n <> 2 then raise exception '0112 aborted: the sweep did not mint the candidates'' due set'; end if;
      if exists (select 1 from notification_jobs where kind = 'lead_escalation' and lead_id = v_backlog) then
        raise exception '0112 aborted: the sweep minted a past-cutoff lead — the one rule is not the old rule';
      end if;
      select count(*) into n from lead_escalation_candidates(v_org, null, '2026-09-28 06:20:00+00')
       where lead_id in (v_friday, v_monday) and verdict = 'already_escalated' and job_state = 'pending';
      if n <> 2 then raise exception '0112 aborted: minted leads are not reported as already_escalated'; end if;
      if raise_lead_escalations(v_org, '2026-09-28 06:20:00+00') <> 0 then
        raise exception '0112 aborted: a second sweep at the same instant minted again';
      end if;
      select count(*) into n from events
       where entity_type = 'lead' and entity_id in (v_friday, v_monday) and event_type = 'lead_escalation' and payload ->> 'outcome' = 'scheduled';
      if n <> 2 then raise exception '0112 aborted: expected two scheduled events, found %', n; end if;
      if exists (select 1 from events where entity_id in (v_friday, v_monday, v_backlog) and payload::text ilike '%selftest-0112-%@%') then
        raise exception '0112 aborted: an event payload carries an address';
      end if;

      probed := 'PASSED — the sweep minted exactly the candidates'' due set (Friday night + Monday control), the backlog stayed past the cutoff';

      -- unwind everything: leads, jobs, events, the policy flip
      raise exception using errcode = 'YY112', message = 'rollback the 0112 probe';
    exception
      when sqlstate 'YY112' then null;   -- specific: a real failure still propagates
    end;

    if (public.lead_escalation_config() ->> 'enabled')::boolean then
      raise exception '0112 aborted: the probe''s policy flip survived its rollback';
    end if;
    if exists (select 1 from leads where org_id = v_org and idempotency_key like 'selftest-0112-%') then
      raise exception '0112 aborted: the probe''s leads survived its rollback';
    end if;
  end if;

  -- no new table: the aal2 invariant stands, and says so
  select count(*) into n from rls_aal2_coverage();
  if n <> 0 then raise exception '0112 aborted: % table(s) lack require_aal2', n; end if;

  raise notice '0112 ok: lead_escalation_candidates (one rule), raise_lead_escalations minting from it, preview_lead_escalation (STABLE, admin, aal2, own org). Probe: %', probed;
end $$;
