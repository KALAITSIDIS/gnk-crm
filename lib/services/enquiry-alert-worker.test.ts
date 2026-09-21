import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/nextjs";
import type { AlertSendResult, EnquiryAlert } from "./enquiry-alert";
import { KEY_SAFE_WINDOW_MS } from "./enquiry-alert-jobs";
import { DEFAULT_LEASE_SECONDS, runEnquiryAlertWorker } from "./enquiry-alert-worker";

vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn() }));

/**
 * The worker between the outbox and the provider (0101, reviewed 0102). The
 * database owns the state (supabase/tests/enquiry-alert-outbox*.test.ts prove
 * the claim, the lease, the window and the terminal states on a real stack);
 * this file pins what the worker DOES with a claimed job — which RPC it calls,
 * with which words, what it sends and when it stops — against a scripted
 * client, a scripted sender and a controlled clock, so no message ever
 * leaves and no database is needed.
 */
const REDACTED = "[erased at the contact's request]";

interface Job {
  id: string;
  org_id: string;
  lead_id: string;
  kind: string;
  state: string;
  attempts: number;
  max_attempts: number;
  key_serial: number;
  provider: string;
  first_attempted_at: string | null;
}

const T0 = new Date("2026-09-21T10:00:00Z").getTime();
const ago = (h: number) => new Date(T0 - h * 3_600_000).toISOString();

const job = (over: Partial<Job> = {}): Job => ({
  id: "job-1",
  org_id: "org-1",
  lead_id: "lead-1",
  kind: "enquiry_desk_alert",
  state: "sending",
  attempts: 1,
  max_attempts: 8,
  key_serial: 1,
  provider: "resend",
  // a claim sets the first attempt to "now" when there was none
  first_attempted_at: new Date(T0).toISOString(),
  ...over,
});

const message = [
  "Website enquiry",
  "Name: A Buyer",
  "Email: buyer@example.invalid",
  "About: PAF0001",
  "",
  "Still available?",
].join("\n");

/**
 * A client with exactly the surface the worker uses: rpc() for the claim and
 * the completion, from("leads") for the lead. Every call is recorded; every
 * answer is scripted. The legacy guard is the DATABASE's since 0102, so a
 * read of "events" here is a regression and is recorded to be asserted on.
 */
function makeClient(script: {
  claim?: Job[] | { error: { message: string; code?: string } };
  lead?: Record<string, unknown> | null;
  completeReturns?: boolean;
}) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const tablesRead: string[] = [];
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === "claim_notification_jobs") {
        const c = script.claim ?? [];
        return Array.isArray(c) ? { data: c, error: null } : { data: null, error: c.error };
      }
      if (name === "complete_notification_job") return { data: script.completeReturns ?? true, error: null };
      throw new Error("unexpected rpc " + name);
    },
    from: (table: string) => {
      tablesRead.push(table);
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      for (const m of ["select", "eq", "limit", "order"]) chain[m] = self;
      chain.maybeSingle = async () =>
        table === "leads"
          ? { data: script.lead === undefined ? { id: "lead-1", message, criteria: {} } : script.lead, error: null }
          : { data: null, error: null };
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
      return chain;
    },
  };
  return { client: client as never, rpcCalls, tablesRead };
}

const sent: Array<{ alert: EnquiryAlert; key: string | undefined }> = [];
const sender = (result: AlertSendResult) => async (a: EnquiryAlert, opts?: { idempotencyKey?: string }) => {
  sent.push({ alert: a, key: opts?.idempotencyKey });
  return result;
};

/** A clock the worker reads through deps.now, advanced by the scripted sender. */
function clock() {
  let t = T0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const completions = (calls: Array<{ name: string; args: Record<string, unknown> }>) =>
  calls.filter((c) => c.name === "complete_notification_job").map((c) => c.args);

const OLD = { ...process.env };
beforeEach(() => {
  sent.length = 0;
  vi.mocked(Sentry.captureMessage).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  process.env.RESEND_API_KEY = "re_test";
  process.env.ENQUIRY_ALERT_TO = "desk@example.invalid";
});
afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...OLD };
});

describe("arming", () => {
  it("claims nothing while the provider is not configured — the rows wait, and say so", async () => {
    delete process.env.RESEND_API_KEY;
    const { client, rpcCalls } = makeClient({ claim: [job()] });
    const run = await runEnquiryAlertWorker(client, { workerId: "w1" }, { send: sender({ outcome: "skipped" }) });
    expect(run.skipped).toBe("unconfigured");
    expect(run.error).toBeNull();
    expect(rpcCalls, "no claim: an unconfigured worker must not spend attempts").toHaveLength(0);
    expect(sent).toHaveLength(0);
  });
});

describe("the claim", () => {
  it("is made with the worker's name, the lease, the lead it was asked for, and only as many rows as the budget fits (review B)", async () => {
    const { client, rpcCalls } = makeClient({ claim: [] });
    await runEnquiryAlertWorker(
      client,
      { workerId: "route:abc", leadId: "lead-9", limit: 10, budgetMs: 45_000 },
      { send: sender({ outcome: "skipped" }), sendTimeoutMs: 8_000 },
    );
    expect(rpcCalls[0]!.name).toBe("claim_notification_jobs");
    expect(rpcCalls[0]!.args).toMatchObject({ p_worker: "route:abc", p_lead_id: "lead-9" });
    expect(rpcCalls[0]!.args.p_limit, "45 s fits four sends of 8 s + 2 s each, whatever was asked").toBe(4);
    expect(Number(rpcCalls[0]!.args.p_lease_seconds), "the lease outlives the budget").toBeGreaterThanOrEqual(
      DEFAULT_LEASE_SECONDS,
    );
  });

  it("asks for less than the budget fits when the caller wants less", async () => {
    const { client, rpcCalls } = makeClient({ claim: [] });
    await runEnquiryAlertWorker(client, { workerId: "w1", limit: 1, budgetMs: 45_000 }, { send: sender({ outcome: "skipped" }) });
    expect(rpcCalls[0]!.args.p_limit).toBe(1);
  });

  it("claims nothing at all when the budget cannot fit one worst-case send, and says so", async () => {
    const { client, rpcCalls } = makeClient({ claim: [job()] });
    const run = await runEnquiryAlertWorker(
      client,
      { workerId: "w1", budgetMs: 5_000 },
      { send: sender({ outcome: "accepted", providerMessageId: "x" }), sendTimeoutMs: 8_000 },
    );
    expect(rpcCalls, "no claim for a budget that could only strand the row").toHaveLength(0);
    expect(run.claimed).toBe(0);
    expect(run.error).toEqual({ stage: "budget", code: "too_small" });
  });

  it("a claim that ERRORS is an explicit failure, not an empty queue (review C)", async () => {
    const { client } = makeClient({ claim: { error: { message: "connection refused", code: "PGRST301" } } });
    const run = await runEnquiryAlertWorker(client, { workerId: "w1" }, { send: sender({ outcome: "skipped" }) });
    expect(run.error).toEqual({ stage: "claim", code: "PGRST301" });
    expect(run).toMatchObject({ claimed: 0, accepted: 0, retried: 0, failed: 0, cancelled: 0, released: 0 });
    expect(Sentry.captureMessage, "somebody is told the queue could not be reached").toHaveBeenCalledTimes(1);
    const ctx = JSON.stringify(vi.mocked(Sentry.captureMessage).mock.calls[0]);
    expect(ctx).toContain("PGRST301");
    expect(ctx, "the message can carry a connection string; the code cannot").not.toContain("connection refused");
  });

  it("a claim error without a code still carries a word", async () => {
    const { client } = makeClient({ claim: { error: { message: "boom" } } });
    const run = await runEnquiryAlertWorker(client, { workerId: "w1" }, { send: sender({ outcome: "skipped" }) });
    expect(run.error).toEqual({ stage: "claim", code: "unknown" });
  });

  it("an empty queue is a clean run: no error, nothing counted", async () => {
    const { client } = makeClient({ claim: [] });
    const run = await runEnquiryAlertWorker(client, { workerId: "w1" }, { send: sender({ outcome: "skipped" }) });
    expect(run.error).toBeNull();
    expect(run.claimed).toBe(0);
  });
});

describe("a claimed job", () => {
  it("is rebuilt from the lead, sent under the job's key, and completed as accepted — with no separate legacy read (review D)", async () => {
    const { client, rpcCalls, tablesRead } = makeClient({ claim: [job()] });
    const run = await runEnquiryAlertWorker(
      client,
      { workerId: "w1" },
      { send: sender({ outcome: "accepted", providerMessageId: "re_42" }) },
    );
    expect(run).toMatchObject({ claimed: 1, accepted: 1, retried: 0, failed: 0, cancelled: 0, released: 0, error: null });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.alert).toEqual({
      name: "A Buyer",
      email: "buyer@example.invalid",
      phone: null,
      propertyReference: "PAF0001",
      message: "Still available?",
      meta: null,
    });
    expect(sent[0]!.key).toBe("enquiry-desk-alert/job-1/1");
    expect(tablesRead, "the legacy closure is the claim's, in its own transaction; a lookup that can fail is gone").not.toContain(
      "events",
    );
    expect(completions(rpcCalls)[0]).toEqual({
      p_job_id: "job-1",
      p_worker: "w1",
      p_outcome: "accepted",
      p_result: "accepted",
      p_provider_message_id: "re_42",
    });
  });

  it("a transient failure is handed back for a retry after the schedule's delay for that attempt", async () => {
    const { client, rpcCalls } = makeClient({ claim: [job({ attempts: 3 })] });
    const run = await runEnquiryAlertWorker(
      client,
      { workerId: "w1" },
      { send: sender({ outcome: "failed", category: "transient", result: "503", retryAfterSeconds: null }) },
    );
    expect(run.retried).toBe(1);
    expect(completions(rpcCalls)[0]).toMatchObject({
      p_outcome: "retry",
      p_category: "transient",
      p_result: "503",
      p_retry_in_seconds: 240,
    });
    expect(Sentry.captureMessage, "a retry is not a page").not.toHaveBeenCalled();
  });

  it("a Retry-After inside the window is honoured IN FULL, even past the old one-hour cap (review A)", async () => {
    const { client, rpcCalls } = makeClient({ claim: [job({ first_attempted_at: ago(1) })] });
    await runEnquiryAlertWorker(
      client,
      { workerId: "w1" },
      {
        send: sender({ outcome: "failed", category: "transient", result: "rate_limit_exceeded", retryAfterSeconds: 5_400 }),
        now: () => T0,
      },
    );
    expect(completions(rpcCalls)[0]).toMatchObject({ p_outcome: "retry", p_retry_in_seconds: 5_400 });
  });

  it("a Retry-After the key window cannot hold is NOT scheduled: the row is closed for a decision (review A)", async () => {
    // first attempted 19 h ago: one hour of window left; the provider asks for two
    const { client, rpcCalls } = makeClient({ claim: [job({ attempts: 2, first_attempted_at: ago(19) })] });
    const run = await runEnquiryAlertWorker(
      client,
      { workerId: "w1" },
      {
        send: sender({ outcome: "failed", category: "transient", result: "rate_limit_exceeded", retryAfterSeconds: 7_200 }),
        now: () => T0,
      },
    );
    expect(run.failed).toBe(1);
    expect(run.retried).toBe(0);
    expect(completions(rpcCalls)[0]).toMatchObject({
      p_outcome: "failed",
      p_category: "transient",
      p_result: "retry_beyond_window",
    });
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
  });

  it("a backoff the key window cannot hold is closed the same way — never a retry the provider could double", async () => {
    // attempt 7 → 64 min backoff; 19.5 h since the first attempt leaves 30 min
    const { client, rpcCalls } = makeClient({ claim: [job({ attempts: 7, first_attempted_at: ago(19.5) })] });
    await runEnquiryAlertWorker(
      client,
      { workerId: "w1" },
      { send: sender({ outcome: "failed", category: "timeout", result: "timeout", retryAfterSeconds: null }), now: () => T0 },
    );
    expect(completions(rpcCalls)[0]).toMatchObject({ p_outcome: "failed", p_category: "timeout", p_result: "retry_beyond_window" });
  });

  it("a job whose first attempt is already outside the window is closed WITHOUT a send, whatever the claim said (review A)", async () => {
    const { client, rpcCalls } = makeClient({ claim: [job({ attempts: 2, first_attempted_at: ago(KEY_SAFE_WINDOW_MS / 3_600_000 + 1) })] });
    const run = await runEnquiryAlertWorker(
      client,
      { workerId: "w1" },
      { send: sender({ outcome: "accepted", providerMessageId: "must-not-happen" }), now: () => T0 },
    );
    expect(sent, "the provider may no longer remember this key: sending could be a second e-mail").toHaveLength(0);
    expect(run.failed).toBe(1);
    expect(completions(rpcCalls)[0]).toMatchObject({ p_outcome: "failed", p_category: "timeout", p_result: "key_window_expired" });
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
  });

  it("an ambiguous timeout is retried under the SAME key, so a message that did arrive is not sent twice", async () => {
    const { client, rpcCalls } = makeClient({ claim: [job({ attempts: 2 })] });
    await runEnquiryAlertWorker(
      client,
      { workerId: "w1" },
      { send: sender({ outcome: "failed", category: "timeout", result: "timeout", retryAfterSeconds: null }) },
    );
    expect(sent[0]!.key).toBe("enquiry-desk-alert/job-1/1");
    expect(completions(rpcCalls)[0]).toMatchObject({ p_outcome: "retry", p_category: "timeout", p_result: "timeout" });
  });

  it("a permanent refusal is terminal at once, and Sentry is told the shape and never the person", async () => {
    const { client, rpcCalls } = makeClient({ claim: [job()] });
    const run = await runEnquiryAlertWorker(
      client,
      { workerId: "w1" },
      { send: sender({ outcome: "failed", category: "permanent", result: "validation_error", retryAfterSeconds: null }) },
    );
    expect(run.failed).toBe(1);
    expect(completions(rpcCalls)[0]).toMatchObject({ p_outcome: "failed", p_category: "permanent", p_result: "validation_error" });
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    const ctx = JSON.stringify(vi.mocked(Sentry.captureMessage).mock.calls[0]);
    expect(ctx).toContain("validation_error");
    expect(ctx).toContain("job-1");
    expect(ctx).not.toContain("buyer@example.invalid");
    expect(ctx).not.toContain("A Buyer");
  });

  it("a key conflict is terminal with its own category — the worker never rotates a key to escape it", async () => {
    const { client, rpcCalls } = makeClient({ claim: [job()] });
    await runEnquiryAlertWorker(
      client,
      { workerId: "w1" },
      { send: sender({ outcome: "failed", category: "conflict", result: "invalid_idempotent_request", retryAfterSeconds: null }) },
    );
    expect(completions(rpcCalls)[0]).toMatchObject({ p_outcome: "failed", p_category: "conflict" });
    expect(sent[0]!.key, "the same serial: rotation is a person's decision").toBe("enquiry-desk-alert/job-1/1");
  });

  it("a redacted lead is cancelled, and nothing is sent", async () => {
    const { client, rpcCalls } = makeClient({ claim: [job()], lead: { id: "lead-1", message: REDACTED, criteria: {} } });
    const run = await runEnquiryAlertWorker(client, { workerId: "w1" }, { send: sender({ outcome: "accepted", providerMessageId: "x" }) });
    expect(run.cancelled).toBe(1);
    expect(sent).toHaveLength(0);
    expect(completions(rpcCalls)[0]).toMatchObject({ p_outcome: "cancelled", p_result: "lead_redacted" });
  });

  it("a lead that is gone is cancelled too", async () => {
    const { client, rpcCalls } = makeClient({ claim: [job()], lead: null });
    await runEnquiryAlertWorker(client, { workerId: "w1" }, { send: sender({ outcome: "accepted", providerMessageId: "x" }) });
    expect(sent).toHaveLength(0);
    expect(completions(rpcCalls)[0]).toMatchObject({ p_outcome: "cancelled", p_result: "lead_missing" });
  });

  it("a completion the database refuses (the claim was lost) is a warning, not a crash", async () => {
    const { client } = makeClient({ claim: [job()], completeReturns: false });
    const warn = vi.mocked(console.warn);
    const run = await runEnquiryAlertWorker(client, { workerId: "w1" }, { send: sender({ outcome: "accepted", providerMessageId: "x" }) });
    expect(run.lost).toBe(1);
    expect(String(warn.mock.calls.at(-1)?.[0])).toMatch(/no longer held/i);
  });

  it("processes every claimed job even when one sender throws", async () => {
    const { client, rpcCalls } = makeClient({ claim: [job({ id: "job-1" }), job({ id: "job-2", lead_id: "lead-2" })] });
    let n = 0;
    const flaky = async (a: EnquiryAlert, opts?: { idempotencyKey?: string }) => {
      n += 1;
      if (n === 1) throw new Error("sender exploded");
      return sender({ outcome: "accepted", providerMessageId: "re_2" })(a, opts);
    };
    const run = await runEnquiryAlertWorker(client, { workerId: "w1" }, { send: flaky });
    expect(run.claimed).toBe(2);
    expect(run.accepted).toBe(1);
    expect(run.retried, "a throwing sender is treated as a transient failure of that job").toBe(1);
    expect(completions(rpcCalls)).toHaveLength(2);
  });
});

/**
 * THE BUDGET (review B). A sweep is one invocation with a wall-clock limit.
 * The worker claims only what fits (above) and, when the sends it did make
 * were slow, hands back what it cannot reach in time — UNATTEMPTED, so the
 * database gives the claim's attempt back.
 */
describe("the run's budget", () => {
  it("releases the jobs it cannot reach before the budget ends, without spending their attempts", async () => {
    const c = clock();
    // budget 12 s, sends of at most 3 s + 2 s overhead: two fit — and the first one takes 9 s
    const { client, rpcCalls } = makeClient({ claim: [job({ id: "job-1" }), job({ id: "job-2", lead_id: "lead-2" })] });
    const slow = async (a: EnquiryAlert, opts?: { idempotencyKey?: string }) => {
      c.advance(9_000);
      return sender({ outcome: "accepted", providerMessageId: "re_slow" })(a, opts);
    };
    const run = await runEnquiryAlertWorker(
      client,
      { workerId: "w1", budgetMs: 12_000 },
      { send: slow, now: c.now, sendTimeoutMs: 3_000 },
    );
    expect(rpcCalls[0]!.args.p_limit, "two fit the budget on paper").toBe(2);
    expect(sent, "only the first was attempted").toHaveLength(1);
    expect(run.accepted).toBe(1);
    expect(run.released).toBe(1);
    const done = completions(rpcCalls);
    expect(done).toHaveLength(2);
    expect(done[1]).toEqual({ p_job_id: "job-2", p_worker: "w1", p_outcome: "released" });
    expect(run.error).toBeNull();
  });

  it("does not release when time remains — a fast batch runs to the end", async () => {
    const c = clock();
    const { client, rpcCalls } = makeClient({
      claim: [job({ id: "job-1" }), job({ id: "job-2", lead_id: "lead-2" }), job({ id: "job-3", lead_id: "lead-3" })],
    });
    const quick = async (a: EnquiryAlert, opts?: { idempotencyKey?: string }) => {
      c.advance(500);
      return sender({ outcome: "accepted", providerMessageId: "re_q" })(a, opts);
    };
    const run = await runEnquiryAlertWorker(
      client,
      { workerId: "w1", budgetMs: 45_000 },
      { send: quick, now: c.now, sendTimeoutMs: 8_000 },
    );
    expect(run.accepted).toBe(3);
    expect(run.released).toBe(0);
    expect(completions(rpcCalls).every((x) => x.p_outcome === "accepted")).toBe(true);
  });
});
