import Link from "next/link";
import type { ProposalHistory } from "@/lib/queries/proposals-sent";
import { opensText } from "@/lib/services/match-proposal";
import { shareLinkState } from "@/lib/services/share-links";
import { formatDateTime } from "@/lib/utils/format";

const STATE_TONE: Record<string, string> = {
  live: "text-success",
  expired: "text-text-3",
  revoked: "text-text-3",
};

/**
 * The proposals minted for this buyer (A04): when, how many listings, whether
 * the link still works, and how often it was opened — read from the links
 * themselves (`share_links.contact_id`). A read that failed says so; it is
 * never drawn as "none sent". Revoking stays on Share links, where it lives.
 */
export function ProposalsSentList({ history, now }: { history: ProposalHistory; now: Date }) {
  if (!history.ok) {
    return (
      <p className="text-sm text-warning" role="status">
        Proposal history is unavailable just now — refresh to try again.
      </p>
    );
  }
  if (history.proposals.length === 0) {
    return <p className="text-sm text-text-2">No proposal has been made for this buyer yet.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col divide-y divide-border/60">
        {history.proposals.map((p) => {
          const state = shareLinkState({ expires_at: p.expiresAt, revoked_at: p.revokedAt }, now);
          return (
            <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
              <span className="tabular-nums text-text-1">{formatDateTime(p.createdAt)}</span>
              <span className="text-text-2">
                {p.propertyIds.length} listing{p.propertyIds.length === 1 ? "" : "s"}
              </span>
              <span className={`text-xs font-medium capitalize ${STATE_TONE[state] ?? ""}`}>{state}</span>
              <span className="text-xs text-text-3">{opensText(p.viewCount)}</span>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-text-3">
        {history.capped ? `The latest ${history.proposals.length} are listed. ` : ""}
        Revoke a link on{" "}
        <Link href="/share-links" className="text-brand-700 underline underline-offset-2">
          Share links
        </Link>
        .
      </p>
    </div>
  );
}
