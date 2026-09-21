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
-- secrets were created by hand, and only then did this file move here. The
-- self-test at the bottom refuses to run without the secrets, so a database
-- that lacks them (a fresh restore, another developer's stack) stops at this
-- migration with the remedy in the error text rather than scheduling a job
-- that posts an empty bearer every two minutes.
--
-- WHAT IT DOES. Every two minutes, POST the sweep route
-- (/api/internal/enquiry-alerts, docs/10 §2 "The desk-alert sweep") with the
-- bearer secret. pg_net is asynchronous: the call returns a request id and
-- the response lands in net._http_response, so a failing route does not block
-- the scheduler. The worker claims at most what the route's 45-second budget
-- fits — four rows at the provider's 8-second worst case (review B) — and
-- hands back unattempted whatever a slow batch cannot reach. Between the
-- enquiry route's after() accelerator and this, a retry lands within two
-- minutes of its scheduled time and the whole eight-attempt budget completes
-- inside ~2h07m — well inside the 20-hour key window the claim enforces
-- (0102). Until this job the sweep was reached only by the daily Vercel cron
-- in vercel.json (Hobby allows once a day) and by hand.
--
-- WHAT IT NEEDS — two Vault secrets, read at RUN time. Nothing here, and
-- nothing in cron.job's command text, holds a value; `vault.decrypted_secrets`
-- is readable by postgres, which is what pg_cron runs as.
--   * `crm_url`     — https://gnk-crm.vercel.app on hosted (no trailing
--                     slash); http://host.docker.internal:3000 locally.
--   * `cron_secret` — the SAME value as Vercel's CRON_SECRET. Rotate both
--                     together, or the sweep answers 401 every two minutes.
--   Locally, before `supabase migration up`:
--     select vault.create_secret('<the CRON_SECRET value>', 'cron_secret');
--     select vault.create_secret('http://host.docker.internal:3000', 'crm_url');
--   On hosted they were created through the dashboard (Integrations → Vault).
--
-- PINS THAT MOVED WITH IT (tests/unit/cron-jobs-pinned.test.ts derives the
-- count from these files and fails when one is left behind):
--   EXPECTED_CRON_JOBS (lib/services/cron-health.ts) 10 → 11 · RLS test 50 ·
--   scripts/backup/verify-restore.sql (the cron list and the migrations pin) ·
--   docs/10's pg_cron table · HANDOFF §0's Cron row.
--
-- `cron_health()` watches it like the other ten: the sub-daily branch in
-- lib/services/cron-health.ts allows 6 intervals (12 minutes, floored to
-- 1 hour) before the dashboard shows it amber.
--
-- Idempotent: `create extension if not exists`, and cron.schedule() by name
-- replaces the existing job's command and schedule rather than adding a
-- second one (measured on the local stack: re-running leaves eleven jobs).
-- =============================================================================

create extension if not exists pg_net with schema extensions;

-- (name and schedule on the cron.schedule line itself: tests/unit/
-- cron-jobs-pinned.test.ts derives the expected job count by scanning
-- migrations for `cron.schedule('<name>'`, and the prepared copy had them on
-- the next line — the test read ten jobs against a pin of eleven.)
select cron.schedule('enquiry-alerts', '*/2 * * * *', $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'crm_url')
               -- no ?limit=: the route's own ceiling is what its budget fits (review B —
               -- ten never fitted sixty seconds at eight seconds a send)
               || '/api/internal/enquiry-alerts',
    headers := jsonb_build_object(
                 'Authorization',
                 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'),
                 'Content-Type', 'application/json'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 55000
  )
  $$
);

-- Apply-time assertions, in the 0084 idiom.
do $$
declare n int;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise exception '0103 aborted: pg_net is not installed';
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'cron_secret')
     or not exists (select 1 from vault.decrypted_secrets where name = 'crm_url') then
    raise exception '0103 aborted: create the cron_secret and crm_url Vault secrets first (see the header)';
  end if;
  if not exists (select 1 from cron.job where jobname = 'enquiry-alerts' and schedule = '*/2 * * * *') then
    raise exception '0103 aborted: enquiry-alerts is not scheduled every two minutes';
  end if;
  select count(*) into n from cron.job;
  if n <> 11 then raise exception '0103 aborted: expected eleven cron jobs, found %', n; end if;
  raise notice '0103: enquiry-alerts sweep scheduled every two minutes through pg_net; secret and URL from Vault.';
end $$;
