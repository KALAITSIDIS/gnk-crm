import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { MessageSquareWarning } from "lucide-react";
import { getCurrentProfile } from "@/lib/services/auth";
import { createClient } from "@/lib/supabase/server";
import { formatDateTime, formatMoney } from "@/lib/utils/format";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const t = await getTranslations("dashboard");
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  // Won this month (T3.4) — full dashboards land in T5.3
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [{ data: wonDeals }, { data: needFeedback }] = await Promise.all([
    supabase
      .from("deals")
      .select("id, expected_value")
      .eq("status", "won")
      .gte("won_at", monthStart.toISOString()),
    // Completed viewings still missing feedback (T4.3 nudge), mine first
    supabase
      .from("viewings")
      .select("id, scheduled_at, properties(reference)")
      .eq("agent_id", profile.id)
      .eq("status", "completed")
      .is("feedback", null)
      .order("scheduled_at", { ascending: false })
      .limit(8),
  ]);

  const wonCount = wonDeals?.length ?? 0;
  const wonValue = (wonDeals ?? []).reduce((sum, d) => sum + Number(d.expected_value ?? 0), 0);
  const feedbackTodo = needFeedback ?? [];

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

      {feedbackTodo.length > 0 ? (
        <section className="mt-4 rounded-[10px] border border-warning/40 bg-warning/5 p-5">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-text-1">
            <MessageSquareWarning className="size-4 text-warning" />
            Viewings awaiting your feedback ({feedbackTodo.length})
          </h2>
          <ul className="mt-3 flex flex-col divide-y divide-border/60">
            {feedbackTodo.map((v) => (
              <li key={v.id}>
                <Link
                  href={`/viewings/${v.id}`}
                  className="flex items-baseline justify-between gap-4 py-2 text-sm hover:text-brand-700"
                >
                  <span className="font-mono text-text-2">
                    {(v.properties as { reference: string } | null)?.reference ?? "—"}
                  </span>
                  <span className="tabular-nums text-text-3">{formatDateTime(v.scheduled_at)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="mt-4 text-sm text-text-3">
        Full role dashboards are built in Sprint 5 (T5.3).
      </p>
    </div>
  );
}
