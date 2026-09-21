/**
 * The worker between the outbox and the provider (0101).
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
 * and discarded), and never sends twice for one job: the provider key is the
 * job's, so a retry after an ambiguous timeout presents the same key.
 *
 * THE ROLLOUT GUARD. The hosted migration is applied BEFORE the CRM that
 * runs this deploys (HANDOFF §3), so for that window the OLD route still
 * sends directly from `after()` and writes its `enquiry_alert: sent` event,
 * while the door already writes a pending job. When this code arrives it
 * would send those leads' alerts a second time — unless it looks. It looks:
 * a lead whose timeline already says `sent` is closed as accepted with the
 * word `legacy_sender`, and nothing leaves.
 */
import * as Sentry from "@sentry/nextjs";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import {
  enquiryAlertConfigured,
  sendEnquiryAlert,
  type AlertSendResult,
  type EnquiryAlert,
} from "@/lib/services/enquiry-alert";
import { alertFromLead, idempotencyKeyFor, retryDelaySeconds } from "@/lib/services/enquiry-alert-jobs";
import { LEAD_MESSAGE_REDACTED } from "@/lib/services/erasure";

type Client = SupabaseClient<Database>;
type Job = Database["public"]["Tables"]["notification_jobs"]["Row"];

export interface WorkerOptions {
  /** Who is claiming — a route instance, a sweep run, a retry. Appears on the row while the lease lives. */
  workerId: string;
  /** Rows per run. The sweep route keeps this small so a run fits its function budget. */
  limit?: number;
  /** Narrow the claim to one lead (the accelerator and the staff retry). */
  leadId?: string;
  /** How long a claim may be held before another worker may take the row over. */
  leaseSeconds?: number;
}

export interface WorkerDeps {
  /** The one provider attempt. Injected so a test never reaches the network. */
  send?: (a: EnquiryAlert, opts: { idempotencyKey: string }) => Promise<AlertSendResult>;
}

export interface WorkerRun {
  claimed: number;
  accepted: number;
  retried: number;
  failed: number;
  cancelled: number;
  /** completions the database refused because the claim was no longer this worker's */
  lost: number;
  skipped: "unconfigured" | null;
}

/** Enough for five sends of up to eight seconds each plus the round trips. */
export const DEFAULT_LEASE_SECONDS = 90;
export const DEFAULT_LIMIT = 5;

const zero = (): WorkerRun => ({
  claimed: 0,
  accepted: 0,
  retried: 0,
  failed: 0,
  cancelled: 0,
  lost: 0,
  skipped: null,
});

export async function runEnquiryAlertWorker(
  supabase: Client,
  opts: WorkerOptions,
  deps: WorkerDeps = {},
): Promise<WorkerRun> {
  const run = zero();
  const send = deps.send ?? sendEnquiryAlert;

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

  const claim = await supabase.rpc("claim_notification_jobs", {
    p_worker: opts.workerId,
    p_limit: opts.limit ?? DEFAULT_LIMIT,
    p_lease_seconds: opts.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
    // omitted, not null: PostgREST then takes the function's own default
    ...(opts.leadId ? { p_lead_id: opts.leadId } : {}),
  });
  if (claim.error) {
    console.error("[enquiry-alert] claim failed:", claim.error.message);
    return run;
  }
  const jobs = (claim.data ?? []) as Job[];
  run.claimed = jobs.length;

  for (const job of jobs) {
    try {
      await processOne(supabase, job, opts.workerId, send, run);
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

async function processOne(
  supabase: Client,
  job: Job,
  workerId: string,
  send: NonNullable<WorkerDeps["send"]>,
  run: WorkerRun,
): Promise<void> {
  const complete = async (
    outcome: "accepted" | "retry" | "failed" | "cancelled",
    fields: { category?: string | null; result?: string | null; providerMessageId?: string | null; retryIn?: number | null } = {},
  ): Promise<boolean> => {
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
  };

  // The rollout guard (header): the old route's own record of having told
  // the desk. Costs one indexed read per job and is what stops a double send
  // during the migrate-then-deploy window.
  const legacy = await supabase
    .from("events")
    .select("id")
    .eq("entity_type", "lead")
    .eq("entity_id", job.lead_id)
    .eq("event_type", "enquiry_alert")
    .eq("payload->>outcome", "sent")
    .limit(1);
  if (legacy.error) {
    console.error("[enquiry-alert] legacy check failed:", legacy.error.message);
  } else if ((legacy.data ?? []).length > 0) {
    if (await complete("accepted", { result: "legacy_sender", providerMessageId: null })) run.accepted += 1;
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
    if (await complete("retry", { category: "transient", result: "lead_read_failed", retryIn: retryDelaySeconds(job.attempts, null) }))
      run.retried += 1;
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
    if (await complete("retry", { category: "transient", result: "unconfigured", retryIn: 900 })) run.retried += 1;
    return;
  }

  if (result.category === "transient" || result.category === "timeout") {
    const retryIn = retryDelaySeconds(job.attempts, result.retryAfterSeconds);
    if (await complete("retry", { category: result.category, result: result.result, retryIn })) {
      run.retried += 1;
      // The database decides whether that retry was the last allowed; when it
      // was, the row is terminal now and somebody should know.
      if (job.attempts >= job.max_attempts) reportTerminal(job, result.category, result.result, true);
    }
    return;
  }

  // permanent or conflict: terminal now, and a human reads the inbox chip
  if (await complete("failed", { category: result.category, result: result.result })) {
    run.failed += 1;
    reportTerminal(job, result.category, result.result, false);
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
