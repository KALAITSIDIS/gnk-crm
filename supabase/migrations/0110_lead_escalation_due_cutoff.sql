-- =============================================================================
-- 0110 — the lead escalation's age cutoff counts from the END of the wait
--        (audit 2026-09-22, second brief, finding 3)
--
-- THE DEFECT. 0107's sweep required two things of a website lead: that its
-- working-time wait had ended (`lead_escalation_due_at(received_at) <=
-- now()`) and that it had ARRIVED within `max_age_hours` (48). The second
-- was the guard against e-mailing a colleague about every stale enquiry of
-- the quarter the moment the policy is switched on — and it was measured in
-- wall-clock hours from arrival, while the first is measured in working
-- time. With the seeded Mon–Fri 09:00–18:00 hours the two disagree on
-- exactly the enquiries that arrive outside the hours:
--
--   received Friday 25 September 2026 22:00 Asia/Nicosia (19:00Z)
--   due      Monday 28 September 09:15 (06:15Z) — the wait starts at opening
--   swept    Monday 09:20 (06:20Z): due, five minutes overdue — and 59 hours
--            old, so "received within 48 hours" is false and NOTHING is
--            minted. Not then, not ever: it only gets older.
--
-- Reproduced on the local stack on 2026-09-22 with the real clock (a Sunday
-- small-hours arrival swept on Tuesday afternoon: due, 28 hours past due,
-- outside the cutoff, skipped while fifteen other leads were minted) and
-- pinned with fixed dates in supabase/tests/lead-escalation.test.ts. Every
-- Friday-evening, Saturday and Sunday enquiry was cut off by the closed
-- days it had legitimately waited through.
--
-- THE FIX. The guard asks the right question: not "when did it arrive" but
-- "how long ago did its wait END". An enquiry is escalated when its due
-- time has passed AND lies within the last `max_age_hours`:
--
--     due_at <= p_now  and  due_at > p_now - max_age_hours
--
-- For a lead received inside the hours the two readings differ by
-- `after_minutes`; for one received outside them they differ by exactly the
-- closed time — which is the point. The old rule is a strict subset of the
-- new one (received within N hours and due ⇒ due within N hours), so
-- nothing that was eligible stops being eligible.
--
-- WHAT `max_age_hours` MEANS NOW — a configuration migration in meaning,
-- not in value. The stored 48 is untouched and still a placeholder for the
-- operator to confirm; it now reads "an enquiry whose wait ended more than
-- 48 hours ago is left to its task". That is still, and only, the
-- activation guard: while the policy is on, the sweep runs every five
-- minutes and mints within five minutes of the due time, so the cutoff
-- never bites — it bites at activation and after an outage of the sweep
-- longer than the cutoff, which is exactly the backlog it exists to keep
-- quiet. Settings → Lead escalation and the row's description say so; the
-- reader (lead_escalation_config / readLeadEscalation) is unchanged.
--
-- THE CLOCK IS A PARAMETER. `p_now` defaults to now() and is for the tests
-- (like `p_org`): the scenario above can only be a regression test if it
-- runs on ITS dates whatever day the suite runs — an assertion that only
-- fails on some days is not coverage. Nothing but the cron and the tests
-- calls this function; service_role-only, as before.
--
-- THE SIGNATURE CHANGES, SO THE OLD ONE IS DROPPED FIRST. `create or
-- replace` with a second defaulted parameter would CREATE A SECOND
-- FUNCTION beside the first, and `select raise_lead_escalations()` — the
-- cron's command — would then fail at call time with "function is not
-- unique" (the trap 0060 and 0062 document). Drop, then create, in this one
-- transaction; the cron command text does not change and resolves to the
-- new function, PostgREST resolves `{p_org}` to it by argument name, and
-- the deployed application never calls it — so this is not deploy-coupled.
--
-- A BOUND THE INDEX CAN USE. `lead_escalation_due_at` never places a due
-- time more than 61 days after arrival (it gives up looking for a working
-- day after 60 and falls back to flat time), so a lead whose wait ended
-- inside the window cannot have arrived before `p_now - max_age_hours -
-- 61 days`. That bound keeps the sweep from evaluating the due time of
-- every open lead in the organisation's history; it excludes nothing the
-- rule would admit.
--
-- Pins that move with this file: the migrations count in
-- scripts/backup/verify-restore.sql (110). No new table, job or grant
-- surface; the function count and the grants are asserted below.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The sweep, with the guard counted from the due time
-- ---------------------------------------------------------------------------
drop function if exists public.raise_lead_escalations(uuid);

create function public.raise_lead_escalations(p_org uuid default null, p_now timestamptz default now())
returns int
language plpgsql security definer set search_path = public as $fn$
declare
  cfg     jsonb := public.lead_escalation_config();
  v_age   interval;
  v_count int := 0;
begin
  if not (cfg ->> 'enabled')::boolean then return 0; end if;
  v_age := make_interval(hours => (cfg ->> 'max_age_hours')::int);

  with due as (
    -- the eligibility rule, in one place: a website lead, open, unanswered,
    -- not redacted, not yet escalated, whose wait has ended — and ended
    -- within max_age_hours (0110: counted from the due time, so closed days
    -- the lead waited through do not cut it off)
    select l.id, l.org_id
      from leads l
      cross join lateral (select public.lead_escalation_due_at(l.received_at, cfg) as at) w
     where l.source = 'website'
       and l.status in ('new', 'contacted', 'qualified')
       and l.first_response_at is null
       and l.message is distinct from '[erased at the contact''s request]'
       -- the bound the index can use (header): nothing due inside the window
       -- arrived earlier than this
       and l.received_at > p_now - v_age - interval '61 days'
       and (p_org is null or l.org_id = p_org)
       and not exists (select 1 from notification_jobs j
                        where j.lead_id = l.id and j.kind = 'lead_escalation')
       and w.at <= p_now
       and w.at > p_now - v_age
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
  'Every five minutes (0107, cutoff 0110): one lead_escalation notification job '
  'per website lead still open, unanswered, not redacted, with no such job yet, '
  'whose working-time wait (lead_escalation_due_at) ended at or before p_now '
  'and within the last max_age_hours — the guard against a stale backlog at '
  'activation, counted from the END of the wait so that closed days a lead '
  'waited through do not cut it off. A lead_escalation: scheduled event per '
  'row. Nothing while the policy is off. The unique (lead_id, kind) index makes '
  'a second job impossible; concurrent sweeps mint one. The worker re-checks '
  'eligibility and resolves recipients at send time. Returns the number minted. '
  'p_org and p_now (default now()) are for the tests; cron calls it bare. '
  'service_role-only.';

revoke execute on function public.raise_lead_escalations(uuid, timestamptz) from public, anon, authenticated;
grant  execute on function public.raise_lead_escalations(uuid, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- 2. The row's description says what the setting means now (its VALUE is
--    untouched — still the operator's placeholder)
-- ---------------------------------------------------------------------------
update public.cyprus_config
   set description = 'Escalate a website enquiry still unanswered after after_minutes of working time to the listed colleagues by e-mail (never to its assignee). OFF until enabled on Settings → Lead escalation. Checked every five minutes, sent by the two-minute alert sweep: expect the wait plus up to seven minutes. days are ISO (1 = Monday … 7 = Sunday); working_hours null = around the clock; max_age_hours bounds how long ago an enquiry''s wait may have ENDED and still be escalated (0110: counted from the due time, not from arrival, so an enquiry that waited through closed days is not cut off by them) — the guard against e-mailing about a stale backlog when the policy is switched on.'
 where key = 'lead_escalation';

-- ---------------------------------------------------------------------------
-- 3. Apply-time assertions. The scenario runs in a SUBTRANSACTION that is
--    rolled back (0061's idiom): the self-test leads, their events, their
--    jobs and the policy flip all unwind, so nothing is left on the first
--    organisation — on the hosted project that is the live one.
-- ---------------------------------------------------------------------------
do $$
declare
  v_org     uuid;
  v_slug    text;
  v_friday  uuid;
  v_monday  uuid;
  v_backlog uuid;
  n         int;
  probed    text := 'skipped (no organizations)';
  hours     jsonb := jsonb_build_object('days', '[1,2,3,4,5]'::jsonb, 'start', '09:00', 'end', '18:00');
begin
  -- exactly one function of this name: the zero-argument cron call is not ambiguous
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'raise_lead_escalations';
  if n <> 1 then
    raise exception '0110 aborted: expected one raise_lead_escalations, found % — the cron call would be ambiguous', n;
  end if;
  -- and the bare call resolves (policy OFF here, so it mints nothing)
  if (public.lead_escalation_config() ->> 'enabled')::boolean then
    raise exception '0110 aborted: the policy is ON on this database; apply with it off, or verify by hand';
  end if;
  perform public.raise_lead_escalations();

  if has_function_privilege('anon', 'public.raise_lead_escalations(uuid,timestamptz)', 'execute')
     or has_function_privilege('authenticated', 'public.raise_lead_escalations(uuid,timestamptz)', 'execute')
     or not has_function_privilege('service_role', 'public.raise_lead_escalations(uuid,timestamptz)', 'execute') then
    raise exception '0110 aborted: grants are wrong';
  end if;

  if not exists (select 1 from cron.job where jobname = 'lead-escalation' and command = 'select raise_lead_escalations()') then
    raise exception '0110 aborted: the lead-escalation cron command changed — it must stay the bare call';
  end if;

  select id, slug into v_org, v_slug from organizations order by created_at limit 1;
  if v_org is not null then
    begin
      -- the brief's scenario, on fixed dates, with the policy ON inside the subtransaction only
      update cyprus_config
         set value = value || jsonb_build_object('enabled', true, 'after_minutes', 15, 'max_age_hours', 48,
                                                 'working_hours', hours, 'timezone', 'Asia/Nicosia',
                                                 'recipients', '["11111111-1111-1111-1111-111111111111"]'::jsonb)
       where key = 'lead_escalation';

      select s.lead_id into v_friday
        from submit_public_enquiry(v_slug, '0110 selftest friday', 'selftest-0110-friday@example.invalid',
                                   null, '0110 self-test friday night', null, 'selftest-0110-friday', null) s;
      select s.lead_id into v_monday
        from submit_public_enquiry(v_slug, '0110 selftest monday', 'selftest-0110-monday@example.invalid',
                                   null, '0110 self-test monday control', null, 'selftest-0110-monday', null) s;
      select s.lead_id into v_backlog
        from submit_public_enquiry(v_slug, '0110 selftest backlog', 'selftest-0110-backlog@example.invalid',
                                   null, '0110 self-test backlog', null, 'selftest-0110-backlog', null) s;
      if v_friday is null or v_monday is null or v_backlog is null then
        raise exception '0110 aborted: the door refused a self-test enquiry';
      end if;
      update leads set received_at = '2026-09-25 19:00:00+00' where id = v_friday;  -- Friday 22:00 local
      update leads set received_at = '2026-09-28 06:00:00+00' where id = v_monday;  -- Monday 09:00 local
      update leads set received_at = '2026-09-01 07:00:00+00' where id = v_backlog; -- weeks earlier

      -- Sunday noon: nothing has come due
      perform raise_lead_escalations(v_org, '2026-09-27 12:00:00+00');
      if exists (select 1 from notification_jobs where kind = 'lead_escalation' and lead_id in (v_friday, v_monday, v_backlog)) then
        raise exception '0110 aborted: a lead was escalated before its wait had ended';
      end if;

      -- Monday 09:20 local: the Friday-night lead (59 h old, 5 min overdue) and
      -- the Monday control are minted; the backlog lead, due weeks ago, is not
      perform raise_lead_escalations(v_org, '2026-09-28 06:20:00+00');
      if not exists (select 1 from notification_jobs where kind = 'lead_escalation' and lead_id = v_friday) then
        raise exception '0110 aborted: the Friday-night enquiry was not escalated on Monday morning';
      end if;
      if not exists (select 1 from notification_jobs where kind = 'lead_escalation' and lead_id = v_monday) then
        raise exception '0110 aborted: the Monday control enquiry was not escalated';
      end if;
      if exists (select 1 from notification_jobs where kind = 'lead_escalation' and lead_id = v_backlog) then
        raise exception '0110 aborted: an enquiry whose wait ended weeks ago was escalated — the activation guard is gone';
      end if;
      -- idempotent: a second sweep at the same instant changes nothing
      perform raise_lead_escalations(v_org, '2026-09-28 06:20:00+00');
      select count(*) into n from notification_jobs where kind = 'lead_escalation' and lead_id in (v_friday, v_monday);
      if n <> 2 then raise exception '0110 aborted: expected two escalation rows after a repeated sweep, found %', n; end if;
      select count(*) into n from events
       where entity_type = 'lead' and entity_id in (v_friday, v_monday) and event_type = 'lead_escalation' and payload ->> 'outcome' = 'scheduled';
      if n <> 2 then raise exception '0110 aborted: expected two scheduled events, found %', n; end if;
      if exists (select 1 from events where entity_id in (v_friday, v_monday, v_backlog) and payload::text ilike '%selftest-0110-%@%') then
        raise exception '0110 aborted: an event payload carries an address';
      end if;

      probed := 'PASSED — Friday 22:00 → Monday 09:20 escalated once; Sunday sweep minted nothing; weeks-old backlog left alone';

      -- unwind everything: leads, jobs, events, the policy flip
      raise exception using errcode = 'YY110', message = 'rollback the 0110 probe';
    exception
      when sqlstate 'YY110' then null;   -- specific: a real failure still propagates
    end;

    if (public.lead_escalation_config() ->> 'enabled')::boolean then
      raise exception '0110 aborted: the probe''s policy flip survived its rollback';
    end if;
    if exists (select 1 from leads where org_id = v_org and idempotency_key like 'selftest-0110-%') then
      raise exception '0110 aborted: the probe''s leads survived its rollback';
    end if;
  end if;

  raise notice '0110: raise_lead_escalations(p_org, p_now) counts max_age_hours from the end of the wait. Probe: %', probed;
end $$;
