/**
 * What the inbox says about a website lead's desk alert (0101).
 *
 * Read from the lead's `notification_jobs` row — the one place a person
 * learns that the desk was, or was not, told. Pure: the row in, a tone, a
 * sentence and whether a retry is offered out. `accepted` is rendered as
 * "alerted", never "delivered": the provider took the message, and nothing
 * here confirms more than that.
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
  label: string;
  /** Offer the "Retry alert" button: terminal failure, or a claim whose lease has lapsed. */
  canRetry: boolean;
}

const minutesUntil = (iso: string, now: Date): number =>
  Math.max(0, Math.round((new Date(iso).getTime() - now.getTime()) / 60_000));

export function deskAlertStatus(job: DeskAlertJob | null | undefined, now: Date): DeskAlertStatus | null {
  if (!job) return null;
  const last = job.last_result ? ` (${job.last_result})` : "";

  switch (job.state) {
    case "accepted":
      return { tone: "success", label: "Desk alerted", canRetry: false };

    case "failed":
      return {
        tone: "danger",
        label:
          job.attempts > 1
            ? `Desk alert FAILED after ${job.attempts} attempts${last}`
            : `Desk alert FAILED${last}`,
        canRetry: true,
      };

    case "cancelled":
      return {
        tone: "neutral",
        label:
          job.last_result === "lead_redacted"
            ? "Desk alert cancelled (enquiry redacted)"
            : `Desk alert cancelled${last}`,
        canRetry: false,
      };

    case "sending": {
      const live = job.claimed_until !== null && new Date(job.claimed_until).getTime() > now.getTime();
      if (live) return { tone: "neutral", label: "Desk alert sending…", canRetry: false };
      return {
        tone: "warning",
        label: `Desk alert stuck (${job.attempts} of ${job.max_attempts}) — will be picked up`,
        canRetry: true,
      };
    }

    default: {
      // pending
      if (job.attempts === 0) return { tone: "neutral", label: "Desk alert queued", canRetry: false };
      const wait = minutesUntil(job.next_attempt_at, now);
      return {
        tone: "warning",
        label:
          `Desk alert retrying (${job.attempts} of ${job.max_attempts}` +
          (job.last_result ? `, last ${job.last_result}` : "") +
          `) — ${wait === 0 ? "due now" : `next in ${wait} min`}`,
        canRetry: false,
      };
    }
  }
}
