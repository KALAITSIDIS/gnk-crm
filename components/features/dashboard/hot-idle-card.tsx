import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Flame } from "lucide-react";
import { Card, CardEmpty } from "@/components/features/dashboard/card";
import { createClient } from "@/lib/supabase/server";
import { unwrapRows } from "@/lib/supabase/unwrap";
import { readLastTouched } from "@/lib/services/entity-timeline";

/**
 * "Hot buyers idle 3+ days" (T5.3, doc 05), one of the My day cards (A01).
 *
 * Moved here VERBATIM from agent-dashboard.tsx when My day became shared by
 * the agent and admin dashboards: the queries, the 3-day rule and the
 * last-touched read are unchanged. What "touched" should mean (an event of
 * any kind, or a logged contact) is a separate, pending change — it is kept in
 * this one file so that change lands in one place.
 */
export async function HotIdleCard({ profileId, level = 2 }: { profileId: string; level?: 2 | 3 }) {
  const t = await getTranslations("dashboard.myDay");
  const supabase = await createClient();
  const now = new Date();

  // SQL: select id, display_name from contacts where assigned_agent_id = :me
  //      and temperature = 'hot' and contact_types @> '{buyer}'
  //      and is_archived = false;  (doc 05: hot BUYERS)
  const hotContactsRes = await supabase
    .from("contacts")
    // org_id comes back so the last-touched read (which runs as the system)
    // has an explicit org boundary taken from a row RLS already returned
    .select("id, display_name, org_id")
    .eq("assigned_agent_id", profileId)
    .eq("temperature", "hot")
    .contains("contact_types", ["buyer"])
    .eq("is_archived", false)
    .order("created_at", { ascending: true })
    .limit(100);
  const hotContacts = unwrapRows(hotContactsRes, "hot contacts");

  // Hot buyers idle ≥3 days: latest contact-scoped event per hot contact;
  // SQL: select entity_id, max(occurred_at) from events where entity_type='contact'
  //      and entity_id in (:hot_ids) group by entity_id;
  //      idle = no event or max(occurred_at) < now() - interval '3 days'
  //      (sampled over the 500 most recent events across the hot contacts)
  const hotIds = hotContacts.map((c) => c.id);
  /*
   * "Last touched" means by ANYONE, so this asks the system.
   *
   * `events_select` shows a non-admin only the rows they authored, so on the
   * caller's client this computed "when did I last touch them" — and a contact
   * a colleague rang yesterday still read as idle for three days. The desk's
   * own tool then told this agent to ring a buyer who had just been rung,
   * which is the duplicate-call failure a CRM exists to prevent.
   *
   * The ids are contacts assigned to this agent and read on their own client;
   * the org comes from those same rows.
   */
  const hotEvents = await readLastTouched({
    orgId: (hotContacts[0]?.org_id as string | undefined) ?? "",
    entityType: "contact",
    entityIds: hotIds,
    limit: 500,
  });
  const lastTouch = new Map<string, string>();
  for (const e of hotEvents) {
    if (e.entity_id && !lastTouch.has(e.entity_id)) lastTouch.set(e.entity_id, e.occurred_at);
  }
  const idleCutoff = now.getTime() - 3 * 86_400_000;
  const idleHot = hotContacts
    .map((c) => {
      const last = lastTouch.get(c.id);
      const idleDays = last
        ? Math.floor((now.getTime() - new Date(last).getTime()) / 86_400_000)
        : null;
      return { ...c, idleDays, lastMs: last ? new Date(last).getTime() : 0 };
    })
    .filter((c) => c.lastMs < idleCutoff)
    .sort((a, b) => a.lastMs - b.lastMs)
    .slice(0, 8);

  return (
    <Card
      title={t("cards.hotIdle")}
      icon={<Flame className="size-4 text-danger" />}
      count={idleHot.length}
      level={level}
    >
      {idleHot.length === 0 ? (
        <CardEmpty text={t("empty.hotAllTouched")} />
      ) : (
        <ul className="flex flex-col divide-y divide-border/60 text-sm">
          {idleHot.map((c) => (
            <li key={c.id}>
              <Link
                href={`/contacts/${c.id}`}
                className="flex min-h-11 items-center justify-between gap-3 py-2 hover:text-brand-700"
              >
                <span className="truncate text-text-1">{c.display_name ?? t("unnamed")}</span>
                <span className="shrink-0 text-xs tabular-nums text-text-3">
                  {c.idleDays === null ? t("noActivity") : t("idleDays", { days: c.idleDays })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
