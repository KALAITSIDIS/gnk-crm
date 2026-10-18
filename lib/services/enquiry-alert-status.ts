/**
 * What the inbox says about a website lead's desk alert (0101).
 *
 * Read from the lead's `notification_jobs` row — the one place a person
 * learns that the desk was, or was not, told. Pure: the row in, a tone, a
 * sentence, its technical details and whether a retry is offered out.
 *
 * TWO AUDIENCES, TWO FIELDS (A08, review 2026-10-18). The chip sits on every
 * website lead card and every role reads it, so `label` is business words
 * only: what happened, and what a person can do about it. The outbox's own
 * vocabulary — the state, the provider's result code ("validation_error",
 * "503", "key_window_expired"), the attempt counter, the key — is for whoever
 * chases a failure, and goes in `detail`, which the chip renders behind a
 * "Technical details" disclosure. Before this the label read "Desk alert
 * FAILED (validation_error)" and "Desk alert retrying (2 of 8, last 503)".
 *
 * Nothing keys off these words: the retry offer is `canRetry` (computed from
 * the row's state here) and, for real, request_enquiry_alert_retry in the
 * database. `accepted` is rendered as "alerted", never "delivered": the
 * provider took the message, and nothing here confirms more than that.
 */
export interface DeskAlertJob {
  state: string;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  claimed_until: string | null;
  last_category: string | null;
  last_result: string | null;
  accepted_at: string | null;
}

export type DeskAlertTone = "success" | "warning" | "danger" | "neutral";

export interface DeskAlertStatus {
  tone: DeskAlertTone;
  /** What happened, in business words — no codes, counters or system names. */
  label: string;
  /** The technical details (state, result code, attempts), or null when there is nothing to add. */
  detail: string | null;
  /** Offer the "Retry alert" button: terminal failure, or a claim whose lease has lapsed. */
  canRetry: boolean;
}

/**
 * Cancellations because the enquiry no longer needed an e-mail — final, and
 * worded for the reader. The escalation (lead-escalation-status.ts) uses the
 * same words; a code with no entry here stays in the technical details.
 */
export const LEAD_CANCELLATION_WORDS: Readonly<Record<string, string>> = {
  lead_answered: "the enquiry was answered first",
  lead_closed: "the lead was closed",
  lead_redacted: "the enquiry was redacted",
  lead_unreadable: "the enquiry could not be read",
  lead_missing: "the lead no longer exists",
};

/**
 * For a row that is waiting or in flight: nothing technical to add — unless
 * it still carries an earlier attempt's result (a retried row keeps it),
 * which is then not lost.
 */
export function earlierResult(job: DeskAlertJob): string | null {
  return job.last_result || job.last_category ? outboxTechnicalDetail(job) : null;
}

/** A map's OWN entry for a stored code — never one inherited from Object ("toString"). */
export function ownWord(words: Readonly<Record<string, string>>, code: string | null | undefined): string | undefined {
  return code && Object.hasOwn(words, code) ? words[code] : undefined;
}

const minutesUntil = (iso: string, now: Date): number =>
  Math.max(0, Math.round((new Date(iso).getTime() - now.getTime()) / 60_000));

/**
 * The row in the outbox's own words — its state, the attempt counter and the
 * last result with its category — then whatever explanation the caller adds.
 * Shared with lead-escalation-status.ts, so both chips' details read alike.
 */
export function outboxTechnicalDetail(job: DeskAlertJob, ...more: Array<string | null | undefined>): string {
  const parts = [`state ${job.state}`, `attempt ${job.attempts} of ${job.max_attempts}`];
  if (job.last_result) parts.push(`last result ${job.last_result}${job.last_category ? ` (${job.last_category})` : ""}`);
  else if (job.last_category) parts.push(`last category ${job.last_category}`);
  for (const m of more) if (m) parts.push(m);
  return parts.join(" · ");
}

export function deskAlertStatus(job: DeskAlertJob | null | undefined, now: Date): DeskAlertStatus | null {
  if (!job) return null;

  switch (job.state) {
    case "accepted":
      return {
        tone: "success",
        label: "Desk alerted",
        // the rollout closure (0102): the pre-outbox route had already told the desk
        detail:
          job.last_result === "legacy_sender"
            ? outboxTechnicalDetail(job, "sent by the route used before the outbox (0102)")
            : null,
        canRetry: false,
      };

    case "failed":
      // The review states (0102): nothing is wrong with the enquiry or the
      // address — the provider may hold an earlier copy, or its key can no
      // longer be trusted, so the worker stopped and a person decides.
      // request_enquiry_alert_retry rotates the key for exactly these.
      if (job.last_result === "key_window_expired" || job.last_category === "conflict") {
        return {
          tone: "danger",
          label: "Desk alert needs a decision — it may already have reached the desk; Retry sends it again",
          detail: outboxTechnicalDetail(
            job,
            job.last_category === "conflict"
              ? "the provider holds an earlier version of this e-mail under its key"
              : "the provider key expired before the outcome of an earlier attempt was known",
          ),
          canRetry: true,
        };
      }
      if (job.last_result === "retry_beyond_window") {
        return {
          tone: "danger",
          label: "Desk alert needs a decision — the mail service asked to wait too long; Retry sends it again",
          detail: outboxTechnicalDetail(job, "the provider's Retry-After outlasts the key's safe window, so the worker stopped"),
          canRetry: true,
        };
      }
      return {
        tone: "danger",
        label:
          job.last_category === "permanent"
            ? "Desk alert not sent — the mail service refused it"
            : job.attempts > 1
              ? `Desk alert not sent after ${job.attempts} tries`
              : "Desk alert not sent",
        detail: outboxTechnicalDetail(job),
        canRetry: true,
      };

    case "cancelled": {
      const why = ownWord(LEAD_CANCELLATION_WORDS, job.last_result);
      return {
        tone: "neutral",
        label: why ? `Desk alert cancelled — ${why}` : "Desk alert cancelled",
        detail: earlierResult(job),
        canRetry: false,
      };
    }

    case "sending": {
      const live = job.claimed_until !== null && new Date(job.claimed_until).getTime() > now.getTime();
      if (live) return { tone: "neutral", label: "Desk alert sending…", detail: earlierResult(job), canRetry: false };
      return {
        tone: "warning",
        label: "Desk alert stuck — it will be retried",
        detail: outboxTechnicalDetail(job, "the worker's claim lapsed; the next sweep picks it up"),
        canRetry: true,
      };
    }

    default: {
      // pending
      if (job.attempts === 0) return { tone: "neutral", label: "Desk alert queued", detail: earlierResult(job), canRetry: false };
      const wait = minutesUntil(job.next_attempt_at, now);
      return {
        tone: "warning",
        label: `Desk alert delayed — trying again ${wait === 0 ? "now" : `in ${wait} min`}`,
        detail: outboxTechnicalDetail(job),
        canRetry: false,
      };
    }
  }
}
