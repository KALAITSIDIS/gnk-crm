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

  it("a SUB-DAILY job gets an hour, not a day — this file had no such case", () => {
    // 0098's `lead-sla` is the only one, and every schedule tested here was
    // nightly or slower, so the daily fallback swallowed it in silence.
    expect(allowanceMs("*/10 * * * *"), "six an hour, six intervals, floored at 1h").toBe(HOUR);
    expect(allowanceMs("*/5 * * * *"), "twelve an hour, still floored at 1h").toBe(HOUR);
    expect(allowanceMs("*/30 * * * *"), "twice an hour, so 3h").toBe(3 * HOUR);
    expect(allowanceMs("* * * * *"), "every minute, floored at 1h").toBe(HOUR);
    expect(allowanceMs("0 * * * *"), "once an hour, so 6h").toBe(6 * HOUR);
  });

  it("a busy MINUTE field under a FIXED hour is still daily", () => {
    // "0,30 3 * * *" runs twice, at 03:00 and 03:30 — nightly, not sub-daily.
    // It is the hour field that decides, and reading the minute alone would
    // put every nightly job on a one-hour leash.
    expect(allowanceMs("0,30 3 * * *")).toBe(26 * HOUR);
    expect(allowanceMs("*/10 3 * * *")).toBe(26 * HOUR);
  });

  it("every schedule the migrations actually use lands in a sane band", () => {
    // The real set (tests/unit/cron-jobs-pinned.test.ts derives the COUNT from
    // the migrations; this pins the SHAPES). Nothing may fall back to a day
    // because nobody thought about it — which is exactly what lead-sla did.
    const real: Array<[string, number]> = [
      ["0 3 * * *", 26 * HOUR], // expire-mandates
      ["30 3 * * *", 26 * HOUR], // verify-events-chain
      ["15 3 * * *", 26 * HOUR], // followup-nudges
      ["45 3 * * *", 26 * HOUR], // expire-reservations
      ["50 3 * * *", 26 * HOUR], // warn-expiring-reservations
      ["55 3 * * *", 26 * HOUR], // remind-due-installments
      ["10 3 * * *", 26 * HOUR], // redact-stale-enquiries
      ["35 3 * * 0", 8 * 24 * HOUR], // verify-events-chain-full
      ["20 3 1 * *", 32 * 24 * HOUR], // ensure-events-partitions
      ["*/10 * * * *", HOUR], // lead-sla (0098)
    ];
    for (const [schedule, expected] of real) {
      expect(allowanceMs(schedule), schedule).toBe(expected);
    }
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

  it("a lead-SLA sweep silent since yesterday is UNHEALTHY — it was called healthy", () => {
    /* MEASURED BEFORE THE FIX, on this exact input: `{healthy: true, reason:
       null}`. A job that runs six times an hour had been silent for 25 hours —
       about 150 missed runs — and the panel whose job is noticing silence said
       nothing, because `*\/10 * * * *` fell through to the nightly allowance.
       The enquiry door writes the leads this sweep watches, so the failure was
       invisible on exactly the path a lead goes quiet down. */
    const sweep = {
      ...base,
      jobname: "lead-sla",
      schedule: "*/10 * * * *",
      last_start: ago(25 * HOUR),
      last_success: ago(25 * HOUR),
    };
    const v = judgeJob(sweep, NOW);
    expect(v.healthy, "25 hours of silence from a ten-minute job").toBe(false);
    expect(v.reason).toContain("25h");
  });

  it("…but an hour of it is not, so a slow run does not cry wolf", () => {
    const sweep = {
      ...base,
      jobname: "lead-sla",
      schedule: "*/10 * * * *",
      last_start: ago(50 * 60_000),
      last_success: ago(50 * 60_000),
    };
    expect(judgeJob(sweep, NOW).healthy).toBe(true);
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
