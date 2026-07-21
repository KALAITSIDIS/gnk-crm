import Link from "next/link";
import { AlertCircle, Inbox } from "lucide-react";
import { AddLeadDialog } from "@/components/features/leads/add-lead-dialog";
import { LeadsFilters } from "@/components/features/leads/filters";
import { LeadRowActions } from "@/components/features/leads/lead-actions";
import { ChatLinks } from "@/components/features/shared/chat-links";
import { ResponseClock } from "@/components/features/shared/response-clock";
import { StatusBadge } from "@/components/features/shared/status-badge";
import { getCurrentProfile } from "@/lib/services/auth";
import { createClient } from "@/lib/supabase/server";
import { formatDateTime } from "@/lib/utils/format";
import {
  LEAD_OPEN_STATUSES,
  leadFiltersSchema,
  leadStatusesForFilter,
} from "@/lib/validators/contacts";

export const dynamic = "force-dynamic";

type SearchParams = { [key: string]: string | string[] | undefined };

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const filters = leadFiltersSchema.parse({ status: first(sp.status) });
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const openStatuses = [...LEAD_OPEN_STATUSES];
  // Leads are never deleted (doc 04: DELETE ❌ — closing sets spam/lost, and
  // converted is terminal), so the inbox defaults to the open scope.
  const scopedStatuses = leadStatusesForFilter(filters.status);

  let leadsQuery = supabase
    .from("leads")
    .select(
      `id, source, channel, message, status, received_at, first_response_at,
       assigned_agent_id, lost_reason, converted_deal_id,
       contacts(id, display_name, phone_e164, telegram_username, has_whatsapp),
       properties(id, reference)`,
    );
  if (scopedStatuses) leadsQuery = leadsQuery.in("status", [...scopedStatuses]);

  // header counts are exact DB counts, not derived from the 100-row slice
  const [{ data: leads, error: leadsError }, openCount, awaitingCount, { data: agents }] =
    await Promise.all([
      leadsQuery.order("received_at", { ascending: false }).limit(100),
      supabase
        .from("leads")
        .select("id", { count: "exact", head: true })
        .in("status", openStatuses),
      supabase
        .from("leads")
        .select("id", { count: "exact", head: true })
        .in("status", openStatuses)
        .is("first_response_at", null),
      supabase.from("profiles").select("id, full_name, is_active"),
    ]);

  const agentName = new Map(
    (agents ?? []).map((a) => [a.id, a.is_active ? a.full_name : `${a.full_name} (inactive)`]),
  );

  const rows = leads ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-text-1">Leads</h1>
          <p className="text-sm text-text-2">
            {openCount.count ?? 0} open · {awaitingCount.count ?? 0} awaiting first response
          </p>
        </div>
        <div className="flex items-center gap-2">
          <LeadsFilters />
          <AddLeadDialog />
        </div>
      </div>

      {leadsError ? (
        <div className="flex flex-col items-center gap-3 rounded-[10px] border border-danger/40 bg-surface py-16">
          <AlertCircle className="size-8 text-danger" />
          <p className="text-sm text-text-2">Leads could not be loaded — try refreshing.</p>
          <p className="text-xs text-text-3">{leadsError.message}</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-[10px] border border-border bg-surface py-16">
          <Inbox className="size-8 text-text-3" />
          <p className="text-sm text-text-2">
            {filters.status === "open"
              ? "Inbox zero — no open leads."
              : filters.status === "all"
                ? "No leads yet."
                : `No ${filters.status} leads.`}
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((lead) => {
            const contact = lead.contacts as {
              id: string;
              display_name: string | null;
              phone_e164: string | null;
              telegram_username: string | null;
              has_whatsapp: boolean;
            } | null;
            const property = lead.properties as { id: string; reference: string } | null;
            const isOpen = (openStatuses as string[]).includes(lead.status);
            return (
              <li
                key={lead.id}
                className="flex flex-col gap-2 rounded-[10px] border border-border bg-surface p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <ResponseClock
                      receivedAt={lead.received_at}
                      firstResponseAt={lead.first_response_at}
                      active={isOpen}
                    />
                    <StatusBadge status={lead.status} />
                    <span className="text-xs text-text-3">
                      {lead.source}
                      {lead.channel ? ` · ${lead.channel}` : ""} ·{" "}
                      {formatDateTime(lead.received_at)}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    {contact ? (
                      <Link
                        href={`/contacts/${contact.id}`}
                        className="font-medium text-brand-700 hover:underline"
                      >
                        {contact.display_name}
                      </Link>
                    ) : (
                      <span className="text-text-3">No contact linked</span>
                    )}
                    {property ? (
                      <Link
                        href={`/properties/${property.id}`}
                        className="font-mono text-xs text-brand-700 hover:underline"
                      >
                        {property.reference}
                      </Link>
                    ) : null}
                    {contact ? (
                      <ChatLinks
                        phoneE164={contact.phone_e164}
                        telegramUsername={contact.telegram_username}
                        hasWhatsapp={contact.has_whatsapp}
                        leadId={lead.id}
                      />
                    ) : null}
                    {lead.assigned_agent_id ? (
                      <span className="text-xs text-text-2">
                        → {agentName.get(lead.assigned_agent_id) ?? "?"}
                      </span>
                    ) : (
                      <span className="text-xs text-warning">unassigned</span>
                    )}
                  </div>
                  {lead.message ? (
                    <p className="truncate text-sm text-text-2">{lead.message}</p>
                  ) : null}
                  {lead.lost_reason ? (
                    <p className="text-xs text-text-3">Reason: {lead.lost_reason}</p>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  {lead.status === "converted" && lead.converted_deal_id ? (
                    <Link
                      href={`/deals/${lead.converted_deal_id}`}
                      className="whitespace-nowrap text-xs font-medium text-brand-700 hover:underline"
                    >
                      View deal →
                    </Link>
                  ) : null}
                  <LeadRowActions
                    leadId={lead.id}
                    isMine={lead.assigned_agent_id === profile.id}
                    isUnassigned={!lead.assigned_agent_id}
                    isOpen={isOpen}
                    hasResponse={Boolean(lead.first_response_at)}
                    hasContact={Boolean(contact)}
                    isAdmin={profile.role === "admin"}
                    status={lead.status}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
