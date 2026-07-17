import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import {
  AddUnitForm,
  PaymentPlansSection,
  PriceListsSection,
  UnitsMatrix,
  type PaymentPlanRow,
  type PriceListRow,
  type UnitRow,
} from "@/components/features/properties/units-matrix";
import { Button } from "@/components/ui/button";
import { getCurrentProfile } from "@/lib/services/auth";
import { createClient } from "@/lib/supabase/server";
import { unwrapRows } from "@/lib/supabase/unwrap";

export default async function ProjectUnitsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: project, error: projectErr } = await supabase
    .from("properties")
    .select("id, reference, kind, title")
    .eq("id", id)
    .maybeSingle();
  if (projectErr) throw new Error(`Project query failed: ${projectErr.message}`);
  if (!project) notFound();
  if (project.kind !== "project" && project.kind !== "phase") {
    redirect(`/properties/${id}`);
  }

  const profile = await getCurrentProfile(supabase);
  const canManage = profile.role === "admin" || profile.role === "listing_manager";

  const [unitsRes, priceListsRes, plansRes] = await Promise.all([
    supabase
      .from("properties")
      .select(
        "id, reference, unit_number, block, property_type, bedrooms, covered_area_sqm, asking_price, status, floor_number",
      )
      .eq("parent_id", id)
      .eq("kind", "unit")
      .order("block")
      .order("unit_number"),
    supabase
      .from("price_lists")
      .select("id, version, effective_date, notes, price_list_items(unit_id)")
      .eq("project_id", id)
      .order("version", { ascending: false }),
    supabase
      .from("payment_plans")
      .select("id, name, installments")
      .eq("project_id", id)
      .order("created_at"),
  ]);
  const unitRows = unwrapRows(unitsRes, "units");
  const priceListRows = unwrapRows(priceListsRes, "price lists");
  const planRows = unwrapRows(plansRes, "payment plans");

  const units: UnitRow[] = (unitRows ?? []).map((u) => ({
    ...u,
    covered_area_sqm: u.covered_area_sqm === null ? null : Number(u.covered_area_sqm),
    asking_price: u.asking_price === null ? null : Number(u.asking_price),
  }));

  const priceLists: PriceListRow[] = (priceListRows ?? []).map((pl) => ({
    id: pl.id,
    version: pl.version,
    effective_date: pl.effective_date,
    notes: pl.notes,
    itemCount: (pl.price_list_items ?? []).length,
  }));

  const plans: PaymentPlanRow[] = (planRows ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    installments: (p.installments ?? []) as PaymentPlanRow["installments"],
  }));

  const statusCounts = units.reduce<Record<string, number>>((acc, u) => {
    acc[u.status] = (acc[u.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2 text-text-2">
          <Link href={`/properties/${id}`}>
            <ArrowLeft className="size-4" /> {project.reference}
          </Link>
        </Button>
        <h1 className="text-xl font-semibold text-text-1">
          Units — {(project.title as { en?: string })?.en ?? project.reference}
        </h1>
        <p className="mt-1 text-sm text-text-2">
          {units.length} unit{units.length === 1 ? "" : "s"}
          {Object.entries(statusCounts)
            .map(([s, n]) => ` · ${n} ${s.replace(/_/g, " ")}`)
            .join("")}
        </p>
      </div>

      <UnitsMatrix units={units} canManage={canManage} />
      {canManage ? <AddUnitForm projectId={id} /> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <PriceListsSection projectId={id} priceLists={priceLists} canManage={canManage} />
        <PaymentPlansSection projectId={id} plans={plans} canManage={canManage} />
      </div>
    </div>
  );
}
