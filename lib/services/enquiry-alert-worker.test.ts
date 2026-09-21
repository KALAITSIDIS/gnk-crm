import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/nextjs";
import type { AlertSendResult, EnquiryAlert } from "./enquiry-alert";
import { runEnquiryAlertWorker } from "./enquiry-alert-worker";

vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn() }));

/**
 * The worker between the outbox and the provider (0101). The database owns
 * the state (supabase/tests/enquiry-alert-outbox.test.ts proves the claim,
 * the lease and the terminal states on a real stack); this file pins what the
 * worker DOES with a claimed job — which RPC it calls, with which words, and
 * what it sends — against a scripted client and a scripted sender, so no
 * message ever leaves and no database is needed.
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
}

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
 * the completion, from("leads") for the lead, from("events") for the legacy
 * guard. Every call is recorded; every answer is scripted.
 */
function makeClient(script: {
  claim?: Job[] | { error: string };
  lead?: Record<string, unknown> | null;
  legacySent?: boolean;
  completeReturns?: boolean;
}) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === "claim_notification_jobs") {
        const c = script.claim ?? [];
        return Array.isArray(c) ? { data: c, error: null } : { data: null, error: { message: c.error } };
      }
      if (name === "complete_notification_job") return { data: script.completeReturns ?? true, error: null };
      throw new Error("unexpected rpc " + name);
    },
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      for (const m of ["select", "eq", "limit", "order"]) chain[m] = self;
      chain.maybeSingle = async () =>
        table === "leads" ? { data: script.lead === undefined ? { id: "lead-1", message, criteria: {} } : script.lead, error: null } : { data: null, error: null };
      chain.then = (resolve: (v: unknown) => void) =>
        resolve(table === "events" ? { data: script.legacySent ? [{ id: 1 }] : [], error: null } : { data: [], error: null });
      return chain;
    },
  };
  return { client: client as never, rpcCalls };
}

const sent: Array<{ alert: EnquiryAlert; key: string | undefined }> = [];
const sender = (result: AlertSendResult) => async (a: EnquiryAlert, opts?: { idempotencyKey?: string }) => {
  sent.push({ alert: a, key: opts?.idempotencyKey });
  return result;
};

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
    expect(rpcCalls, "no claim: an unconfigured worker must not spend attempts").toHaveLength(0);
    expect(sent).toHaveLength(0);
  });
});

describe("a claimed job", () => {
  it("is claimed with the worker's name, the limit, the lease and the lead it was asked for", async () => {
    const { client, rpcCalls } = makeClient({ claim: [] });
    await runEnquiryAlertWorker(client, { workerId: "route:abc", leadId: "lead-9", limit: 1 }, { send: sender({ outcome: "skipped" }) });
    expect(rpcCalls[0]).toEqual({
      name: "claim_notification_jobs",
      args: { p_worker: "route:abc", p_limit: 1, p_lease_seconds: 90, p_lead_id: "lead-9" },
    });
  });

  it("is rebuilt from the lead, sent under the job's key, and completed as accepted with the provider's id", async () => {
    const { client, rpcCalls } = makeClient({ claim: [job()] });
    const run = await runEnquiryAlertWorker(
      client,
      { workerId: "w1" },
      { send: sender({ outcome: "accepted", providerMessageId: "re_42" }) },
    );
    expect(run).toMatchObject({ claimed: 1, accepted: 1, retried: 0, failed: 0, cancelled: 0, skipped: null });
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
    // optional arguments are omitted, never sent as null — PostgREST fills the SQL default
    expect(rpcCalls[1]).toEqual({
      name: "complete_notification_job",
      args: {
        p_job_id: "job-1",
        p_worker: "w1",
        p_outcome: "accepted",
        p_result: "accepted",
        p_provider_message_id: "re_42",
      },
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
    expect(rpcCalls[1]!.args).toMatchObject({
      p_outcome: "retry",
      p_category: "transient",
      p_result: "503",
      p_retry_in_seconds: 240,
    });
    expect(Sentry.captureMessage, "a retry is not a page").not.toHaveBeenCalled();
  });

  it("a rate limit waits for as long as the provider asked", async () => {
    const { client, rpcCalls } = makeClient({ claim: [job()] });
    await runEnquiryAlertWorker(
      client,
      { workerId: "w1" },
      { send: sender({ outcome: "failed", category: "transient", result: "rate_limit_exceeded", retryAfterSeconds: 900 }) },
    );
    expect(rpcCalls[1]!.args).toMatchObject({ p_outcome: "retry", p_retry_in_seconds: 900 });
  });

  it("an ambiguous timeout is retried under the SAME key, so a message that did arrive is not sent twice", async () => {
    const { client, rpcCalls } = makeClient({ claim: [job({ attempts: 2 })] });
    await runEnquiryAlertWorker(
      client,
      { workerId: "w1" },
      { send: sender({ outcome: "failed", category: "timeout", result: "timeout", retryAfterSeconds: null }) },
    );
    expect(sent[0]!.key).toBe("enquiry-desk-alert/job-1/1");
    expect(rpcCalls[1]!.args).toMatchObject({ p_outcome: "retry", p_category: "timeout", p_result: "timeout" });
  });

  it("a permanent refusal is terminal at once, and Sentry is told the shape and never the person", async () => {
    const { client, rpcCalls } = makeClient({ claim: [job()] });
    const run = await runEnquiryAlertWorker(
      client,
      { workerId: "w1" },
      { send: sender({ outcome: "failed", category: "permanent", result: "validation_error", retryAfterSeconds: null }) },
    );
    expect(run.failed).toBe(1);
    expect(rpcCalls[1]!.args).toMatchObject({ p_outcome: "failed", p_category: "permanent", p_result: "validation_error" });
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    const ctx = JSON.stringify(vi.mocked(Sentry.captureMessage).mock.calls[0]);
    expect(ctx).toContain("validation_error");
    expect(ctx).toContain("job-1");
    expect(ctx).not.toContain("buyer@example.invalid");
    expect(ctx).not.toContain("A Buyer");
  });

  it("a key conflict is terminal with its own category — the retry action knows to rotate the key", async () => {
    const { client, rpcCalls } = makeClient({ claim: [job()] });
    await runEnquiryAlertWorker(
      client,
      { workerId: "w1" },
      { send: sender({ outcome: "failed", category: "conflict", result: "invalid_idempotent_request", retryAfterSeconds: null }) },
    );
    expect(rpcCalls[1]!.args).toMatchObject({ p_outcome: "failed", p_category: "conflict" });
  });

  it("a redacted lead is cancelled, and nothing is sent", async () => {
    const { client, rpcCalls } = makeClient({ claim: [job()], lead: { id: "lead-1", message: REDACTED, criteria: {} } });
    const run = await runEnquiryAlertWorker(client, { workerId: "w1" }, { send: sender({ outcome: "accepted", providerMessageId: "x" }) });
    expect(run.cancelled).toBe(1);
    expect(sent).toHaveLength(0);
    expect(rpcCalls[1]!.args).toMatchObject({ p_outcome: "cancelled", p_result: "lead_redacted" });
  });

  it("a lead that is gone is cancelled too", async () => {
    const { client, rpcCalls } = makeClient({ claim: [job()], lead: null });
    await runEnquiryAlertWorker(client, { workerId: "w1" }, { send: sender({ outcome: "accepted", providerMessageId: "x" }) });
    expect(sent).toHaveLength(0);
    expect(rpcCalls[1]!.args).toMatchObject({ p_outcome: "cancelled", p_result: "lead_missing" });
  });

  it("a lead the old route already alerted is closed as accepted without a second e-mail (the rollout guard)", async () => {
    const { client, rpcCalls } = makeClient({ claim: [job()], legacySent: true });
    const run = await runEnquiryAlertWorker(client, { workerId: "w1" }, { send: sender({ outcome: "accepted", providerMessageId: "x" }) });
    expect(sent, "the desk was told by the after() sender before the deploy").toHaveLength(0);
    expect(run.accepted).toBe(1);
    expect(rpcCalls[1]!.args).toMatchObject({ p_outcome: "accepted", p_result: "legacy_sender" });
    expect(rpcCalls[1]!.args, "no provider id — nothing was sent by this code").not.toHaveProperty("p_provider_message_id");
  });

  it("a completion the database refuses (the claim was lost) is a warning, not a crash", async () => {
    const { client } = makeClient({ claim: [job()], completeReturns: false });
    const warn = vi.mocked(console.warn);
    const run = await runEnquiryAlertWorker(client, { workerId: "w1" }, { send: sender({ outcome: "accepted", providerMessageId: "x" }) });
    expect(run.lost).toBe(1);
    expect(String(warn.mock.calls.at(-1)?.[0])).toMatch(/no longer held/i);
  });

  it("a claim that errors is reported and the run answers empty — the sweep will come round again", async () => {
    const { client } = makeClient({ claim: { error: "boom" } });
    const run = await runEnquiryAlertWorker(client, { workerId: "w1" }, { send: sender({ outcome: "skipped" }) });
    expect(run).toMatchObject({ claimed: 0, accepted: 0, retried: 0, failed: 0, cancelled: 0 });
    expect(String(vi.mocked(console.error).mock.calls[0]?.[0])).toMatch(/claim/i);
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
    expect(rpcCalls.filter((c) => c.name === "complete_notification_job")).toHaveLength(2);
  });
});
