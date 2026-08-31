"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { AlertTriangle, Info, Receipt } from "lucide-react";
import { deriveVat, type VatConfigRow, type VatStatus } from "@/lib/services/vat";
import { formatMoney } from "@/lib/utils/format";

/**
 * The VAT treatment of a sale, derived live from what is on the form.
 *
 * WHY IT WRAPS TWO SECTIONS. The derivation needs the price (Pricing) and the
 * covered area (Areas & rooms), which sit in different parts of the form. The
 * `read` below goes through `target.form`, so it can see any named field — but
 * a re-render only happens for input events that BUBBLE to this element. Wrap
 * only Pricing and typing a new covered area would silently leave the panel
 * showing the previous answer, which is worse than not showing one.
 *
 * Same live-not-saved stance as PricingBreakdown, for the same reason: the
 * question is asked mid-negotiation ("what if we come down to 470?"), and the
 * cliff below is exactly the kind of thing you want to see BEFORE agreeing a
 * price rather than after saving one.
 *
 * The fields stay uncontrolled. Nothing here writes to the form.
 */
export function VatTreatment({
  config,
  configVerifiedAt,
  askingPrice,
  coveredAreaSqm,
  vatStatus,
  children,
}: {
  config: VatConfigRow | null;
  configVerifiedAt: string | null;
  askingPrice: number | string | null;
  coveredAreaSqm: number | string | null;
  vatStatus: VatStatus | null;
  /** Pricing and Areas & rooms — wrapped so their input events bubble here. */
  children: ReactNode;
}) {
  const [live, setLive] = useState<{
    price: number | string | null;
    area: number | string | null;
    status: VatStatus | null;
  }>({ price: askingPrice, area: coveredAreaSqm, status: vatStatus });

  const onInput = (e: FormEvent<HTMLDivElement>) => {
    const target = e.target as HTMLInputElement | HTMLSelectElement;
    const form = target.form;
    if (!form || !target.name) return;
    // NOTE: vat_status is a <select>, so this cannot narrow to HTMLInputElement
    // the way PricingBreakdown does — that would read "" for the status and the
    // panel would think every property was `unknown`.
    const read = (n: string): string | null => {
      const el = form.elements.namedItem(n);
      const v =
        el instanceof HTMLInputElement || el instanceof HTMLSelectElement ? el.value.trim() : "";
      return v === "" ? null : v;
    };
    setLive({
      price: read("asking_price"),
      area: read("covered_area_sqm"),
      status: (read("vat_status") as VatStatus | null) ?? null,
    });
  };

  const t = deriveVat({
    coveredAreaSqm: live.area,
    price: live.price,
    vatStatus: live.status,
    config,
    configVerifiedAt,
  });

  return (
    <div onInput={onInput} onChange={onInput}>
      {children}

      <div className="mt-4 rounded-[10px] border border-border bg-surface-2 p-4">
        <div className="flex items-center gap-1.5">
          <Receipt className="size-3.5 text-text-3" />
          <h3 className="text-sm font-semibold text-text-1">VAT treatment</h3>
          <span className="ml-auto text-xs text-text-3">derived, not saved</span>
        </div>

        {/* ---------------------------------------------------- the numbers -- */}
        {t.bands.length > 0 ? (
          <div className="mt-3 flex flex-col gap-2">
            {t.bands.map((b) => (
              <div
                key={b.rate}
                className="flex items-baseline justify-between gap-4 text-sm tabular-nums"
              >
                <span className="text-text-2">
                  {formatMoney(b.base)} at {(b.rate * 100).toFixed(0)}%
                </span>
                <span className="font-medium text-text-1">{formatMoney(b.vat)}</span>
              </div>
            ))}
            <div className="mt-1 flex items-baseline justify-between gap-4 border-t border-border pt-2 text-sm tabular-nums">
              <span className="font-semibold text-text-1">VAT</span>
              <span className="text-lg font-semibold text-text-1">
                {t.totalVat === null ? "—" : formatMoney(t.totalVat)}
              </span>
            </div>
            {t.totalWithVat !== null ? (
              <div className="flex items-baseline justify-between gap-4 text-xs tabular-nums text-text-3">
                <span>Price including VAT</span>
                <span>{formatMoney(t.totalWithVat)}</span>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* ------------------------------------------- the cliff, from below */}
        {t.nearCliff ? (
          <div className="mt-3 flex gap-2 rounded-[8px] border border-warning/40 bg-warning/10 p-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="text-sm">
              <p className="font-semibold text-text-1">
                {t.nearCliff.kind === "value"
                  ? `${formatMoney(t.nearCliff.headroom)} under the total cap`
                  : `${t.nearCliff.headroom} m² under the total cap`}{" "}
                — crossing it would cost {formatMoney(t.nearCliff.wouldCostEur)} in VAT relief.
              </p>
              <p className="mt-0.5 text-text-2">
                One over-ask standard-rates the whole purchase, not just the excess. Worth
                knowing before the price moves.
              </p>
            </div>
          </div>
        ) : null}

        {/* -------------------------------------------------------- the cliff */}
        {t.cliff ? (
          <div className="mt-3 flex gap-2 rounded-[8px] border border-warning/40 bg-warning/10 p-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="text-sm">
              <p className="font-semibold text-text-1">
                {t.cliff.kind === "value"
                  ? `${formatMoney(t.cliff.over)} over the cap`
                  : `${t.cliff.over} m² over the cap`}{" "}
                — that costs {formatMoney(t.cliff.costsEur)} in VAT relief.
              </p>
              <p className="mt-0.5 text-text-2">
                Crossing a total cap standard-rates the whole purchase, not just the excess.
              </p>
            </div>
          </div>
        ) : null}

        {/* ------------------------------------------- contradicts the record */}
        {t.conflictsWithDeclaration ? (
          <div className="mt-3 flex gap-2 rounded-[8px] border border-danger/40 bg-danger/10 p-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
            <div className="text-sm">
              <p className="font-semibold text-text-1">
                VAT status says “Reduced rate eligible”, but these figures refuse it.
              </p>
              <p className="mt-0.5 text-text-2">
                Buyer matching trusts the stored status, so this property may be offered to buyers
                on a rate it cannot have.
              </p>
            </div>
          </div>
        ) : null}

        {/* --------------------------------------------- the transitional out */}
        {t.transitionalMayHelp ? (
          <div className="mt-3 flex gap-2 rounded-[8px] border border-border bg-surface-1 p-3">
            <Info className="mt-0.5 size-4 shrink-0 text-text-3" />
            <div className="text-sm">
              <p className="text-text-1">
                Transitional rules may still apply until {t.transitionalMayHelp.deadline}:{" "}
                {t.transitionalMayHelp.oldRule}.
              </p>
              <p className="mt-0.5 text-text-2">
                They need a planning permit issued, or applied for, by 31 October 2023 — which is
                not recorded here. Check the permit before quoting.
              </p>
              {t.transitionalMayHelp.condition ? (
                // 0079: the deadline is conditional, and for one subset it has
                // already lapsed — that reads as a warning, not a footnote
                <p className="mt-0.5 font-medium text-warning">
                  Condition: {t.transitionalMayHelp.condition}.
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* ------------------------------------------------------- the rule -- */}
        {t.reasons.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-1 text-sm text-text-2">
            {t.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ) : null}

        {/* THE BUYER HALF, WHICH A PROPERTY ROW CANNOT KNOW. Always stated for a
            reduced-rate result, because the figure above is conditional on it
            and a number without its condition is how a wrong quote happens. */}
        {t.outcome === "reduced_possible" ? (
          <p className="mt-3 text-xs text-text-3">
            Conditional on the buyer: a natural person, first and primary residence, held 10 years,
            one per person or couple. Nothing here can check that.
          </p>
        ) : null}

        {t.assumptions.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-1 text-xs text-text-3">
            {t.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
