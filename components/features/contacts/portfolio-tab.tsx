import Link from "next/link";
import { Building2 } from "lucide-react";
import { StatusBadge } from "@/components/features/shared/status-badge";
import { formatMoney } from "@/lib/utils/format";
import type { Portfolio } from "@/lib/services/contact-portfolio";

const ROLE_LABEL: Record<string, string> = {
  owner: "Owns",
  developer: "Built",
};

function labelize(value: string) {
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * What this contact owns or built (BACKLOG audit finding 9).
 *
 * The page a person opens before a call with a developer. Units are rolled up
 * into their project rather than listed — "40 available · 12 sold" answers the
 * question that sixty rows would bury, which is the same call the properties
 * list makes about units by default.
 */
export function PortfolioTab({ portfolio }: { portfolio: Portfolio }) {
  if (portfolio.entries.length === 0) {
    return (
      <p className="text-sm text-text-3">
        Nothing recorded against this contact yet. A property names them from its Parties panel,
        as owner or as developer.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
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
          <dt className="text-xs text-text-3">Total asking</dt>
          <dd className="text-sm font-semibold tabular-nums text-text-1">
            {portfolio.totalValue > 0 ? formatMoney(portfolio.totalValue) : "—"}
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
                <span className="text-sm font-medium tabular-nums text-text-1">
                  {formatMoney(e.units && e.units.value > 0 ? e.units.value : e.asking_price)}
                </span>
                <StatusBadge status={e.status} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
