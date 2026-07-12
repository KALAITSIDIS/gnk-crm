import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import {
  DetailsForm,
  LegalForm,
  MarketingForm,
} from "@/components/features/properties/detail-forms";
import { MediaTab } from "@/components/features/properties/media-tab";
import {
  PriceHistorySection,
  type PriceHistoryRow,
} from "@/components/features/properties/price-history";
import { CreateViewingDialog } from "@/components/features/viewings/create-viewing-dialog";
import { EventTimeline } from "@/components/features/shared/event-timeline";
import { QualityScoreRing } from "@/components/features/shared/quality-score-ring";
import { computeQualityScore } from "@/lib/services/quality-score";
import { getCurrentProfile } from "@/lib/services/auth";
import { MandateBadge, type MandateBadgeState } from "@/components/features/shared/mandate-badge";
import { StatusBadge } from "@/components/features/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { createClient } from "@/lib/supabase/server";
import { formatArea, formatDateTime, formatMoney } from "@/lib/utils/format";

export default async function PropertyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: p }, { data: areaRows }, { data: mediaRows }] = await Promise.all([
    supabase
      .from("properties")
      .select("*, districts(name), areas(name), mandates(type, status)")
      .eq("id", id)
      .maybeSingle(),
    supabase.from("areas").select("id, district_id, name"),
    supabase
      .from("property_media")
      .select("id, path_thumb, path_card, is_cover, sort_order, watermarked, width, height")
      .eq("property_id", id)
      .order("sort_order"),
  ]);

  const [{ data: priceRows }, { data: eventRows }, { data: viewingRows }] = await Promise.all([
    supabase
      .from("price_history")
      .select("id, old_price, new_price, changed_at, changed_by")
      .eq("property_id", id)
      .order("changed_at", { ascending: false })
      .limit(50),
    supabase
      .from("events")
      .select("id, occurred_at, event_type, entity_type, payload")
      .eq("entity_type", "property")
      .eq("entity_id", id)
      .order("occurred_at", { ascending: false })
      .limit(50),
    supabase
      .from("viewings")
      .select("id, scheduled_at, duration_min, status, contacts(display_name), agent:profiles!agent_id(full_name)")
      .eq("property_id", id)
      .eq("status", "scheduled")
      .gte("scheduled_at", new Date().toISOString())
      .order("scheduled_at", { ascending: true })
      .limit(10),
  ]);

  if (!p) notFound();

  const profile = await getCurrentProfile(supabase);

  const isLand = p.property_type === "land";
  const media = mediaRows ?? [];
  const mandateRows = (p.mandates ?? []) as { type: string; status: string }[];
  const quality = computeQualityScore({
    isLand,
    hasCoverPhoto: media.some((m) => m.is_cover),
    photoCount: media.length,
    titleEn: (p.title as { en?: string } | null)?.en,
    publicDescriptionEn: (p.public_description as { en?: string } | null)?.en,
    hasPrice: p.asking_price !== null || p.rent_price_month !== null,
    hasArea: isLand ? p.plot_area_sqm !== null : p.covered_area_sqm !== null,
    hasBedroomsAndBathrooms: p.bedrooms !== null && p.bathrooms !== null,
    hasPlanningZoneAndDensity:
      p.planning_zone_code !== null && p.building_density_pct !== null,
    hasCoords: p.location !== null,
    titleDeedSet: p.title_deed_status !== "unknown",
    permitSet: p.permit_status !== "unknown",
    mandateActive: mandateRows.some((m) => m.status === "active"),
  });

  const changerIds = [...new Set((priceRows ?? []).map((r) => r.changed_by).filter(Boolean))];
  const { data: changerProfiles } = changerIds.length
    ? await supabase.from("profiles").select("id, full_name").in("id", changerIds as string[])
    : { data: [] };
  const changerName = new Map((changerProfiles ?? []).map((c) => [c.id, c.full_name]));
  const priceHistory: PriceHistoryRow[] = (priceRows ?? []).map((r) => ({
    id: r.id,
    old_price: r.old_price === null ? null : Number(r.old_price),
    new_price: r.new_price === null ? null : Number(r.new_price),
    changed_at: r.changed_at,
    changed_by_name: r.changed_by ? (changerName.get(r.changed_by) ?? null) : null,
  }));

  const areas = (areaRows ?? []).map((a) => ({
    id: a.id,
    districtId: a.district_id,
    name: (a.name as { en?: string })?.en ?? "—",
  }));

  const mandates = (p.mandates ?? []) as { type: MandateBadgeState; status: string }[];
  const activeMandate = mandates.find((m) => m.status === "active");
  const mandateState: MandateBadgeState = activeMandate
    ? activeMandate.type
    : mandates.some((m) => m.status === "expired")
      ? "expired"
      : "none";

  const title = (p.title as { en?: string })?.en;
  const district = (p.districts as { name?: { en?: string } } | null)?.name?.en;
  const area = (p.areas as { name?: { en?: string } } | null)?.name?.en;

  const overviewFacts: [string, string][] = [
    ["Kind", p.kind],
    ["Type", p.property_type.replace(/_/g, " ")],
    ["Transaction", p.transaction_type.replace(/_/g, " ")],
    ["Location", [district, area, p.address].filter(Boolean).join(" · ") || "—"],
    [
      "Price",
      p.transaction_type === "rent"
        ? p.rent_price_month
          ? `${formatMoney(Number(p.rent_price_month))}/mo`
          : "—"
        : formatMoney(p.asking_price === null ? null : Number(p.asking_price)),
    ],
    [
      "Area",
      formatArea(
        p.property_type === "land"
          ? p.plot_area_sqm === null
            ? null
            : Number(p.plot_area_sqm)
          : p.covered_area_sqm === null
            ? null
            : Number(p.covered_area_sqm),
      ),
    ],
    ["Bedrooms / Bathrooms", `${p.bedrooms ?? "—"} / ${p.bathrooms ?? "—"}`],
    ["Quality score", `${quality.score}/100`],
    ["Created", formatDateTime(p.created_at)],
    ["Updated", formatDateTime(p.updated_at)],
  ];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2 text-text-2">
          <Link href="/properties">
            <ArrowLeft className="size-4" /> Properties
          </Link>
        </Button>
        <div className="flex flex-wrap items-center gap-3">
          <QualityScoreRing score={quality.score} missing={quality.missing} />
          <h1 className="font-mono text-xl font-semibold text-text-1">{p.reference}</h1>
          <MandateBadge state={mandateState} />
          <StatusBadge status={p.status} />
          <StatusBadge status={p.visibility} />
          {p.kind === "project" || p.kind === "phase" ? (
            <Button asChild variant="outline" size="sm" className="ml-auto">
              <Link href={`/properties/${p.id}/units`}>Units matrix</Link>
            </Button>
          ) : null}
        </div>
        {title ? <p className="mt-1 text-sm text-text-2">{title}</p> : null}
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="legal">Legal</TabsTrigger>
          <TabsTrigger value="marketing">Marketing</TabsTrigger>
          <TabsTrigger value="media">Media ({(mediaRows ?? []).length})</TabsTrigger>
          <TabsTrigger value="mandate" disabled title="Arrives with T4.5/T4.6">
            Mandate & Keys
          </TabsTrigger>
          <TabsTrigger value="documents" disabled title="Arrives later in Phase 1">
            Documents
          </TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <div className="max-w-3xl rounded-[10px] border border-border bg-surface p-6">
            <dl className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
              {overviewFacts.map(([label, value]) => (
                <div
                  key={label}
                  className="flex items-baseline justify-between gap-4 border-b border-border/60 pb-2"
                >
                  <dt className="text-[13px] text-text-2">{label}</dt>
                  <dd className="text-right text-sm font-medium text-text-1">{value}</dd>
                </div>
              ))}
            </dl>
            <PriceHistorySection
              rows={priceHistory}
              currentPrice={p.asking_price === null ? null : Number(p.asking_price)}
            />

            <div className="mt-6 border-t border-border/60 pt-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-text-1">Upcoming viewings</h3>
                <CreateViewingDialog
                  defaultProperty={{
                    id: p.id,
                    label: title || p.reference,
                    sublabel: p.reference,
                  }}
                  triggerLabel="Schedule"
                />
              </div>
              {(viewingRows ?? []).length === 0 ? (
                <p className="mt-2 text-sm text-text-3">None scheduled.</p>
              ) : (
                <ul className="mt-2 flex flex-col divide-y divide-border/60">
                  {(viewingRows ?? []).map((v) => (
                    <li key={v.id}>
                      <Link
                        href={`/viewings/${v.id}`}
                        className="flex items-baseline justify-between gap-4 py-2 text-sm hover:text-brand-700"
                      >
                        <span className="tabular-nums text-text-1">
                          {formatDateTime(v.scheduled_at)}
                          <span className="ml-1.5 text-xs text-text-3">{v.duration_min}m</span>
                        </span>
                        <span className="truncate text-right text-text-2">
                          {(v.contacts as { display_name: string | null } | null)?.display_name ??
                            "—"}
                          <span className="ml-1.5 text-xs text-text-3">
                            {(v.agent as { full_name: string } | null)?.full_name ?? "—"}
                          </span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <p className="mt-4 text-xs text-text-3">
              Mandate & key panels (T4.5/T4.6) land here as their tasks ship.
            </p>
          </div>
        </TabsContent>

        <TabsContent value="media" className="mt-4">
          <div className="rounded-[10px] border border-border bg-surface p-6">
            <MediaTab propertyId={p.id} items={mediaRows ?? []} />
          </div>
        </TabsContent>

        <TabsContent value="details" className="mt-4">
          <div className="rounded-[10px] border border-border bg-surface p-6">
            <DetailsForm property={p} areas={areas} isAdmin={profile.role === "admin"} />
          </div>
        </TabsContent>

        <TabsContent value="legal" className="mt-4">
          <div className="max-w-3xl rounded-[10px] border border-border bg-surface p-6">
            <LegalForm property={p} />
          </div>
        </TabsContent>

        <TabsContent value="marketing" className="mt-4">
          <div className="max-w-3xl rounded-[10px] border border-border bg-surface p-6">
            <MarketingForm property={p} />
          </div>
        </TabsContent>

        <TabsContent value="activity" className="mt-4">
          <div className="max-w-3xl rounded-[10px] border border-border bg-surface p-6">
            <EventTimeline events={eventRows ?? []} />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
