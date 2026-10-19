import Link from "next/link";
import { StatusBadge } from "@/components/features/shared/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  AvailabilityPhaseRow,
  AvailabilityUnitRow,
  HoldView,
} from "@/lib/queries/container-availability";
import { groupByPhase, statusSummary } from "@/lib/services/share-links";
import { formatArea, formatDate, formatMoney } from "@/lib/utils/format";

/**
 * A unit's live hold in words — "Held to 12 Nov 2026 · buyer" — and, where the
 * unit's status says otherwise, a note (A05). The text is the server's
 * (`describeHold`, lib/queries/container-availability.ts); nothing here reads a
 * clock, so the server's render and the browser's agree. Shared with the
 * units matrix, which is a client component: this module stays free of
 * anything server-only.
 */
export function HoldSummary({ hold }: { hold: HoldView | null | undefined }) {
  if (!hold) return <span className="text-text-3">—</span>;
  return (
    <span className="flex flex-col gap-0.5 text-[13px]">
      {hold.label ? (
        <span className={hold.lapsed ? "text-warning" : "text-text-1"}>
          {hold.label}
          {hold.buyer ? <span className="text-text-2"> · {hold.buyer}</span> : null}
        </span>
      ) : (
        <span className="text-text-3">—</span>
      )}
      {hold.note ? <span className="text-xs text-warning">{hold.note}</span> : null}
    </span>
  );
}

export type OverviewUnit = AvailabilityUnitRow & { hold: HoldView };

function labelize(value: string) {
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** The unit's price as the detail page reads it: a let unit's rent, otherwise the asking price. */
function unitPrice(u: AvailabilityUnitRow): string {
  if (u.transaction_type === "rent") {
    return u.rent_price_month === null ? "—" : `${formatMoney(u.rent_price_month)}/mo`;
  }
  return formatMoney(u.asking_price);
}

const COLUMNS = 9;

/**
 * Every unit of a phased project, grouped by phase — READ-ONLY (review
 * 2026-10-18, A05).
 *
 * The project's own matrix shows its direct units only, by decision (reprice,
 * price lists and velocity act per node), so on a project whose units live
 * under its phases it was empty — "0 units", "No units yet" — over inventory
 * that exists. This answers "what is left in this development" in one table:
 * each phase with its OWN delivery date (severed from the project at creation,
 * BACKLOG 11) and its available count, each unit with its size, price, status,
 * live hold and delivery. Nothing here edits: a status changes in the unit's
 * own phase matrix, where the scope rules live.
 *
 * Grouped by the one rule the public availability page uses (`groupByPhase`).
 */
export function AvailabilityOverview({
  project,
  phases,
  units,
}: {
  project: { id: string; reference: string; delivery_date: string | null };
  phases: AvailabilityPhaseRow[];
  units: OverviewUnit[];
}) {
  const groups = groupByPhase({
    phases,
    units,
    phaseKey: (p) => p.id,
    // a unit directly under the project is its own group, first; any other
    // parent is a phase — one the list does not describe gets a bare heading
    unitPhaseKey: (u) => (u.parent_id === project.id ? null : u.parent_id),
    sortLabel: (p) => p.reference,
    placeholder: (id) => ({
      id,
      reference: id,
      title: null,
      status: "",
      delivery_date: null,
      construction_status: null,
    }),
  });
  const available = units.filter((u) => u.status === "available").length;

  return (
    <section
      aria-labelledby="availability-overview-heading"
      data-testid="availability-overview"
      className="rounded-[10px] border border-border bg-surface"
    >
      <div className="p-4">
        <h2 id="availability-overview-heading" className="text-base font-semibold text-text-1">
          Availability across phases
        </h2>
        <p className="mt-1 text-xs text-text-3">
          Every unit in {project.reference}, by phase — {available} of {units.length} available.
          Read-only: a unit&apos;s status is changed in its own phase&apos;s matrix, where reprices
          and price lists are kept per phase.
        </p>
      </div>
      <div className="border-t border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Unit</TableHead>
              <TableHead>Reference</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Beds</TableHead>
              <TableHead className="text-right">Covered</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="min-w-44">Hold</TableHead>
              <TableHead>Delivery</TableHead>
            </TableRow>
          </TableHeader>
          {groups.length === 0 ? (
            <TableBody>
              <TableRow>
                <TableCell colSpan={COLUMNS} className="py-8 text-center text-sm text-text-3">
                  No units yet in this project or its phases.
                </TableCell>
              </TableRow>
            </TableBody>
          ) : null}
          {groups.map((group) => {
            const phase = group.phase;
            // the date a unit is compared against: its phase's own, or the project's
            const groupDelivery = phase ? phase.delivery_date : project.delivery_date;
            const summary = statusSummary(group.units)
              .filter((s) => s.status !== "available")
              .map((s) => `${s.count} ${labelize(s.status).toLowerCase()}`);
            return (
              <TableBody key={phase?.id ?? "direct"} data-phase-group={phase?.reference ?? "direct"}>
                <TableRow className="bg-surface-2/60 hover:bg-surface-2/60">
                  <TableHead colSpan={COLUMNS} scope="colgroup" className="h-auto py-2 whitespace-normal">
                    <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1 font-normal">
                      {phase ? (
                        <Link
                          href={`/properties/${phase.id}/units`}
                          className="font-mono text-sm font-semibold text-brand-700 hover:underline"
                        >
                          {phase.reference}
                        </Link>
                      ) : (
                        <span className="text-sm font-semibold text-text-1">
                          Directly under {project.reference}
                        </span>
                      )}
                      {phase?.title ? <span className="text-sm text-text-1">{phase.title}</span> : null}
                      <span className="text-xs text-text-2">
                        {groupDelivery ? `delivery ${formatDate(groupDelivery)}` : "no delivery date"}
                        {phase?.construction_status ? ` · ${labelize(phase.construction_status).toLowerCase()}` : ""}
                      </span>
                      <span className="text-xs tabular-nums text-text-2">
                        {group.availableCount} of {group.units.length} available
                        {summary.length > 0 ? ` · ${summary.join(" · ")}` : ""}
                      </span>
                    </span>
                  </TableHead>
                </TableRow>
                {group.units.map((u) => {
                  const differs = u.delivery_date !== groupDelivery;
                  return (
                    <TableRow key={u.id} className="h-11 hover:bg-surface-2">
                      <TableCell className="font-medium">
                        {[u.block, u.unit_number].filter(Boolean).join("") || "—"}
                      </TableCell>
                      <TableCell>
                        <Link href={`/properties/${u.id}`} className="text-brand-700 hover:underline">
                          {u.reference}
                        </Link>
                      </TableCell>
                      <TableCell className="text-[13px]">{labelize(u.property_type)}</TableCell>
                      <TableCell className="text-right tabular-nums">{u.bedrooms ?? "—"}</TableCell>
                      <TableCell className="text-right tabular-nums text-[13px]">
                        {formatArea(u.covered_area_sqm)}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">{unitPrice(u)}</TableCell>
                      <TableCell>
                        <StatusBadge status={u.status} />
                      </TableCell>
                      <TableCell>
                        <HoldSummary hold={u.hold} />
                      </TableCell>
                      <TableCell className="text-[13px] tabular-nums">
                        {differs ? (
                          <span className="flex flex-col">
                            <span className="font-medium text-warning">{formatDate(u.delivery_date)}</span>
                            <span className="text-xs text-warning">
                              differs from the {phase ? "phase" : "project"}
                            </span>
                          </span>
                        ) : (
                          <span className="text-text-3">{formatDate(u.delivery_date)}</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            );
          })}
        </Table>
      </div>
    </section>
  );
}
