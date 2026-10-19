/**
 * What the inbox says about a website lead's escalation (0107; recovery
 * 0111), from its `notification_jobs` row — beside the desk alert's status
 * (enquiry-alert-status.ts), which it deliberately does not replace: the
 * two rows answer different questions ("was the desk told?" / "was anyone
 * else told it was still waiting?") and the escalation has two recoveries
 * where the desk alert has one.
 *
 * Pure: the row in; a tone, a sentence, its technical details and the
 * recovery the DATABASE would admit for this row out.
 * `request_lead_escalation_recovery` decides for real and refuses the other
 * action, so what is offered here is a prediction of that decision, never
 * the decision itself:
 *
 *   retry   — the same provider key, which cannot send a second copy: a
 *             terminal failure, a lapsed lease, or a cancellation the POLICY
 *             caused, while the key is still safe (no conflict, not one of
 *             the two review words, first attempt inside KEY_SAFE_WINDOW_MS);
 *   resend  — a new key, a person's decision: the same rows once the key is
 *             no longer safe, because an earlier attempt may have been
 *             accepted with its answer lost;
 *   null    — nothing to do, or nothing an admin may do.
 *
 * TWO AUDIENCES, TWO FIELDS (A08, review 2026-10-18). Every role reads the
 * chip, so `label` is business words: what happened and, where it helps,
 * what to do. The outbox's vocabulary — state, result code, attempt counter,
 * the worker's lease, the provider key — goes in `detail`, rendered behind a
 * "Technical details" disclosure. Nothing keys off these words: the chip
 * acts on `recovery`, the database on the row.
 *
 * `accepted` is rendered as sent — accepted for sending — never delivered.
 */
import {
  LEAD_CANCELLATION_WORDS,
  earlierResult,
  outboxTechnicalDetail,
  ownWord,
  type DeskAlertJob,
  type DeskAlertTone,
} from "@/lib/services/enquiry-alert-status";
import { KEY_SAFE_WINDOW_MS } from "@/lib/services/enquiry-alert-jobs";

export interface EscalationJob extends DeskAlertJob {
  id: string;
  first_attempted_at: string | null;
  last_attempted_at: string | null;
  key_serial: number;
}

export type EscalationRecovery = "retry" | "resend" | null;

export interface EscalationStatus {
  tone: DeskAlertTone;
  /** What happened and, where it helps, what to do — business words only. */
  label: string;
  /** The technical details (state, result code, attempts, lease, key), or null. */
  detail: string | null;
  recovery: EscalationRecovery;
}

/** Cancellations the policy caused: recoverable once the policy is fixed. */
const POLICY_CANCELLATIONS: Readonly<Record<string, string>> = {
  escalation_disabled: "lead escalation was switched off when it was due. Switch it on under Settings → Lead escalation",
  no_recipient: "nobody eligible was set to receive it. Check the recipients under Settings → Lead escalation",
};

/** Why a person must decide: the recipients may already have the first e-mail. */
const MAY_HAVE_ARRIVED = "Escalation needs a decision — an earlier try may already have reached colleagues";

const minutesUntil = (iso: string, now: Date): number =>
  Math.max(0, Math.round((new Date(iso).getTime() - now.getTime()) / 60_000));

/** "just now", "N min ago", "N h ago", "N days ago" — whole units, rounded. */
export function ago(iso: string | null, now: Date): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const minutes = Math.round((now.getTime() - t) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

const lastAttempt = (job: EscalationJob, now: Date): string | null => {
  const when = ago(job.last_attempted_at, now);
  return when ? `last attempt ${when}` : null;
};

/** May the same provider key be presented again? Mirrors the SQL's v_key_safe. */
function keySafe(job: EscalationJob, now: Date): boolean {
  if (job.last_category === "conflict") return false;
  if (job.last_result === "key_window_expired" || job.last_result === "retry_beyond_window") return false;
  if (!job.first_attempted_at) return true;
  const first = new Date(job.first_attempted_at).getTime();
  if (Number.isNaN(first)) return true;
  return first + KEY_SAFE_WINDOW_MS > now.getTime();
}

const KEY_EXPIRED = "the provider key's safe window has passed, so a new send needs a new key";
const SAME_KEY = "Retry presents the same provider key, which cannot send a second copy";

export function escalationStatus(job: EscalationJob | null | undefined, now: Date): EscalationStatus | null {
  if (!job) return null;
  const attempted = lastAttempt(job, now);
  // the row's facts (with when it was last tried), then the explanation
  const tech = (...more: Array<string | null>) => outboxTechnicalDetail(job, attempted, ...more);

  switch (job.state) {
    case "accepted": {
      const when = ago(job.accepted_at, now);
      return {
        tone: "success",
        label: when ? `Escalation sent ${when}` : "Escalation sent",
        detail: outboxTechnicalDetail(job, "accepted by the provider for sending — not a delivery receipt"),
        recovery: null,
      };
    }

    case "failed": {
      // The three review words: the provider may already have this e-mail.
      if (job.last_category === "conflict") {
        return {
          tone: "danger",
          label: "Escalation needs a decision — the first e-mail may already have reached colleagues",
          detail: tech("the provider holds an earlier version of this e-mail under its key"),
          recovery: "resend",
        };
      }
      if (job.last_result === "key_window_expired") {
        return {
          tone: "danger",
          label: "Escalation needs a decision — the first e-mail may already have reached colleagues",
          detail: tech("the provider key expired before the outcome of an earlier attempt was known"),
          recovery: "resend",
        };
      }
      if (job.last_result === "retry_beyond_window") {
        return {
          tone: "danger",
          label: "Escalation needs a decision — the mail service asked to wait too long",
          detail: tech("the provider's Retry-After outlasts the key's safe window, so the worker stopped"),
          recovery: "resend",
        };
      }
      if (!keySafe(job, now)) {
        return { tone: "danger", label: MAY_HAVE_ARRIVED, detail: tech(KEY_EXPIRED), recovery: "resend" };
      }
      return {
        tone: "danger",
        label:
          job.last_category === "permanent"
            ? "Escalation not sent — the mail service refused it"
            : job.attempts > 1
              ? `Escalation not sent after ${job.attempts} tries`
              : "Escalation not sent",
        detail: tech(SAME_KEY),
        recovery: "retry",
      };
    }

    case "cancelled": {
      const policy = ownWord(POLICY_CANCELLATIONS, job.last_result);
      if (policy) {
        if (!keySafe(job, now)) {
          return {
            tone: "neutral",
            label: `Escalation cancelled — ${policy}, then review and send a new copy.`,
            detail: tech(KEY_EXPIRED),
            recovery: "resend",
          };
        }
        return { tone: "neutral", label: `Escalation cancelled — ${policy}, then Retry.`, detail: tech(SAME_KEY), recovery: "retry" };
      }
      const final = ownWord(LEAD_CANCELLATION_WORDS, job.last_result);
      return {
        tone: "neutral",
        label: final ? `Escalation cancelled — ${final}` : "Escalation cancelled",
        detail: job.last_result || job.last_category ? tech() : null,
        recovery: null,
      };
    }

    case "sending": {
      const live = job.claimed_until !== null && new Date(job.claimed_until).getTime() > now.getTime();
      if (live) return { tone: "neutral", label: "Escalation sending…", detail: earlierResult(job), recovery: null };
      const lapsed = ago(job.claimed_until, now);
      const lease = `the worker's lease lapsed${lapsed ? ` ${lapsed}` : ""}`;
      if (!keySafe(job, now)) {
        return { tone: "warning", label: MAY_HAVE_ARRIVED, detail: tech(lease, KEY_EXPIRED), recovery: "resend" };
      }
      return {
        tone: "warning",
        label: "Escalation stuck — it will be retried",
        detail: tech(lease, `the next sweep picks it up; ${SAME_KEY}`),
        recovery: "retry",
      };
    }

    default: {
      // pending: the worker owns it
      if (job.attempts === 0) return { tone: "neutral", label: "Escalation queued", detail: earlierResult(job), recovery: null };
      const wait = minutesUntil(job.next_attempt_at, now);
      return {
        tone: "warning",
        label: `Escalation delayed — trying again ${wait === 0 ? "now" : `in ${wait} min`}`,
        detail: tech(),
        recovery: null,
      };
    }
  }
}
