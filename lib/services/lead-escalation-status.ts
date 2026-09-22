/**
 * What the inbox says about a website lead's escalation (0107; recovery
 * 0111), from its `notification_jobs` row — beside the desk alert's status
 * (enquiry-alert-status.ts), which it deliberately does not replace: the
 * two rows answer different questions ("was the desk told?" / "was anyone
 * else told it was still waiting?") and the escalation has two recoveries
 * where the desk alert has one.
 *
 * Pure: the row in; a tone, a label, a second line and the recovery the
 * DATABASE would admit for this row out. `request_lead_escalation_recovery`
 * decides for real and refuses the other action, so what is offered here is
 * a prediction of that decision, never the decision itself:
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
 * `accepted` is rendered as accepted by the provider, never delivered.
 */
import type { DeskAlertJob, DeskAlertTone } from "@/lib/services/enquiry-alert-status";
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
  label: string;
  /** the second line — when, why, and what an admin may do — or null */
  detail: string | null;
  recovery: EscalationRecovery;
}

/** Cancellations the policy caused: recoverable once the policy is fixed. */
const POLICY_CANCELLATIONS: Record<string, string> = {
  escalation_disabled: "lead escalation was switched off at send time — switch it on under Settings → Lead escalation, then Retry",
  no_recipient: "nobody eligible to receive it — check the recipients under Settings → Lead escalation, then Retry",
};

/** Cancellations because the enquiry no longer needed one: final. */
const FINAL_CANCELLATIONS: Record<string, string> = {
  lead_answered: "the enquiry was answered first",
  lead_closed: "the lead was closed",
  lead_redacted: "the enquiry was redacted",
  lead_unreadable: "the enquiry could not be read",
  lead_missing: "the lead no longer exists",
};

const RESEND_TAIL = "review, then resend under a new key";

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

export function escalationStatus(job: EscalationJob | null | undefined, now: Date): EscalationStatus | null {
  if (!job) return null;
  const last = job.last_result ? ` (${job.last_result})` : "";
  const attempted = lastAttempt(job, now);
  const paren = attempted ? ` (${attempted})` : "";

  switch (job.state) {
    case "accepted": {
      const when = ago(job.accepted_at, now);
      return {
        tone: "success",
        label: "Escalation accepted by the provider",
        detail: `${when ?? "accepted"} — accepted for sending, not a delivery receipt`,
        recovery: null,
      };
    }

    case "failed": {
      // The three review words: the provider may already have this e-mail.
      if (job.last_category === "conflict") {
        return {
          tone: "danger",
          label: "Escalation needs a decision",
          detail: `the provider holds an earlier version of this e-mail under its key and may already have sent it${paren} — ${RESEND_TAIL}`,
          recovery: "resend",
        };
      }
      if (job.last_result === "key_window_expired") {
        return {
          tone: "danger",
          label: "Escalation needs a decision",
          detail: `an earlier attempt may have reached the recipients and the provider key has expired${paren} — ${RESEND_TAIL}`,
          recovery: "resend",
        };
      }
      if (job.last_result === "retry_beyond_window") {
        return {
          tone: "danger",
          label: "Escalation needs a decision",
          detail: `the provider asked to wait longer than the key stays safe${paren} — ${RESEND_TAIL}`,
          recovery: "resend",
        };
      }
      const label = job.attempts > 1 ? `Escalation FAILED after ${job.attempts} attempts${last}` : `Escalation FAILED${last}`;
      const lead = attempted ? `${attempted} — ` : "";
      if (!keySafe(job, now)) {
        return {
          tone: "danger",
          label,
          detail: `${lead}the provider key has expired, so an earlier attempt may have reached the recipients; ${RESEND_TAIL}`,
          recovery: "resend",
        };
      }
      return {
        tone: "danger",
        label,
        detail: `${lead}Retry sends it again under the same key, which cannot send a second copy`,
        recovery: "retry",
      };
    }

    case "cancelled": {
      const why = job.last_result ?? "";
      if (why in POLICY_CANCELLATIONS) {
        if (!keySafe(job, now)) {
          return {
            tone: "neutral",
            label: "Escalation cancelled",
            detail: `${POLICY_CANCELLATIONS[why]!.replace(/, then Retry$/, "")} — the provider key has since expired; ${RESEND_TAIL}`,
            recovery: "resend",
          };
        }
        return { tone: "neutral", label: "Escalation cancelled", detail: POLICY_CANCELLATIONS[why]!, recovery: "retry" };
      }
      return {
        tone: "neutral",
        label: "Escalation cancelled",
        detail: FINAL_CANCELLATIONS[why] ?? (why || null),
        recovery: null,
      };
    }

    case "sending": {
      const live = job.claimed_until !== null && new Date(job.claimed_until).getTime() > now.getTime();
      if (live) return { tone: "neutral", label: "Escalation sending…", detail: null, recovery: null };
      const lapsed = ago(job.claimed_until, now);
      const label = `Escalation stuck (${job.attempts} of ${job.max_attempts})`;
      if (!keySafe(job, now)) {
        return {
          tone: "warning",
          label,
          detail: `the worker's lease lapsed${lapsed ? ` ${lapsed}` : ""} and the provider key has expired — an earlier attempt may have reached the recipients; ${RESEND_TAIL}`,
          recovery: "resend",
        };
      }
      return {
        tone: "warning",
        label,
        detail: `the worker's lease lapsed${lapsed ? ` ${lapsed}` : ""} — the sweep will pick it up; Retry sends it now under the same key`,
        recovery: "retry",
      };
    }

    default: {
      // pending: the worker owns it
      if (job.attempts === 0) return { tone: "neutral", label: "Escalation queued", detail: null, recovery: null };
      const wait = minutesUntil(job.next_attempt_at, now);
      const next = wait === 0 ? "due now" : `next in ${wait} min`;
      return {
        tone: "warning",
        label: `Escalation retrying (${job.attempts} of ${job.max_attempts}${job.last_result ? `, last ${job.last_result}` : ""})`,
        detail: attempted ? `${next} · ${attempted}` : next,
        recovery: null,
      };
    }
  }
}
