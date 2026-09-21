/**
 * The worker between the outbox and the provider (0101, reviewed 0102).
 *
 * WHAT IT IS. One function that claims due `notification_jobs` rows (or the
 * one row for a given lead), rebuilds each desk e-mail from its lead, makes
 * ONE provider attempt under the job's idempotency key, and hands the outcome
 * back to the database, which owns the state. It runs from three places and
 * behaves identically in each:
 *
 *   - the enquiry route's `after()`, for the lead it just made — the
 *     ACCELERATOR: the desk is told within a second of the 202, as before;
 *   - the staff retry action's `after()`, for the lead a person asked about;
 *   - the sweep, `GET|POST /api/internal/enquiry-alerts`, for whatever the
 *     first two never reached: an invocation killed after the commit, a
 *     provider that answered 503, a lease that lapsed. The sweep is what
 *     makes the alert RECOVERABLE; the accelerator only makes it fast.
 *
 * WHAT IT NEVER DOES. It never throws (a sweep that dies on one job would
 * strand the rest), never decides a state on its own (every transition is a
 * `complete_notification_job` call the database validates against the
 * claim), never stores or logs a person (the e-mail is rebuilt from the lead
 * and discarded), never rotates a key (that is a person's decision, in
 * `request_enquiry_alert_retry`), and never sends twice for one job: the
 * provider key is the job's, so a retry after an ambiguous timeout presents
 * the same key.
 *
 * THE KEY WINDOW (review A). That last promise holds only while the provider
 * remembers the key — 24 hours at Resend; 20 here (KEY_SAFE_WINDOW_MS, the
 * same number as the database's notification_key_window()). The claim
 * refuses a row first attempted longer ago than that; this file checks it
 * again before sending, and refuses to SCHEDULE a retry — backoff or the
 * provider's Retry-After — that would land past it. Either way the row is
 * closed for a decision (`key_window_expired`, `retry_beyond_window`) and
 * the inbox offers Retry alert, which is where a person may choose to send
 * again under a fresh key.
 *
 * THE BUDGET (review B). A sweep is one invocation with a wall-clock limit.
 * The worker claims only as many rows as `budgetMs` fits at the provider's
 * worst case plus round trips, and — when the sends it made were slow —
 * hands back what it cannot reach UNATTEMPTED (`released`: the database
 * gives the claim's attempt back).
 *
 * THE RUN'S VERDICT (review C). A claim that fails is not an empty queue:
 * `error` names the stage and the error CODE (never the message, which can
 * carry a connection string), Sentry is told, and the sweep route answers
 * 503 rather than an "ok" that reads as nothing due.
 *
 * THE ROLLOUT GUARD (review D) is no longer here. A lead the pre-0101 route
 * already alerted is closed by `claim_notification_jobs` itself, in the
 * claim's own transaction — there is no lookup left that can fail and let
 * a send through.
 */
import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import {
  ALERT_TIMEOUT_MS,
  enquiryAlertConfigured,
  sendEnquiryAlert,
  type AlertSendResult,
  type EnquiryAlert,
} from "@/lib/services/enquiry-alert";
import {
  PER_JOB_OVERHEAD_MS,
  alertFromLead,
  idempotencyKeyFor,
  jobsThatFit,
  keyWindowRemainingMs,
  retryDelaySeconds,
  retryFitsKeyWindow,
} from "@/lib/services/enquiry-alert-jobs";
import { LEAD_MESSAGE_REDACTED } from "@/lib/services/erasure";

type Client = SupabaseClient<Database>;
type Job = Database["public"]["Tables"]["notification_jobs"]["Row"];

export interface WorkerOptions {
  /** Who is claiming — a route instance, a sweep run, a retry. Appears on the row while the lease lives. */
  workerId: string;
  /** Rows per run, at most; the budget may lower it. */
  limit?: number;
  /** Narrow the claim to one lead (the accelerator and the staff retry). */
  leadId?: string;
  /** How long a claim may be held before another worker may take the row over. Raised to outlive the budget. */
  leaseSeconds?: number;
  /** Wall-clock budget for this run. Claims only what fits; releases what it cannot reach. */
  budgetMs?: number;
}

export interface WorkerDeps {
  /** The one provider attempt. Injected so a test never reaches the network. */
  send?: (a: EnquiryAlert, opts: { idempotencyKey: string }) => Promise<AlertSendResult>;
  /** The clock, for the budget and the key window. Injected so a test controls time. */
  now?: () => number;
  /** The provider call's worst case, for the budget arithmetic. */
  sendTimeoutMs?: number;
}

export type WorkerError = { stage: "claim" | "budget"; code: string };

export interface WorkerRun {
  claimed: number;
  accepted: number;
  retried: number;
  failed: number;
  cancelled: number;
  /** claims handed back unattempted because the budget ran out (the attempt is given back) */
  released: number;
  /** completions the database refused because the claim was no longer this worker's */
  lost: number;
  skipped: "unconfigured" | null;
  /** an infrastructure failure — the queue could not be reached, or no run could fit — distinct from an empty queue */
  error: WorkerError | null;
}

export const DEFAULT_LEASE_SECONDS = 90;
export const DEFAULT_LIMIT = 4;
/** What the sweep route can afford inside its maxDuration; the accelerator passes its own. */
export const DEFAULT_BUDGET_MS = 45_000;

const zero = (): WorkerRun => ({
  claimed: 0,
  accepted: 0,
  retried: 0,
  failed: 0,
  cancelled: 0,
  released: 0,
  lost: 0,
  skipped: null,
  error: null,
});

export async function runEnquiryAlertWorker(
  supabase: Client,
  opts: WorkerOptions,
  deps: WorkerDeps = {},
): Promise<WorkerRun> {
  const run = zero();
  const send = deps.send ?? sendEnquiryAlert;
  const now = deps.now ?? Date.now;
  const sendTimeoutMs = deps.sendTimeoutMs ?? ALERT_TIMEOUT_MS;
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const startedAt = now();

  // Unarmed: claim NOTHING. A claim spends an attempt, and an unconfigured
  // deployment would burn every job's budget saying "skipped" eight times.
  // The rows wait as pending — visible on the inbox — until the environment
  // is set, and the sweep sends them then.
  if (!enquiryAlertConfigured()) {
    console.warn(
      "[enquiry-alert] worker SKIPPED — RESEND_API_KEY and ENQUIRY_ALERT_TO are not both set; " +
        "pending desk alerts wait in notification_jobs.",
    );
    run.skipped = "unconfigured";
    return run;
  }

  // Claim only what this run can finish: the provider's worst case plus the
  // round trips, per job, inside the budget. A budget that fits nothing
  // claims nothing — a claimed row this run could not attempt would only sit
  // under a lease.
  const fit = jobsThatFit(budgetMs, sendTimeoutMs);
  if (fit < 1) {
    console.error(`[enquiry-alert] run budget ${budgetMs}ms cannot fit one send of ${sendTimeoutMs}ms; nothing claimed`);
    run.error = { stage: "budget", code: "too_small" };
    return run;
  }
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, fit));
  // The lease must outlive the whole run, or a slow batch's last row could be
  // handed to a second worker while this one is still on it.
  const leaseSeconds = Math.max(
    opts.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
    Math.ceil((budgetMs + sendTimeoutMs + PER_JOB_OVERHEAD_MS) / 1000),
  );

  const claim = await supabase.rpc("claim_notification_jobs", {
    p_worker: opts.workerId,
    p_limit: limit,
    p_lease_seconds: leaseSeconds,
    // omitted, not null: PostgREST then takes the function's own default
    ...(opts.leadId ? { p_lead_id: opts.leadId } : {}),
  });
  if (claim.error) {
    // The queue could not be reached. That is not "nothing due", and nobody
    // reading a 200 would know the difference — so it is an error the route
    // turns into a 503, and a page. The CODE only: a PostgREST message can
    // carry a connection string.
    const code = claim.error.code ? String(claim.error.code) : "unknown";
    console.error(`[enquiry-alert] claim failed (${code})`);
    run.error = { stage: "claim", code };
    reportInfrastructure("claim", code, opts.workerId);
    return run;
  }
  const jobs = (claim.data ?? []) as Job[];
  run.claimed = jobs.length;

  for (const job of jobs) {
    // THE BUDGET: is there time for one more worst-case send? If not, hand
    // this row back untouched — the database gives the attempt back — and
    // let the next run take it.
    const remaining = budgetMs - (now() - startedAt);
    if (remaining < sendTimeoutMs + PER_JOB_OVERHEAD_MS) {
      try {
        if (await completeJob(supabase, job, opts.workerId, run, "released")) run.released += 1;
      } catch (err) {
        console.error(`[enquiry-alert] job ${job.id} could not be released:`, err instanceof Error ? err.name : String(err));
      }
      continue;
    }
    try {
      await processOne(supabase, job, opts.workerId, send, run, now);
    } catch (err) {
      // A job that throws past its own handling must not strand the rest of
      // the batch. Its lease lapses and the next sweep counts the attempt.
      console.error(
        `[enquiry-alert] job ${job.id} threw:`,
        err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      );
    }
  }
  return run;
}

type Outcome = "accepted" | "retry" | "failed" | "cancelled" | "released";

async function completeJob(
  supabase: Client,
  job: Job,
  workerId: string,
  run: WorkerRun,
  outcome: Outcome,
  fields: { category?: string | null; result?: string | null; providerMessageId?: string | null; retryIn?: number | null } = {},
): Promise<boolean> {
  // Optional arguments are OMITTED when absent, not sent as null: the
  // generated types say `?: string`, and PostgREST fills the SQL default.
  const { data, error } = await supabase.rpc("complete_notification_job", {
    p_job_id: job.id,
    p_worker: workerId,
    p_outcome: outcome,
    ...(fields.category ? { p_category: fields.category } : {}),
    ...(fields.result ? { p_result: fields.result } : {}),
    ...(fields.providerMessageId ? { p_provider_message_id: fields.providerMessageId } : {}),
    ...(fields.retryIn !== null && fields.retryIn !== undefined ? { p_retry_in_seconds: fields.retryIn } : {}),
  });
  if (error) {
    console.error(`[enquiry-alert] could not record ${outcome} for job ${job.id}:`, error.message);
    return false;
  }
  if (data !== true) {
    run.lost += 1;
    console.warn(`[enquiry-alert] job ${job.id} is no longer held by ${workerId}; its ${outcome} was not recorded`);
    return false;
  }
  return true;
}

async function processOne(
  supabase: Client,
  job: Job,
  workerId: string,
  send: NonNullable<WorkerDeps["send"]>,
  run: WorkerRun,
  now: () => number,
): Promise<void> {
  const complete = (outcome: Outcome, fields: Parameters<typeof completeJob>[5] = {}) =>
    completeJob(supabase, job, workerId, run, outcome, fields);
  const at = () => new Date(now());

  // THE KEY WINDOW, checked before anything leaves. The claim (0102) refuses
  // such a row already; this is the same rule read by the worker's own
  // clock, so a claim's arithmetic cannot be the only thing between a
  // forgotten key and a second e-mail.
  const remainingWindow = keyWindowRemainingMs(job, at());
  if (remainingWindow !== null && remainingWindow <= 0) {
    if (await complete("failed", { category: "timeout", result: "key_window_expired" })) {
      run.failed += 1;
      reportTerminal(job, "timeout", "key_window_expired", false);
    }
    return;
  }

  const { data: lead, error: leadErr } = await supabase
    .from("leads")
    .select("id, message, criteria")
    .eq("id", job.lead_id)
    .maybeSingle();
  if (leadErr) {
    // Ask the database, not the reader: a failed read is a retry, not a cancellation.
    console.error("[enquiry-alert] lead read failed:", leadErr.message);
    await scheduleRetry(job, "transient", "lead_read_failed", null, complete, run, at());
    return;
  }
  if (!lead) {
    if (await complete("cancelled", { result: "lead_missing" })) run.cancelled += 1;
    return;
  }
  const alert = alertFromLead(lead);
  if (!alert) {
    const why = lead.message === LEAD_MESSAGE_REDACTED ? "lead_redacted" : "lead_unreadable";
    if (await complete("cancelled", { result: why })) run.cancelled += 1;
    return;
  }

  let result: AlertSendResult;
  try {
    result = await send(alert, { idempotencyKey: idempotencyKeyFor(job) });
  } catch (err) {
    // The sender promises never to throw; if it does anyway, that is one
    // failed attempt of THIS job, not the end of the run.
    console.error(`[enquiry-alert] sender threw for job ${job.id}:`, err instanceof Error ? err.name : String(err));
    result = { outcome: "failed", category: "transient", result: "sender_threw", retryAfterSeconds: null };
  }

  if (result.outcome === "accepted") {
    if (await complete("accepted", { result: "accepted", providerMessageId: result.providerMessageId })) run.accepted += 1;
    return;
  }
  if (result.outcome === "skipped") {
    // Configuration vanished between the check above and the send — the
    // platform does not do that, but the row must not be left in flight.
    await scheduleRetry(job, "transient", "unconfigured", 900, complete, run, at());
    return;
  }

  if (result.category === "transient" || result.category === "timeout") {
    await scheduleRetry(job, result.category, result.result, result.retryAfterSeconds, complete, run, at());
    return;
  }

  // permanent or conflict: terminal now, and a human reads the inbox chip.
  // A conflict means the provider holds this key with a different payload;
  // the worker does NOT rotate the key to get past it — a person does.
  if (await complete("failed", { category: result.category, result: result.result })) {
    run.failed += 1;
    reportTerminal(job, result.category, result.result, false);
  }
}

/**
 * Back off — the schedule's step for this attempt, or the provider's
 * Retry-After in full, whichever is later — unless that wait would land
 * past the key window, in which case the row is closed for a decision:
 * a retry the provider could no longer deduplicate is not a retry this
 * worker may make on its own.
 */
async function scheduleRetry(
  job: Job,
  category: "transient" | "timeout",
  result: string,
  retryAfterSeconds: number | null,
  complete: (outcome: Outcome, fields?: Parameters<typeof completeJob>[5]) => Promise<boolean>,
  run: WorkerRun,
  now: Date,
): Promise<void> {
  const retryIn = retryDelaySeconds(job.attempts, retryAfterSeconds);
  if (!retryFitsKeyWindow(job, retryIn, now)) {
    if (await complete("failed", { category, result: "retry_beyond_window" })) {
      run.failed += 1;
      reportTerminal(job, category, "retry_beyond_window", false);
    }
    return;
  }
  if (await complete("retry", { category, result, retryIn })) {
    run.retried += 1;
    // The database decides whether that retry was the last allowed; when it
    // was, the row is terminal now and somebody should know.
    if (job.attempts >= job.max_attempts) reportTerminal(job, category, result, true);
  }
}

/**
 * The one failure this module exists to prevent, on the one channel a human
 * is paged on (audit LR-07). SHAPE ONLY: ids, the category, the provider's
 * error name — never the person, the address or the message.
 */
function reportTerminal(job: Job, category: string, result: string, exhausted: boolean): void {
  try {
    Sentry.captureMessage(`[enquiry-alert] desk alert failed for good: ${result}`, {
      level: "error",
      tags: { category, result: result.slice(0, 40) },
      extra: { jobId: job.id, leadId: job.lead_id, attempts: job.attempts, exhausted },
    });
  } catch {
    // Sentry is best-effort; the row and the event carry the outcome.
  }
}

/** The queue itself could not be reached: a stage and a code, never a message. */
function reportInfrastructure(stage: WorkerError["stage"], code: string, workerId: string): void {
  try {
    Sentry.captureMessage(`[enquiry-alert] worker could not ${stage}: ${code}`, {
      level: "error",
      tags: { stage, code: code.slice(0, 40) },
      extra: { workerId },
    });
  } catch {
    // best-effort
  }
}
