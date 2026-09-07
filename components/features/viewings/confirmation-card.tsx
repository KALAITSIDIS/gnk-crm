"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { AlertTriangle, Download, FileText } from "lucide-react";
import { toast } from "sonner";
import {
  generateViewingConfirmation,
  getViewingConfirmationUrl,
  type ConfirmationActionState,
} from "@/lib/actions/viewing-documents";
import { Button } from "@/components/ui/button";

const initialState: ConfirmationActionState = { error: null, savedAt: null, documentId: null };

/**
 * Generate / re-generate the viewing confirmation (IMPROVEMENTS B4).
 *
 * `hasExisting` comes from the server so the Download button is offered on
 * first paint when a confirmation is already filed — otherwise the agent has to
 * regenerate one that exists just to get the link, which files a duplicate.
 */
export function ConfirmationCard({
  viewingId,
  hasExisting,
  stale = false,
  filedTitle = null,
}: {
  viewingId: string;
  hasExisting: boolean;
  /** the filed confirmation predates the viewing's last reschedule */
  stale?: boolean;
  /** the filed document's own title — it names the time it was issued for */
  filedTitle?: string | null;
}) {
  const [state, formAction, pending] = useActionState(generateViewingConfirmation, initialState);
  const [downloading, setDownloading] = useState(false);
  const lastToasted = useRef<number | null>(null);

  useEffect(() => {
    if (state.savedAt && state.savedAt !== lastToasted.current) {
      lastToasted.current = state.savedAt;
      toast.success("Confirmation generated");
    }
    if (state.error) toast.error(state.error);
  }, [state.savedAt, state.error]);

  const available = hasExisting || Boolean(state.documentId);
  // Regenerating in this session files a confirmation for the CURRENT time, so
  // the warning must clear without a reload — otherwise the agent fixes it and
  // is still told it is wrong.
  const outOfDate = stale && !state.documentId;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-text-2">
        A branded sheet confirming the appointment — property, time, agent and attendee. Not a
        reservation; the attendance slip is signed at the viewing.
      </p>

      {outOfDate ? (
        <p
          role="status"
          className="flex items-start gap-2 rounded-[10px] border border-warning/40 bg-warning/5 px-3 py-2 text-sm text-text-2"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>
            This viewing was rescheduled after the confirmation on file was issued, so the filed
            sheet names the old time
            {filedTitle ? (
              <>
                {" — "}
                <span className="text-text-1">{filedTitle}</span>
              </>
            ) : null}
            . Regenerate before sending it. The old one is kept as a record of what was sent.
          </span>
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <form action={formAction}>
          <input type="hidden" name="viewing_id" value={viewingId} />
          <Button
            type="submit"
            variant={available && !outOfDate ? "outline" : "default"}
            disabled={pending}
          >
            <FileText className="size-4" />
            {pending ? "Generating…" : available ? "Regenerate" : "Generate confirmation"}
          </Button>
        </form>

        {available ? (
          <Button
            type="button"
            variant="outline"
            disabled={downloading}
            onClick={async () => {
              setDownloading(true);
              const { url, error } = await getViewingConfirmationUrl(viewingId);
              setDownloading(false);
              if (url) window.open(url, "_blank", "noopener");
              else toast.error(error ?? "Could not open the confirmation");
            }}
          >
            <Download className="size-4" />
            {downloading ? "Preparing…" : outOfDate ? "Download the old one (PDF)" : "Download (PDF)"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
