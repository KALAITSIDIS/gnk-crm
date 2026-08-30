/**
 * Verdicts over cron_health() facts (0074, audit REL-03).
 *
 * The SQL returns per-job facts; THIS file owns "is that healthy?", because
 * the answer depends on each job's schedule and that arithmetic belongs where
 * unit tests reach it. A nightly job that has not succeeded in ~26 hours is
 * late; the Sunday full chain walk is only late after ~8 days; the monthly
 * partition pre-create after ~32. One flat threshold would either false-alarm
 * on the quiet jobs every week or leave the nightly ones un-alarmed for days.
 *
 * The allowances deliberately echo the dead-man's switch: Period + Grace with
 * headroom, not exactness. This surface exists to catch a STOPPED scheduler
 * (the known post-restore state, §4b.4) and a persistently failing job — not
 * to page anyone about a single slow night, which healthchecks already covers.
 */

export interface CronJobFacts {
  jobname: string;
  schedule: string;
  active: boolean;
  last_start: string | null;
  last_status: string | null;
  last_success: string | null;
}

export interface CronVerdict {
  jobname: string;
  healthy: boolean;
  reason: string | null; // null when healthy
}

const HOUR = 3_600_000;

/**
 * How long a job may go without a SUCCESS before it is unhealthy, derived
 * from its cron expression's shape:
 *   day-of-week set   (e.g. "35 3 * * 0")  → weekly  → 8 days
 *   day-of-month set  (e.g. "20 3 1 * *")  → monthly → 32 days
 *   otherwise         (e.g. "0 3 * * *")   → daily   → 26 hours
 */
export function allowanceMs(schedule: string): number {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length === 5) {
    const [, , dayOfMonth, , dayOfWeek] = fields;
    if (dayOfWeek !== "*") return 8 * 24 * HOUR;
    if (dayOfMonth !== "*") return 32 * 24 * HOUR;
  }
  return 26 * HOUR;
}

export function judgeJob(job: CronJobFacts, now: Date): CronVerdict {
  if (!job.active) {
    return { jobname: job.jobname, healthy: false, reason: "job is deactivated" };
  }
  if (!job.last_success) {
    // never succeeded — the post-restore state, or a job broken since birth
    return {
      jobname: job.jobname,
      healthy: false,
      reason: job.last_start ? `never succeeded (last run: ${job.last_status ?? "unknown"})` : "has never run",
    };
  }
  const age = now.getTime() - new Date(job.last_success).getTime();
  if (age > allowanceMs(job.schedule)) {
    const days = age / (24 * HOUR);
    return {
      jobname: job.jobname,
      healthy: false,
      reason: `last success ${days >= 2 ? `${Math.floor(days)} days` : `${Math.round(age / HOUR)}h`} ago`,
    };
  }
  return { jobname: job.jobname, healthy: true, reason: null };
}

export function judgeAll(jobs: CronJobFacts[], now: Date): CronVerdict[] {
  return jobs.map((j) => judgeJob(j, now));
}

/** The chain badge's own staleness rule (reports page): a verification result
 *  older than this is not evidence of the present. 48h = one missed nightly
 *  plus a full day of nobody noticing. */
export const CHAIN_CHECK_STALE_MS = 48 * HOUR;

export function chainCheckIsStale(checkedAt: string | null, now: Date): boolean {
  if (!checkedAt) return true;
  return now.getTime() - new Date(checkedAt).getTime() > CHAIN_CHECK_STALE_MS;
}
