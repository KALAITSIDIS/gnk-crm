"use client";

import { useState, useTransition } from "react";
import { MailWarning, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { recoverLeadEscalation } from "@/lib/actions/leads";
import { escalationStatus, type EscalationJob } from "@/lib/services/lead-escalation-status";
import type { DeskAlertTone } from "@/lib/services/enquiry-alert-status";
import { TechnicalDetails } from "@/components/features/shared/technical-details";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * The escalation's status on a website lead's inbox row (0107; recovery
 * 0111), beside the desk alert's chip: queued, sending, delayed, sent,
 * not sent, cancelled — and, for an ADMIN, the one recovery the database
 * would admit for this row:
 *
 *   Retry escalation  — one click; the same provider key, which cannot
 *                       send a second copy, so colleagues cannot get it
 *                       twice;
 *   Send a new copy…  — a dialog that says the first e-mail may already
 *                       have arrived and, only on an explicit
 *                       confirmation, creates a NEW logical send. It asks
 *                       for no typed text (0115): the event records who,
 *                       when, which action and why the first one stopped,
 *                       and the append-only chain must never hold words
 *                       about a person.
 *
 * Business words on the row; the outbox's codes, counters and key behind
 * "Technical details" (A08). The wording lives in
 * lib/services/lead-escalation-status.ts where a test pins it; the rules
 * live in request_lead_escalation_recovery, which refuses anything this
 * file gets wrong. A lead with no escalation row renders nothing. Provider
 * acceptance is never called delivery.
 */
const TONE_CLASSES: Record<DeskAlertTone, string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  neutral: "text-text-3",
};

export function EscalationChip({ job, isAdmin }: { job: EscalationJob | null; isAdmin: boolean }) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const status = escalationStatus(job, new Date());
  if (!job || !status) return null;

  const retry = () =>
    startTransition(async () => {
      try {
        // the database's refusal comes back as an answer — a thrown message is redacted by Next
        const { error } = await recoverLeadEscalation({ jobId: job.id, action: "retry" });
        if (error) toast.error(error);
        else toast.success("Escalation queued — sending now");
      } catch {
        toast.error("Could not retry the escalation — reload the page and try again.");
      }
    });

  const resend = () =>
    startTransition(async () => {
      try {
        const { error } = await recoverLeadEscalation({ jobId: job.id, action: "resend" });
        if (error) {
          toast.error(error);
          return;
        }
        setOpen(false);
        toast.success("New copy of the escalation queued — sending now");
      } catch {
        toast.error("Could not send a new copy of the escalation — reload the page and try again.");
      }
    });

  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
      <span className={cn("text-xs", TONE_CLASSES[status.tone])} title="Whether a colleague was e-mailed that this enquiry was still unanswered">
        {status.label}
      </span>
      {isAdmin && status.recovery === "retry" ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-6 px-2 text-xs"
          disabled={pending}
          onClick={retry}
          title="Sends it again. Colleagues cannot receive it twice: the mail service drops a repeat of the same e-mail."
        >
          <RotateCcw className="size-3" /> {pending ? "Retrying…" : "Retry escalation"}
        </Button>
      ) : null}
      {isAdmin && status.recovery === "resend" ? (
        <Dialog open={open} onOpenChange={(next) => (pending ? null : setOpen(next))}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={pending}
            onClick={() => setOpen(true)}
            title="Decide whether to send colleagues a new copy of the escalation"
          >
            <MailWarning className="size-3" /> Send a new copy…
          </Button>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Send a new copy of the escalation?</DialogTitle>
              <DialogDescription>
                The first e-mail may already have arrived — if it did, colleagues will get it twice. Check with them
                first where you can.
              </DialogDescription>
            </DialogHeader>
            <p className="text-xs text-text-3">
              The event log records that you sent a new copy, when, and why the first one stopped.
            </p>
            {status.detail ? <TechnicalDetails>{status.detail}</TechnicalDetails> : null}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={pending} onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="button" disabled={pending} onClick={resend}>
                {pending ? "Sending…" : "Send a new copy"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
      {/* the outbox's codes, counters and key, out of the sentence (A08) */}
      {status.detail ? <TechnicalDetails>{status.detail}</TechnicalDetails> : null}
    </span>
  );
}
