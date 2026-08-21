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
import { GenerateUnitsForm } from "@/components/features/properties/generate-units-form";
import { InheritanceDrift } from "@/components/features/properties/inheritance-drift";
import {
  PhasesSection,
  type PhaseRow,
} from "@/components/features/properties/phases-section";
import { comparePriceLists, summariseVersion } from "@/lib/services/price-list";
import {
  computeInheritanceDrift,
  UNIT_PARENT_SELECT,
  UNIT_ROW_SELECT,
} from "@/lib/services/unit-inheritance";
import { Button } from "@/components/ui/button";
import { getCurrentProfile } from "@/lib/services/auth";
import { createClient } from "@/lib/supabase/server";
import { unwrapRows } from "@/lib/supabase/unwrap";

interface PriceListItemRow {
  unit_id: string;
  list_price: number | string;
  properties: { reference: string; unit_number: string | null; block: string | null } | null;
}

export default async function ProjectUnitsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  // the full inheritable set, because the drift panel compares every one of them
  const { data: project, error: projectErr } = await supabase
    .from("properties")
    .select(`${UNIT_PARENT_SELECT}, title`)
    .eq("id", id)
    .maybeSingle();
  if (projectErr) throw new Error(`Project query failed: ${projectErr.message}`);
  if (!project) notFound();
  if (project.kind !== "project" && project.kind !== "phase") {
    redirect(`/properties/${id}`);
  }

  const profile = await getCurrentProfile(supabase);
  const canManage = profile.role === "admin" || profile.role === "listing_manager";

  const [unitsRes, priceListsRes, plansRes, phasesRes] = await Promise.all([
    supabase
      .from("properties")
      .select(UNIT_ROW_SELECT)
      .eq("parent_id", id)
      .eq("kind", "unit")
      .order("block")
      .order("unit_number"),
    supabase
      .from("price_lists")
      // audit finding 4: the PRICES, not just a count of them. list_price was
      // written by every snapshot since 0001 and selected by nothing.
      .select(
        "id, version, effective_date, notes, price_list_items(unit_id, list_price, properties(reference, unit_number, block))",
      )
      .eq("project_id", id)
      .order("version", { ascending: false }),
    supabase
      .from("payment_plans")
      .select("id, name, installments")
      .eq("project_id", id)
      .order("created_at"),
    // audit finding 11 — a project's phases, each with its own unit count
    supabase
      .from("properties")
      .select("id, reference, title, status, delivery_date, units:properties!parent_id(count)")
      .eq("parent_id", id)
      .eq("kind", "phase")
      .order("reference"),
  ]);
  const unitRows = unwrapRows(unitsRes, "units");
  const priceListRows = unwrapRows(priceListsRes, "price lists");
  const planRows = unwrapRows(plansRes, "payment plans");
  const phaseRows = unwrapRows(phasesRes, "phases");

  const phases: PhaseRow[] = (phaseRows ?? []).map((ph) => ({
    id: ph.id,
    reference: ph.reference,
    title: (ph.title as { en?: string } | null)?.en ?? null,
    status: ph.status,
    delivery_date: ph.delivery_date,
    unitCount: (ph.units as { count: number }[] | null)?.[0]?.count ?? 0,
  }));

  const units: UnitRow[] = (unitRows ?? []).map((u) => ({
    ...u,
    covered_area_sqm: u.covered_area_sqm === null ? null : Number(u.covered_area_sqm),
    asking_price: u.asking_price === null ? null : Number(u.asking_price),
  }));

  // Versions come back newest-first, so each one's predecessor is the NEXT
  // element — that is what it gets compared against.
  const rawLists = (priceListRows ?? []).map((pl) => ({
    id: pl.id,
    version: pl.version,
    effective_date: pl.effective_date,
    notes: pl.notes,
    items: ((pl.price_list_items ?? []) as PriceListItemRow[]).map((it) => ({
      unit_id: it.unit_id,
      list_price: it.list_price,
      unit_label:
        [it.properties?.block, it.properties?.unit_number].filter(Boolean).join("") ||
        it.properties?.reference ||
        null,
      reference: it.properties?.reference ?? null,
    })),
  }));

  const priceLists: PriceListRow[] = rawLists.map((pl, i) => {
    const comparison = comparePriceLists(pl.items, rawLists[i + 1]?.items ?? null);
    return {
      id: pl.id,
      version: pl.version,
      effective_date: pl.effective_date,
      notes: pl.notes,
      itemCount: pl.items.length,
      comparison,
      summary: summariseVersion(comparison),
    };
  });

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

      <InheritanceDrift
        projectId={id}
        drift={computeInheritanceDrift(project, unitRows ?? [])}
        canManage={canManage}
      />

      {project.kind === "project" ? (
        <PhasesSection
          projectId={id}
          projectReference={project.reference}
          phases={phases}
          canManage={canManage}
        />
      ) : null}

      <UnitsMatrix units={units} canManage={canManage} />
      {canManage ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <GenerateUnitsForm projectId={id} projectReference={project.reference} />
          <AddUnitForm projectId={id} />
        </div>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <PriceListsSection projectId={id} priceLists={priceLists} canManage={canManage} />
        <PaymentPlansSection projectId={id} plans={plans} canManage={canManage} />
      </div>
    </div>
  );
}
