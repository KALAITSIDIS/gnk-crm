"use client";

import { useMemo, useState } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import {
  computeStampDuty,
  computeTransferFees,
  type BandRow,
  type StampDutyConfig,
  type TransferFeesConfig,
} from "@/lib/services/calculators";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDate, formatMoney } from "@/lib/utils/format";

function pct(rate: number) {
  return `${(rate * 100).toLocaleString("en-GB", { maximumFractionDigits: 2 })}%`;
}

function bandLabel(b: BandRow) {
  return b.to === null
    ? `above ${formatMoney(b.from)}`
    : `${formatMoney(b.from)} – ${formatMoney(b.to)}`;
}

function FreshnessLine({ verifiedAt }: { verifiedAt: string | null }) {
  return (
    <p className="text-xs text-text-3">
      Rates from config, last verified {verifiedAt ? formatDate(verifiedAt) : "never"} — verify
      current legislation.
    </p>
  );
}

function BandTable({ rows }: { rows: BandRow[] }) {
  if (rows.length === 0) return null;
  return (
    <ul className="flex flex-col divide-y divide-border/60 text-sm">
      {rows.map((b, i) => (
        <li key={i} className="flex items-baseline justify-between gap-4 py-1.5">
          <span className="text-text-2">
            {bandLabel(b)} <span className="text-xs text-text-3">@ {pct(b.rate)}</span>
          </span>
          <span className="tabular-nums text-text-1">{formatMoney(b.fee)}</span>
        </li>
      ))}
    </ul>
  );
}

function copyText(text: string) {
  const fallback = () => {
    // execCommand path for contexts where the async Clipboard API is blocked
    // (embedded panes, missing transient activation)
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    if (ok) toast.success("Summary copied");
    else toast.error("Could not copy");
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success("Summary copied"))
      .catch(fallback);
  } else {
    fallback();
  }
}

export function CalculatorsClient({
  transferConfig,
  transferVerifiedAt,
  stampConfig,
  stampVerifiedAt,
  initialPrice,
}: {
  transferConfig: TransferFeesConfig | null;
  transferVerifiedAt: string | null;
  stampConfig: StampDutyConfig | null;
  stampVerifiedAt: string | null;
  initialPrice: number | null;
}) {
  const [priceInput, setPriceInput] = useState(initialPrice ? String(initialPrice) : "");
  const [purchasersInput, setPurchasersInput] = useState("1");
  const [relief, setRelief] = useState(true); // default ON (doc 02 §C8)
  const [vatPaid, setVatPaid] = useState(false);

  const price = Number(priceInput);
  const valid = Number.isFinite(price) && price > 0;
  // the service normalises anything odd, but keep the field usable while typing
  const purchasers = Math.max(1, Math.floor(Number(purchasersInput) || 1));

  const transfer = useMemo(
    () =>
      valid && transferConfig
        ? computeTransferFees(price, transferConfig, { relief, vatPaid, purchasers })
        : null,
    [valid, price, transferConfig, relief, vatPaid, purchasers],
  );
  const stamp = useMemo(
    () => (valid && stampConfig ? computeStampDuty(price, stampConfig) : null),
    [valid, price, stampConfig],
  );

  const joint = transfer !== null && transfer.purchasers > 1;

  // UX-4: a VAT-paid purchase is exempt outright, so the relief toggle cannot
  // move the total. Mirror `computeTransferFees`'s own early-return condition
  // exactly (`vatPaid && config.vat_paid_exempt`) rather than just `vatPaid` —
  // a config with `vat_paid_exempt: false` still charges fees, and there relief
  // must stay live. The tick is disabled, never reset: un-ticking VAT gives the
  // agent back the choice they had made.
  const reliefMoot = vatPaid && transferConfig?.vat_paid_exempt === true;

  const transferSummary =
    transfer &&
    [
      `Transfer fees for ${formatMoney(price)}` +
        (joint ? ` (${transfer.purchasers} purchasers):` : ":"),
      ...(transfer.vatExempt
        ? ["No transfer fees — transaction was subject to VAT."]
        : [
            ...(joint
              ? [`Assessed per purchaser on ${formatMoney(price / transfer.purchasers)} each:`]
              : []),
            ...transfer.rows.map((b) => `  ${bandLabel(b)} @ ${pct(b.rate)} = ${formatMoney(b.fee)}`),
            ...(joint
              ? [
                  `Per purchaser: ${formatMoney(transfer.perShareGross)}`,
                  `× ${transfer.purchasers} purchasers = ${formatMoney(transfer.gross)}`,
                ]
              : [`Gross: ${formatMoney(transfer.gross)}`]),
            ...(transfer.reliefApplied
              ? [`50% relief: −${formatMoney(transfer.reliefAmount)}`]
              : []),
            `Total: ${formatMoney(transfer.total)}`,
          ]),
      "Rates from config — verify current legislation.",
    ].join("\n");

  const stampSummary =
    stamp &&
    [
      `Stamp duty for ${formatMoney(price)}:`,
      ...stamp.rows.map((b) => `  ${bandLabel(b)} @ ${pct(b.rate)} = ${formatMoney(b.fee)}`),
      ...(stamp.capApplied
        ? [`Uncapped: ${formatMoney(stamp.uncapped)} → capped at ${formatMoney(stamp.cap)}`]
        : []),
      `Total: ${formatMoney(stamp.total)}`,
      "Rates from config — verify current legislation.",
    ].join("\n");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex w-full max-w-xs flex-col gap-1.5">
          <Label htmlFor="calc-price">Purchase price (€)</Label>
          <Input
            id="calc-price"
            type="number"
            min="0"
            value={priceInput}
            onChange={(e) => setPriceInput(e.target.value)}
            placeholder="e.g. 300000"
          />
        </div>
        {/* The DLS scale restarts for each purchaser's share, so a joint
            purchase is materially cheaper than a sole one (finding CALC-1). */}
        <div className="flex w-32 flex-col gap-1.5">
          <Label htmlFor="calc-purchasers">Purchasers</Label>
          <Input
            id="calc-purchasers"
            type="number"
            min="1"
            step="1"
            value={purchasersInput}
            onChange={(e) => setPurchasersInput(e.target.value)}
          />
          <p className="text-xs text-text-3">Equal shares</p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="flex flex-col gap-3 rounded-[10px] border border-border bg-surface p-5">
          <h2 className="text-sm font-semibold text-text-1">Transfer fees (DLS)</h2>
          {!transferConfig ? (
            <p className="text-sm text-danger">transfer_fees config missing or malformed.</p>
          ) : (
            <>
              <div className="flex flex-col gap-2">
                <label
                  className={
                    reliefMoot
                      ? "flex items-center gap-2 text-sm text-text-3"
                      : "flex items-center gap-2 text-sm text-text-1"
                  }
                >
                  <Checkbox
                    checked={relief}
                    disabled={reliefMoot}
                    onCheckedChange={(v) => setRelief(v === true)}
                  />
                  Apply 50% relief (transfers not subject to VAT)
                </label>
                {reliefMoot ? (
                  <p className="pl-6 text-xs text-text-3">
                    No relief to apply — a VAT-paid purchase carries no transfer fee.
                  </p>
                ) : null}
                <label className="flex items-center gap-2 text-sm text-text-1">
                  <Checkbox
                    checked={vatPaid}
                    onCheckedChange={(v) => setVatPaid(v === true)}
                  />
                  VAT was paid on this purchase
                </label>
              </div>

              {transfer ? (
                transfer.vatExempt ? (
                  <p className="rounded-lg bg-success/10 px-3 py-2 text-sm text-success">
                    No transfer fees — the transaction was subject to VAT.
                  </p>
                ) : (
                  <>
                    {joint ? (
                      <p className="text-xs text-text-3">
                        Assessed per purchaser on{" "}
                        <span className="tabular-nums text-text-2">
                          {formatMoney(price / transfer.purchasers)}
                        </span>{" "}
                        each — the bands restart for every buyer.
                      </p>
                    ) : null}
                    <BandTable rows={transfer.rows} />
                    <dl className="flex flex-col gap-1 border-t border-border pt-2 text-sm">
                      {joint ? (
                        <div className="flex justify-between">
                          <dt className="text-text-2">
                            Per purchaser × {transfer.purchasers}
                          </dt>
                          <dd className="tabular-nums text-text-1">
                            {formatMoney(transfer.perShareGross)}
                          </dd>
                        </div>
                      ) : null}
                      <div className="flex justify-between">
                        <dt className="text-text-2">Gross</dt>
                        <dd className="tabular-nums text-text-1">{formatMoney(transfer.gross)}</dd>
                      </div>
                      {transfer.reliefApplied ? (
                        <div className="flex justify-between">
                          <dt className="text-text-2">50% relief</dt>
                          <dd className="tabular-nums text-success">
                            −{formatMoney(transfer.reliefAmount)}
                          </dd>
                        </div>
                      ) : null}
                      <div className="flex justify-between text-base font-semibold">
                        <dt className="text-text-1">Total</dt>
                        <dd className="tabular-nums text-text-1">{formatMoney(transfer.total)}</dd>
                      </div>
                    </dl>
                  </>
                )
              ) : (
                <p className="text-sm text-text-3">Enter a price to calculate.</p>
              )}

              <div className="mt-auto flex items-center justify-between gap-3 pt-1">
                <FreshnessLine verifiedAt={transferVerifiedAt} />
                {transfer && transferSummary ? (
                  <Button size="sm" variant="outline" onClick={() => copyText(transferSummary)}>
                    <Copy className="size-4" /> Copy summary
                  </Button>
                ) : null}
              </div>
            </>
          )}
        </section>

        <section className="flex flex-col gap-3 rounded-[10px] border border-border bg-surface p-5">
          <h2 className="text-sm font-semibold text-text-1">Stamp duty</h2>
          {!stampConfig ? (
            <p className="text-sm text-danger">stamp_duty config missing or malformed.</p>
          ) : stamp ? (
            <>
              <BandTable rows={stamp.rows} />
              <dl className="flex flex-col gap-1 border-t border-border pt-2 text-sm">
                {stamp.capApplied ? (
                  <div className="flex justify-between">
                    <dt className="text-text-2">Uncapped</dt>
                    <dd className="tabular-nums text-text-2 line-through">
                      {formatMoney(stamp.uncapped)}
                    </dd>
                  </div>
                ) : null}
                <div className="flex justify-between text-base font-semibold">
                  <dt className="text-text-1">
                    Total{stamp.capApplied ? ` (capped at ${formatMoney(stamp.cap)})` : ""}
                  </dt>
                  <dd className="tabular-nums text-text-1">{formatMoney(stamp.total)}</dd>
                </div>
              </dl>
              <div className="mt-auto flex items-center justify-between gap-3 pt-1">
                <FreshnessLine verifiedAt={stampVerifiedAt} />
                {stampSummary ? (
                  <Button size="sm" variant="outline" onClick={() => copyText(stampSummary)}>
                    <Copy className="size-4" /> Copy summary
                  </Button>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-text-3">Enter a price to calculate.</p>
              <div className="mt-auto pt-1">
                <FreshnessLine verifiedAt={stampVerifiedAt} />
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
