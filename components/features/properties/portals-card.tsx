"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { deselectPortal, selectPortal } from "@/lib/actions/portals";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/utils/format";
// A TYPE-ONLY import, so nothing from the service module — and nothing it
// imports — reaches the browser bundle. `PortalRow` is declared there because
// that is where the rows are built; two declarations of the same shape would
// drift.
import type { PortalRow, PortalRowState } from "@/lib/services/portals/property-portals";

/**
 * Which portals this listing is selected for, and whether each one's feed
 * carries it (spec 2026-09-14 §Property page; portal integrations audit
 * 2026-10-18, finding 7).
 *
 * WHAT IT CAN AND CANNOT SAY. The CRM knows a listing is SELECTED, whether it
 * passes the portal's requirements and so is IN THE FEED the portal is
 * offered, and when the feed URL was last requested. It never learns whether
 * the portal accepted or published it — so no row says "on", "live" or
 * "published", and the card says where to check instead.
 *
 * THE REASONS COME FROM THE SAME FUNCTION THE FEED USES. `eligibilityFor` is
 * what decides whether the portal's document carries this listing, so a
 * disabled toggle here names exactly why the listing would be missing from
 * that feed, each with a link to the tab that fixes it. A selection whose
 * listing has since become ineligible keeps its Remove button: the row
 * exists, and the desk must be able to undo it.
 *
 * No website revalidation on either action: the site's feed knows nothing
 * about portal selection. The actions revalidate this property's page and
 * `router.refresh()` picks the new state up — including after a FAILURE,
 * because the commonest failure is a row someone else has already removed.
 */

const STATE_TEXT: Record<PortalRowState, string> = {
  in_feed: "Selected · in the feed this portal is offered",
  excluded: "Selected · left out of the feed until the reasons below are fixed",
  off_site: "Selected · not sent while the listing is off the website (sold, withdrawn or private)",
  switched_off: "Selected · the portal is switched off, so no feed carries it — enabling the portal puts it back",
  not_selected: "Not selected",
};

const STATE_CLASS: Record<PortalRowState, string> = {
  in_feed: "text-text-2",
  excluded: "text-warning",
  off_site: "text-text-3",
  switched_off: "text-text-3",
  not_selected: "text-text-3",
};

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
          ? `Deselected — dropped from the ${row.name} feed at its next request`
          : `Selected for ${row.name} — it goes into the feed at its next request; ${row.name} decides whether to publish it`,
      );
      // saved, but its timeline line could not be written or confirmed
      if (result.notice) toast.warning(result.notice);
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
        Where this listing can be offered beyond the website. A portal sees a change at its next
        request to the feed; whether it publishes the listing is its own decision, and it does not
        tell the CRM.
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
          // An off-site selection is not a failure, so it lists no reasons to
          // fix (that would offer to put a sold listing back on the website).
          const reasons = row.eligibility.ok || row.state === "off_site" ? null : row.eligibility.reasons;
          const notRequestedSince =
            selected && row.connectionEnabled && (!row.lastRequestedAt || row.lastRequestedAt < selected.at);
          return (
            <li
              key={row.id}
              data-testid={`portal-row-${row.id}`}
              className="flex flex-wrap items-start justify-between gap-3 py-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-text-1">{row.name}</p>
                <p className={`mt-0.5 text-xs ${STATE_CLASS[row.state]}`} data-testid={`portal-state-${row.id}`}>
                  {STATE_TEXT[row.state]}
                </p>
                {selected ? (
                  <p className="mt-0.5 text-xs text-text-3">
                    Selected {formatDateTime(selected.at)}
                    {selected.byName ? ` by ${selected.byName}` : ""}
                  </p>
                ) : null}
                {row.connectionEnabled ? (
                  <p className="mt-0.5 text-xs text-text-3">
                    {row.lastRequestedAt
                      ? `Feed URL last requested ${formatDateTime(row.lastRequestedAt)}${
                          notRequestedSince ? " — not since this listing was selected" : ""
                        }`
                      : "The feed URL has not been requested yet"}
                  </p>
                ) : null}
                {reasons ? (
                  <ul id={reasonsId} className="mt-1 list-disc pl-4 text-xs text-warning">
                    {reasons.map((reason) => (
                      <li key={reason.text}>
                        {reason.text}{" "}
                        {reason.fixTab ? (
                          <Link
                            href={`/properties/${propertyId}?tab=${reason.fixTab}`}
                            className="text-brand underline underline-offset-2"
                          >
                            Fix
                          </Link>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {row.advisories.length ? (
                  <ul className="mt-1 list-disc pl-4 text-xs text-text-3" data-testid={`portal-advisories-${row.id}`}>
                    {row.advisories.map((a) => (
                      <li key={a}>{a}</li>
                    ))}
                  </ul>
                ) : null}
                {selected && row.publicationCheck ? (
                  <p className="mt-1 text-xs text-text-3">Whether it is published: {row.publicationCheck}</p>
                ) : null}
              </div>
              {/* A switched-off portal is never offered Select: the connection
                  is the admin's to make. Remove stays, so an existing
                  selection can still be taken back. */}
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
