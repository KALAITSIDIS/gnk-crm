-- =============================================================================
-- 0102 (PREPARED, NOT APPLIED) — the desk-alert sweep every two minutes,
--        from the database, through pg_net
--
-- THIS FILE IS NOT UNDER supabase/migrations/ ON PURPOSE. It installs an
-- extension on the hosted project (`pg_net` — available there, not
-- installed), and enabling an extension on production is the operator's
-- decision (BACKLOG: "Lead SLA e-mail escalation — NEEDS AN OPERATOR
-- DECISION", the same decision). Until it is taken, the sweep is reached by
-- the daily Vercel cron in vercel.json and by hand (docs/10 §2, "The
-- desk-alert sweep").
--
-- WHEN APPROVED:
--   1. In the Supabase dashboard (hosted): Project Settings → Vault → add a
--      secret named `cron_secret` holding the SAME value as Vercel's
--      CRON_SECRET, and one named `crm_url` holding
--      https://gnk-crm.vercel.app (no trailing slash). Locally:
--        select vault.create_secret('<value>', 'cron_secret');
--        select vault.create_secret('http://host.docker.internal:3000', 'crm_url');
--   2. Move this file to supabase/migrations/ under the next free number
--      (check every other worktree's supabase/migrations first — HANDOFF).
--   3. It becomes the ELEVENTH cron job: bump EXPECTED_CRON_JOBS
--      (lib/services/cron-health.ts), RLS test 50, the cron list in
--      scripts/backup/verify-restore.sql, docs/10's table and HANDOFF §0's
--      Cron row. tests/unit/cron-jobs-pinned.test.ts fails until you do.
--   4. Apply to hosted per HANDOFF §3 (separate calls, verify separately,
--      then get_advisors), BEFORE the merge, as always.
--
-- WHAT IT DOES. Every two minutes, POST the sweep route with the bearer
-- secret. pg_net is asynchronous: the call returns a request id and the
-- response lands in net._http_response, so a failing route does not block
-- the scheduler. The worker claims at most `limit` rows per call (the query
-- string below asks for 10 — twice the route's default, half its ceiling).
-- Between the route's after() accelerator and this, a retry lands within two
-- minutes of its scheduled time and the whole eight-attempt budget completes
-- inside ~2h07m — inside the provider's 24-hour memory of the key.
--
-- `cron_health()` will watch it like the other ten: the sub-daily branch in
-- lib/services/cron-health.ts allows 6 intervals (12 minutes, floor 1 hour)
-- before it shows amber.
-- =============================================================================

create extension if not exists pg_net with schema extensions;

-- The secret is read from Vault at run time: nothing here, and nothing in
-- cron.job's command text, holds it. `vault.decrypted_secrets` is readable
-- by postgres, which is what pg_cron runs as.
select cron.schedule(
  'enquiry-alerts',
  '*/2 * * * *',
  $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'crm_url')
               || '/api/internal/enquiry-alerts?limit=10',
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
    raise exception '0102 aborted: pg_net is not installed';
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'cron_secret')
     or not exists (select 1 from vault.decrypted_secrets where name = 'crm_url') then
    raise exception '0102 aborted: create the cron_secret and crm_url Vault secrets first (see the header)';
  end if;
  if not exists (select 1 from cron.job where jobname = 'enquiry-alerts' and schedule = '*/2 * * * *') then
    raise exception '0102 aborted: enquiry-alerts is not scheduled every two minutes';
  end if;
  select count(*) into n from cron.job;
  if n <> 11 then raise exception '0102 aborted: expected eleven cron jobs, found %', n; end if;
  raise notice '0102: enquiry-alerts sweep scheduled every two minutes through pg_net; secret and URL from Vault.';
end $$;
