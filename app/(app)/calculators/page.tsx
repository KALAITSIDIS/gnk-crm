import { CalculatorsClient } from "@/components/features/calculators/calculators-client";
import {
  parseStampDutyConfig,
  parseTransferFeesConfig,
} from "@/lib/services/calculators";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Cyprus purchase-cost calculators (T5.1). Rates come from cyprus_config —
 * a Settings edit changes results here with no deploy (guardrail 5). */
export default async function CalculatorsPage({
  searchParams,
}: {
  searchParams: Promise<{ price?: string }>;
}) {
  const { price: priceParam } = await searchParams;
  const supabase = await createClient();

  const { data: rows } = await supabase
    .from("cyprus_config")
    .select("key, value, verified_at")
    .in("key", ["transfer_fees", "stamp_duty"]);

  const byKey = new Map((rows ?? []).map((r) => [r.key, r]));
  const transferRow = byKey.get("transfer_fees");
  const stampRow = byKey.get("stamp_duty");

  const parsedPrice = Number(priceParam);
  const initialPrice =
    Number.isFinite(parsedPrice) && parsedPrice > 0 ? Math.round(parsedPrice) : null;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-text-1">Calculators</h1>
        <p className="text-sm text-text-2">
          Cyprus transfer fees &amp; stamp duty — figures are indicative, not legal advice.
        </p>
      </div>

      <CalculatorsClient
        transferConfig={parseTransferFeesConfig(transferRow?.value)}
        transferVerifiedAt={transferRow?.verified_at ?? null}
        stampConfig={parseStampDutyConfig(stampRow?.value)}
        stampVerifiedAt={stampRow?.verified_at ?? null}
        initialPrice={initialPrice}
      />
    </div>
  );
}
