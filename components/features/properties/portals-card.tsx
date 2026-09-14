"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { deselectPortal, selectPortal } from "@/lib/actions/portals";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/utils/format";
// A TYPE-ONLY import, so nothing from the service module — and nothing it
// imports — reaches the browser bundle. `PortalRow` is declared there because
// that is where the rows are built; two declarations of the same shape would
// drift.
import type { PortalRow } from "@/lib/services/portals/property-portals";

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
 * this property's page and `router.refresh()` picks the new state up —
 * including after a FAILURE, because the commonest failure is a row someone
 * else has already removed, and not refreshing would leave the desk clicking
 * a button that can no longer do anything.
 */

export function PortalsCard({
  propertyId,
  portals,
  photoNote,
  readOnly,
}: {
  propertyId: string;
  portals: PortalRow[];
  /** set when some photographs have no JPEG rendition yet */
  photoNote: string | null;
  readOnly: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  // One transition for the card, but only the row that was clicked says so.
  // Every button reading "Working…" at once claimed the desk had started
  // something on every portal.
  const [busyId, setBusyId] = useState<string | null>(null);

  const toggle = (row: PortalRow) => {
    const wasSelected = row.selected !== null;
    setBusyId(row.id);
    start(async () => {
      const result = wasSelected
        ? await deselectPortal(propertyId, row.id)
        : await selectPortal(propertyId, row.id);
      setBusyId(null);
      if (result.error) {
        toast.error(result.error);
        // The card may be describing a world that has moved on — another tab,
        // another agent — so take the refusal as a reason to re-read.
        router.refresh();
        return;
      }
      // Refresh FIRST: the toast says what is now true, and it should not be
      // readable a moment before the card it describes catches up.
      router.refresh();
      toast.success(
        wasSelected
          ? `Removed from ${row.name} at its next pull`
          : `On ${row.name} at its next pull`,
      );
    });
  };

  if (portals.length === 0) {
    return (
      <section
        className="rounded-[10px] border border-border bg-surface p-6"
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
      className="rounded-[10px] border border-border bg-surface p-6"
      data-testid="portals-card"
    >
      <h2 className="text-sm font-semibold text-text-1">Portals</h2>
      <p className="mt-1 text-sm text-text-2">
        Where this listing is advertised beyond the website. A portal picks the change up at its
        next pull.
      </p>
      {photoNote ? (
        <p className="mt-1 text-xs text-warning" data-testid="portals-photo-note">
          {photoNote}
        </p>
      ) : null}

      <ul className="mt-4 divide-y divide-border">
        {portals.map((row) => {
          const selected = row.selected;
          const reasonsId = `portal-reasons-${row.id}`;
          // Pulled out rather than tested inline: a boolean does not narrow
          // the discriminated union at the point the list is rendered.
          const reasons = row.eligibility.ok ? null : row.eligibility.reasons;
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
                {row.connectionEnabled ? (
                  <p className="mt-0.5 text-xs text-text-3">
                    {row.lastPulledAt
                      ? `Portal last pulled ${formatDateTime(row.lastPulledAt)}`
                      : "Portal has not pulled yet"}
                  </p>
                ) : (
                  // Disabling a portal leaves its selections in place, so this
                  // listing is one switch away from being published there again.
                  <p className="mt-0.5 text-xs text-text-3">
                    Portal is switched off — this listing goes out again if it is switched back on
                  </p>
                )}
                {reasons ? (
                  <ul id={reasonsId} className="mt-1 list-disc pl-4 text-xs text-warning">
                    {reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
              {/* A switched-off portal is never offered Select: the connection
                  is the admin's to make, and a row selected into a portal
                  nothing pulls is a promise the CRM cannot keep. Remove stays,
                  so an existing selection can still be taken back. */}
              {selected || row.connectionEnabled ? (
                <Button
                  type="button"
                  size="sm"
                  variant={selected ? "secondary" : "default"}
                  data-testid={`portal-select-${row.id}`}
                  aria-describedby={reasons ? reasonsId : undefined}
                  // A listing that became ineligible AFTER it was selected keeps
                  // Remove enabled — the feed already drops it, and the desk
                  // still has to be able to take the row away.
                  disabled={readOnly || pending || (!row.eligibility.ok && !selected)}
                  onClick={() => toggle(row)}
                >
                  {busyId === row.id ? "Working…" : selected ? "Remove" : "Select"}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
