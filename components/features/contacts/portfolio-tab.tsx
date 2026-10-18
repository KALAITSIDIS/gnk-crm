import Link from "next/link";
import { Archive, Building2 } from "lucide-react";
import { StatusBadge } from "@/components/features/shared/status-badge";
import { formatMoney } from "@/lib/utils/format";
import type { Portfolio, PortfolioEntry } from "@/lib/services/contact-portfolio";

const ROLE_LABEL: Record<string, string> = {
  owner: "Owns",
  developer: "Built",
};

function labelize(value: string) {
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * The figure on an entry's row. A container shows what its units ask when they
 * carry prices — the figure the total counts. Without priced units it shows its
 * own "from" price, SAID to be one: that figure is not in the asking total
 * (F04), and a bare number beside the total would read as if it were.
 */
function rowFigure(e: PortfolioEntry): string {
  if (e.units && e.units.value > 0) return formatMoney(e.units.value);
  if ((e.kind === "project" || e.kind === "phase") && e.asking_price !== null) {
    return `from ${formatMoney(e.asking_price)}`;
  }
  return formatMoney(e.asking_price);
}

/**
 * What this contact owns or built (BACKLOG audit finding 9).
 *
 * The page a person opens before a call with a developer. Units are rolled up
 * into their project rather than listed — "40 available · 12 sold" answers the
 * question that sixty rows would bury, which is the same call the properties
 * list makes about units by default.
 *
 * The total is "Asking total (listings + units)" and means exactly that (F04):
 * standalone listings and units for sale, never a project's own "from" price
 * on top of the units it is priced from, never a rental's (it has no asking
 * price — the note says the total leaves rentals out instead of calling them
 * unpriced), and nothing archived. Archived records are listed apart and
 * counted nowhere; an archived unit whose container is here is grouped under
 * that container's reference, every unit named and linked — no other page
 * lists it.
 */
export function PortfolioTab({ portfolio }: { portfolio: Portfolio }) {
  if (portfolio.entries.length === 0 && portfolio.archivedCount === 0) {
    return (
      <p className="text-sm text-text-3">
        Nothing recorded against this contact yet. A property names them from its Parties panel,
        as owner or as developer.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {portfolio.entries.length === 0 ? (
        <p className="text-sm text-text-3">
          Nothing live recorded against this contact — only archived records, listed below.
        </p>
      ) : (
        <>
          <dl className="flex flex-wrap gap-x-8 gap-y-2 rounded-[10px] border border-border bg-surface-2 px-4 py-3">
            <div>
              <dt className="text-xs text-text-3">Properties</dt>
              <dd className="text-sm font-semibold tabular-nums text-text-1">
                {portfolio.propertyCount}
              </dd>
            </div>
            {portfolio.unitCount > 0 ? (
              <div>
                <dt className="text-xs text-text-3">Units</dt>
                <dd className="text-sm font-semibold tabular-nums text-text-1">
                  {portfolio.unitCount}
                </dd>
              </div>
            ) : null}
            <div>
              <dt className="text-xs text-text-3">Asking total (listings + units)</dt>
              <dd className="text-sm font-semibold tabular-nums text-text-1">
                {portfolio.totalValue > 0 ? formatMoney(portfolio.totalValue) : "—"}
                {/* a missing price is not a zero: say the total is short of it */}
                {portfolio.unpricedCount > 0 ? (
                  <span className="ml-2 text-xs font-normal text-text-3">
                    {portfolio.unpricedCount} without an asking price
                  </span>
                ) : null}
                {/* a rental has a monthly rent, not an asking price: not missing, not in it */}
                {portfolio.rentOnlyCount > 0 ? (
                  <span className="ml-2 text-xs font-normal text-text-3">
                    {portfolio.rentOnlyCount} for rent only, not in this total
                  </span>
                ) : null}
              </dd>
            </div>
          </dl>

          <ul className="flex flex-col divide-y divide-border/60 rounded-[10px] border border-border bg-surface">
            {portfolio.entries.map((e) => (
              <li key={e.id}>
                <Link
                  href={`/properties/${e.id}`}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 hover:bg-surface-2"
                >
                  <Building2 className="size-4 shrink-0 self-center text-text-3" />
                  <span className="font-mono text-sm font-medium text-brand-700">{e.reference}</span>
                  <span className="text-sm text-text-1">{e.title ?? labelize(e.property_type)}</span>
                  <span className="text-xs text-text-3">
                    {e.roles.map((r) => ROLE_LABEL[r]).join(" & ")}
                    {e.kind !== "standalone" ? ` · ${labelize(e.kind)}` : null}
                  </span>
                  <span className="ml-auto flex items-center gap-3">
                    {e.units ? (
                      <span className="text-xs tabular-nums text-text-2">
                        {e.units.total} units ·{" "}
                        {Object.entries(e.units.byStatus)
                          .map(([s, n]) => `${n} ${s.replace(/_/g, " ")}`)
                          .join(" · ")}
                      </span>
                    ) : null}
                    <span className="text-sm font-medium tabular-nums text-text-1">{rowFigure(e)}</span>
                    <StatusBadge status={e.status} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      {portfolio.archivedCount > 0 ? (
        // native <details>: closed by default, and its rows are plain links
        <details className="rounded-[10px] border border-border bg-surface">
          <summary className="cursor-pointer px-4 py-3 text-sm text-text-2">
            Archived — not counted ({portfolio.archivedCount})
          </summary>
          <ul className="flex flex-col divide-y divide-border/60 border-t border-border">
            {portfolio.archived.map((a) => (
              <li key={a.id}>
                <Link
                  href={`/properties/${a.id}`}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5 hover:bg-surface-2"
                >
                  <Archive className="size-4 shrink-0 self-center text-text-3" />
                  <span className="font-mono text-sm text-text-2">{a.reference}</span>
                  <span className="text-sm text-text-2">{a.title ?? labelize(a.property_type)}</span>
                  <span className="text-xs text-text-3">
                    {a.roles.map((r) => ROLE_LABEL[r]).join(" & ")}
                    {a.kind !== "standalone" ? ` · ${labelize(a.kind)}` : null}
                  </span>
                </Link>
              </li>
            ))}
            {/* archived units under a container shown above: one row per
                container, every unit linked — its units page lists none */}
            {portfolio.archivedUnits.map((g) => (
              <li
                key={`units-of-${g.containerId}`}
                data-testid="portfolio-archived-units"
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5"
              >
                <Archive className="size-4 shrink-0 self-center text-text-3" />
                {/* the container itself is a row of its own, live or archived */}
                <span className="text-sm text-text-2">
                  {`${g.units.length} archived unit${g.units.length === 1 ? "" : "s"} of ${g.containerReference}`}
                </span>
                <span className="flex flex-wrap gap-x-2 gap-y-1">
                  {g.units.map((u) => (
                    <Link
                      key={u.id}
                      href={`/properties/${u.id}`}
                      className="font-mono text-xs text-brand-700 hover:underline"
                    >
                      {u.reference}
                    </Link>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
