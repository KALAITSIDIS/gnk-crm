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

  const [{ data: stageRows }, { data: dealRows }, { data: agents }] = await Promise.all([
    supabase
      .from("deal_stages")
      .select("id, name, sort_order, is_won, is_lost")
      .eq("deal_type", dealType)
      .order("sort_order"),
    supabase
      .from("deals")
      .select(
        "id, title, stage_id, expected_value, health_score, agent_id, updated_at, created_at, properties(reference)",
      )
      .eq("deal_type", dealType)
      .eq("status", "open"),
    supabase.from("profiles").select("id, full_name"),
  ]);

  const agentName = new Map((agents ?? []).map((a) => [a.id, a.full_name]));
  const initials = (name: string | undefined) =>
    (name ?? "?")
      .split(/\s+/)
      .map((p) => p[0])
      .slice(0, 2)
      .join("")
      .toUpperCase();

  const stages: KanbanStage[] = stageRows ?? [];
  /* eslint-disable react-hooks/purity -- server component renders per-request; clock read for days-in-stage is intentional */
  const deals: KanbanDeal[] = (dealRows ?? []).map((d) => ({
    id: d.id,
    title: d.title,
    stage_id: d.stage_id,
    expected_value: d.expected_value === null ? null : Number(d.expected_value),
    health_score: d.health_score,
    agentInitials: initials(d.agent_id ? agentName.get(d.agent_id) : undefined),
    daysInStage: Math.max(
      0,
      Math.floor((Date.now() - new Date(d.updated_at).getTime()) / 86_400_000),
    ),
    propertyRef: (d.properties as { reference: string } | null)?.reference ?? null,
  }));
  /* eslint-enable react-hooks/purity */

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-text-1">Pipeline</h1>
        <p className="text-sm text-text-2">
          {deals.length} open {dealType} deal{deals.length === 1 ? "" : "s"} — drag between stages
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

      <KanbanBoard stages={stages} deals={deals} />
    </div>
  );
}
