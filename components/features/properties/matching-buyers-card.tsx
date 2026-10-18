import Link from "next/link";
import {
  MatchEmpty,
  MatchFooter,
  MatchReasons,
  ProposedBadge,
  ScoreBadge,
  VisibilityChip,
} from "@/components/features/shared/match-list";
import { BuyerRowActions } from "@/components/features/shared/match-proposal";
import { findMatchingBuyers } from "@/lib/queries/matches";
import { latestProposalBy, proposalsForProperty } from "@/lib/queries/proposals-sent";
import { getCurrentProfile } from "@/lib/services/auth";
import { proposedDetail, visibilityChipLabel } from "@/lib/services/match-proposal";
import type { MatchCandidate } from "@/lib/services/matching";
import { createClient } from "@/lib/supabase/server";
import { RETIRED_PROPERTY_VISIBILITY } from "@/lib/validators/properties";
import { formatDate } from "@/lib/utils/format";

/**
 * Buyers whose saved search this property suits (0043, T-B7) — and, since
 * A04, the next step from each row: a proposal of this listing bound to that
 * buyer, or a viewing with both filled in. A buyer already sent a proposal
 * holding this listing says "Proposed <date>".
 *
 * The reverse of the contact-side card, scored by the SAME `matchProperty` —
 * two implementations of "does this fit" would have drifted within a month, and
 * an agent being told different things on the two pages is worse than being
 * told nothing.
 *
 * RLS scopes it: an agent sees only contacts and requirements in their org.
 * The matcher already drops archived (and so erased) contacts.
 */
export async function MatchingBuyersCard({
  property,
}: {
  /** the page's whole property row; the reference, title and visibility are read when present */
  property: MatchCandidate & {
    reference?: string;
    title?: Record<string, string> | null;
    visibility?: string;
  };
}) {
  const supabase = await createClient();
  const [result, proposals, profile] = await Promise.all([
    findMatchingBuyers(supabase, property),
    proposalsForProperty(supabase, property.id),
    getCurrentProfile(supabase),
  ]);

  if (result.rows.length === 0) {
    return (
      <MatchEmpty
        text="No buyer's saved search matches this listing yet."
        href="/contacts"
        action="Add a search to a buyer"
      />
    );
  }

  const reference = property.reference ?? "this listing";
  const listingLabel =
    property.title?.en?.trim() || property.title?.el?.trim() || property.title?.ru?.trim() || reference;
  // a retired listing is off the books: the proposal page would drop it, so none is offered
  const retired = property.visibility === RETIRED_PROPERTY_VISIBILITY;
  const listing = {
    id: property.id,
    reference,
    status: property.status,
    visibility: property.visibility ?? "",
  };
  const proposedTo = proposals.ok ? latestProposalBy(proposals.proposals, "contact") : null;
  const now = new Date();

  return (
    <>
      {visibilityChipLabel(property.visibility) || !proposals.ok || proposals.capped ? (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <VisibilityChip visibility={property.visibility} />
          {/* never "not proposed" for "could not tell" */}
          {!proposals.ok ? (
            <p className="text-xs text-warning" role="status">
              Proposal history is unavailable just now — buyers already sent this listing cannot be marked.
            </p>
          ) : proposals.capped ? (
            <p className="text-xs text-text-3">
              &ldquo;Proposed&rdquo; marks cover the latest {proposals.proposals.length} proposals holding this
              listing only.
            </p>
          ) : null}
        </div>
      ) : null}
      <ul className="flex flex-col gap-2">
        {result.rows.map((row) => {
          const sent = proposedTo?.get(row.contactId) ?? null;
          return (
            <li key={row.requirementId} className="rounded-[10px] border border-border bg-surface p-3">
              <div className="flex flex-wrap items-start gap-3">
                <ScoreBadge score={row.verdict.score} />
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/contacts/${row.contactId}`}
                    className="text-sm font-medium text-text-1 underline-offset-2 hover:underline"
                  >
                    {row.contactName}
                  </Link>
                  {/* A separator character, not just `ml-2`: a margin separates
                      this visually but leaves "Elena PetrovaPaphos villa" in the
                      accessibility tree and on copy-paste. */}
                  {row.label ? (
                    <span className="text-xs text-text-3"> · {row.label}</span>
                  ) : null}
                  {sent ? (
                    <div className="mt-1 flex flex-wrap gap-1">
                      <ProposedBadge date={formatDate(sent.createdAt)} detail={proposedDetail(sent, now)} />
                    </div>
                  ) : null}
                  <MatchReasons verdict={row.verdict} />
                </div>
                {!retired ? (
                  <BuyerRowActions
                    buyer={{ id: row.contactId, name: row.contactName, languages: row.contactLanguages }}
                    listing={listing}
                    listingLabel={listingLabel}
                    role={profile.role}
                  />
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <MatchFooter
        shown={result.rows.length}
        considered={result.considered}
        capped={result.capped}
      />
    </>
  );
}
