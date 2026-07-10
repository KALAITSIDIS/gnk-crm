import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { MandateBadge, type MandateBadgeState } from "@/components/features/shared/mandate-badge";
import { StatusBadge } from "@/components/features/shared/status-badge";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";
import { formatArea, formatMoney } from "@/lib/utils/format";

// Minimal detail view (T1.2) — the full tabbed page arrives in T1.3.
export default async function PropertyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: p } = await supabase
    .from("properties")
    .select(
      `id, reference, kind, property_type, transaction_type, status, visibility,
       title, address, asking_price, rent_price_month, bedrooms, bathrooms,
       covered_area_sqm, plot_area_sqm, quality_score, internal_notes,
       districts(name), areas(name), mandates(type, status)`,
    )
    .eq("id", id)
    .maybeSingle();

  if (!p) notFound();

  const mandates = (p.mandates ?? []) as { type: MandateBadgeState; status: string }[];
  const active = mandates.find((m) => m.status === "active");
  const mandateState: MandateBadgeState = active
    ? active.type
    : mandates.some((m) => m.status === "expired")
      ? "expired"
      : "none";

  const facts: [string, string][] = [
    ["Kind", p.kind],
    ["Type", p.property_type.replace(/_/g, " ")],
    ["Transaction", p.transaction_type.replace(/_/g, " ")],
    [
      "Location",
      [
        (p.districts as { name?: { en?: string } } | null)?.name?.en,
        (p.areas as { name?: { en?: string } } | null)?.name?.en,
        p.address,
      ]
        .filter(Boolean)
        .join(" · ") || "—",
    ],
    [
      "Price",
      p.transaction_type === "rent"
        ? p.rent_price_month
          ? `${formatMoney(Number(p.rent_price_month))}/mo`
          : "—"
        : formatMoney(p.asking_price === null ? null : Number(p.asking_price)),
    ],
    ["Bedrooms", p.bedrooms?.toString() ?? "—"],
    ["Bathrooms", p.bathrooms?.toString() ?? "—"],
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
    ["Quality score", `${p.quality_score}/100`],
  ];

  return (
    <div className="flex max-w-3xl flex-col gap-4">
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
        {(p.title as { en?: string })?.en ? (
          <p className="mt-1 text-sm text-text-2">{(p.title as { en?: string }).en}</p>
        ) : null}
      </div>

      <div className="rounded-[10px] border border-border bg-surface p-6">
        <dl className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
          {facts.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-4 border-b border-border/60 pb-2">
              <dt className="text-[13px] text-text-2">{label}</dt>
              <dd className="text-right text-sm font-medium text-text-1">{value}</dd>
            </div>
          ))}
        </dl>
        {p.internal_notes ? (
          <p className="mt-4 rounded-lg bg-surface-2 p-3 text-sm text-text-2">{p.internal_notes}</p>
        ) : null}
      </div>

      <p className="text-xs text-text-3">
        Reference numbers are immutable. Full detail tabs (media, legal, marketing, activity)
        arrive with T1.3+.
      </p>
    </div>
  );
}
