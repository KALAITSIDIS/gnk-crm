import type { CronVerdict } from "@/lib/services/cron-health";

/**
 * Verdicts over `enquiry_alert_sweep_health()` (0105, audit 2026-09-21
 * finding 3): whether the desk-alert sweep is actually WORKING, as opposed
 * to being scheduled.
 *
 * WHY cron_health() IS NOT ENOUGH FOR THIS JOB. `enquiry-alerts` (0103) is a
 * pg_cron job whose body queues an HTTP request through pg_net. pg_cron
 * records the run `succeeded` the moment the request is queued — measured on
 * production: 0.03 s, every time — and the route's real answer (200 with the
 * worker's counts, 401 because the bearer moved, 503 because the queue could
 * not be reached, a timeout, nothing at all) lands in `net._http_response`,
 * which nothing read and which pg_net purges after six hours. The card was
 * green for as long as requests were being queued. 0105 reconciles those
 * answers into `enquiry_alert_sweep_runs` and summarises them; this file
 * turns the summary into the one line the admin reads.
 *
 * THRESHOLDS, in two-minute units. The job runs every two minutes; a lead
 * unanswered for an hour raises a task (0098), so the desk alert has to be
 * on time in minutes, not hours:
 *   - silence: no COMPLETED run for 15 minutes (~7 misses) — one slow or
 *     failed run does not alarm, a stopped worker does within the quarter;
 *   - a streak: three failures in a row, whatever the kind;
 *   - responses missing: three requests queued without any answer;
 *   - overdue alerts: any desk-alert row still due 10 minutes after its
 *     time, with the oldest's age — the product-facing failure, alarmed
 *     whatever the runs say;
 *   - an unconfigured provider is never "healthy": a 200 that says
 *     `skipped: unconfigured` proves the route runs and nothing else.
 * An empty queue completed (`ok`, claimed 0) is the normal healthy state.
 */
export interface SweepHealthFacts {
  last_queued_at: string | null;
  /** the last run whose worker COMPLETED (ok, an empty queue included) */
  last_ok_at: string | null;
  /** the outcome of the most recently resolved run */
  last_outcome: string | null;
  last_resolved_at: string | null;
  /** resolved runs since the last completed one, newest first */
  consecutive_failures: number;
  /** requests past the grace period with no answer yet */
  queued_unresolved: number;
  runs_last_hour: number;
  /** desk-alert rows still due OVERDUE_JOB_MINUTES after their time */
  overdue_jobs: number;
  oldest_overdue_minutes: number | null;
  pending_jobs: number;
}

export interface SweepVerdict {
  healthy: boolean;
  reason: string | null;
}

const MIN = 60_000;

export const SWEEP_INTERVAL_MS = 2 * MIN;
/** No completed run for this long is a stopped worker, not a slow night. */
export const SWEEP_SILENCE_ALLOWANCE_MS = 15 * MIN;
export const SWEEP_FAILURE_STREAK = 3;
export const SWEEP_MISSING_RESPONSES = 3;
/** Mirrors the default of enquiry_alert_sweep_health(p_overdue_minutes). */
export const OVERDUE_JOB_MINUTES = 10;

export function judgeSweep(facts: SweepHealthFacts | null, now: Date): SweepVerdict {
  if (!facts) return { healthy: false, reason: "sweep outcomes unreadable" };
  if (!facts.last_queued_at) return { healthy: false, reason: "no sweep run recorded" };

  if (facts.overdue_jobs > 0) {
    const oldest = facts.oldest_overdue_minutes ?? OVERDUE_JOB_MINUTES;
    return {
      healthy: false,
      reason: `${facts.overdue_jobs} desk alert${facts.overdue_jobs === 1 ? "" : "s"} overdue, oldest ${oldest} min`,
    };
  }
  if (facts.last_outcome === "unconfigured") {
    return { healthy: false, reason: "provider unconfigured — the sweep runs but no alert can be sent" };
  }
  if (facts.consecutive_failures >= SWEEP_FAILURE_STREAK) {
    return { healthy: false, reason: `last ${facts.consecutive_failures} runs failed (${facts.last_outcome ?? "unknown"})` };
  }
  if (facts.queued_unresolved >= SWEEP_MISSING_RESPONSES) {
    return { healthy: false, reason: `${facts.queued_unresolved} runs without a response` };
  }
  if (!facts.last_ok_at) return { healthy: false, reason: "no completed run yet" };
  const silence = now.getTime() - new Date(facts.last_ok_at).getTime();
  if (Number.isNaN(silence) || silence > SWEEP_SILENCE_ALLOWANCE_MS) {
    return { healthy: false, reason: `no completed run for ${Math.round(silence / MIN)} min` };
  }
  return { healthy: true, reason: null };
}

/**
 * Fold the worker's verdict into pg_cron's for the one job it concerns: a
 * red scheduler stays red (its reason first — a stopped scheduler is the
 * bigger fact), a green scheduler with a red worker turns red with the
 * worker's reason. Other jobs are untouched, and a job pg_cron does not
 * list is not invented.
 */
export function applySweepVerdict(verdicts: CronVerdict[], sweep: SweepVerdict, jobname = "enquiry-alerts"): CronVerdict[] {
  return verdicts.map((v) => {
    if (v.jobname !== jobname || !v.healthy || sweep.healthy) return v;
    return { jobname: v.jobname, healthy: false, reason: sweep.reason ?? "worker unhealthy" };
  });
}
