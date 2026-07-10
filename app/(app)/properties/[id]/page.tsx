import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import {
  DetailsForm,
  LegalForm,
  MarketingForm,
} from "@/components/features/properties/detail-forms";
import { MediaTab } from "@/components/features/properties/media-tab";
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

  if (!p) notFound();

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
    ["Quality score", `${p.quality_score}/100`],
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
          <h1 className="font-mono text-xl font-semibold text-text-1">{p.reference}</h1>
          <MandateBadge state={mandateState} />
          <StatusBadge status={p.status} />
          <StatusBadge status={p.visibility} />
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
          <TabsTrigger value="activity" disabled title="Arrives with T3.5">
            Activity
          </TabsTrigger>
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
            <p className="mt-4 text-xs text-text-3">
              Score ring (T1.5), price history sparkline (T1.7), mandate & key panels (T4.5/T4.6)
              land here as their tasks ship.
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
            <DetailsForm property={p} areas={areas} />
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
      </Tabs>
    </div>
  );
}
