import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CalendarPlus, CheckCircle2, PenLine, Star } from "lucide-react";
import { ViewingFeedbackForm } from "@/components/features/viewings/feedback-form";
import { SlipDownloadButton } from "@/components/features/viewings/slip-download";
import { ConfirmationCard } from "@/components/features/viewings/confirmation-card";
import { RescheduleViewingDialog } from "@/components/features/viewings/reschedule-viewing-dialog";
import { ViewingStatusActions } from "@/components/features/viewings/viewing-status-actions";
import { Button } from "@/components/ui/button";
import { getCurrentProfile } from "@/lib/services/auth";
import { createClient } from "@/lib/supabase/server";
import { formatDateTime } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import type { ViewingFeedback, ViewingStatus } from "@/lib/validators/viewings";

export const dynamic = "force-dynamic";

const STATUS_TONES: Record<ViewingStatus, string> = {
  scheduled: "bg-brand-100 text-brand-700",
  completed: "bg-success/10 text-success",
  cancelled: "bg-surface-2 text-text-3",
  no_show: "bg-danger/10 text-danger",
};

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[10px] border border-border bg-surface p-5">
      <h2 className="mb-3 text-sm font-semibold text-text-1">{title}</h2>
      {children}
    </section>
  );
}

export default async function ViewingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: v } = await supabase
    .from("viewings")
    .select(
      `id, org_id, agent_id, scheduled_at, duration_min, status, feedback, property_id, deal_id,
       properties(id, reference, address),
       contacts(id, display_name, phone_e164),
       deals(id, title),
       agent:profiles!agent_id(full_name)`,
    )
    .eq("id", id)
    .maybeSingle();
  if (!v) notFound();

  const { data: slip } = await supabase
    .from("viewing_slips")
    .select("id, signer_name, second_attendee_name, signed_at")
    .eq("viewing_id", id)
    .maybeSingle();

  // Head-only count: the card needs "is one already filed", not the row — so
  // the Download button appears on first paint rather than after a regenerate.
  const { count: confirmationCount } = await supabase
    .from("documents")
    .select("id", { count: "exact", head: true })
    .eq("entity_type", "viewing")
    .eq("entity_id", id)
    .eq("doc_type", "viewing_confirmation");

  const property = v.properties as { id: string; reference: string; address: string | null } | null;
  const contact = v.contacts as { id: string; display_name: string | null; phone_e164: string | null } | null;
  const agentName = (v.agent as { full_name: string } | null)?.full_name ?? "—";
  const status = v.status as ViewingStatus;
  const feedback = (v.feedback ?? null) as ViewingFeedback | null;
  const canManage = profile.role === "admin" || v.agent_id === profile.id;

  const facts: [string, React.ReactNode][] = [
    [
      "Property",
      property ? (
        <Link href={`/properties/${property.id}`} className="font-mono text-brand-700 hover:underline">
          {property.reference}
        </Link>
      ) : (
        "—"
      ),
    ],
    ...(property?.address ? ([["Address", property.address]] as [string, React.ReactNode][]) : []),
    [
      "Contact",
      contact ? (
        <Link href={`/contacts/${contact.id}`} className="text-brand-700 hover:underline">
          {contact.display_name ?? "—"}
        </Link>
      ) : (
        "—"
      ),
    ],
    ["Agent", agentName],
    ["When", `${formatDateTime(v.scheduled_at)} · ${v.duration_min}m`],
    // WF-3: the link existed in the schema since T4.1 and rendered nowhere
    ...(v.deal_id
      ? ([
          [
            "Deal",
            <Link
              key="deal"
              href={`/deals/${v.deal_id}`}
              className="text-brand-700 hover:underline"
            >
              {(v.deals as { title: string } | null)?.title ?? "Open deal"}
            </Link>,
          ],
        ] as [string, React.ReactNode][])
      : []),
  ];

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <div>
        <Link
          href="/viewings"
          className="mb-2 inline-flex items-center gap-1 text-sm text-text-2 hover:text-text-1"
        >
          <ArrowLeft className="size-4" /> Viewings
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-text-1">Viewing</h1>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-xs font-medium capitalize",
              STATUS_TONES[status],
            )}
          >
            {status.replace("_", " ")}
          </span>
        </div>
      </div>

      <Card title="Details">
        <dl className="flex flex-col divide-y divide-border/60">
          {facts.map(([label, value], i) => (
            <div key={i} className="flex items-baseline justify-between gap-4 py-2 text-sm">
              <dt className="text-text-3">{label}</dt>
              <dd className="text-right font-medium text-text-1">{value}</dd>
            </div>
          ))}
        </dl>
        {status === "scheduled" ? (
          // Plain anchor: file download (audit ICS-1) — the one format every
          // phone calendar imports. Cancelled/past viewings are noise there.
          <div className="mt-3 border-t border-border pt-3">
            <Button asChild size="sm" variant="outline">
              <a href={`/viewings/${v.id}/ics`} download>
                <CalendarPlus className="size-4" /> Add to calendar (.ics)
              </a>
            </Button>
          </div>
        ) : null}
      </Card>

      {status === "scheduled" && canManage ? (
        <Card title="Status">
          <div className="flex flex-wrap items-center gap-2">
            <RescheduleViewingDialog
              viewingId={v.id}
              agentId={v.agent_id}
              propertyId={v.property_id}
              contactId={contact?.id ?? null}
              scheduledAt={v.scheduled_at}
              durationMin={v.duration_min}
            />
            <ViewingStatusActions viewingId={v.id} />
          </div>
        </Card>
      ) : null}

      {/* Same gate as the slip: the viewing's agent or an admin. */}
      {canManage ? (
        <Card title="Confirmation">
          <ConfirmationCard viewingId={v.id} hasExisting={(confirmationCount ?? 0) > 0} />
        </Card>
      ) : null}

      <Card title="Signed slip">
        {slip ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="flex items-center gap-2 text-sm text-text-2">
              <CheckCircle2 className="size-4 text-success" />
              Signed by {slip.signer_name}
              {slip.second_attendee_name ? ` (with ${slip.second_attendee_name})` : ""} on{" "}
              {formatDateTime(slip.signed_at)}
            </p>
            <SlipDownloadButton viewingId={v.id} />
          </div>
        ) : status === "cancelled" || status === "no_show" ? (
          <p className="text-sm text-text-3">No slip — viewing did not take place.</p>
        ) : canManage ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-text-3">Not signed yet.</p>
            <Button asChild size="sm" variant="outline">
              <Link href={`/viewings/${v.id}/sign`}>
                <PenLine className="size-4" /> Sign slip
              </Link>
            </Button>
          </div>
        ) : (
          // RLS hides slips from everyone but the assigned agent and admins, so
          // "not signed" would be a lie here — say what we actually know.
          <p className="text-sm text-text-3">
            Slip status is visible to the assigned agent and admins only.
          </p>
        )}
      </Card>

      {status === "completed" ? (
        <Card title="Feedback">
          {canManage ? (
            <ViewingFeedbackForm viewingId={v.id} initial={feedback} />
          ) : feedback ? (
            <FeedbackReadOnly feedback={feedback} />
          ) : (
            <p className="text-sm text-text-3">No feedback recorded.</p>
          )}
        </Card>
      ) : null}
    </div>
  );
}

function FeedbackReadOnly({ feedback }: { feedback: ViewingFeedback }) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="flex gap-0.5">
        {[1, 2, 3, 4, 5].map((n) => (
          <Star
            key={n}
            className={cn(
              "size-4",
              n <= feedback.rating ? "fill-warning text-warning" : "text-text-3",
            )}
          />
        ))}
      </div>
      {feedback.liked ? (
        <p>
          <span className="text-text-3">Liked: </span>
          {feedback.liked}
        </p>
      ) : null}
      {feedback.disliked ? (
        <p>
          <span className="text-text-3">Disliked: </span>
          {feedback.disliked}
        </p>
      ) : null}
      {feedback.comment ? (
        <p>
          <span className="text-text-3">Comment: </span>
          {feedback.comment}
        </p>
      ) : null}
    </div>
  );
}
