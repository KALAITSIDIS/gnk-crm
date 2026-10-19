import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Flame } from "lucide-react";
import { Card, CardEmpty } from "@/components/features/dashboard/card";
import { createClient } from "@/lib/supabase/server";
import { unwrapRows } from "@/lib/supabase/unwrap";
import { readLastLoggedContacts } from "@/lib/services/contact-activity-summary";

const DAY_MS = 86_400_000;
/** "3+ days" (T5.3, doc 05) */
const IDLE_DAYS = 3;
/** rows the card lists; the badge counts every idle buyer */
const SHOWN = 8;

/**
 * "Hot buyers — no logged contact in 3+ days" (T5.3, doc 05), one of the My
 * day cards (A01).
 *
 * IDLE MEANS NO LOGGED CONTACT (A06 step 7): no logged conversation, call or
 * "contacted" stamp on the buyer, a contact merged into them, their leads or
 * the deals this viewer may read with them as a party, for three days. The
 * card used to count ANY event on the contact (readLastTouched, removed): a
 * WhatsApp-link click or a profile edit cleared "idle", and a call logged on
 * the buyer's lead from the inbox — where the Contacted / Called / Log
 * buttons file their events — or on their deal did not. A chat-link click
 * opens WhatsApp and says nothing about a message being sent, so it never
 * clears idle. The rule is the contact page strip's "Last logged contact"
 * (lib/services/contact-activity-summary.ts), asked of every hot buyer at once.
 *
 * The badge is the number of idle buyers among those read (Card's contract:
 * the count, not the list's length); the list shows the longest-idle first.
 * A read that did not answer says so — never a list of everyone, never "all
 * contacted".
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
    // org_id comes back so the system-side events read has an explicit org
    // boundary taken from a row RLS already returned
    .select("id, display_name, org_id")
    .eq("assigned_agent_id", profileId)
    .eq("temperature", "hot")
    .contains("contact_types", ["buyer"])
    .eq("is_archived", false)
    .order("created_at", { ascending: true })
    .limit(100);
  const hotContacts = unwrapRows(hotContactsRes, "hot contacts");

  /*
   * "Logged contact" by ANYONE, so the events are read as the system: on the
   * caller's client `events_select` shows a non-admin only the rows they
   * authored, and a buyer a colleague rang yesterday would read as idle — the
   * duplicate-call failure a CRM exists to prevent. The contacts are this
   * agent's, read on their own client; their leads and deals are read on it
   * too (inside the reader), and the org comes from those same rows.
   */
  const logged = await readLastLoggedContacts({
    orgId: (hotContacts[0]?.org_id as string | undefined) ?? "",
    viewer: supabase,
    contactIds: hotContacts.map((c) => c.id),
  });

  if (!logged.ok) {
    return (
      <Card title={t("cards.hotIdle")} icon={<Flame className="size-4 text-danger" />} level={level}>
        <CardEmpty text={t("hotUnavailable")} />
      </Card>
    );
  }

  const idleCutoff = now.getTime() - IDLE_DAYS * DAY_MS;
  const idleHot = hotContacts
    .map((c) => {
      const last = logged.last.get(c.id);
      const lastMs = last ? new Date(last).getTime() : 0;
      return { ...c, lastMs, days: last ? Math.floor((now.getTime() - lastMs) / DAY_MS) : null };
    })
    // never logged (0) first, then the longest since
    .filter((c) => c.lastMs < idleCutoff)
    .sort((a, b) => a.lastMs - b.lastMs);

  return (
    <Card
      title={t("cards.hotIdle")}
      icon={<Flame className="size-4 text-danger" />}
      count={idleHot.length}
      level={level}
    >
      {idleHot.length === 0 ? (
        <CardEmpty text={t("empty.hotAllContacted")} />
      ) : (
        <ul className="flex flex-col divide-y divide-border/60 text-sm">
          {idleHot.slice(0, SHOWN).map((c) => (
            <li key={c.id}>
              <Link
                href={`/contacts/${c.id}`}
                className="flex min-h-11 items-center justify-between gap-3 py-2 hover:text-brand-700"
              >
                <span className="truncate text-text-1">{c.display_name ?? t("unnamed")}</span>
                <span className="shrink-0 text-xs tabular-nums text-text-3">
                  {c.days === null ? t("neverLogged") : t("lastLoggedDays", { days: c.days })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
