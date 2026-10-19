import { CalculatorsClient } from "@/components/features/calculators/calculators-client";
import {
  parseStampDutyConfig,
  parseTransferFeesConfig,
  type CalculatorPropertyContext,
} from "@/lib/services/calculators";
import { vatApplicability } from "@/lib/services/vat";
import { createClient } from "@/lib/supabase/server";
import { isGuid } from "@/lib/validators/ids";
import { VAT_STATUS_LABELS } from "@/lib/validators/properties";
import type { Metadata } from "next";

/** The browser tab's name (A08): "Calculators · GN REOS" through the root layout's title template. */
export const metadata: Metadata = { title: "Calculators" };

export const dynamic = "force-dynamic";

/** a repeated search param: the first value wins, as on every list page */
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Cyprus purchase-cost calculators (T5.1). Rates come from cyprus_config —
 * a Settings edit changes results here with no deploy (guardrail 5).
 *
 * `?price=` prefills the amount (the T5.1 link contract). `?property=` (F01)
 * names the listing the Costs link came from: the page reads it through the
 * viewer's own RLS and opens on the scenario its stored VAT status implies,
 * with its reference on every copied summary. The price stays authoritative
 * for the amount — a deal's Costs link sends the deal's value, not the
 * listing's asking price. */
export default async function CalculatorsPage({
  searchParams,
}: {
  searchParams: Promise<{ price?: string | string[]; property?: string | string[] }>;
}) {
  const query = await searchParams;
  const priceParam = first(query.price);
  const propertyParam = first(query.property);
  const supabase = await createClient();

  // a malformed id names no row: it is dropped, not queried (T-malformed-ids)
  const propertyId = isGuid(propertyParam) ? propertyParam : null;

  const [{ data: rows }, propertyRes] = await Promise.all([
    supabase
      .from("cyprus_config")
      .select("key, value, verified_at")
      .in("key", ["transfer_fees", "stamp_duty"]),
    propertyId
      ? supabase
          .from("properties")
          .select("id, reference, kind, property_type, vat_status")
          .eq("id", propertyId)
          .maybeSingle()
      : Promise.resolve(null),
  ]);

  const byKey = new Map((rows ?? []).map((r) => [r.key, r]));
  const transferRow = byKey.get("transfer_fees");
  const stampRow = byKey.get("stamp_duty");

  const parsedPrice = Number(priceParam);
  const initialPrice =
    Number.isFinite(parsedPrice) && parsedPrice > 0 ? Math.round(parsedPrice) : null;

  // The context is a convenience, never a gate: no row (another org's, or
  // gone) is the bare calculator — which says nothing about whether the row
  // exists — and a failed read is the bare calculator plus one line saying
  // the scenario shown is the default, not this property's. Never a 404.
  let property: CalculatorPropertyContext | null = null;
  let propertyUnreadable = false;
  if (propertyRes?.error) {
    propertyUnreadable = true;
    console.error("[calculators] property context read failed", propertyRes.error.code);
  } else if (propertyRes?.data) {
    const p = propertyRes.data;
    const type = p.property_type.replace(/_/g, " ");
    property = {
      id: p.id,
      reference: p.reference,
      typeLabel: p.kind === "project" || p.kind === "phase" ? `${p.kind} · ${type}` : type,
      vatStatusLabel: VAT_STATUS_LABELS[p.vat_status],
      scenario: vatApplicability(p.vat_status),
    };
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-text-1">Calculators</h1>
        <p className="text-sm text-text-2">
          Cyprus transfer fees &amp; stamp duty — figures are indicative, not legal advice.
        </p>
      </div>

      <CalculatorsClient
        // a new link to this same page is a new conversation: re-seed the
        // price and the scenario rather than keep the previous property's
        key={`${property?.id ?? ""}|${initialPrice ?? ""}`}
        transferConfig={parseTransferFeesConfig(transferRow?.value)}
        transferVerifiedAt={transferRow?.verified_at ?? null}
        stampConfig={parseStampDutyConfig(stampRow?.value)}
        stampVerifiedAt={stampRow?.verified_at ?? null}
        initialPrice={initialPrice}
        property={property}
        propertyUnreadable={propertyUnreadable}
      />
    </div>
  );
}
