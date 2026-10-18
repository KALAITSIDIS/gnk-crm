import Link from "next/link";
import { ResponseClock } from "@/components/features/shared/response-clock";
import { leadTarget } from "@/lib/services/task-target";

/**
 * Lead rows on the dashboard (A01): My day's "My open leads" and the admin's
 * "Unassigned open leads". Each row opens where its next step is done
 * (leadTarget: an unanswered lead → the inbox, where the response is logged;
 * an answered one → its person), with the live response clock beside it.
 */
export interface DashboardLeadRow {
  id: string;
  received_at: string;
  first_response_at: string | null;
  source: string;
  message: string | null;
  contact_id: string | null;
  contacts: { display_name: string | null } | null;
}

export function LeadRowList({ rows }: { rows: DashboardLeadRow[] }) {
  return (
    <ul className="flex flex-col divide-y divide-border/60 text-sm">
      {rows.map((l) => (
        <li key={l.id} className="flex min-h-11 items-center justify-between gap-3 py-2">
          <Link
            href={leadTarget(l).href}
            className="min-w-0 flex-1 truncate text-text-1 hover:text-brand-700"
          >
            {l.contacts?.display_name ?? l.message?.slice(0, 40) ?? l.source}
          </Link>
          <ResponseClock receivedAt={l.received_at} firstResponseAt={l.first_response_at} />
        </li>
      ))}
    </ul>
  );
}
