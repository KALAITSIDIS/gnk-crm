import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CheckCircle2, ShieldAlert } from "lucide-react";
import { SignSlip } from "@/components/features/viewings/sign-slip";
import { SlipDownloadButton } from "@/components/features/viewings/slip-download";
import { getCurrentProfile } from "@/lib/services/auth";
import { SLIP_GDPR_LINE } from "@/lib/services/viewings";
import { createClient } from "@/lib/supabase/server";
import { formatDateTime } from "@/lib/utils/format";

export const dynamic = "force-dynamic";

export default async function SignSlipPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: v } = await supabase
    .from("viewings")
    .select(
      `id, org_id, agent_id, scheduled_at, duration_min, status,
       properties(reference, address),
       contacts(display_name),
       agent:profiles!agent_id(full_name)`,
    )
    .eq("id", id)
    .maybeSingle();
  if (!v) notFound();

  const [{ data: org }, { data: slip }] = await Promise.all([
    supabase.from("organizations").select("name").eq("id", v.org_id).maybeSingle(),
    supabase
      .from("viewing_slips")
      .select("id, signer_name, signed_at")
      .eq("viewing_id", id)
      .maybeSingle(),
  ]);

  const property = v.properties as { reference: string; address: string | null } | null;
  const buyerName = (v.contacts as { display_name: string | null } | null)?.display_name ?? "";
  const agentName = (v.agent as { full_name: string } | null)?.full_name ?? "—";
  const canSign = profile.role === "admin" || v.agent_id === profile.id;

  const Summary = (
    <dl className="flex flex-col divide-y divide-border/60 rounded-[10px] border border-border bg-surface">
      {(
        [
          ["Agency", org?.name ?? "—"],
          ["Agent", agentName],
          ["Attendee", buyerName || "—"],
          ["Property", property?.reference ?? "—"],
          ...(property?.address ? ([["Address", property.address]] as [string, string][]) : []),
          ["Viewing", formatDateTime(v.scheduled_at)],
        ] as [string, string][]
      ).map(([label, value]) => (
        <div key={label} className="flex items-baseline justify-between gap-4 px-4 py-2.5">
          <dt className="text-[13px] text-text-3">{label}</dt>
          <dd className="text-right text-sm font-medium text-text-1">{value}</dd>
        </div>
      ))}
    </dl>
  );

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <div>
        <Link
          href="/viewings"
          className="mb-2 inline-flex items-center gap-1 text-sm text-text-2 hover:text-text-1"
        >
          <ArrowLeft className="size-4" /> Viewings
        </Link>
        <h1 className="text-xl font-semibold text-text-1">Viewing slip</h1>
      </div>

      {Summary}

      {slip ? (
        <div className="flex flex-col items-center gap-4 rounded-[10px] border border-success/30 bg-success/10 p-6 text-center">
          <CheckCircle2 className="size-10 text-success" />
          <div>
            <p className="font-semibold text-text-1">Already signed</p>
            <p className="text-sm text-text-2">
              Signed by {slip.signer_name} on {formatDateTime(slip.signed_at)}.
            </p>
          </div>
          <SlipDownloadButton viewingId={id} />
        </div>
      ) : canSign ? (
        <SignSlip viewingId={id} defaultSignerName={buyerName} gdprLine={SLIP_GDPR_LINE} />
      ) : (
        <div className="flex items-center gap-2 rounded-[10px] border border-border bg-surface px-4 py-3 text-sm text-text-2">
          <ShieldAlert className="size-4 shrink-0 text-warning" />
          Only the assigned agent or an admin can sign this slip.
        </div>
      )}
    </div>
  );
}
