import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { formatMoney } from "@/lib/utils/format";

export default async function DashboardPage() {
  const t = await getTranslations("dashboard");
  const supabase = await createClient();

  // Won this month (T3.4 acceptance) — full dashboards land in T5.3
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const { data: wonDeals } = await supabase
    .from("deals")
    .select("id, expected_value")
    .eq("status", "won")
    .gte("won_at", monthStart.toISOString());
  const wonCount = wonDeals?.length ?? 0;
  const wonValue = (wonDeals ?? []).reduce((sum, d) => sum + Number(d.expected_value ?? 0), 0);

  return (
    <div>
      <h1 className="text-xl font-semibold text-text-1">{t("title")}</h1>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <div className="rounded-[10px] border border-border bg-surface p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-text-3">
            Won this month
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-text-1">{wonCount}</p>
          <p className="text-sm tabular-nums text-text-2">{formatMoney(wonValue)}</p>
        </div>
      </div>

      <p className="mt-4 text-sm text-text-3">
        Full role dashboards are built in Sprint 5 (T5.3).
      </p>
    </div>
  );
}
