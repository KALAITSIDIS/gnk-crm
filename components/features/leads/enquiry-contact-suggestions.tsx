import Link from "next/link";
import { UserSearch } from "lucide-react";
import type { EnquirySuggestionState } from "@/lib/queries/enquiry-contact-suggestions";
import {
  SUGGESTION_MORE_CANDIDATES,
  SUGGESTION_STATE_TEXT,
  ambiguityNote,
  evidenceLines,
  reasonLabel,
  suggestionHeading,
} from "@/lib/services/enquiry-contact-match";
import { formatDate } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { EarlierEnquiriesFolded } from "@/components/features/leads/earlier-enquiries";
import { ReviewAndLinkDialog } from "@/components/features/leads/review-and-link-dialog";

/**
 * "Possible existing contact" on an unlinked website enquiry's inbox row
 * (T-enquiry-contact-suggestions). A server component: the lookup ran once for
 * the whole page (lib/queries/enquiry-contact-suggestions.ts), so the row
 * paints with its answer and there is no client-side loading phase — and no
 * write, ever, from rendering it.
 *
 * Every state says something, because "nothing shown" would read as "no
 * match": a failed lookup says it failed, an enquiry with no usable e-mail or
 * phone says so. Several candidates are listed side by side with a sentence
 * that names the split when the e-mail and the phone point at different
 * people; nothing is pre-selected. "Review and link" appears only for someone
 * the lead's update policy lets link (admin; an agent on their own or an
 * unassigned lead).
 *
 * The wording lives in lib/services/enquiry-contact-match.ts, where a test pins it.
 */
export function EnquiryContactSuggestions({
  leadId,
  state,
  canLink,
  agentLabels,
}: {
  leadId: string;
  state: EnquirySuggestionState;
  canLink: boolean;
  /** profile id → display name, as the inbox row prints agents */
  agentLabels: Record<string, string>;
}) {
  if (state.status !== "matches") {
    return (
      <p className={cn("text-xs", state.status === "unavailable" ? "text-warning" : "text-text-3")}>
        {SUGGESTION_STATE_TEXT[state.status]}
      </p>
    );
  }

  const heading = suggestionHeading(state.candidates.length);
  const note = ambiguityNote(state);
  const agent = (id: string | null) => (id ? (agentLabels[id] ?? "Unknown agent") : "Unassigned");

  return (
    <div
      role="group"
      aria-label={heading}
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2"
    >
      <p className="flex items-center gap-1.5 text-sm font-medium text-text-1">
        <UserSearch className="size-4 shrink-0 text-brand-700" aria-hidden />
        {heading}
      </p>
      {note ? <p className="text-xs text-warning">{note}</p> : null}
      <ul className="flex min-w-0 flex-col divide-y divide-border/60">
        {state.candidates.map((c) => {
          const history = c.history.map((h) => ({
            id: h.id,
            date: formatDate(h.received_at),
            propertyId: h.property?.id ?? null,
            reference: h.property?.reference ?? null,
            status: h.status,
            agent: agent(h.assigned_agent_id),
          }));
          const reason = reasonLabel(c.evidence);
          return (
            <li key={c.contact.id} className="flex min-w-0 flex-col gap-1 py-2 first:pt-0 last:pb-0">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <Link
                  href={`/contacts/${c.contact.id}`}
                  className="break-words text-sm font-medium text-brand-700 hover:underline"
                >
                  {c.contact.name}
                </Link>
                <span className="text-xs text-text-2">{reason}</span>
                {canLink ? (
                  <ReviewAndLinkDialog
                    leadId={leadId}
                    note={note}
                    candidate={{
                      contactId: c.contact.id,
                      name: c.contact.name,
                      reason,
                      evidence: evidenceLines(state.keys, c.evidence),
                      history,
                      moreHistory: c.moreHistory,
                    }}
                  />
                ) : null}
              </div>
              <EarlierEnquiriesFolded items={history} more={c.moreHistory} />
            </li>
          );
        })}
      </ul>
      {state.moreCandidates ? <p className="text-xs text-text-3">{SUGGESTION_MORE_CANDIDATES}</p> : null}
    </div>
  );
}
