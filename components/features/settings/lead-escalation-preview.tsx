"use client";

import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  RECIPIENT_REASON_COPY,
  VERDICT_COPY,
  leadExclusionReason,
  type LeadEscalationPreview,
  type PreviewLead,
} from "@/lib/services/lead-escalation-preview";
import { senderReadinessCopy, type SenderReadiness } from "@/lib/services/sender-readiness";
import { cn } from "@/lib/utils";

/**
 * The activation preview's card (0112), under the form on Settings → Lead
 * escalation: what switching the values on the form ON would do right now —
 * the policy as the sweep reads it, who could be told and who could not
 * (and why), how many enquiries the sweep would mint against how many the
 * worker could actually e-mail, and a bounded list of the enquiries with a
 * verdict each. Pure: the document in, markup out; the words come from
 * lib/services/lead-escalation-preview.ts where a test pins them.
 *
 * Says three things plainly, because a preview that does not is worse than
 * none: it is as of one instant and eligibility moves on; provider
 * acceptance is not delivery; and previewing changes nothing — Save is the
 * only activation.
 *
 * Keeps two questions apart (audit 2026-09-22, late): who is ELIGIBLE under
 * the escalation's own rules (the database's counts) and what the SENDER can
 * do (sender-readiness.ts: not configured, Resend's test sender, a custom
 * domain unknown or refused, or verified). An eligible recipient is not a
 * recipient the provider will accept a message for.
 */
const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function when(iso: string, timeZone: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(t);
  } catch {
    return t.toISOString();
  }
}

function hoursLine(p: LeadEscalationPreview["policy"]): string {
  if (!p.working_hours) return "around the clock";
  const days = p.working_hours.days.map((d) => DAY_NAMES[d] ?? String(d)).join(", ");
  return `${days} ${p.working_hours.start}–${p.working_hours.end} ${p.timezone}`;
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "warning" | "danger" | "success" }) {
  return (
    <div className="flex flex-col rounded-[10px] border border-border bg-surface px-3 py-2">
      <span className={cn("text-lg font-semibold tabular-nums", tone === "warning" && value > 0 && "text-warning", tone === "danger" && value > 0 && "text-danger", tone === "success" && "text-success")}>
        {value}
      </span>
      <span className="text-xs text-text-3">{label}</span>
    </div>
  );
}

function LeadRow({ lead, timeZone }: { lead: PreviewLead; timeZone: string }) {
  const excluded = leadExclusionReason(lead);
  const sendable = lead.verdict === "due" && excluded === null;
  return (
    <TableRow data-testid={`preview-lead-${lead.lead_id}`} className={cn(lead.only_recipient_is_assignee && "bg-warning/5")}>
      <TableCell className="whitespace-nowrap text-xs">{when(lead.received_at, timeZone)}</TableCell>
      <TableCell className="whitespace-nowrap text-xs">{when(lead.due_at, timeZone)}</TableCell>
      <TableCell className="text-xs">
        <span className={cn("font-medium", sendable ? "text-success" : lead.verdict === "due" ? "text-warning" : "text-text-2")}>
          {sendable ? VERDICT_COPY.due : lead.verdict === "due" ? "would be minted, but not sent" : VERDICT_COPY[lead.verdict]}
        </span>
        {excluded && lead.verdict === "due" ? <span className="block text-text-3">{excluded}</span> : null}
      </TableCell>
      <TableCell className="text-xs">{lead.property_ref ?? <span className="text-text-3">—</span>}</TableCell>
      <TableCell className="text-xs">
        {lead.assignee_name ?? <span className="text-text-3">nobody</span>}
        {lead.only_recipient_is_assignee ? <span className="block text-warning">also the only eligible recipient</span> : null}
      </TableCell>
      <TableCell className="text-right text-xs tabular-nums">{lead.recipients_eligible}</TableCell>
    </TableRow>
  );
}

export function LeadEscalationPreviewCard({
  preview,
  sender,
  stale,
}: {
  preview: LeadEscalationPreview;
  sender: SenderReadiness;
  stale: boolean;
}) {
  const p = preview.policy;
  const c = preview.counts;
  const tz = p.timezone;
  const proposed = preview.recipients.length;
  const senderLine = senderReadinessCopy(sender);

  return (
    <section
      data-testid="lead-escalation-preview"
      aria-label="Activation preview"
      className={cn("flex flex-col gap-4 rounded-[10px] border border-border p-4", stale && "opacity-80")}
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold text-text-1">If these values were switched on now</h3>
        <p className="text-xs text-text-2">
          Evaluated at <span className="font-mono">{when(preview.evaluated_at, tz)}</span> ({tz}), as if escalation were on — the stored policy is
          currently <span className="font-medium">{preview.stored_enabled ? "ON" : "OFF"}</span>. Nothing was written and nothing was sent.
        </p>
        {stale ? (
          <p data-testid="lead-escalation-preview-stale" role="status" className="text-xs font-medium text-warning">
            The form has changed since this preview — run it again before saving.
          </p>
        ) : null}
      </div>

      <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
        <dt className="text-text-3">Wait</dt>
        <dd className="text-text-1">
          {p.after_minutes} min of {p.working_hours ? "working" : "clock"} time
        </dd>
        <dt className="text-text-3">Hours</dt>
        <dd className="text-text-1">{hoursLine(p)}</dd>
        <dt className="text-text-3">Cutoff</dt>
        <dd className="text-text-1">an enquiry whose wait ended more than {p.max_age_hours} h ago is left to its task</dd>
        <dt className="text-text-3">Recipients</dt>
        <dd className="text-text-1">
          {proposed} proposed, {preview.eligible_recipient_count} eligible under the escalation&rsquo;s rules (an active admin or agent with an
          address) — not a check that the provider will take a message for them
        </dd>
        <dt className="text-text-3">Sender</dt>
        <dd
          data-testid="lead-escalation-preview-sender"
          data-sender-state={sender.state}
          className={cn(senderLine.tone === "danger" ? "text-danger" : senderLine.tone === "warning" ? "text-warning" : "text-text-1")}
        >
          {senderLine.text}
        </dd>
      </dl>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="enquiries considered" value={c.considered} />
        <Stat label="jobs the sweep would create" value={c.due} />
        <Stat
          label={sender.state === "not_configured" ? "e-mails the worker would attempt once configured" : "e-mails the worker would attempt"}
          value={c.would_send}
          tone={sender.state === "domain_verified" ? "success" : undefined}
        />
        <Stat label="due, but nobody eligible" value={c.no_recipient} tone="danger" />
        <Stat label="of which: only recipient is the assignee" value={c.only_recipient_is_assignee} tone="warning" />
        <Stat label="not yet due" value={c.not_yet_due} />
        <Stat label="past the cutoff" value={c.past_cutoff} />
        <Stat label="already escalated" value={c.already_escalated} />
      </div>

      <div className="flex flex-col gap-1">
        <h4 className="text-xs font-semibold text-text-1">Who could be told</h4>
        {proposed === 0 ? (
          <p className="text-xs text-danger">Nobody is ticked — every due enquiry would be cancelled as no_recipient.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {preview.recipients.map((r) => (
              <li key={r.id} data-testid={`preview-recipient-${r.id}`} className="flex flex-wrap items-center gap-2 text-xs">
                <Badge variant={r.eligible ? "outline" : "destructive"}>{r.eligible ? "eligible" : "skipped"}</Badge>
                <span className="text-text-1">{r.full_name ?? "not a member"}</span>
                {r.role ? <span className="text-text-3">({r.role})</span> : null}
                {!r.eligible ? <span className="text-text-2">— {RECIPIENT_REASON_COPY[r.reason]}</span> : null}
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-text-3">An enquiry&rsquo;s own assignee is never told, even if ticked — the count per enquiry below allows for that.</p>
      </div>

      <div className="flex flex-col gap-1">
        <h4 className="text-xs font-semibold text-text-1">The enquiries</h4>
        {preview.leads.length === 0 ? (
          <p className="text-xs text-text-2">
            No open, unanswered website enquiry is inside the sweep&rsquo;s window — nothing would be escalated right now with these values.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Received</TableHead>
                  <TableHead className="text-xs">Due</TableHead>
                  <TableHead className="text-xs">Verdict</TableHead>
                  <TableHead className="text-xs">Property</TableHead>
                  <TableHead className="text-xs">Assigned to</TableHead>
                  <TableHead className="text-right text-xs">Recipients</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.leads.map((l) => (
                  <LeadRow key={l.lead_id} lead={l} timeZone={tz} />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {preview.truncated ? (
          <p className="text-xs text-text-3">
            Showing the first {preview.limit} of {c.considered} — the counts above are over all of them.
          </p>
        ) : null}
      </div>

      <p className="text-xs text-text-3">
        Eligibility changes after this preview: an enquiry answered, closed or redacted, a colleague deactivated, or a new enquiry arriving
        changes the answer. The five-minute check and the alert sweep decide again at their own moment, and the e-mail is rebuilt from the lead
        then. Previewing never switches escalation on — Save does.
      </p>
    </section>
  );
}
