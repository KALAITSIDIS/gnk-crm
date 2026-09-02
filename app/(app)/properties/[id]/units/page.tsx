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
import { AvailabilityShare } from "@/components/features/properties/availability-share";
import { BuildProgressCard } from "@/components/features/properties/build-progress-card";
import { SalesVelocityCard } from "@/components/features/properties/sales-velocity-card";
import { GenerateUnitsForm } from "@/components/features/properties/generate-units-form";
import { InheritanceDrift } from "@/components/features/properties/inheritance-drift";
import {
  PhasesSection,
  type PhaseRow,
} from "@/components/features/properties/phases-section";
import { comparePriceLists, summariseVersion } from "@/lib/services/price-list";
import { PriceUpliftForm } from "@/components/features/properties/price-uplift-form";
import { UnitTypesSection } from "@/components/features/properties/unit-types-section";
import { blocksOf } from "@/lib/services/price-uplift";
import type { UnitType } from "@/lib/services/unit-type";
import {
  computeInheritanceDrift,
  UNIT_PARENT_SELECT,
  UNIT_ROW_SELECT,
} from "@/lib/services/unit-inheritance";
import { countContainerUnits } from "@/lib/services/container-units";
import { Button } from "@/components/ui/button";
import { getCurrentProfile } from "@/lib/services/auth";
import { fetchProjectVelocity } from "@/lib/queries/sales-velocity";
import { createClient } from "@/lib/supabase/server";
import { unwrapRows } from "@/lib/supabase/unwrap";

interface PriceListItemRow {
  unit_id: string;
  list_price: number | string;
  properties: { reference: string; unit_number: string | null; block: string | null } | null;
}

export default async function ProjectUnitsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  /** `?units=failed&reason=…` — the wizard created the project but not its units */
  searchParams: Promise<{ units?: string; reason?: string }>;
}) {
  const { id } = await params;
  const { units: unitsParam, reason: unitsReason } = await searchParams;
  const unitsFailed = unitsParam === "failed";
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

  const [unitsRes, priceListsRes, plansRes, phasesRes, typesRes] = await Promise.all([
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
      // the phase's units by visibility, counted here — a bare embedded count
      // would include archived ones and contradict the banner (2026-09-02)
      .select("id, reference, title, status, delivery_date, units:properties!parent_id(visibility)")
      .eq("parent_id", id)
      .eq("kind", "phase")
      .order("reference"),
    // 0039 — the layouts this project repeats
    supabase
      .from("unit_types")
      .select(
        "id, code, name, bedrooms, bathrooms, covered_area_sqm, veranda_sqm, price_per_sqm",
      )
      .eq("project_id", id)
      .order("code"),
  ]);
  const unitRows = unwrapRows(unitsRes, "units");
  const priceListRows = unwrapRows(priceListsRes, "price lists");
  const planRows = unwrapRows(plansRes, "payment plans");
  const phaseRows = unwrapRows(phasesRes, "phases");
  const unitTypes = (unwrapRows(typesRes, "unit types") ?? []) as UnitType[];

  const phases: PhaseRow[] = (phaseRows ?? []).map((ph) => ({
    id: ph.id,
    reference: ph.reference,
    title: (ph.title as { en?: string } | null)?.en ?? null,
    status: ph.status,
    delivery_date: ph.delivery_date,
    unitCount: ((ph.units as { visibility: string }[] | null) ?? []).filter(
      (u) => u.visibility !== "archived",
    ).length,
  }));

  // the ONE definition of "has units" (container-units.ts) — reaches through
  // the phases, so a project whose units all sit under phases is not told it
  // is empty, and a project with only empty phases IS (2026-09-02 review)
  const unitFacts = await countContainerUnits(supabase, id);

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

  // 0054: two round trips of its own, the second bounded by the number of SOLD
  // units rather than by project size — see lib/queries/sales-velocity.ts. Kept
  // out of the Promise.all above because the event query needs the unit ids.
  const velocity = await fetchProjectVelocity(supabase, id);

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

      <BuildProgressCard
        constructionStatus={project.construction_status}
        deliveryDate={project.delivery_date}
      />

      <SalesVelocityCard velocity={velocity} />

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

      {/* The state the wizard now lands on when units were left for later.
          Said out loud, because a project with no units scored 100/100 and
          went public once — nothing on this page had told anyone it was
          empty, or what being empty costs (2026-09-02). */}
      {/* The wizard's partial-failure landing: the project row exists, its
          units did not land, and the person who pressed the button must be
          told WHY here, not in a server log (2026-09-02 review). */}
      {unitsFailed ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-[10px] border border-danger/40 bg-danger/10 p-4 text-sm"
        >
          <span className="mt-0.5 font-semibold text-danger">The project was created — its units were not.</span>
          <p className="text-text-2">
            {unitsReason ? `${unitsReason} ` : ""}
            Nothing else was lost: describe the layout again in the generator below and it will
            create them now.
          </p>
        </div>
      ) : null}

      {unitFacts.unitCount === 0 ? (
        <div className="flex items-start gap-2 rounded-[10px] border border-warning/40 bg-warning/10 p-4 text-sm">
          {/* the matrix below already says "no units yet" and offers the way
              out — this line is the CONSEQUENCE, stated once */}
          <span className="mt-0.5 font-semibold text-warning">Not a listing until it has units.</span>
          <p className="text-text-2">
            This {project.kind} cannot be published, no buyer can be matched to it, and nothing
            on it can be reserved — the units carry the prices.{" "}
            {phases.length > 0 ? "Its phases are empty too — a phase is not a unit. " : ""}
            {units.length > 0 ? "Its only units are archived. " : ""}
            {canManage
              ? "Generate them below: describe the block or the villas once and every unit is created."
              : "An admin or listing manager can generate them from this page."}
          </p>
        </div>
      ) : null}

      <UnitsMatrix units={units} canManage={canManage} />

      <AvailabilityShare
        projectId={id}
        projectReference={project.reference}
        isPhase={project.kind === "phase"}
        priceLists={priceLists.map((pl) => ({
          id: pl.id,
          version: pl.version,
          effectiveDate: pl.effective_date,
        }))}
        unitCount={units.length}
        hasPhases={phases.length > 0}
      />
      {canManage ? (
        <div className="grid gap-4 xl:grid-cols-2">
          <GenerateUnitsForm projectId={id} projectReference={project.reference} />
          <AddUnitForm projectId={id} />
        </div>
      ) : null}
      <UnitTypesSection
        projectId={id}
        types={unitTypes}
        blocks={blocksOf(
          units.map((u) => ({
            id: u.id,
            reference: u.reference,
            block: u.block,
            asking_price: u.asking_price,
          })),
        )}
        unitCount={units.length}
        canManage={canManage}
      />

      {canManage ? (
        <PriceUpliftForm
          projectId={id}
          units={units.map((u) => ({
            id: u.id,
            reference: u.reference,
            block: u.block,
            asking_price: u.asking_price,
          }))}
          nextVersion={(priceLists[0]?.version ?? 0) + 1}
        />
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <PriceListsSection projectId={id} priceLists={priceLists} canManage={canManage} />
        <PaymentPlansSection projectId={id} plans={plans} canManage={canManage} />
      </div>
    </div>
  );
}
