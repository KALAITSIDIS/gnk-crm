"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { AlertTriangle, Percent } from "lucide-react";
import { computePricing, hasPricingInsight } from "@/lib/services/commission";
import { formatMoney } from "@/lib/utils/format";

/**
 * The arithmetic between Asking price, Min acceptable and Owner net.
 *
 * LIVE, not a snapshot of what was saved. An agent on the phone wants to try
 * "what if I take 240?" and see whether the owner still gets their number — a
 * panel that only updated on save would answer the previous question.
 *
 * It reads the values on INPUT BUBBLE rather than owning them. The three fields
 * stay uncontrolled `defaultValue` inputs exactly as they were: converting a
 * working form's fields to controlled state to feed a read-only panel is a lot
 * of risk for a display, and `name` is all the form ever needed.
 *
 * `commissionPct` comes from `mandates_safe`, which is NULL for anyone who is
 * not an admin or the property's assigned agent. Nothing is derived from null,
 * so the panel simply does not appear — the masking upstream IS the permission
 * check, and re-implementing it here would be a second copy to drift.
 */

function Row({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: "muted" | "strong";
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs uppercase tracking-wide text-text-3">{label}</span>
      <span
        className={
          "tabular-nums " +
          (tone === "strong"
            ? "text-lg font-semibold text-text-1"
            : tone === "muted"
              ? "text-sm text-text-2"
              : "text-sm text-text-1")
        }
      >
        {value}
      </span>
      {hint ? <span className="text-xs text-text-3">{hint}</span> : null}
    </div>
  );
}

export function PricingBreakdown({
  commissionPct,
  askingPrice,
  minAcceptablePrice,
  ownerNetPrice,
  children,
}: {
  commissionPct: number | string | null;
  askingPrice: number | string | null;
  minAcceptablePrice: number | string | null;
  ownerNetPrice: number | string | null;
  /** the Pricing fields themselves — wrapped so their input events bubble here */
  children: ReactNode;
}) {
  const [live, setLive] = useState<{
    asking: number | string | null;
    min: number | string | null;
    net: number | string | null;
  }>({ asking: askingPrice, min: minAcceptablePrice, net: ownerNetPrice });

  const onInput = (e: FormEvent<HTMLDivElement>) => {
    const target = e.target as HTMLInputElement;
    const form = target.form;
    if (!form || !target.name) return;
    const read = (n: string) => {
      const el = form.elements.namedItem(n);
      const v = el instanceof HTMLInputElement ? el.value.trim() : "";
      return v === "" ? null : v;
    };
    setLive({
      asking: read("asking_price"),
      min: read("min_acceptable_price"),
      net: read("owner_net_price"),
    });
  };

  const b = computePricing({
    askingPrice: live.asking,
    minAcceptablePrice: live.min,
    ownerNetPrice: live.net,
    commissionPct,
  });

  return (
    <div onInput={onInput}>
      {children}

      {hasPricingInsight(b) ? (
        <div className="mt-4 rounded-[10px] border border-border bg-surface-2 p-4">
          <div className="flex items-center gap-1.5">
            <Percent className="size-3.5 text-text-3" />
            <h3 className="text-sm font-semibold text-text-1">
              At {b.commissionPct}% commission
            </h3>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Row
              label="Commission at asking"
              value={b.commissionAtAsking === null ? "—" : formatMoney(b.commissionAtAsking)}
            />
            <Row
              label="Owner nets at asking"
              value={b.ownerNetsAtAsking === null ? "—" : formatMoney(b.ownerNetsAtAsking)}
            />
            <Row
              label="Floor"
              value={b.floor === null ? "—" : formatMoney(b.floor)}
              tone={b.floor === null ? "muted" : "strong"}
              hint={
                b.floor === null
                  ? "set an owner net to see it"
                  : "lowest sale that still delivers the owner's net"
              }
            />
            <Row
              label="Owner net wanted"
              value={b.ownerNetTarget === null ? "—" : formatMoney(b.ownerNetTarget)}
              tone="muted"
            />
          </div>

          {/* The two states that cost money, named in euro rather than implied. */}
          {b.askingShortfall !== null ? (
            <p className="mt-3 flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-text-2">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-danger" />
              <span>
                Even at the full asking price the owner receives{" "}
                <span className="font-medium tabular-nums text-text-1">
                  {formatMoney(b.askingShortfall)}
                </span>{" "}
                less than the net they want. The asking price needs to be at least the floor.
              </span>
            </p>
          ) : null}

          {b.minAcceptableShortfall !== null ? (
            <p className="mt-2 flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-text-2">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
              <span>
                Selling at the min acceptable leaves the owner{" "}
                <span className="font-medium tabular-nums text-text-1">
                  {formatMoney(b.minAcceptableShortfall)}
                </span>{" "}
                short — the agency would have to cut its own commission to close it.
              </span>
            </p>
          ) : null}

          <p className="mt-3 text-xs text-text-3">
            {/* As a PERCENTAGE, not a rounded decimal: `.toFixed(2)` turned the
                0.965 behind a 3.5% rate into "0.96", and 200.000 / 0.96 is
                208.333 — an explanation that does not reproduce the figure
                beside it is worse than no explanation. */}
            Commission is charged on the sale price, so the floor is the net divided by{" "}
            {100 - (b.commissionPct ?? 0)}%, not the net plus the fee. Before VAT on the
            commission.
          </p>
        </div>
      ) : null}
    </div>
  );
}
