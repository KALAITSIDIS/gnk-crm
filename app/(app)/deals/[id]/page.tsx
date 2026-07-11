import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, BadgeCheck } from "lucide-react";
import { CommissionForm, DealDetailsForm } from "@/components/features/deals/detail-forms";
import { OffersCard, type OfferRow } from "@/components/features/deals/offers";
import { Button } from "@/components/ui/button";
import type { EntityOption } from "@/lib/actions/entity-search";
import { createClient } from "@/lib/supabase/server";
import { formatDateTime, formatMoney } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import type { OfferStatus } from "@/lib/validators/deals";

const STATUS_TONES: Record<string, string> = {
  open: "bg-brand-100 text-brand-700",
  won: "bg-success/10 text-success",
  lost: "bg-danger/10 text-danger",
};

function healthTone(score: number) {
  if (score >= 70) return "bg-success";
  if (score >= 40) return "bg-warning";
  return "bg-danger";
}

function payloadSummary(payload: unknown): string | null {
  const p = payload as Record<string, unknown> | null;
  if (!p || typeof p !== "object") return null;
  if (typeof p.from === "string" && typeof p.to === "string") return `${p.from} → ${p.to}`;
  if (p.amount !== undefined) return formatMoney(p.amount as number | string);
  if (typeof p.section === "string") return `section: ${p.section}`;
  return null;
}

export default async function DealDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: deal } = await supabase.from("deals").select("*").eq("id", id).maybeSingle();
  if (!deal) notFound();

  const [{ data: stage }, { data: offerRows }] = await Promise.all([
    supabase
      .from("deal_stages")
      .select("id, name, is_won, is_lost")
      .eq("id", deal.stage_id)
      .maybeSingle(),
    supabase
      .from("offers")
      .select("*")
      .eq("deal_id", id)
      .order("created_at", { ascending: false }),
  ]);
  const offers = offerRows ?? [];

  const contactIds = [
    deal.buyer_contact_id,
    deal.seller_contact_id,
    ...offers.map((o) => o.contact_id),
  ].filter((v): v is string => Boolean(v));
  const offerIds = offers.map((o) => o.id);

  const [contactsRes, agentRes, propertyRes, dealEventsRes, offerEventsRes] = await Promise.all([
    contactIds.length
      ? supabase.from("contacts").select("id, display_name, phone_e164, email").in("id", contactIds)
      : Promise.resolve({ data: [] as { id: string; display_name: string | null; phone_e164: string | null; email: string | null }[] }),
    deal.agent_id
      ? supabase.from("profiles").select("id, full_name, role").eq("id", deal.agent_id).maybeSingle()
      : Promise.resolve({ data: null }),
    deal.property_id
      ? supabase
          .from("properties")
          .select("id, reference, title, status")
          .eq("id", deal.property_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("events")
      .select("id, occurred_at, event_type, entity_type, payload")
      .eq("entity_type", "deal")
      .eq("entity_id", id)
      .order("occurred_at", { ascending: false })
      .limit(50),
    offerIds.length
      ? supabase
          .from("events")
          .select("id, occurred_at, event_type, entity_type, payload")
          .eq("entity_type", "offer")
          .in("entity_id", offerIds)
          .order("occurred_at", { ascending: false })
          .limit(50)
      : Promise.resolve({ data: [] as never[] }),
  ]);

  const contactOption = new Map(
    (contactsRes.data ?? []).map((c) => [
      c.id,
      {
        id: c.id,
        label: c.display_name ?? "Unnamed",
        sublabel: c.phone_e164 ?? c.email,
      } satisfies EntityOption,
    ]),
  );
  const agent = agentRes.data;
  const property = propertyRes.data;

  // combined feed: deal events + this deal's offer events (rich lines: T3.5)
  const events = [...(dealEventsRes.data ?? []), ...(offerEventsRes.data ?? [])]
    .sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1))
    .slice(0, 50);

  const offerList: OfferRow[] = offers.map((o) => ({
    id: o.id,
    amount: o.amount,
    status: o.status as OfferStatus,
    terms: o.terms,
    valid_until: o.valid_until,
    decided_at: o.decided_at,
    created_at: o.created_at,
    contact: o.contact_id ? (contactOption.get(o.contact_id) ?? null) : null,
  }));

  const wonEligible = deal.status === "open" && offers.some((o) => o.status === "accepted");

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2 text-text-2">
          <Link href="/pipeline">
            <ArrowLeft className="size-4" /> Pipeline
          </Link>
        </Button>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-text-1">{deal.title}</h1>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-xs font-medium",
              STATUS_TONES[deal.status] ?? "",
            )}
          >
            {deal.status}
          </span>
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs capitalize text-text-2">
            {deal.deal_type}
          </span>
          {stage ? (
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-text-2">
              {stage.name}
            </span>
          ) : null}
          <span
            className={cn("size-2 rounded-full", healthTone(deal.health_score))}
            title={`Health ${deal.health_score}/100`}
          />
          <span className="text-sm tabular-nums text-text-2">
            {formatMoney(deal.expected_value)}
          </span>
        </div>
      </div>

      {wonEligible ? (
        <div className="flex items-center gap-2 rounded-[10px] border border-success/30 bg-success/10 px-4 py-3 text-sm text-success">
          <BadgeCheck className="size-4 shrink-0" />
          <span>
            <span className="font-semibold">Won-eligible</span> — this deal has an accepted
            offer. The guarded Won flow arrives with T3.4.
          </span>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <section className="rounded-[10px] border border-border bg-surface p-6">
            <h2 className="mb-4 text-sm font-semibold text-text-1">Details</h2>
            <DealDetailsForm
              deal={{
                id: deal.id,
                title: deal.title,
                expected_value: deal.expected_value,
                property: property
                  ? {
                      id: property.id,
                      label: (property.title as { en?: string } | null)?.en || property.reference,
                      sublabel: `${property.reference} · ${property.status}`,
                    }
                  : null,
                buyer: deal.buyer_contact_id
                  ? (contactOption.get(deal.buyer_contact_id) ?? null)
                  : null,
                seller: deal.seller_contact_id
                  ? (contactOption.get(deal.seller_contact_id) ?? null)
                  : null,
                agent: agent
                  ? { id: agent.id, label: agent.full_name, sublabel: agent.role }
                  : null,
              }}
            />
          </section>

          <section className="rounded-[10px] border border-border bg-surface p-6">
            <OffersCard dealId={deal.id} offers={offerList} />
          </section>

          <section className="rounded-[10px] border border-border bg-surface p-6">
            <h2 className="mb-3 text-sm font-semibold text-text-1">Activity</h2>
            {events.length === 0 ? (
              <p className="text-sm text-text-3">No activity yet.</p>
            ) : (
              <ul className="divide-y divide-border">
                {events.map((e) => (
                  <li key={e.id} className="flex items-baseline justify-between gap-4 py-2 text-sm">
                    <span className="font-medium text-text-1">
                      {e.entity_type === "offer" ? "offer " : ""}
                      {e.event_type.replace(/_/g, " ")}
                      {payloadSummary(e.payload) ? (
                        <span className="ml-2 text-xs font-normal text-text-3">
                          {payloadSummary(e.payload)}
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-text-3">{formatDateTime(e.occurred_at)}</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-text-3">
              Rich timeline with payload summaries arrives with T3.5.
            </p>
          </section>
        </div>

        <div className="flex flex-col gap-4">
          <section className="rounded-[10px] border border-border bg-surface p-6">
            <h2 className="mb-3 text-sm font-semibold text-text-1">Health</h2>
            <div className="flex items-center gap-3">
              <span className={cn("size-3 rounded-full", healthTone(deal.health_score))} />
              <span className="text-2xl font-semibold tabular-nums text-text-1">
                {deal.health_score}
              </span>
              <span className="text-sm text-text-3">/ 100</span>
            </div>
            <p className="mt-3 text-xs text-text-3">
              Factor breakdown and automatic recompute arrive with T3.3 (health service).
            </p>
          </section>

          <section className="rounded-[10px] border border-border bg-surface p-6">
            <h2 className="mb-4 text-sm font-semibold text-text-1">Commission</h2>
            <CommissionForm dealId={deal.id} notes={deal.commission_split_notes} />
          </section>
        </div>
      </div>
    </div>
  );
}
