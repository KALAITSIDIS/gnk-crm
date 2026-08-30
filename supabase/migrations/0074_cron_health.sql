-- 0074 — cron_health(): the sweeps get a witness (audit 2026-08-29, REL-03).
--
-- Eight pg_cron jobs drive mandate expiry, nudges, reservation expiry and
-- warnings, instalment reminders, chain verification (nightly incremental +
-- weekly full walk) and monthly partition pre-creation — and NOTHING read
-- cron.job_run_details. A job that started failing, or a scheduler that
-- stopped entirely (the KNOWN post-restore state: §4b.4, all jobs absent),
-- was invisible until a mandate silently failed to expire or someone
-- happened to notice the chain badge's date ageing. The audit called it:
-- "who notices the 03:30 sweep?" Nobody did.
--
-- THE FUNCTION RETURNS FACTS, NOT VERDICTS. Schedules differ — nightly jobs
-- should have succeeded within ~26h, the Sunday full walk within ~8 days,
-- the monthly partition job within ~32 days — and encoding that arithmetic
-- in SQL would bury it where no unit test reaches. So this returns (job,
-- schedule, active, last run, last success) per job and
-- lib/services/cron-health.ts owns the per-schedule allowance, where it is
-- pinned by tests. The admin dashboard renders the verdict; the chain badge
-- separately gains a staleness state in the same change.
--
-- SECURITY DEFINER because cron.job_run_details belongs to the job owner
-- (postgres); EXECUTE is service_role-ONLY — the dashboard reaches it through
-- createAdminClient() from the admin-gated page branch, the
-- raise_key_recall_tasks precedent. Not because the data is sensitive
-- (jobnames and timestamps), but because the anon-default-EXECUTE hazard has
-- bitten this repo twice and the reflex is revoke-first.
--
-- Additive: hosted before the merge. Pre-0074 code never calls it.

create or replace function public.cron_health()
returns table (
  jobname      text,
  schedule     text,
  active       boolean,
  last_start   timestamptz,
  last_status  text,
  last_success timestamptz
)
language sql stable security definer set search_path = public as $$
  select j.jobname::text, j.schedule::text, j.active,
         d.start_time, d.status::text, s.start_time
    from cron.job j
    left join lateral (
      select r.start_time, r.status
        from cron.job_run_details r
       where r.jobid = j.jobid
       order by r.start_time desc
       limit 1
    ) d on true
    left join lateral (
      select r.start_time
        from cron.job_run_details r
       where r.jobid = j.jobid and r.status = 'succeeded'
       order by r.start_time desc
       limit 1
    ) s on true
   order by j.jobname;
$$;

comment on function public.cron_health() is
  'Per-job pg_cron facts: schedule, active flag, last run, last SUCCESSFUL '
  'run. Verdicts (is this job overdue for its schedule?) live in '
  'lib/services/cron-health.ts where they are unit-tested. service_role '
  'only; the admin dashboard calls it through the admin client. A job with '
  'last_success NULL has never succeeded — the post-restore state until the '
  'jobs are recreated from migrations (BACKUP_RESTORE §4b.4).';

revoke execute on function public.cron_health() from public, anon, authenticated;
grant  execute on function public.cron_health() to service_role;

do $$
declare
  n int;
begin
  if has_function_privilege('anon', 'public.cron_health()', 'execute') then
    raise exception '0074 aborted: cron_health is callable by anon';
  end if;
  if has_function_privilege('authenticated', 'public.cron_health()', 'execute') then
    raise exception '0074 aborted: cron_health is callable by authenticated — the T-C4 lesson, at write time';
  end if;
  if not has_function_privilege('service_role', 'public.cron_health()', 'execute') then
    raise exception '0074 aborted: service_role cannot call cron_health — the dashboard would be blind';
  end if;

  -- All eight jobs exist by 0063, so the function must see exactly eight on
  -- any migration-built database. A different count on a future apply means
  -- a job was added or lost without this file learning about it.
  select count(*) into n from public.cron_health();
  if n <> 8 then
    raise exception '0074 aborted: cron_health sees % job(s), expected 8', n;
  end if;

  raise notice '0074: cron_health() live — 8 jobs visible, service_role only';
end $$;
