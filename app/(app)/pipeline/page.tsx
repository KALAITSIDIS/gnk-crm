import Link from "next/link";
import {
  KanbanBoard,
  type KanbanDeal,
  type KanbanStage,
} from "@/components/features/pipeline/kanban";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const DEAL_TYPES = ["sale", "rental", "antiparoxi", "advisory"] as const;

/** Won/lost deals stay visible on the board this long (DECISIONS, pipeline audit). */
const CLOSED_WINDOW_DAYS = 30;

const DEAL_COLUMNS =
  "id, title, stage_id, expected_value, health_score, health, agent_id, status, stage_entered_at, won_at, lost_at, created_at, properties(reference)";

type SearchParams = { [key: string]: string | string[] | undefined };

export default async function PipelinePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const rawType = Array.isArray(sp.type) ? sp.type[0] : sp.type;
  const dealType = (DEAL_TYPES as readonly string[]).includes(rawType ?? "")
    ? (rawType as (typeof DEAL_TYPES)[number])
    : "sale";

  const supabase = await createClient();
  /* eslint-disable react-hooks/purity -- server component renders per-request; clock reads for the closed-deal window and days-in-stage are intentional */
  const closedCutoff = new Date(Date.now() - CLOSED_WINDOW_DAYS * 86_400_000).toISOString();

  const [stagesRes, openRes, closedRes] = await Promise.all([
    supabase
      .from("deal_stages")
      .select("id, name, sort_order, is_won, is_lost")
      .eq("deal_type", dealType)
      .order("sort_order"),
    supabase
      .from("deals")
      .select(DEAL_COLUMNS)
      .eq("deal_type", dealType)
      .eq("status", "open")
      .order("last_activity_at", { ascending: false }),
    // Recently closed deals render read-only in the won/lost columns so the
    // board tells the whole story instead of two permanently empty columns.
    supabase
      .from("deals")
      .select(DEAL_COLUMNS)
      .eq("deal_type", dealType)
      .neq("status", "open")
      .or(`won_at.gte.${closedCutoff},lost_at.gte.${closedCutoff}`)
      .order("last_activity_at", { ascending: false }),
  ]);

  const loadError = stagesRes.error ?? openRes.error ?? closedRes.error;
  const stages: KanbanStage[] = stagesRes.data ?? [];
  const dealRows = [...(openRes.data ?? []), ...(closedRes.data ?? [])];

  // Only the profiles actually referenced on the board — not the whole org.
  const agentIds = [...new Set(dealRows.map((d) => d.agent_id).filter((id) => id !== null))];
  const { data: agents } = agentIds.length
    ? await supabase.from("profiles").select("id, full_name").in("id", agentIds)
    : { data: [] };

  const agentName = new Map((agents ?? []).map((a) => [a.id, a.full_name]));
  const initials = (name: string | undefined) =>
    (name ?? "?")
      .split(/\s+/)
      .map((p) => p[0])
      .slice(0, 2)
      .join("")
      .toUpperCase();

  const now = Date.now();
  const daysSince = (iso: string | null) =>
    iso === null ? 0 : Math.max(0, Math.floor((now - new Date(iso).getTime()) / 86_400_000));

  const deals: KanbanDeal[] = dealRows.map((d) => ({
    id: d.id,
    title: d.title,
    stage_id: d.stage_id,
    expected_value: d.expected_value === null ? null : Number(d.expected_value),
    health_score: d.health_score,
    healthFactors: Array.isArray((d.health as { factors?: unknown } | null)?.factors)
      ? ((d.health as { factors: KanbanDeal["healthFactors"] }).factors ?? null)
      : null,
    agentInitials: initials(d.agent_id ? agentName.get(d.agent_id) : undefined),
    status: d.status as KanbanDeal["status"],
    daysInStage: daysSince(
      d.status === "won" ? d.won_at : d.status === "lost" ? d.lost_at : d.stage_entered_at,
    ),
    propertyRef: (d.properties as { reference: string } | null)?.reference ?? null,
  }));
  /* eslint-enable react-hooks/purity */

  const openCount = (openRes.data ?? []).length;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-text-1">Pipeline</h1>
        <p className="text-sm text-text-2">
          {openCount} open {dealType} deal{openCount === 1 ? "" : "s"} — drag between stages
        </p>
      </div>

      <div className="flex gap-1 border-b border-border">
        {DEAL_TYPES.map((t) => (
          <Link
            key={t}
            href={`/pipeline?type=${t}`}
            className={cn(
              "border-b-2 px-3 py-2 text-sm capitalize",
              t === dealType
                ? "border-brand-700 font-semibold text-brand-700"
                : "border-transparent text-text-2 hover:text-text-1",
            )}
          >
            {t}
          </Link>
        ))}
      </div>

      {loadError ? (
        <div className="rounded-lg border border-danger/40 bg-danger/5 p-4 text-sm text-danger">
          The pipeline could not be loaded: {loadError.message}. Refresh to try again.
        </div>
      ) : stages.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface-2 p-6 text-sm text-text-2">
          No stages are configured for {dealType} deals.{" "}
          <Link href="/settings/stages" className="font-medium text-brand-700 hover:underline">
            Set them up in Settings → Stages
          </Link>
          .
        </div>
      ) : (
        <KanbanBoard stages={stages} deals={deals} />
      )}
    </div>
  );
}
