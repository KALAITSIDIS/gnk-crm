import { describe, expect, it } from "vitest";
import type { CronVerdict } from "./cron-health";
import {
  applySweepVerdict,
  judgeSweep,
  OVERDUE_JOB_MINUTES,
  SWEEP_FAILURE_STREAK,
  SWEEP_SILENCE_ALLOWANCE_MS,
  type SweepHealthFacts,
} from "./enquiry-alert-sweep-health";

/**
 * 0105 (audit 2026-09-21, finding 3): the cron-health card judged the
 * `enquiry-alerts` job by `cron.job_run_details`, where every run reads
 * `succeeded` — pg_cron only sees that `net.http_post` QUEUED a request.
 * Whether the sweep route then answered 200, 401, 503, timed out or never
 * answered was invisible; the card could stay green while the worker failed
 * every two minutes. These verdicts read the reconciled outcomes instead.
 *
 * Facts come from `enquiry_alert_sweep_health()`; the arithmetic lives here
 * so a controlled clock can reach every branch.
 */
const NOW = new Date("2026-09-22T10:00:00Z");
const MIN = 60_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const healthyFacts: SweepHealthFacts = {
  last_queued_at: ago(1 * MIN),
  last_ok_at: ago(1 * MIN),
  last_outcome: "ok",
  last_resolved_at: ago(1 * MIN),
  consecutive_failures: 0,
  queued_unresolved: 0,
  runs_last_hour: 30,
  overdue_jobs: 0,
  oldest_overdue_minutes: null,
  pending_jobs: 0,
};

describe("judgeSweep — what the worker actually did, not whether a request was queued", () => {
  it("a run that completed with an empty queue is HEALTHY: nothing due is a valid state", () => {
    expect(judgeSweep(healthyFacts, NOW)).toEqual({ healthy: true, reason: null });
  });

  it("no facts at all, or no run ever recorded, is unhealthy — the card must never be green by absence", () => {
    expect(judgeSweep(null, NOW).healthy).toBe(false);
    const never = judgeSweep({ ...healthyFacts, last_queued_at: null, last_ok_at: null, last_outcome: null }, NOW);
    expect(never.healthy).toBe(false);
    expect(never.reason).toContain("no sweep run");
  });

  it("three 401s in a row: the bearer is wrong, and the card says so even though every run 'succeeded'", () => {
    const v = judgeSweep(
      { ...healthyFacts, last_ok_at: ago(8 * MIN), last_outcome: "unauthorized", consecutive_failures: 3 },
      NOW,
    );
    expect(v.healthy).toBe(false);
    expect(v.reason).toContain("unauthorized");
    expect(v.reason).toContain("3");
  });

  it("three 503s in a row: the worker cannot reach its queue", () => {
    const v = judgeSweep(
      { ...healthyFacts, last_ok_at: ago(8 * MIN), last_outcome: "worker_failed", consecutive_failures: 3 },
      NOW,
    );
    expect(v.healthy).toBe(false);
    expect(v.reason).toContain("worker_failed");
  });

  it("three timeouts in a row is a failure streak like any other", () => {
    const v = judgeSweep(
      { ...healthyFacts, last_ok_at: ago(8 * MIN), last_outcome: "timeout", consecutive_failures: SWEEP_FAILURE_STREAK },
      NOW,
    );
    expect(v.healthy).toBe(false);
    expect(v.reason).toContain("timeout");
  });

  it("a malformed 'success' — a 200 whose body is not the worker's — counts as a failure", () => {
    const v = judgeSweep(
      { ...healthyFacts, last_ok_at: ago(8 * MIN), last_outcome: "malformed", consecutive_failures: 3 },
      NOW,
    );
    expect(v.healthy).toBe(false);
    expect(v.reason).toContain("malformed");
  });

  it("ONE failure with a completed run just before it does not cry wolf", () => {
    const v = judgeSweep({ ...healthyFacts, last_ok_at: ago(3 * MIN), last_outcome: "worker_failed", consecutive_failures: 1 }, NOW);
    expect(v.healthy).toBe(true);
  });

  it("requests queued without any response are unhealthy once there are several", () => {
    const v = judgeSweep({ ...healthyFacts, last_ok_at: ago(9 * MIN), queued_unresolved: 3 }, NOW);
    expect(v.healthy).toBe(false);
    expect(v.reason).toContain("without a response");
    expect(judgeSweep({ ...healthyFacts, queued_unresolved: 1 }, NOW).healthy).toBe(true);
  });

  it("an unconfigured provider is NOT proof that alerts can be sent — unhealthy even with 200s", () => {
    const v = judgeSweep({ ...healthyFacts, last_outcome: "unconfigured", last_ok_at: ago(20 * MIN) }, NOW);
    expect(v.healthy).toBe(false);
    expect(v.reason).toContain("unconfigured");
  });

  it("silence: no completed run inside the allowance is unhealthy, inside it is not", () => {
    const quiet = judgeSweep(
      { ...healthyFacts, last_ok_at: ago(SWEEP_SILENCE_ALLOWANCE_MS + MIN), last_queued_at: ago(SWEEP_SILENCE_ALLOWANCE_MS + MIN) },
      NOW,
    );
    expect(quiet.healthy).toBe(false);
    expect(quiet.reason).toContain("no completed run");
    expect(judgeSweep({ ...healthyFacts, last_ok_at: ago(SWEEP_SILENCE_ALLOWANCE_MS - MIN) }, NOW).healthy).toBe(true);
    // the allowance is a handful of missed two-minute runs, not an hour
    expect(SWEEP_SILENCE_ALLOWANCE_MS).toBeLessThanOrEqual(20 * MIN);
    expect(SWEEP_SILENCE_ALLOWANCE_MS).toBeGreaterThanOrEqual(10 * MIN);
  });

  it("an increasing backlog of overdue desk alerts is unhealthy whatever the runs say", () => {
    const v = judgeSweep({ ...healthyFacts, overdue_jobs: 4, oldest_overdue_minutes: 23, pending_jobs: 4 }, NOW);
    expect(v.healthy).toBe(false);
    expect(v.reason).toContain("4");
    expect(v.reason).toContain("23");
    expect(OVERDUE_JOB_MINUTES).toBe(10);
  });

  it("pending jobs that are not yet overdue are fine — the queue is allowed to have work", () => {
    expect(judgeSweep({ ...healthyFacts, pending_jobs: 2 }, NOW).healthy).toBe(true);
  });
});

describe("applySweepVerdict — the card cannot stay green because requests are being queued", () => {
  const cron: CronVerdict[] = [
    { jobname: "expire-mandates", healthy: true, reason: null },
    { jobname: "enquiry-alerts", healthy: true, reason: null },
  ];

  it("overrides a green pg_cron verdict for enquiry-alerts with the worker's own", () => {
    const out = applySweepVerdict(cron, { healthy: false, reason: "last 3 runs failed (unauthorized)" });
    expect(out.find((v) => v.jobname === "enquiry-alerts")).toEqual({
      jobname: "enquiry-alerts",
      healthy: false,
      reason: "last 3 runs failed (unauthorized)",
    });
    expect(out.find((v) => v.jobname === "expire-mandates")!.healthy, "other jobs untouched").toBe(true);
  });

  it("keeps a red pg_cron verdict (a stopped scheduler) even when the last worker outcome was fine", () => {
    const stopped: CronVerdict[] = [{ jobname: "enquiry-alerts", healthy: false, reason: "last success 25h ago" }];
    const out = applySweepVerdict(stopped, { healthy: true, reason: null });
    expect(out[0]!.healthy).toBe(false);
    expect(out[0]!.reason).toBe("last success 25h ago");
  });

  it("leaves everything alone when both agree, and does not invent the job when pg_cron lacks it", () => {
    expect(applySweepVerdict(cron, { healthy: true, reason: null })).toEqual(cron);
    expect(applySweepVerdict([cron[0]!], { healthy: false, reason: "x" })).toEqual([cron[0]]);
  });
});
