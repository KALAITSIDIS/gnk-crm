"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Copy } from "lucide-react";
import { toast } from "sonner";
import {
  bandLabel,
  buildStampSummary,
  buildTransferSummary,
  computeStampDuty,
  computeTransferScenario,
  pct,
  reliefLabel,
  VAT_SCENARIO_LABELS,
  VAT_SCENARIOS,
  type BandRow,
  type CalculatorPropertyContext,
  type StampDutyConfig,
  type TransferFeesConfig,
  type TransferFeesResult,
} from "@/lib/services/calculators";
import type { VatApplicability } from "@/lib/services/vat";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDate, formatMoney } from "@/lib/utils/format";

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

/** One assessment: the bands, then gross, relief and the total, under `totalLabel`. */
function Breakdown({
  price,
  result,
  totalLabel,
}: {
  price: number;
  result: TransferFeesResult;
  totalLabel: string;
}) {
  const joint = result.purchasers > 1;
  return (
    <>
      {joint ? (
        <p className="text-xs text-text-3">
          Assessed per purchaser on{" "}
          <span className="tabular-nums text-text-2">{formatMoney(price / result.purchasers)}</span>{" "}
          each — the bands restart for every buyer.
        </p>
      ) : null}
      <BandTable rows={result.rows} />
      <dl className="flex flex-col gap-1 border-t border-border pt-2 text-sm">
        {joint ? (
          <div className="flex justify-between">
            <dt className="text-text-2">Per purchaser × {result.purchasers}</dt>
            <dd className="tabular-nums text-text-1">{formatMoney(result.perShareGross)}</dd>
          </div>
        ) : null}
        <div className="flex justify-between">
          <dt className="text-text-2">Gross</dt>
          <dd className="tabular-nums text-text-1">{formatMoney(result.gross)}</dd>
        </div>
        {result.reliefApplied ? (
          <div className="flex justify-between">
            <dt className="text-text-2">{reliefLabel(result.reliefPct)}</dt>
            <dd className="tabular-nums text-success">−{formatMoney(result.reliefAmount)}</dd>
          </div>
        ) : null}
        <div className="flex justify-between text-base font-semibold">
          <dt className="text-text-1">{totalLabel}</dt>
          <dd className="tabular-nums text-text-1">{formatMoney(result.total)}</dd>
        </div>
      </dl>
    </>
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
  property = null,
  propertyUnreadable = false,
}: {
  transferConfig: TransferFeesConfig | null;
  transferVerifiedAt: string | null;
  stampConfig: StampDutyConfig | null;
  stampVerifiedAt: string | null;
  initialPrice: number | null;
  /** the listing the Costs link came from, when the viewer can read it (F01) */
  property?: CalculatorPropertyContext | null;
  /** a `property=` link whose read FAILED: the scenario shown is the default */
  propertyUnreadable?: boolean;
}) {
  const [priceInput, setPriceInput] = useState(initialPrice ? String(initialPrice) : "");
  const [purchasersInput, setPurchasersInput] = useState("1");
  const [relief, setRelief] = useState(true); // default ON (doc 02 §C8)
  // F01: whether the sale is subject to VAT is a SCENARIO, chosen in the
  // open. Opened on a property it is what the stored status implies (unknown
  // → "Not confirmed"); a bare calculator keeps today's default, not subject.
  const [scenario, setScenario] = useState<VatApplicability>(
    property?.scenario ?? "does_not_apply",
  );

  const price = Number(priceInput);
  const valid = Number.isFinite(price) && price > 0;
  // the service normalises anything odd, but keep the field usable while typing
  const purchasers = Math.max(1, Math.floor(Number(purchasersInput) || 1));

  const transfer = useMemo(
    () =>
      valid && transferConfig
        ? computeTransferScenario(price, transferConfig, { relief, purchasers, scenario })
        : null,
    [valid, price, transferConfig, relief, purchasers, scenario],
  );
  // Law 239(I)/2025: no stamp duty on documents signed on/after the config's
  // `abolished.from`. The panel then explains instead of computing — the bands
  // stay in config because they still govern pre-abolition contracts.
  const stampAbolished = stampConfig?.abolished ?? null;
  const stamp = useMemo(
    () =>
      valid && stampConfig && !stampConfig.abolished
        ? computeStampDuty(price, stampConfig)
        : null,
    [valid, price, stampConfig],
  );

  // UX-4: a purchase subject to VAT is exempt outright, so the relief toggle
  // cannot move the total. Mirror `computeTransferFees`'s own early-return
  // condition exactly (`subjectToVat && config.vat_paid_exempt`) — a config
  // with `vat_paid_exempt: false` still charges fees, and there relief must
  // stay live. "Not confirmed" keeps it live too: the not-subject branch is on
  // screen. The tick is disabled, never reset: leaving "Subject to VAT" gives
  // the agent back the choice they had made.
  const reliefMoot = scenario === "applies" && transferConfig?.vat_paid_exempt === true;

  // CALC-2 + F01: a pasted summary dates itself, names its scenario, and
  // carries the listing's reference so a quote in a thread says what it was
  // for. "Computed" is the moment of copying.
  const meta = (verifiedAt: string | null) => ({
    reference: property?.reference ?? null,
    verifiedAt,
    computedAt: new Date(),
  });
  const copyTransfer = () => {
    if (transfer) copyText(buildTransferSummary(price, transfer, meta(transferVerifiedAt)));
  };
  const copyStamp = () => {
    if (!stampConfig) return;
    const text = buildStampSummary(valid ? price : null, stampConfig, meta(stampVerifiedAt), scenario);
    if (text) copyText(text);
  };

  const primary = transfer?.primary ?? null;

  return (
    <div className="flex flex-col gap-4">
      {/* -------------------------------------------- whose figures these are */}
      {property ? (
        <p className="text-sm text-text-2">
          For{" "}
          <Link
            href={`/properties/${property.id}?tab=details`}
            className="font-mono font-medium text-text-1 hover:text-brand-700"
          >
            {property.reference}
          </Link>{" "}
          · {property.typeLabel} · VAT status: {property.vatStatusLabel}
        </p>
      ) : propertyUnreadable ? (
        <p className="text-sm text-text-3" role="status">
          The property in this link could not be read — the VAT scenario below is the default,
          not the property&apos;s. Choose it before quoting.
        </p>
      ) : null}

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
              {/* "Subject to VAT", the config's own trigger — never "VAT was
                  paid", which is a different fact (F01). Native radios: the
                  kit has no radio group, and a fieldset names the choice. */}
              <fieldset className="flex flex-col gap-1.5">
                <legend className="mb-1 text-sm font-medium text-text-1">
                  VAT on this purchase
                </legend>
                {VAT_SCENARIOS.map((s) => (
                  <label key={s} className="flex items-center gap-2 text-sm text-text-1">
                    <input
                      type="radio"
                      name="vat-scenario"
                      value={s}
                      checked={scenario === s}
                      onChange={() => setScenario(s)}
                      className="size-4 accent-brand-700"
                    />
                    {VAT_SCENARIO_LABELS[s]}
                  </label>
                ))}
                {/* the config's own wording for the rule, and only while the
                    config applies it — a note that outlived its flag would
                    contradict the figures below */}
                {transferConfig.vat_paid_exempt && transferConfig.vat_paid_note ? (
                  <p className="text-xs text-text-3">
                    {transferConfig.vat_paid_note.replace(/[.\s]+$/, "")}.
                  </p>
                ) : null}
              </fieldset>

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
                  {/* the rate the arithmetic applies, from the config (guardrail 5) */}
                  Apply {reliefLabel(transferConfig.relief_pct)} (transfers not subject to VAT)
                </label>
                {reliefMoot ? (
                  <p className="pl-6 text-xs text-text-3">
                    No relief to apply — a purchase subject to VAT carries no transfer fee.
                  </p>
                ) : null}
              </div>

              {transfer && primary ? (
                transfer.scenario === "unconfirmed" && transfer.ifSubject ? (
                  <>
                    {/* Unknown is a scenario, never a conclusion: both branches,
                        and the question the agent must settle before quoting. */}
                    <div
                      role="status"
                      className="flex gap-2 rounded-[8px] border border-warning/40 bg-warning/10 p-3"
                    >
                      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                      <div className="text-sm">
                        <p className="font-semibold text-text-1">
                          VAT status not confirmed — confirm before quoting.
                        </p>
                        <p className="mt-0.5 text-text-2">
                          {transfer.ifSubject.vatExempt
                            ? "If the sale is subject to VAT, no transfer fees are payable."
                            : `If the sale is subject to VAT: ${formatMoney(transfer.ifSubject.total)}.`}
                        </p>
                      </div>
                    </div>
                    <h3 className="text-sm font-semibold text-text-1">If not subject to VAT</h3>
                    <Breakdown
                      price={price}
                      result={primary}
                      totalLabel="Total (if not subject to VAT)"
                    />
                  </>
                ) : primary.vatExempt ? (
                  <>
                    <p className="rounded-lg bg-success/10 px-3 py-2 text-sm text-success">
                      No transfer fees — the transaction is subject to VAT.
                    </p>
                    {property ? (
                      <p className="text-sm">
                        <Link
                          href={`/properties/${property.id}?tab=details`}
                          className="font-medium text-brand-700 hover:underline"
                        >
                          VAT applies instead — see the property&apos;s VAT treatment
                        </Link>
                      </p>
                    ) : null}
                  </>
                ) : (
                  <Breakdown price={price} result={primary} totalLabel="Total" />
                )
              ) : (
                <p className="text-sm text-text-3">Enter a price to calculate.</p>
              )}

              <div className="mt-auto flex items-center justify-between gap-3 pt-1">
                <FreshnessLine verifiedAt={transferVerifiedAt} />
                {transfer ? (
                  <Button size="sm" variant="outline" onClick={copyTransfer}>
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
          ) : stampAbolished ? (
            <>
              <p className="rounded-lg bg-success/10 px-3 py-2 text-sm text-success">
                No stamp duty — abolished for documents signed on or after{" "}
                {formatDate(stampAbolished.from)} ({stampAbolished.law}).
              </p>
              <p className="text-xs text-text-3">
                Contracts signed before that date follow the previous bands
                {stampConfig.cap !== null
                  ? `, capped at ${formatMoney(stampConfig.cap)} per contract`
                  : ""}
                .
              </p>
              <div className="mt-auto flex items-center justify-between gap-3 pt-1">
                <FreshnessLine verifiedAt={stampVerifiedAt} />
                <Button size="sm" variant="outline" onClick={copyStamp}>
                  <Copy className="size-4" /> Copy summary
                </Button>
              </div>
            </>
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
                <Button size="sm" variant="outline" onClick={copyStamp}>
                  <Copy className="size-4" /> Copy summary
                </Button>
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
