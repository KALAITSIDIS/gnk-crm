import { describe, expect, it } from "vitest";
import {
  CHAIN_CHECK_STALE_MS,
  allowanceMs,
  chainCheckIsStale,
  judgeJob,
} from "./cron-health";

/**
 * REL-03: the verdict arithmetic lives HERE so it can be pinned — one flat
 * threshold would false-alarm the weekly/monthly jobs or under-alarm the
 * nightly ones, and either failure teaches the operator to ignore the panel.
 */
const NOW = new Date("2026-08-30T12:00:00Z");
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const base = {
  jobname: "expire-mandates",
  schedule: "0 3 * * *",
  active: true,
  last_start: ago(9 * HOUR),
  last_status: "succeeded",
  last_success: ago(9 * HOUR),
};

describe("cron allowances follow the schedule's shape", () => {
  it("nightly jobs get ~26h — one missed night alarms, one slow one does not", () => {
    expect(allowanceMs("0 3 * * *")).toBe(26 * HOUR);
    expect(allowanceMs("55 3 * * *")).toBe(26 * HOUR);
  });
  it("the Sunday full walk gets ~8 days, the monthly partition job ~32", () => {
    expect(allowanceMs("35 3 * * 0")).toBe(8 * 24 * HOUR); // verify-events-chain-full
    expect(allowanceMs("20 3 1 * *")).toBe(32 * 24 * HOUR); // ensure-events-partitions
  });
});

describe("judgeJob", () => {
  it("a nightly job that succeeded this morning is healthy", () => {
    expect(judgeJob(base, NOW)).toEqual({ jobname: "expire-mandates", healthy: true, reason: null });
  });

  it("a nightly job whose last success is 30h old is unhealthy — one missed night", () => {
    const v = judgeJob({ ...base, last_success: ago(30 * HOUR) }, NOW);
    expect(v.healthy).toBe(false);
    expect(v.reason).toContain("30h");
  });

  it("the weekly walk 6 days after Sunday is still healthy — no false alarm", () => {
    const v = judgeJob(
      { ...base, jobname: "verify-events-chain-full", schedule: "35 3 * * 0", last_success: ago(6 * 24 * HOUR) },
      NOW,
    );
    expect(v.healthy).toBe(true);
  });

  it("a job that has NEVER succeeded is unhealthy — the post-restore state", () => {
    const v = judgeJob({ ...base, last_start: null, last_status: null, last_success: null }, NOW);
    expect(v.healthy).toBe(false);
    expect(v.reason).toBe("has never run");
  });

  it("a job that runs but keeps failing says so, not just 'late'", () => {
    const v = judgeJob({ ...base, last_status: "failed", last_success: null }, NOW);
    expect(v.healthy).toBe(false);
    expect(v.reason).toContain("never succeeded");
    expect(v.reason).toContain("failed");
  });

  it("a deactivated job is unhealthy even with a recent success", () => {
    expect(judgeJob({ ...base, active: false }, NOW).reason).toBe("job is deactivated");
  });
});

describe("chain badge staleness (the reports page's amber state)", () => {
  it("a fresh check is not stale; a 3-day-old one is; a missing one is", () => {
    expect(chainCheckIsStale(ago(10 * HOUR), NOW)).toBe(false);
    expect(chainCheckIsStale(ago(3 * 24 * HOUR), NOW)).toBe(true);
    expect(chainCheckIsStale(null, NOW)).toBe(true);
  });
  it("the threshold is one missed nightly plus a day of nobody noticing", () => {
    expect(CHAIN_CHECK_STALE_MS).toBe(48 * HOUR);
  });
});
