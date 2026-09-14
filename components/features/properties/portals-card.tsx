"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { deselectPortal, selectPortal } from "@/lib/actions/portals";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/utils/format";

/**
 * Which portals this listing is on (spec 2026-09-14 §Property page).
 *
 * THE REASONS COME FROM THE SAME FUNCTION THE FEED USES. `eligibilityFor` is
 * what decides whether the portal's document carries this listing, so a
 * disabled toggle here names exactly why the listing would be missing from
 * that feed — rather than a second, kinder list of rules that would drift
 * from the one the crawler actually meets. A selection whose listing has
 * since become ineligible keeps its Remove button: the row exists, and the
 * desk must be able to undo it.
 *
 * No website revalidation on either action: the site's feed is built from
 * `public_listings`, which knows nothing about portal selection, so the
 * public site is unaffected by anything on this card. The actions revalidate
 * this property's page and `router.refresh()` picks the new state up.
 */

export interface PortalRow {
  id: string;
  name: string;
  /** ok, or the desk sentences (already portal-specific) for each failing reason */
  eligibility: { ok: true } | { ok: false; reasons: string[] };
  selected: { at: string; byName: string | null } | null;
  lastPulledAt: string | null;
}

export function PortalsCard({
  propertyId,
  portals,
  readOnly,
}: {
  propertyId: string;
  portals: PortalRow[];
  readOnly: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const toggle = (row: PortalRow) => {
    const wasSelected = row.selected !== null;
    start(async () => {
      const result = wasSelected
        ? await deselectPortal(propertyId, row.id)
        : await selectPortal(propertyId, row.id);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success(
        wasSelected
          ? `Removed from ${row.name} at its next pull`
          : `On ${row.name} at its next pull`,
      );
      router.refresh();
    });
  };

  if (portals.length === 0) {
    return (
      <section
        className="rounded-[10px] border border-border bg-surface p-5"
        data-testid="portals-card"
      >
        <h2 className="text-sm font-semibold text-text-1">Portals</h2>
        <p className="mt-1 text-sm text-text-2">
          No portal is enabled. An admin enables them under Settings → Portals.
        </p>
      </section>
    );
  }

  return (
    <section
      className="rounded-[10px] border border-border bg-surface p-5"
      data-testid="portals-card"
    >
      <h2 className="text-sm font-semibold text-text-1">Portals</h2>
      <p className="mt-1 text-sm text-text-2">
        Where this listing is advertised beyond the website. A portal picks the change up at its
        next pull.
      </p>

      <ul className="mt-4 divide-y divide-border">
        {portals.map((row) => {
          const selected = row.selected;
          return (
            <li
              key={row.id}
              data-testid={`portal-row-${row.id}`}
              className="flex flex-wrap items-start justify-between gap-3 py-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-text-1">{row.name}</p>
                {selected ? (
                  <p className="mt-0.5 text-xs text-text-3">
                    Selected {formatDateTime(selected.at)}
                    {selected.byName ? ` by ${selected.byName}` : ""}
                  </p>
                ) : null}
                <p className="mt-0.5 text-xs text-text-3">
                  {row.lastPulledAt
                    ? `Portal last pulled ${formatDateTime(row.lastPulledAt)}`
                    : "Portal has not pulled yet"}
                </p>
                {!row.eligibility.ok ? (
                  <ul className="mt-1 list-disc pl-4 text-xs text-warning">
                    {row.eligibility.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
              <Button
                type="button"
                size="sm"
                variant={selected ? "secondary" : "default"}
                data-testid={`portal-select-${row.id}`}
                // A listing that became ineligible AFTER it was selected keeps
                // Remove enabled — the feed already drops it, and the desk
                // still has to be able to take the row away.
                disabled={readOnly || pending || (!row.eligibility.ok && !selected)}
                onClick={() => toggle(row)}
              >
                {selected ? "Remove" : "Select"}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
