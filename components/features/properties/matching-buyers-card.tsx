import Link from "next/link";
import {
  MatchEmpty,
  MatchFooter,
  MatchReasons,
  ScoreBadge,
} from "@/components/features/shared/match-list";
import { findMatchingBuyers } from "@/lib/queries/matches";
import type { MatchCandidate } from "@/lib/services/matching";
import { createClient } from "@/lib/supabase/server";

/**
 * Buyers whose saved search this property suits (0043, T-B7).
 *
 * The reverse of the contact-side card, scored by the SAME `matchProperty` —
 * two implementations of "does this fit" would have drifted within a month, and
 * an agent being told different things on the two pages is worse than being
 * told nothing.
 *
 * RLS scopes it: an agent sees only contacts and requirements in their org.
 */
export async function MatchingBuyersCard({ property }: { property: MatchCandidate }) {
  const supabase = await createClient();
  const result = await findMatchingBuyers(supabase, property);

  if (result.rows.length === 0) {
    return (
      <MatchEmpty
        text="No buyer's saved search matches this listing yet."
        href="/contacts"
        action="Add a search to a buyer"
      />
    );
  }

  return (
    <>
      <ul className="flex flex-col gap-2">
        {result.rows.map((row) => (
          <li key={row.requirementId} className="rounded-[10px] border border-border bg-surface p-3">
            <div className="flex items-start gap-3">
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
                <MatchReasons verdict={row.verdict} />
              </div>
            </div>
          </li>
        ))}
      </ul>
      <MatchFooter
        shown={result.rows.length}
        considered={result.considered}
        capped={result.capped}
      />
    </>
  );
}
