"use client";

import { useState, useTransition } from "react";
import { MailWarning, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { recoverLeadEscalation } from "@/lib/actions/leads";
import { escalationStatus, type EscalationJob } from "@/lib/services/lead-escalation-status";
import type { DeskAlertTone } from "@/lib/services/enquiry-alert-status";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/**
 * The escalation's status on a website lead's inbox row (0107; recovery
 * 0111), beside the desk alert's chip: queued, sending, retrying, accepted
 * by the provider, failed, cancelled — and, for an ADMIN, the one recovery
 * the database would admit for this row:
 *
 *   Retry escalation — one click; the same provider key, which cannot send
 *                      a second copy;
 *   Review & resend  — a dialog that says the earlier e-mail may already
 *                      have been accepted, asks for a reason (kept on the
 *                      timeline), and only then creates a NEW logical send.
 *
 * The wording lives in lib/services/lead-escalation-status.ts where a test
 * pins it; the rules live in request_lead_escalation_recovery, which refuses
 * anything this file gets wrong. A lead with no escalation row renders
 * nothing. Provider acceptance is never called delivery.
 */
const TONE_CLASSES: Record<DeskAlertTone, string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  neutral: "text-text-3",
};

const REASON_MAX = 200;

export function EscalationChip({ job, isAdmin }: { job: EscalationJob | null; isAdmin: boolean }) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const status = escalationStatus(job, new Date());
  if (!job || !status) return null;

  const retry = () =>
    startTransition(async () => {
      try {
        await recoverLeadEscalation({ jobId: job.id, action: "retry" });
        toast.success("Escalation queued — sending now");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not retry the escalation");
      }
    });

  const resend = () =>
    startTransition(async () => {
      try {
        await recoverLeadEscalation({ jobId: job.id, action: "resend", reason });
        setOpen(false);
        setReason("");
        toast.success("Escalation queued under a new key — sending now");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not resend the escalation");
      }
    });

  const reasonId = `escalation-reason-${job.id}`;
  const canConfirm = reason.trim().length > 0 && reason.length <= REASON_MAX && !pending;

  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
      <span className={cn("text-xs", TONE_CLASSES[status.tone])} title="Whether a colleague was e-mailed that this enquiry was still unanswered">
        {status.label}
      </span>
      {status.detail ? <span className="text-xs text-text-3">— {status.detail}</span> : null}
      {isAdmin && status.recovery === "retry" ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-6 px-2 text-xs"
          disabled={pending}
          onClick={retry}
          title="Send the escalation again under the same provider key — the provider cannot send a second copy under it"
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
            title="Decide whether to send the escalation again under a NEW provider key"
          >
            <MailWarning className="size-3" /> Review &amp; resend
          </Button>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Resend the escalation under a new key?</DialogTitle>
              <DialogDescription>
                The provider may already have accepted the earlier e-mail under its key — a retry under the same key cannot
                tell, so the worker stopped for this decision. Resending creates a new e-mail: if the earlier one was
                delivered, the recipients receive it twice. Check with them first where you can.
              </DialogDescription>
            </DialogHeader>
            <p className="text-xs text-text-3">Why the worker stopped: {status.detail ?? status.label}.</p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={reasonId}>Reason</Label>
              <Textarea
                id={reasonId}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={REASON_MAX}
                rows={3}
                placeholder="What was checked, and why a second e-mail is right"
                aria-describedby={`${reasonId}-hint`}
              />
              <p id={`${reasonId}-hint`} className="text-xs text-text-3">
                Kept on the lead&apos;s timeline with your name — no personal details, {REASON_MAX} characters at most.
              </p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={pending} onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="button" disabled={!canConfirm} onClick={resend}>
                {pending ? "Resending…" : "Resend under a new key"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </span>
  );
}
