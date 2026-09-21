-- =============================================================================
-- 0105 — the sweep's HTTP outcomes become a durable, readable record
--        (audit 2026-09-21, finding 3: "the health dashboard treats a
--        successfully queued net.http_post as proof the worker succeeded")
--
-- CONFIRMED. `enquiry-alerts` (0103) is a pg_cron job whose body queues one
-- HTTP request through pg_net. pg_cron records the run `succeeded` the moment
-- the request is queued — measured on production: `succeeded`, 0.03 s, on
-- every run — and `cron_health()` (0074) reads nothing else. The route's
-- actual answer lands in `net._http_response`: 200 with the worker's counts,
-- 401 because the bearer in Vault no longer matches Vercel's, 503 because
-- the queue could not be reached, a timeout, a connection failure, or no row
-- at all. Nothing read that table, and pg_net purges it after six hours. The
-- cron-health card could stay green for as long as requests were being
-- queued, while every one of them failed.
--
-- WHAT THIS FILE ADDS.
--   * `enquiry_alert_sweep_runs`: one row per request the sweep queues —
--     the pg_net request id, when, and once reconciled the outcome, the HTTP
--     status, the worker's counts and the error's stage and code. Never a
--     header, never the bearer, never a person: the sweep route's body is
--     counts and codes, and pg_net's error text is transport words.
--   * `enquiry_alerts_sweep()` (0103) now reconciles what it queued last
--     time BEFORE queuing again, and records the request it queues. Same
--     name, same schedule, same cron command; the run fails loudly if the
--     record cannot be written (cron_health goes amber within the hour).
--   * `classify_enquiry_alert_sweep_response(...)`: the pure classifier —
--     `ok` (the worker completed; an EMPTY QUEUE is ok), `unconfigured`
--     (200 but `skipped: unconfigured` — the route runs, no alert can be
--     sent; NOT a success), `worker_failed` (`ok:false`, 503, 500),
--     `unauthorized` (401/403), `timeout`, `connect_error`, `malformed` (a
--     200 that is not the worker's body), `http_error` (anything else).
--   * `reconcile_enquiry_alert_sweeps(...)`: joins queued rows with
--     `net._http_response` after a grace period, marks `no_response` after
--     ten minutes without one, and prunes rows older than thirty days —
--     the operational summary outlives pg_net's retention.
--   * `enquiry_alert_sweep_health(...)`: the facts the dashboard needs —
--     last completed run, last outcome, the failure streak, requests
--     without an answer, and the desk-alert rows that are OVERDUE (still
--     due ten minutes past their time) with the oldest's age.
--   lib/services/enquiry-alert-sweep-health.ts owns the verdict (silence,
--   streak, missing answers, overdue backlog, unconfigured), pinned by unit
--   tests with a controlled clock; the cron-health card folds it into the
--   `enquiry-alerts` line, so the card cannot stay green because requests
--   are being queued while the worker keeps failing.
--
-- Grants: everything here is service_role-only (the dashboard reads through
-- the admin client as cron_health() does; the sweep runs as postgres). The
-- table has RLS with require_aal2 and NO permissive policy: a signed-in
-- user reads nothing directly. Pins that move: verify-restore.sql (the
-- grants table and the migrations count), docs/04 (a row), database.types.
-- The cron count stays ELEVEN and the command text is unchanged.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The record
-- ---------------------------------------------------------------------------
create table if not exists public.enquiry_alert_sweep_runs (
  id           bigserial primary key,
  -- pg_net's request id: the join key to net._http_response while it lasts
  request_id   bigint not null unique,
  queued_at    timestamptz not null default now(),
  resolved_at  timestamptz,
  outcome      text not null default 'queued'
               check (outcome in ('queued', 'ok', 'unconfigured', 'worker_failed', 'unauthorized',
                                  'timeout', 'connect_error', 'malformed', 'http_error', 'no_response')),
  http_status  int,
  -- the worker's own counts, from a 200 body
  claimed      int, accepted int, retried int, failed int, cancelled int, released int, lost int,
  -- the route's `error: {stage, code}` (review C) — a stage word and a code, never a message
  error_stage  text check (error_stage is null or length(error_stage) <= 40),
  error_code   text check (error_code is null or length(error_code) <= 80),
  -- pg_net's transport words ("Couldn't connect to server"), capped
  note         text check (note is null or length(note) <= 120)
);
create index if not exists enquiry_alert_sweep_runs_queued_idx on public.enquiry_alert_sweep_runs (queued_at desc);

comment on table public.enquiry_alert_sweep_runs is
  'One row per request the enquiry-alerts cron job queues through pg_net '
  '(0105): reconciled against net._http_response into an outcome the '
  'dashboard can read after pg_net has purged the answer. Holds counts, '
  'statuses and codes only — no header, no bearer, no person. Thirty days.';

alter table public.enquiry_alert_sweep_runs enable row level security;
revoke all privileges on table public.enquiry_alert_sweep_runs from public;
revoke all privileges on table public.enquiry_alert_sweep_runs from anon;
revoke all privileges on table public.enquiry_alert_sweep_runs from authenticated;
grant select, insert, update, delete on table public.enquiry_alert_sweep_runs to service_role;
grant usage, select on sequence public.enquiry_alert_sweep_runs_id_seq to service_role;
-- A TABLE CREATED AFTER 0029 DOES NOT INHERIT require_aal2; rls_aal2_coverage()
-- must stay at 0. No permissive policy follows it: authenticated reads nothing.
drop policy if exists require_aal2 on public.enquiry_alert_sweep_runs;
create policy require_aal2 on public.enquiry_alert_sweep_runs
  as restrictive for all to authenticated
  using ((select mfa_satisfied())) with check ((select mfa_satisfied()));

-- ---------------------------------------------------------------------------
-- 2. The classifier — pure, so every shape is pinned by a test
-- ---------------------------------------------------------------------------
create or replace function public.classify_enquiry_alert_sweep_response(
  p_status    int,
  p_content   text,
  p_error     text,
  p_timed_out boolean
)
returns table (
  outcome text, claimed int, accepted int, retried int, failed int, cancelled int,
  released int, lost int, error_stage text, error_code text
)
language plpgsql immutable security invoker set search_path = public as $fn$
declare
  v     jsonb;
  v_k   text;
  v_err text := left(nullif(btrim(coalesce(p_error, '')), ''), 80);
begin
  if coalesce(p_timed_out, false) then
    return query select 'timeout', null::int, null::int, null::int, null::int, null::int, null::int, null::int, null::text, v_err;
    return;
  end if;
  if p_status is null then
    return query select case when v_err is not null then 'connect_error' else 'malformed' end,
                        null::int, null::int, null::int, null::int, null::int, null::int, null::int, null::text, v_err;
    return;
  end if;
  if p_status in (401, 403) then
    return query select 'unauthorized', null::int, null::int, null::int, null::int, null::int, null::int, null::int, null::text, ('http_' || p_status)::text;
    return;
  end if;

  begin
    v := nullif(btrim(coalesce(p_content, '')), '')::jsonb;
  exception when others then
    v := null;
  end;
  if v is not null and jsonb_typeof(v) <> 'object' then v := null; end if;

  if p_status = 200 then
    if v is null or coalesce(jsonb_typeof(v -> 'ok'), 'missing') <> 'boolean' then
      return query select 'malformed', null::int, null::int, null::int, null::int, null::int, null::int, null::int, null::text, null::text;
      return;
    end if;
    if (v ->> 'ok')::boolean then
      foreach v_k in array array['claimed', 'accepted', 'retried', 'failed', 'cancelled', 'released', 'lost'] loop
        if coalesce(jsonb_typeof(v -> v_k), 'missing') <> 'number' then
          return query select 'malformed', null::int, null::int, null::int, null::int, null::int, null::int, null::int, null::text, null::text;
          return;
        end if;
      end loop;
      return query select case when v ->> 'skipped' = 'unconfigured' then 'unconfigured' else 'ok' end,
                          floor((v ->> 'claimed')::numeric)::int, floor((v ->> 'accepted')::numeric)::int,
                          floor((v ->> 'retried')::numeric)::int, floor((v ->> 'failed')::numeric)::int,
                          floor((v ->> 'cancelled')::numeric)::int, floor((v ->> 'released')::numeric)::int,
                          floor((v ->> 'lost')::numeric)::int, null::text, null::text;
      return;
    end if;
    -- a 200 that says ok:false is the worker refusing in the wrong status; still a worker failure
    return query select 'worker_failed', null::int, null::int, null::int, null::int, null::int, null::int, null::int,
                        left(v #>> '{error,stage}', 40), coalesce(left(v #>> '{error,code}', 80), 'ok_false');
    return;
  end if;

  if p_status in (500, 503) then
    return query select 'worker_failed', null::int, null::int, null::int, null::int, null::int, null::int, null::int,
                        left(v #>> '{error,stage}', 40), coalesce(left(v #>> '{error,code}', 80), ('http_' || p_status)::text);
    return;
  end if;

  return query select 'http_error', null::int, null::int, null::int, null::int, null::int, null::int, null::int, null::text, ('http_' || p_status)::text;
end $fn$;

comment on function public.classify_enquiry_alert_sweep_response(int, text, text, boolean) is
  '0105: what one pg_net response to the desk-alert sweep means — ok (the '
  'worker completed, an empty queue included), unconfigured (200 with skipped: '
  'unconfigured — not a success), worker_failed (ok:false, 500, 503), '
  'unauthorized (401/403), timeout, connect_error, malformed (a 200 that is not '
  'the worker''s body), http_error. Pure; service_role-only.';

-- ---------------------------------------------------------------------------
-- 3. The reconciler — reads pg_net as postgres, writes the record
-- ---------------------------------------------------------------------------
create or replace function public.reconcile_enquiry_alert_sweeps(
  p_now           timestamptz default now(),
  p_grace         interval    default interval '90 seconds',
  p_missing_after interval    default interval '10 minutes',
  p_retention     interval    default interval '30 days'
)
returns int
language plpgsql security definer set search_path = public as $fn$
declare
  n int := 0;
  m int := 0;
begin
  -- Answered: classify and keep the outcome. The grace period gives pg_net
  -- time to deliver (the request itself may take up to 55 s).
  with answered as (
    select s.id as run_id, r.status_code, r.error_msg, c.*
      from enquiry_alert_sweep_runs s
      join net._http_response r on r.id = s.request_id
      cross join lateral public.classify_enquiry_alert_sweep_response(r.status_code, r.content, r.error_msg, r.timed_out) c
     where s.outcome = 'queued'
       and s.queued_at <= p_now - p_grace
  )
  update enquiry_alert_sweep_runs s
     set outcome     = a.outcome,
         http_status = a.status_code,
         claimed     = a.claimed,
         accepted    = a.accepted,
         retried     = a.retried,
         failed      = a.failed,
         cancelled   = a.cancelled,
         released    = a.released,
         lost        = a.lost,
         error_stage = a.error_stage,
         error_code  = a.error_code,
         note        = left(nullif(btrim(coalesce(a.error_msg, '')), ''), 120),
         resolved_at = p_now
    from answered a
   where s.id = a.run_id;
  get diagnostics n = row_count;

  -- Missing: queued long enough that pg_net will not answer any more.
  update enquiry_alert_sweep_runs
     set outcome = 'no_response', resolved_at = p_now
   where outcome = 'queued'
     and queued_at <= p_now - p_missing_after;
  get diagnostics m = row_count;

  -- Retention: the summary outlives pg_net's six hours, not forever.
  delete from enquiry_alert_sweep_runs where queued_at < p_now - p_retention;

  return n + m;
end $fn$;

comment on function public.reconcile_enquiry_alert_sweeps(timestamptz, interval, interval, interval) is
  '0105: resolves queued sweep runs against net._http_response once p_grace has '
  'passed, marks no_response after p_missing_after, prunes rows older than '
  'p_retention. Returns how many rows it resolved. Called by '
  'enquiry_alerts_sweep() before each run; service_role may call it by hand.';

-- ---------------------------------------------------------------------------
-- 4. The sweep records what it queues (same name, same cron command)
-- ---------------------------------------------------------------------------
create or replace function public.enquiry_alerts_sweep(
  p_url_secret    text default 'crm_url',
  p_bearer_secret text default 'cron_secret'
) returns bigint
language plpgsql
security invoker
set search_path = public
as $fn$
declare
  v_url    text;
  v_bearer text;
  v_id     bigint;
begin
  select s.decrypted_secret into v_url
    from vault.decrypted_secrets s where s.name = p_url_secret limit 1;
  select s.decrypted_secret into v_bearer
    from vault.decrypted_secrets s where s.name = p_bearer_secret limit 1;

  if v_url is null or v_url = '' then
    raise exception 'enquiry-alerts: Vault secret "%" is missing — the sweep cannot run (migration 0103, docs/10 §2)', p_url_secret
      using errcode = 'P0001';
  end if;
  if v_bearer is null or v_bearer = '' then
    raise exception 'enquiry-alerts: Vault secret "%" is missing — the sweep cannot run (migration 0103, docs/10 §2)', p_bearer_secret
      using errcode = 'P0001';
  end if;

  -- 0105: fold last time's answers into the record first. If this fails the
  -- run fails, and cron_health says so — the monitor is part of the sweep.
  perform public.reconcile_enquiry_alert_sweeps();

  -- no ?limit=: the route's own ceiling is what its budget fits (review B)
  v_id := net.http_post(
    url     := rtrim(v_url, '/') || '/api/internal/enquiry-alerts',
    headers := jsonb_build_object(
                 'Authorization', 'Bearer ' || v_bearer,
                 'Content-Type',  'application/json'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 55000
  );

  insert into public.enquiry_alert_sweep_runs (request_id) values (v_id);
  return v_id;
end
$fn$;

comment on function public.enquiry_alerts_sweep(text, text) is
  '0103/0105: the body of the enquiry-alerts cron job — reconciles the previous '
  'requests'' answers, reads crm_url and cron_secret from Vault, POSTs '
  '/api/internal/enquiry-alerts through pg_net and records the request it '
  'queued; raises naming a missing secret. postgres (pg_cron) and service_role only.';

-- ---------------------------------------------------------------------------
-- 5. The facts for the dashboard
-- ---------------------------------------------------------------------------
create or replace function public.enquiry_alert_sweep_health(p_overdue_minutes int default 10)
returns table (
  last_queued_at         timestamptz,
  last_ok_at             timestamptz,
  last_outcome           text,
  last_resolved_at       timestamptz,
  consecutive_failures   int,
  queued_unresolved      int,
  runs_last_hour         int,
  overdue_jobs           int,
  oldest_overdue_minutes int,
  pending_jobs           int
)
language sql stable security definer set search_path = public as $fn$
  with last_ok as (
    select max(queued_at) as at from enquiry_alert_sweep_runs where outcome = 'ok'
  ),
  latest as (
    select outcome, resolved_at
      from enquiry_alert_sweep_runs
     where outcome <> 'queued'
     order by queued_at desc
     limit 1
  ),
  streak as (
    select count(*)::int as n
      from enquiry_alert_sweep_runs s, last_ok
     where s.outcome not in ('queued', 'ok')
       and (last_ok.at is null or s.queued_at > last_ok.at)
  ),
  overdue as (
    select count(*)::int as n,
           min(case when state = 'pending' then next_attempt_at else claimed_until end) as oldest
      from notification_jobs
     where (state = 'pending' and next_attempt_at < now() - make_interval(mins => greatest(coalesce(p_overdue_minutes, 10), 0)))
        or (state = 'sending' and claimed_until < now() - make_interval(mins => greatest(coalesce(p_overdue_minutes, 10), 0)))
  )
  select (select max(queued_at) from enquiry_alert_sweep_runs),
         (select at from last_ok),
         (select outcome from latest),
         (select resolved_at from latest),
         (select n from streak),
         (select count(*)::int from enquiry_alert_sweep_runs
           where outcome = 'queued' and queued_at <= now() - interval '90 seconds'),
         (select count(*)::int from enquiry_alert_sweep_runs where queued_at > now() - interval '1 hour'),
         (select n from overdue),
         (select case when oldest is null then null
                      else floor(extract(epoch from (now() - oldest)) / 60)::int end from overdue),
         (select count(*)::int from notification_jobs where state in ('pending', 'sending'));
$fn$;

comment on function public.enquiry_alert_sweep_health(int) is
  '0105: the desk-alert sweep''s actual outcomes for the dashboard — last '
  'completed run (ok, an empty queue included), the latest outcome, the '
  'failure streak since the last completed run, requests without an answer, '
  'runs in the last hour, and the desk-alert rows overdue by p_overdue_minutes '
  '(default 10) with the oldest''s age. Verdicts live in '
  'lib/services/enquiry-alert-sweep-health.ts. service_role-only.';

-- ---------------------------------------------------------------------------
-- 6. Grants
-- ---------------------------------------------------------------------------
revoke execute on function public.classify_enquiry_alert_sweep_response(int, text, text, boolean) from public, anon, authenticated;
grant  execute on function public.classify_enquiry_alert_sweep_response(int, text, text, boolean) to service_role;
revoke execute on function public.reconcile_enquiry_alert_sweeps(timestamptz, interval, interval, interval) from public, anon, authenticated;
grant  execute on function public.reconcile_enquiry_alert_sweeps(timestamptz, interval, interval, interval) to service_role;
revoke execute on function public.enquiry_alert_sweep_health(int) from public, anon, authenticated;
grant  execute on function public.enquiry_alert_sweep_health(int) to service_role;
revoke execute on function public.enquiry_alerts_sweep(text, text) from public, anon, authenticated;
grant  execute on function public.enquiry_alerts_sweep(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Apply-time assertions (0084 idiom): the classifier on the shapes that
--    matter, the missing-response path on a synthetic row, grants, RLS.
-- ---------------------------------------------------------------------------
do $$
declare
  c record;
  n int;
begin
  select * into c from public.classify_enquiry_alert_sweep_response(200,
    '{"ok":true,"claimed":0,"accepted":0,"retried":0,"failed":0,"cancelled":0,"released":0,"lost":0,"skipped":null,"error":null}', null, false);
  if c.outcome <> 'ok' or c.claimed <> 0 then raise exception '0105 aborted: an empty completed run must be ok'; end if;
  select * into c from public.classify_enquiry_alert_sweep_response(200,
    '{"ok":true,"claimed":0,"accepted":0,"retried":0,"failed":0,"cancelled":0,"released":0,"lost":0,"skipped":"unconfigured","error":null}', null, false);
  if c.outcome <> 'unconfigured' then raise exception '0105 aborted: an unconfigured provider must not read as ok'; end if;
  select * into c from public.classify_enquiry_alert_sweep_response(401, '{"error":"Unauthorized."}', null, false);
  if c.outcome <> 'unauthorized' then raise exception '0105 aborted: 401 must be unauthorized'; end if;
  select * into c from public.classify_enquiry_alert_sweep_response(503,
    '{"ok":false,"claimed":0,"accepted":0,"retried":0,"failed":0,"cancelled":0,"released":0,"lost":0,"skipped":null,"error":{"stage":"claim","code":"PGRST301"}}', null, false);
  if c.outcome <> 'worker_failed' or c.error_code <> 'PGRST301' then raise exception '0105 aborted: 503 ok:false must be worker_failed with its code'; end if;
  select * into c from public.classify_enquiry_alert_sweep_response(null, null, 'Timeout was reached', true);
  if c.outcome <> 'timeout' then raise exception '0105 aborted: a timed-out request must be timeout'; end if;
  select * into c from public.classify_enquiry_alert_sweep_response(null, null, 'Couldn''t connect to server', false);
  if c.outcome <> 'connect_error' then raise exception '0105 aborted: a transport error must be connect_error'; end if;
  select * into c from public.classify_enquiry_alert_sweep_response(200, '<html>Sign in</html>', null, false);
  if c.outcome <> 'malformed' then raise exception '0105 aborted: a 200 that is not the worker''s body must be malformed'; end if;
  select * into c from public.classify_enquiry_alert_sweep_response(200, '{"ok":true}', null, false);
  if c.outcome <> 'malformed' then raise exception '0105 aborted: a 200 without the counts must be malformed'; end if;

  -- the missing-response path, on a row pg_net never wrote
  insert into public.enquiry_alert_sweep_runs (request_id, queued_at) values (-105, now() - interval '11 minutes');
  perform public.reconcile_enquiry_alert_sweeps();
  if (select outcome from public.enquiry_alert_sweep_runs where request_id = -105) <> 'no_response' then
    raise exception '0105 aborted: a request without an answer was not marked no_response';
  end if;
  delete from public.enquiry_alert_sweep_runs where request_id = -105;

  -- grants and RLS
  if has_function_privilege('anon', 'public.reconcile_enquiry_alert_sweeps(timestamptz,interval,interval,interval)', 'execute')
     or has_function_privilege('authenticated', 'public.enquiry_alert_sweep_health(int)', 'execute')
     or has_function_privilege('anon', 'public.classify_enquiry_alert_sweep_response(int,text,text,boolean)', 'execute')
     or not has_function_privilege('service_role', 'public.enquiry_alert_sweep_health(int)', 'execute')
     or not has_function_privilege('service_role', 'public.reconcile_enquiry_alert_sweeps(timestamptz,interval,interval,interval)', 'execute') then
    raise exception '0105 aborted: grants are wrong';
  end if;
  if has_table_privilege('anon', 'public.enquiry_alert_sweep_runs', 'select')
     or has_table_privilege('authenticated', 'public.enquiry_alert_sweep_runs', 'select') then
    raise exception '0105 aborted: the record is readable by a browser role';
  end if;
  select count(*) into n from rls_aal2_coverage();
  if n <> 0 then raise exception '0105 aborted: % table(s) lack require_aal2', n; end if;

  -- the cron job is unchanged: same name, same schedule, same command, eleven jobs
  if not exists (select 1 from cron.job where jobname = 'enquiry-alerts' and schedule = '*/2 * * * *'
                    and command like '%enquiry_alerts_sweep()%') then
    raise exception '0105 aborted: the enquiry-alerts job changed';
  end if;
  select count(*) into n from cron.job;
  if n <> 11 then raise exception '0105 aborted: expected eleven cron jobs, found %', n; end if;

  raise notice '0105: sweep requests are recorded and reconciled against pg_net; enquiry_alert_sweep_health() feeds the dashboard.';
end $$;
