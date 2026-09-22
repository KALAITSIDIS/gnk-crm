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
 *   day-of-week set    ("35 3 * * 0")    → weekly    → 8 days
 *   day-of-month set   ("20 3 1 * *")    → monthly   → 32 days
 *   hour unrestricted  ("[*]/10 * * * *")  → sub-daily → 6 intervals, min 1 hour
 *   otherwise          ("0 3 * * *")     → daily     → 26 hours
 *
 * THE SUB-DAILY BRANCH WAS MISSING, AND THE TENTH JOB NEEDED IT. Every job here
 * was nightly, weekly or monthly until 0098 scheduled `lead-sla` every ten
 * minutes on 2026-09-15 — the sweep that raises a `lead_unanswered` task when a
 * website enquiry goes an hour without a reply. It fell through to the daily
 * fallback, so the dashboard called it healthy for twenty-six hours: measured,
 * a sweep whose last success was 25 hours old — about 150 missed runs — came
 * back `{healthy: true, reason: null}`. The one panel whose whole job is
 * noticing silence was deaf to the one job that is supposed to be noisy.
 *
 * Six intervals of headroom, never under an hour: loose enough that a slow
 * night or one failed run does not cry wolf, tight enough that a stopped
 * scheduler is caught within the hour instead of the next day. Same shape as
 * the rest — Period + Grace, not exactness.
 */
export function allowanceMs(schedule: string): number {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length === 5) {
    const [minute, hour, dayOfMonth, , dayOfWeek] = fields;
    if (dayOfWeek !== "*") return 8 * 24 * HOUR;
    if (dayOfMonth !== "*") return 32 * 24 * HOUR;
    /* An unrestricted HOUR field is what makes a job sub-daily: it runs in
       every hour of every day. A RESTRICTED hour is daily however busy its
       minute field looks ("0,30 3 * * *" runs twice, at 03:00 and 03:30), so
       that falls through to the 26 hours below. */
    if (hour === "*") {
      const everyNMinutes = /^\*\/(\d+)$/.exec(minute ?? "");
      const intervalMs = everyNMinutes
        ? Math.max(1, Number(everyNMinutes[1])) * 60_000
        : minute === "*"
          ? 60_000 // every minute
          : HOUR; // a fixed minute of every hour
      return Math.max(HOUR, 6 * intervalMs);
    }
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

/**
 * How many scheduled jobs the migrations define — the number the dashboard's
 * banner compares against. ONE place, pinned to the migrations by
 * tests/unit/cron-jobs-pinned.test.ts, because the literal that used to live in
 * the component went stale the day 0092 scheduled the ninth job and production
 * read "expected 8 jobs, found 9" on the card whose purpose is to be believed.
 */
export const EXPECTED_CRON_JOBS = 12;

export function chainCheckIsStale(checkedAt: string | null, now: Date): boolean {
  if (!checkedAt) return true;
  return now.getTime() - new Date(checkedAt).getTime() > CHAIN_CHECK_STALE_MS;
}
