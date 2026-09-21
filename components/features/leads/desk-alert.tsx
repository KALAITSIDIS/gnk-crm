"use client";

import { useTransition } from "react";
import { BellRing } from "lucide-react";
import { toast } from "sonner";
import { retryEnquiryAlert } from "@/lib/actions/leads";
import { deskAlertStatus, type DeskAlertJob, type DeskAlertTone } from "@/lib/services/enquiry-alert-status";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The desk alert's status on a website lead's inbox row (0101), from its
 * `notification_jobs` row: queued, sending, retrying, alerted, failed,
 * cancelled — and, on a terminal failure or a lapsed claim, the one action a
 * person has: send it again. The wording lives in
 * lib/services/enquiry-alert-status.ts where a test pins it; this file only
 * renders it. A lead the outbox predates renders nothing at all.
 */
const TONE_CLASSES: Record<DeskAlertTone, string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  neutral: "text-text-3",
};

export function DeskAlertChip({ leadId, job }: { leadId: string; job: DeskAlertJob | null }) {
  const [pending, startTransition] = useTransition();
  const status = deskAlertStatus(job, new Date());
  if (!status) return null;

  const retry = () =>
    startTransition(async () => {
      try {
        await retryEnquiryAlert(leadId);
        toast.success("Desk alert queued — sending now");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not retry the alert");
      }
    });

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className={cn("text-xs", TONE_CLASSES[status.tone])} title="Whether the desk was e-mailed about this enquiry">
        {status.label}
      </span>
      {status.canRetry ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-6 px-2 text-xs"
          disabled={pending}
          onClick={retry}
          title="Send the desk e-mail for this enquiry again"
        >
          <BellRing className="size-3" /> {pending ? "Retrying…" : "Retry alert"}
        </Button>
      ) : null}
    </span>
  );
}
