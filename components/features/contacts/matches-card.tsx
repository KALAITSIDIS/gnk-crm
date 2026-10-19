import { MatchEmpty, MatchFooter } from "@/components/features/shared/match-list";
import {
  MatchProposalList,
  type ContactMatchRow,
  type ProposalBuyer,
} from "@/components/features/shared/match-proposal";
import { findMatchingProperties } from "@/lib/queries/matches";
import { latestProposalBy, type ProposalHistory } from "@/lib/queries/proposals-sent";
import { proposedDetail } from "@/lib/services/match-proposal";
import { priceFor, type MatchRequirement } from "@/lib/services/matching";
import { createClient } from "@/lib/supabase/server";
import { formatDate, formatMoney } from "@/lib/utils/format";

/**
 * Properties that suit this buyer (0043, T-B6) — and, since A04, what to do
 * with them: tick some and mint ONE proposal bound to this buyer, or schedule
 * a viewing of one, from the row. A listing already in a proposal for this
 * buyer says "Proposed <date>".
 *
 * One section per ACTIVE saved search, because "which search matched" is part
 * of the answer — collapsing them into one deduplicated list would tell an
 * agent that a property matched without telling them what the buyer said.
 *
 * Runs under the caller's client, so RLS scopes the candidates: an agent only
 * ever sees properties they were already allowed to open.
 */

export interface RequirementForMatching extends MatchRequirement {
  id: string;
  label: string | null;
  is_active: boolean;
}

function propertyTitle(title: Record<string, string> | null, reference: string): string {
  return title?.en?.trim() || title?.el?.trim() || title?.ru?.trim() || reference;
}

export async function MatchesCard({
  requirements,
  buyer,
  canAct,
  role,
  proposals,
}: {
  requirements: RequirementForMatching[];
  buyer: ProposalBuyer;
  /** false for an archived or erased contact: matches are shown, nothing is offered */
  canAct: boolean;
  role: string;
  /** this buyer's proposals (lib/queries/proposals-sent.ts), read once by the page */
  proposals: ProposalHistory;
}) {
  const active = requirements.filter((r) => r.is_active);

  if (active.length === 0) {
    return (
      <MatchEmpty text="Add a saved search above and matching listings will appear here." />
    );
  }

  const supabase = await createClient();
  const results = await Promise.all(active.map((r) => findMatchingProperties(supabase, r)));
  const proposedBy = proposals.ok ? latestProposalBy(proposals.proposals, "property") : null;
  const now = new Date();

  return (
    <div className="flex flex-col gap-6">
      {/* never "not proposed" for "could not tell" */}
      {!proposals.ok ? (
        <p className="text-xs text-warning" role="status">
          Proposal history is unavailable just now — listings already proposed to this buyer cannot be marked.
        </p>
      ) : proposals.capped ? (
        <p className="text-xs text-text-3">
          &ldquo;Proposed&rdquo; marks cover this buyer&rsquo;s latest {proposals.proposals.length} proposals only.
        </p>
      ) : null}

      {active.map((req, i) => {
        const result = results[i]!;
        const rows: ContactMatchRow[] = result.rows.map(({ property, verdict }) => {
          // The price the SEARCH is about, not always the sale price: a rental
          // brief compares against `rent_price_month`, and printing
          // `asking_price` showed a rent match its sale figure — or "no price
          // set" — beside the chip saying the rent was within budget. One
          // rule, in lib/services/matching.ts, for the matcher and the desk.
          const shown = priceFor(req.transaction_type, property);
          const price =
            shown !== null
              ? ` · ${formatMoney(shown)}${req.transaction_type === "rent" ? " / month" : ""}`
              : " · no price set";
          const sent = proposedBy?.get(property.id) ?? null;
          return {
            listing: {
              id: property.id,
              reference: property.reference,
              status: property.status,
              visibility: property.visibility,
            },
            title: propertyTitle(property.title, property.reference),
            subline: `${property.reference}${price}${property.bedrooms !== null ? ` · ${property.bedrooms} bed` : ""}`,
            verdict,
            proposed: sent ? { date: formatDate(sent.createdAt), detail: proposedDetail(sent, now) } : null,
          };
        });
        return (
          <section key={req.id} className="flex flex-col gap-2">
            {active.length > 1 ? (
              <h3 className="text-sm font-medium text-text-1">
                {req.label || "Untitled search"}
              </h3>
            ) : null}

            {rows.length === 0 ? (
              <MatchEmpty
                text="Nothing on the books matches this search yet."
                href="/properties"
                action="Browse listings"
              />
            ) : (
              <>
                <MatchProposalList listKey={req.id} buyer={buyer} rows={rows} canAct={canAct} role={role} />
                <MatchFooter
                  shown={result.rows.length}
                  considered={result.considered}
                  capped={result.capped}
                />
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}
