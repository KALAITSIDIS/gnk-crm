-- =============================================================================
-- 0103 — the desk-alert sweep every two minutes, from the database, through
--        pg_net: `enquiry-alerts`, the ELEVENTH cron job
--
-- Prepared 2026-09-21 as supabase/activation/0103_enquiry_alerts_cron.sql and
-- held OUTSIDE supabase/migrations/ because it installs an extension on the
-- hosted project, which is the operator's decision (BACKLOG: "Arm the
-- desk-alert sweep at its designed cadence — NEEDS AN OPERATOR DECISION").
-- The decision was taken the same day ("enable pg_net and apply 0103"):
-- pg_net was installed on hosted by hand first (0.20.3), the two Vault
-- secrets were created by hand, and only then did this file move here.
--
-- WHAT IT DOES. Every two minutes pg_cron runs `enquiry_alerts_sweep()`,
-- which reads the CRM origin and the bearer from Vault and POSTs the sweep
-- route (/api/internal/enquiry-alerts, docs/10 §2 "The desk-alert sweep")
-- through pg_net. pg_net is asynchronous: the call returns a request id and
-- the response lands in net._http_response (kept for pg_net's ttl, six
-- hours), so a failing route does not block the scheduler. The worker claims
-- at most what the route's 45-second budget fits — four rows at the
-- provider's 8-second worst case (review B) — and hands back unattempted
-- whatever a slow batch cannot reach. Between the enquiry route's after()
-- accelerator and this, a retry lands within two minutes of its scheduled
-- time and the whole eight-attempt budget completes inside ~2h07m — well
-- inside the 20-hour key window the claim enforces (0102). Until this job
-- the sweep was reached only by the daily Vercel cron in vercel.json (Hobby
-- allows once a day) and by hand; the daily one stays as the second caller.
--
-- WHAT IT NEEDS — two Vault secrets, read at RUN time, never at apply time.
-- Nothing here, and nothing in cron.job's command text, holds a value;
-- `vault.decrypted_secrets` is readable by postgres, which is what pg_cron
-- runs the job as.
--   * `crm_url`     — https://gnk-crm.vercel.app on hosted (no trailing
--                     slash); http://host.docker.internal:3000 locally.
--   * `cron_secret` — the SAME value as Vercel's CRON_SECRET. Rotate both
--                     together, or the sweep answers 401 every two minutes.
--   Locally, supabase/seed.sql plants placeholders on `db reset` (the bearer
--   is deliberately not a real secret — set .env.local's CRON_SECRET to the
--   same string to exercise the sweep locally). On hosted they were created
--   through the dashboard (Integrations → Vault).
--
-- APPLY-TIME vs RUN-TIME — THE LESSON THIS FILE CARRIES. The first cut of
-- this migration refused to APPLY unless both secrets existed, and CI proved
-- that wrong within twenty minutes of the push: `supabase start` on a fresh
-- runner applies every migration before anything else can run, there is no
-- hook in which to create a Vault row first, so `rls` and `e2e` both died at
-- 0103 — and a restore drill into a new project (where Vault rows cannot be
-- decrypted, the key being the project's) would have hit the same wall.
-- A migration must not need run-time configuration to apply. So: the apply
-- needs nothing (it WARNS when the secrets are absent), and the ABSENCE is
-- loud where it matters — `enquiry_alerts_sweep()` raises naming the missing
-- secret, the run is recorded `failed` in cron.job_run_details, and the
-- admin dashboard's cron-health card shows the job amber within the hour
-- (the sub-daily allowance: six intervals, floored at one hour). The
-- explicit checks matter: a NULL url would have failed pg_net's not-null
-- constraint on its own, but a NULL bearer would have posted
-- `Authorization: null` and answered 401 silently, every two minutes,
-- forever. scripts/backup/verify-restore.sql asserts both rows after a
-- restore.
--
-- PINS THAT MOVED WITH IT (tests/unit/cron-jobs-pinned.test.ts derives the
-- count from these files and fails when one is left behind):
--   EXPECTED_CRON_JOBS (lib/services/cron-health.ts) 10 → 11 · RLS test 50 ·
--   scripts/backup/verify-restore.sql (the cron list, the grants row, the
--   Vault row, the migrations pin) · docs/10's table · HANDOFF §0's Cron row.
--
-- Idempotent: `create extension if not exists`, `create or replace function`,
-- and cron.schedule() by name replaces the existing job's command and
-- schedule rather than adding a second one (measured on the local stack:
-- re-running the file leaves eleven jobs). The grants are re-asserted.
-- =============================================================================

create extension if not exists pg_net with schema extensions;

-- The job body. SECURITY INVOKER on purpose: it reads Vault as whoever runs
-- it — postgres under pg_cron, service_role from a rehearsal — and nobody
-- else may execute it at all (the grants below, asserted by the self-test
-- and pinned by the restore pack). The two names are parameters only so a
-- test can prove the refusal path without touching the real rows.
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

  -- no ?limit=: the route's own ceiling is what its budget fits (review B —
  -- ten never fitted sixty seconds at eight seconds a send)
  return net.http_post(
    url     := rtrim(v_url, '/') || '/api/internal/enquiry-alerts',
    headers := jsonb_build_object(
                 'Authorization', 'Bearer ' || v_bearer,
                 'Content-Type',  'application/json'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
end
$fn$;

comment on function public.enquiry_alerts_sweep(text, text) is
  '0103: the body of the enquiry-alerts cron job — reads crm_url and cron_secret from Vault and POSTs /api/internal/enquiry-alerts through pg_net; raises naming the missing secret. postgres (pg_cron) and service_role only.';

revoke execute on function public.enquiry_alerts_sweep(text, text) from public, anon, authenticated;
grant  execute on function public.enquiry_alerts_sweep(text, text) to service_role;

-- (name and schedule on the cron.schedule line itself: tests/unit/
-- cron-jobs-pinned.test.ts derives the expected job count by scanning
-- migrations for `cron.schedule('<name>'`, and the prepared copy had them on
-- the next line — the test read ten jobs against a pin of eleven.)
select cron.schedule('enquiry-alerts', '*/2 * * * *', $$select public.enquiry_alerts_sweep()$$);

-- Apply-time assertions, in the 0084 idiom. Nothing here needs a secret.
do $$
declare n int;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise exception '0103 aborted: pg_net is not installed';
  end if;
  if has_function_privilege('anon', 'public.enquiry_alerts_sweep(text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.enquiry_alerts_sweep(text,text)', 'execute') then
    raise exception '0103 aborted: enquiry_alerts_sweep must not be callable by anon or authenticated';
  end if;
  if not has_function_privilege('service_role', 'public.enquiry_alerts_sweep(text,text)', 'execute') then
    raise exception '0103 aborted: service_role must be able to rehearse enquiry_alerts_sweep';
  end if;
  if not exists (select 1 from cron.job
                  where jobname = 'enquiry-alerts' and schedule = '*/2 * * * *'
                    and command like '%enquiry_alerts_sweep()%') then
    raise exception '0103 aborted: enquiry-alerts is not scheduled every two minutes on enquiry_alerts_sweep()';
  end if;
  select count(*) into n from cron.job;
  if n <> 11 then raise exception '0103 aborted: expected eleven cron jobs, found %', n; end if;

  if not exists (select 1 from vault.decrypted_secrets where name = 'cron_secret')
     or not exists (select 1 from vault.decrypted_secrets where name = 'crm_url') then
    raise warning '0103: Vault secrets crm_url and/or cron_secret are ABSENT — enquiry-alerts is scheduled and will FAIL every two minutes (cron_health shows it amber within the hour) until both exist; see the header';
  else
    raise notice '0103: enquiry-alerts sweep scheduled every two minutes through pg_net; URL and bearer from Vault (both present).';
  end if;
end $$;
