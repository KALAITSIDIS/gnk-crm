import Link from "next/link";
import { Inbox } from "lucide-react";
import { AddLeadDialog } from "@/components/features/leads/add-lead-dialog";
import { LeadRowActions } from "@/components/features/leads/lead-actions";
import { ResponseClock } from "@/components/features/shared/response-clock";
import { StatusBadge } from "@/components/features/shared/status-badge";
import { getCurrentProfile } from "@/lib/services/auth";
import { createClient } from "@/lib/supabase/server";
import { formatDateTime } from "@/lib/utils/format";

export const dynamic = "force-dynamic";

export default async function LeadsPage() {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: leads } = await supabase
    .from("leads")
    .select(
      `id, source, channel, message, status, received_at, first_response_at,
       first_call_at, assigned_agent_id, lost_reason,
       contacts(id, display_name, phone_e164),
       properties(id, reference)`,
    )
    .order("received_at", { ascending: false })
    .limit(100);

  const { data: agents } = await supabase
    .from("profiles")
    .select("id, full_name")
    .eq("is_active", true);
  const agentName = new Map((agents ?? []).map((a) => [a.id, a.full_name]));

  const rows = leads ?? [];
  const openStatuses = ["new", "contacted", "qualified"];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-text-1">Leads</h1>
          <p className="text-sm text-text-2">
            {rows.filter((l) => openStatuses.includes(l.status)).length} open ·{" "}
            {rows.filter((l) => !l.first_response_at && openStatuses.includes(l.status)).length}{" "}
            awaiting first response
          </p>
        </div>
        <AddLeadDialog />
      </div>

      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-[10px] border border-border bg-surface py-16">
          <Inbox className="size-8 text-text-3" />
          <p className="text-sm text-text-2">Inbox zero — no leads yet.</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((lead) => {
            const contact = lead.contacts as {
              id: string;
              display_name: string | null;
              phone_e164: string | null;
            } | null;
            const property = lead.properties as { id: string; reference: string } | null;
            const isOpen = openStatuses.includes(lead.status);
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
                <LeadRowActions
                  leadId={lead.id}
                  isMine={lead.assigned_agent_id === profile.id}
                  isUnassigned={!lead.assigned_agent_id}
                  isOpen={isOpen}
                  hasResponse={Boolean(lead.first_response_at)}
                  hasContact={Boolean(contact)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
