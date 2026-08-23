import Link from "next/link";
import {
  MatchEmpty,
  MatchFooter,
  MatchReasons,
  ScoreBadge,
} from "@/components/features/shared/match-list";
import { findMatchingProperties } from "@/lib/queries/matches";
import type { MatchRequirement } from "@/lib/services/matching";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/utils/format";

/**
 * Properties that suit this buyer (0043, T-B6).
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
}: {
  requirements: RequirementForMatching[];
}) {
  const active = requirements.filter((r) => r.is_active);

  if (active.length === 0) {
    return (
      <MatchEmpty text="Add a saved search above and matching listings will appear here." />
    );
  }

  const supabase = await createClient();
  const results = await Promise.all(active.map((r) => findMatchingProperties(supabase, r)));

  return (
    <div className="flex flex-col gap-6">
      {active.map((req, i) => {
        const result = results[i]!;
        return (
          <section key={req.id} className="flex flex-col gap-2">
            {active.length > 1 ? (
              <h3 className="text-sm font-medium text-text-1">
                {req.label || "Untitled search"}
              </h3>
            ) : null}

            {result.rows.length === 0 ? (
              <MatchEmpty
                text="Nothing on the books matches this search yet."
                href="/properties"
                action="Browse listings"
              />
            ) : (
              <>
                <ul className="flex flex-col gap-2">
                  {result.rows.map(({ property, verdict }) => (
                    <li
                      key={property.id}
                      className="rounded-[10px] border border-border bg-surface p-3"
                    >
                      <div className="flex items-start gap-3">
                        <ScoreBadge score={verdict.score} />
                        <div className="min-w-0 flex-1">
                          <Link
                            href={`/properties/${property.id}`}
                            className="text-sm font-medium text-text-1 underline-offset-2 hover:underline"
                          >
                            {propertyTitle(property.title, property.reference)}
                          </Link>
                          <p className="text-xs text-text-3">
                            {property.reference}
                            {property.asking_price !== null
                              ? ` · ${formatMoney(property.asking_price)}`
                              : " · no price set"}
                            {property.bedrooms !== null ? ` · ${property.bedrooms} bed` : ""}
                          </p>
                          <MatchReasons verdict={verdict} />
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
            )}
          </section>
        );
      })}
    </div>
  );
}
