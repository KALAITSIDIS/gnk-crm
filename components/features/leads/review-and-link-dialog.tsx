"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { UserCheck } from "lucide-react";
import { toast } from "sonner";
import { linkLeadContact, type LinkLeadContactResult } from "@/lib/actions/leads";
import { SUGGESTION_CAUTION } from "@/lib/services/enquiry-contact-match";
import { EarlierEnquiryList, type EarlierEnquiry } from "@/components/features/leads/earlier-enquiries";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * "Review and link" for a possible existing contact (T-enquiry-contact-
 * suggestions). Opening it writes nothing: everything it shows arrived with
 * the page. The one write is the confirm button, which calls the hardened
 * `linkLeadContact` — conditional at the database, so a colleague who linked,
 * converted or closed the lead after this page was drawn wins and nothing of
 * theirs is overwritten. A refusal is said TWICE: in the dialog, and as a
 * toast — the inbox is refreshed underneath (the action revalidates on a
 * lost race), and a refreshed row that no longer qualifies unmounts this
 * dialog, its error with it, while the layout's toaster survives. Without the
 * toast a refused link would close the dialog exactly as a successful one does.
 */
export interface ReviewCandidate {
  contactId: string;
  name: string;
  /** reasonLabel(evidence) */
  reason: string;
  /** evidenceLines(keys, evidence) */
  evidence: string[];
  history: EarlierEnquiry[];
  moreHistory: boolean;
}

export function ReviewAndLinkDialog({
  leadId,
  candidate,
  note,
}: {
  leadId: string;
  candidate: ReviewCandidate;
  /** ambiguityNote — the other candidate(s), when there are any */
  note: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const changeOpen = (next: boolean) => {
    if (pending) return;
    setOpen(next);
    // every close and every open starts clean: no earlier attempt's error
    setError(null);
  };

  const refuse = (message: string) => {
    setError(message);
    toast.error(message);
  };

  const confirm = () =>
    startTransition(async () => {
      setError(null);
      let result: LinkLeadContactResult;
      try {
        result = await linkLeadContact(leadId, candidate.contactId, { via: "suggestion" });
      } catch {
        refuse("Could not reach the server — nothing was changed. Try again.");
        return;
      }
      if (result.error) {
        refuse(result.error);
        // the lead may have moved under this page — show the row as it is now
        router.refresh();
        return;
      }
      toast.success(
        result.alreadyLinked ? `Already linked to ${candidate.name}` : `Enquiry linked to ${candidate.name}`,
      );
      if (result.warning) toast.warning(result.warning);
      setOpen(false);
    });

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      {/* a real trigger: Radix returns focus to it when the dialog closes */}
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-xs"
          // one row can hold several candidates: each button says whose it is
          aria-label={`Review and link ${candidate.name}`}
          title={`Check the evidence, then link this enquiry to ${candidate.name}`}
        >
          <UserCheck className="size-3" aria-hidden /> Review and link
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Link this enquiry to {candidate.name}?</DialogTitle>
          <DialogDescription>{SUGGESTION_CAUTION}</DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-3 text-sm">
          <div className="flex flex-col gap-1">
            <p className="font-medium text-text-1">{candidate.reason}</p>
            <ul className="flex flex-col gap-0.5 text-xs text-text-2">
              {candidate.evidence.map((line) => (
                // a long address breaks only where it must, never mid-word elsewhere
                <li key={line} className="[overflow-wrap:anywhere]">
                  {line}
                </li>
              ))}
            </ul>
          </div>
          {note ? <p className="text-xs text-warning">{note}</p> : null}
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-xs text-text-3">Recent enquiries linked to this contact</p>
            <EarlierEnquiryList items={candidate.history} more={candidate.moreHistory} />
          </div>
          <p className="text-xs text-text-3">
            Linking only attaches this enquiry to the contact. Its status, agent, response clock and alerts stay as
            they are.{" "}
            <Link
              href={`/contacts/${candidate.contactId}`}
              target="_blank"
              rel="noopener"
              className="font-medium text-brand-700 hover:underline"
            >
              Open the contact
            </Link>
          </p>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={() => changeOpen(false)}>
            Cancel
          </Button>
          {/* a long company name wraps instead of running out of a phone-width dialog */}
          <Button
            type="button"
            disabled={pending}
            onClick={confirm}
            className="h-auto min-h-9 whitespace-normal py-1.5 [overflow-wrap:anywhere]"
          >
            {pending ? "Linking…" : `Link to ${candidate.name}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
