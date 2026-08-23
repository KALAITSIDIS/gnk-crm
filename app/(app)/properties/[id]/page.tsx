import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Calculator } from "lucide-react";
import {
  DetailsForm,
  LegalForm,
  MarketingForm,
} from "@/components/features/properties/detail-forms";
import { ArchivePropertyButton } from "@/components/features/properties/archive-button";
import { PartiesForm } from "@/components/features/properties/parties-form";
import { MediaTab } from "@/components/features/properties/media-tab";
import { DocumentsTab } from "@/components/features/properties/documents-tab";
import {
  PriceHistorySection,
  type PriceHistoryRow,
} from "@/components/features/properties/price-history";
import { CreateViewingDialog } from "@/components/features/viewings/create-viewing-dialog";
import {
  KeyMovementActions,
  RegisterKeyDialog,
} from "@/components/features/keys/key-dialogs";
import {
  MandatePanel,
  type MandateRow,
} from "@/components/features/properties/mandate-panel";
import { EventTimeline } from "@/components/features/shared/event-timeline";
import { QualityScoreRing } from "@/components/features/shared/quality-score-ring";
import { computeQualityScore } from "@/lib/services/quality-score";
import { getCurrentProfile } from "@/lib/services/auth";
import { MandateBadge, type MandateBadgeState } from "@/components/features/shared/mandate-badge";
import { StatusBadge } from "@/components/features/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MatchingBuyersCard } from "@/components/features/properties/matching-buyers-card";
import {
  ReservationCard,
  type ReservationRow,
} from "@/components/features/properties/reservation-card";
import type { MatchCandidate } from "@/lib/services/matching";
import { createClient } from "@/lib/supabase/server";
import { unwrapRows } from "@/lib/supabase/unwrap";
import { formatArea, formatDate, formatDateTime, formatMoney } from "@/lib/utils/format";

export default async function PropertyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  // mandates via mandates_safe, NOT the base table: LM has no base-table
  // policy and commission columns are masked in the view (doc 04, T4.5)
  const [propertyRes, areasRes, mediaRes, mandatesRes, keysRes] = await Promise.all([
    supabase
      .from("properties")
      .select("*, districts(name), areas(name)")
      .eq("id", id)
      .maybeSingle(),
    supabase.from("areas").select("id, district_id, name"),
    supabase
      .from("property_media")
      .select("id, path_thumb, path_card, is_cover, sort_order, watermarked, width, height")
      .eq("property_id", id)
      .order("sort_order"),
    supabase
      .from("mandates_safe")
      .select("*")
      .eq("property_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("property_keys")
      .select("id, key_code, description, status, current_holder_name")
      .eq("property_id", id)
      .order("created_at", { ascending: true }),
  ]);

  // a genuine query failure renders the error boundary, not a misleading 404
  if (propertyRes.error) {
    throw new Error(`Property query failed: ${propertyRes.error.message}`);
  }
  const p = propertyRes.data;
  if (!p) notFound();
  const areaRows = unwrapRows(areasRes, "areas");
  const mediaRows = unwrapRows(mediaRes, "property media");
  const mandateSafeRows = unwrapRows(mandatesRes, "mandates");
  const keyRows = unwrapRows(keysRes, "property keys");

  const keyIds = keyRows.map((k) => k.id);
  const [priceRes, eventsRes, keyEventsRes, viewingsRes, documentsRes, reservationsRes] =
    await Promise.all([
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
    // this property's key movements belong on its activity trail (keys audit) —
    // key events carry the key's id, so they need their own fetch
    keyIds.length === 0
      ? Promise.resolve({ data: [], error: null })
      : supabase
          .from("events")
          .select("id, occurred_at, event_type, entity_type, payload")
          .eq("entity_type", "key")
          .in("entity_id", keyIds)
          .order("occurred_at", { ascending: false })
          .limit(20),
    supabase
      .from("viewings")
      .select("id, scheduled_at, duration_min, status, contacts(display_name), agent:profiles!agent_id(full_name)")
      .eq("property_id", id)
      .eq("status", "scheduled")
      .gte("scheduled_at", new Date().toISOString())
      .order("scheduled_at", { ascending: true })
      .limit(10),
    supabase
      .from("documents")
      .select("id, title, doc_type, created_at, uploader:profiles!uploaded_by(full_name)")
      .eq("entity_type", "property")
      .eq("entity_id", id)
      .order("created_at", { ascending: false }),
    // 0044. Newest first; the card splits the one live hold from history,
    // and history is kept because an expired hold is evidence the property
    // WAS held. The contact join is left-side so an erased buyer (0017)
    // does not hide the hold itself.
    supabase
      .from("reservations")
      .select("id, status, amount, held_from, expires_at, released_at, release_reason, notes, contact_id, contacts(display_name)")
      .eq("property_id", id)
      .order("held_from", { ascending: false })
      .limit(50),
  ]);
  const priceRows = unwrapRows(priceRes, "price history");
  const propertyEventRows = unwrapRows(eventsRes, "events");
  const keyEventRows = unwrapRows(keyEventsRes, "key events");
  const eventRows = [...propertyEventRows, ...keyEventRows]
    .sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1))
    .slice(0, 50);
  const viewingRows = unwrapRows(viewingsRes, "viewings");
  const documentRows = unwrapRows(documentsRes, "documents");

  const profile = await getCurrentProfile(supabase);
  const isAdminOrLM = profile.role === "admin" || profile.role === "listing_manager";
  // mirrors properties_update RLS — forms render read-only when a save would no-op
  const canEditProperty =
    isAdminOrLM || (profile.role === "agent" && p.assigned_agent_id === profile.id);

  const reservations: ReservationRow[] = (reservationsRes.data ?? []).map((r) => {
    const joined = r.contacts as { display_name: string } | { display_name: string }[] | null;
    const contact = Array.isArray(joined) ? (joined[0] ?? null) : joined;
    return {
      id: r.id,
      status: r.status as ReservationRow["status"],
      amount: r.amount === null ? null : Number(r.amount),
      held_from: r.held_from,
      expires_at: r.expires_at,
      released_at: r.released_at,
      release_reason: r.release_reason,
      notes: r.notes,
      contact_id: r.contact_id,
      contact_name: contact?.display_name ?? null,
    };
  });

  const isLand = p.property_type === "land";
  const media = mediaRows ?? [];
  const mandateRows = mandateSafeRows ?? [];
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
    hasAssignedAgent: p.assigned_agent_id !== null,
    hasOwnerOrDeveloper: p.owner_contact_id !== null || p.developer_contact_id !== null,
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

  const activeMandate = mandateRows.find((m) => m.status === "active");
  const mandateState: MandateBadgeState = activeMandate
    ? (activeMandate.type as MandateBadgeState)
    : mandateRows.some((m) => m.status === "expired")
      ? "expired"
      : "none";

  // Contact labels for the mandate panel AND the Parties panel — one fetch, so
  // a mandate owner who is also the property owner is read once.
  const contactIds = [
    ...new Set(
      [
        ...mandateRows.map((m) => m.owner_contact_id),
        p.owner_contact_id,
        p.developer_contact_id,
      ].filter(Boolean),
    ),
  ];
  const { data: ownerRows } = contactIds.length
    ? await supabase
        .from("contacts")
        .select("id, display_name, phone_e164")
        .in("id", contactIds as string[])
    : { data: [] };
  const ownerById = new Map(
    (ownerRows ?? []).map((c) => [
      c.id,
      { id: c.id, label: c.display_name ?? "Unnamed", sublabel: c.phone_e164 },
    ]),
  );

  // The assigned agent is a profile, not a contact — and it may be an INACTIVE
  // one, so this query must not filter on is_active or the panel would render
  // empty while the column still points somewhere.
  const { data: agentRow } = p.assigned_agent_id
    ? await supabase
        .from("profiles")
        .select("id, full_name, role, is_active")
        .eq("id", p.assigned_agent_id)
        .maybeSingle()
    : { data: null };
  const assignedAgent = agentRow
    ? {
        id: agentRow.id,
        label: agentRow.full_name,
        sublabel: agentRow.is_active ? agentRow.role : `${agentRow.role} · inactive`,
      }
    : null;
  // Which mandates have been superseded, keyed by the one they replaced.
  const renewedBy = new Map<string, string>();
  for (const m of mandateRows) {
    if (m.renewed_from_id) {
      renewedBy.set(m.renewed_from_id, `the ${m.type} mandate of ${formatDate(m.start_date!)}`);
    }
  }

  const mandatePanelRows: MandateRow[] = mandateRows.map((m) => ({
    id: m.id!,
    type: m.type as MandateRow["type"],
    status: m.status as MandateRow["status"],
    commission_pct: m.commission_pct,
    commission_notes: m.commission_notes,
    start_date: m.start_date!,
    expiry_date: m.expiry_date,
    renewal_reminder_days: m.renewal_reminder_days ?? 30,
    notes: m.notes,
    signed_document_id: m.signed_document_id,
    owner: m.owner_contact_id ? (ownerById.get(m.owner_contact_id) ?? null) : null,
    renewed_from_id: m.renewed_from_id ?? null,
    // the successor, if one exists — so a superseded mandate says so on its own
    // card rather than leaving the reader to compare dates across three of them
    renewed_by_label: renewedBy.get(m.id!) ?? null,
  }));

  const documents = (documentRows ?? []).map((d) => ({
    id: d.id,
    title: d.title,
    doc_type: d.doc_type,
    created_at: d.created_at,
    uploaded_by_name:
      (d.uploader as { full_name: string | null } | null)?.full_name ?? null,
  }));

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
    // T4.6 acceptance: current key holder visible on Overview
    [
      "Keys",
      (keyRows ?? []).length === 0
        ? "—"
        : (keyRows ?? [])
            .map((k) =>
              k.status === "checked_out"
                ? `${k.key_code} — with ${k.current_holder_name ?? "unknown"}`
                : `${k.key_code} — ${k.status.replace(/_/g, " ")}`,
            )
            .join(" · "),
    ],
    // audit finding 10 — the question every off-plan buyer asks first
    ...(p.delivery_date || p.construction_status
      ? ([
          [
            "Build & handover",
            [
              p.construction_status?.replace(/_/g, " "),
              p.delivery_date ? `delivery ${formatDate(p.delivery_date)}` : null,
            ]
              .filter(Boolean)
              .join(" · "),
          ],
        ] as [string, string][])
      : []),
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
          {p.asking_price !== null ? (
            <Link
              href={`/calculators?price=${Number(p.asking_price)}`}
              className="inline-flex items-center gap-1 text-xs font-medium text-text-2 hover:text-brand-700"
              title="Transfer fees & stamp duty at asking price"
            >
              <Calculator className="size-3.5" /> Costs
            </Link>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            {p.kind === "project" || p.kind === "phase" ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`/properties/${p.id}/units`}>Units matrix</Link>
              </Button>
            ) : null}
            {profile.role === "admin" ? (
              <ArchivePropertyButton
                propertyId={p.id}
                reference={p.reference}
                isRetired={p.visibility === "archived" || p.status === "withdrawn"}
                isWithdrawn={p.status === "withdrawn"}
              />
            ) : null}
          </div>
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
          <TabsTrigger value="mandate">Mandate &amp; Keys</TabsTrigger>
          <TabsTrigger value="documents">Documents ({documents.length})</TabsTrigger>
          <TabsTrigger value="reservation">Reservation</TabsTrigger>
          <TabsTrigger value="buyers">Matching buyers</TabsTrigger>
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

            <div className="mt-6 border-t border-border/60 pt-4">
              <h3 className="text-sm font-semibold text-text-1">Parties</h3>
              <p className="mb-3 mt-1 text-xs text-text-3">
                Who owns it, who built it, and who is responsible for it.
              </p>
              <PartiesForm
                propertyId={p.id}
                kind={p.kind}
                owner={p.owner_contact_id ? (ownerById.get(p.owner_contact_id) ?? null) : null}
                developer={
                  p.developer_contact_id
                    ? (ownerById.get(p.developer_contact_id) ?? null)
                    : null
                }
                agent={assignedAgent}
                readOnly={!isAdminOrLM}
              />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="reservation" className="mt-4">
          <div className="max-w-3xl rounded-[10px] border border-border bg-surface p-6">
            <div className="mb-4">
              <h2 className="text-sm font-semibold text-text-1">Reservation</h2>
              <p className="text-sm text-text-2">
                At most one live hold at a time — the database enforces it, so this property cannot
                be promised to two buyers at once. A hold lapses on its own overnight.
              </p>
            </div>
            <ReservationCard
              propertyId={p.id}
              reservations={reservations}
              canReserve={canEditProperty}
              readOnlyHint="Read-only — you don't have permission to change this property's holds."
              isContainer={p.kind === "project" || p.kind === "phase"}
            />
          </div>
        </TabsContent>

        <TabsContent value="buyers" className="mt-4">
          <div className="max-w-3xl rounded-[10px] border border-border bg-surface p-6">
            <div className="mb-4">
              <h2 className="text-sm font-semibold text-text-1">Buyers looking for this</h2>
              <p className="text-sm text-text-2">
                Saved searches this listing fits, scored by the same rules as the buyer side. Every
                score shows what it missed.
              </p>
            </div>
            {/* A project or a phase is a container nobody buys, so it has no
                buyers of its own — its UNITS do. Matching one would put a
                buyer against a thing that has no price. */}
            {p.kind === "project" || p.kind === "phase" ? (
              <p className="text-sm text-text-2">
                A {p.kind} is not matched directly — open one of its units instead.
              </p>
            ) : (
              <MatchingBuyersCard property={p as unknown as MatchCandidate} />
            )}
          </div>
        </TabsContent>

        <TabsContent value="media" className="mt-4">
          <div className="rounded-[10px] border border-border bg-surface p-6">
            <MediaTab
              propertyId={p.id}
              items={mediaRows}
              canUpload={canEditProperty}
              canManage={isAdminOrLM}
            />
          </div>
        </TabsContent>

        <TabsContent value="details" className="mt-4">
          <div className="rounded-[10px] border border-border bg-surface p-6">
            <DetailsForm
              property={p}
              areas={areas}
              isAdmin={profile.role === "admin"}
              readOnly={!canEditProperty}
            />
          </div>
        </TabsContent>

        <TabsContent value="legal" className="mt-4">
          <div className="max-w-3xl rounded-[10px] border border-border bg-surface p-6">
            <LegalForm property={p} readOnly={!canEditProperty} />
          </div>
        </TabsContent>

        <TabsContent value="marketing" className="mt-4">
          <div className="max-w-3xl rounded-[10px] border border-border bg-surface p-6">
            <MarketingForm property={p} readOnly={!canEditProperty} />
          </div>
        </TabsContent>

        <TabsContent value="mandate" className="mt-4">
          <div className="flex max-w-3xl flex-col gap-4">
            <div className="rounded-[10px] border border-border bg-surface p-6">
              <MandatePanel
                propertyId={p.id}
                mandates={mandatePanelRows}
                isAdmin={profile.role === "admin"}
              />
            </div>

            <div className="rounded-[10px] border border-border bg-surface p-6">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-text-1">Keys</h3>
                {profile.role === "admin" || profile.role === "listing_manager" ? (
                  <RegisterKeyDialog
                    defaultProperty={{
                      id: p.id,
                      label: title || p.reference,
                      sublabel: p.reference,
                    }}
                  />
                ) : null}
              </div>
              {(keyRows ?? []).length === 0 ? (
                <p className="text-sm text-text-3">No keys registered for this property.</p>
              ) : (
                <ul className="flex flex-col divide-y divide-border/60">
                  {(keyRows ?? []).map((k) => (
                    <li key={k.id} className="flex items-center justify-between gap-4 py-2 text-sm">
                      <span className="min-w-0">
                        <span className="font-mono text-xs font-semibold text-text-1">
                          {k.key_code}
                        </span>
                        {k.description ? (
                          <span className="ml-2 text-text-2">{k.description}</span>
                        ) : null}
                        <span className="ml-2 text-xs capitalize text-text-3">
                          {k.status.replace(/_/g, " ")}
                          {k.current_holder_name ? ` · ${k.current_holder_name}` : ""}
                        </span>
                      </span>
                      <KeyMovementActions
                        keyId={k.id}
                        keyCode={k.key_code}
                        description={k.description}
                        status={k.status}
                        canEdit={isAdminOrLM}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="documents" className="mt-4">
          <div className="max-w-3xl rounded-[10px] border border-border bg-surface p-6">
            <DocumentsTab
              propertyId={p.id}
              items={documents}
              isAdmin={profile.role === "admin"}
            />
          </div>
        </TabsContent>

        <TabsContent value="activity" className="mt-4">
          <div className="max-w-3xl rounded-[10px] border border-border bg-surface p-6">
            {profile.role !== "admin" ? (
              <p className="mb-3 text-xs text-text-3">
                You see actions you performed — admins see the full history.
              </p>
            ) : null}
            <EventTimeline events={eventRows} />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
