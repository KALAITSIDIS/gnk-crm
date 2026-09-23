import Link from "next/link";
import { StatusBadge } from "@/components/features/shared/status-badge";
import {
  SUGGESTION_MORE_HISTORY,
  SUGGESTION_NO_HISTORY,
  historySummary,
} from "@/lib/services/enquiry-contact-match";

/**
 * A possible existing contact's most recent enquiries — the ones already
 * LINKED to that contact through `leads.contact_id`, newest first
 * (T-enquiry-contact-suggestions). Rendered folded on the inbox row and open
 * in the Review and link dialog, so the values arrive pre-formatted (dates in
 * Nicosia time, on the server) and nothing here depends on the clock or the
 * browser.
 *
 * No directive: it renders on the server inside the row and on the client
 * inside the dialog. An earlier enquiry's message is never shown — only when,
 * about what, how it stands and who has it.
 */
export interface EarlierEnquiry {
  id: string;
  /** formatDate(received_at) */
  date: string;
  propertyId: string | null;
  reference: string | null;
  status: string;
  /** the assigned agent's name, or "Unassigned" */
  agent: string;
}

export function EarlierEnquiryList({ items, more }: { items: EarlierEnquiry[]; more: boolean }) {
  if (items.length === 0) return <p className="text-xs text-text-3">{SUGGESTION_NO_HISTORY}</p>;
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <ul className="flex min-w-0 flex-col gap-0.5">
        {items.map((e) => (
          <li key={e.id} className="flex flex-wrap items-center gap-x-1.5 text-xs text-text-2">
            <span className="tabular-nums">{e.date}</span>
            <span aria-hidden className="text-text-3">·</span>
            {e.propertyId && e.reference ? (
              <Link href={`/properties/${e.propertyId}`} className="font-mono text-brand-700 hover:underline">
                {e.reference}
              </Link>
            ) : (
              <span>No listing</span>
            )}
            <span aria-hidden className="text-text-3">·</span>
            <StatusBadge status={e.status} className="text-xs" />
            <span aria-hidden className="text-text-3">·</span>
            <span className="break-words">{e.agent}</span>
          </li>
        ))}
      </ul>
      {more ? <p className="text-xs text-text-3">{SUGGESTION_MORE_HISTORY}</p> : null}
    </div>
  );
}

/**
 * The row's version: one summary line — how many, and when the latest was —
 * that opens in place. A native <details> needs no JavaScript and works
 * before hydration (lead-message.tsx's reason), and keeps a row with two
 * candidates from growing a dozen lines on a phone.
 */
export function EarlierEnquiriesFolded({ items, more }: { items: EarlierEnquiry[]; more: boolean }) {
  const summary = historySummary(items.length, more, items[0]?.date ?? null);
  if (items.length === 0) return <p className="text-xs text-text-3">{summary}</p>;
  return (
    <details className="group min-w-0">
      <summary className="cursor-pointer list-none text-xs text-text-3 [&::-webkit-details-marker]:hidden">
        {summary}
        <span className="ml-1 group-open:hidden">· show</span>
      </summary>
      <div className="mt-1">
        <EarlierEnquiryList items={items} more={more} />
      </div>
    </details>
  );
}
