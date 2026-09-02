"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Database } from "@/lib/supabase/database.types";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import {
  generateUnits,
  generateVillaUnits,
  MAX_GENERATED_UNITS,
} from "@/lib/services/unit-generator";
import { UNIT_PARENT_SELECT } from "@/lib/services/unit-inheritance";
import { writeGeneratedUnits } from "@/lib/services/unit-writer";
import { generateReference } from "@/lib/services/reference";
import { createClient } from "@/lib/supabase/server";
import { changedValue } from "@/lib/utils/diff";
import { createPropertySchema } from "@/lib/validators/properties";
import type { PropertyDuplicateMatch } from "@/lib/services/property-duplicate";

export type PropertyActionState = { error: string | null };

export type UpdateSectionState = {
  error: string | null;
  savedAt: number | null;
};

/**
 * Is there already a property at this address in this district?
 * (BACKLOG audit finding 13.)
 *
 * WARNS, NEVER BLOCKS — the caller shows a link and leaves the decision alone.
 * Two genuinely different units share a building, and a guard that refuses them
 * is a guard people learn to work around.
 *
 * District-scoped, so the candidate set stays small and two identical addresses
 * in different towns are correctly treated as different places. Bounded at 500
 * rows: the address column is unindexed by design (BACKLOG notes it as fine at
 * internal scale), and a bound that can be stated beats one that cannot.
 */
export async function checkPropertyDuplicate(
  districtId: string,
  address: string,
): Promise<PropertyDuplicateMatch | null> {
  if (!districtId || address.trim().length < 3) return null;

  const supabase = await createClient();
  const { data } = await supabase
    .from("properties")
    .select("id, reference, address, title, status")
    .eq("district_id", districtId)
    .not("address", "is", null)
    .limit(500);

  const { findAddressMatch } = await import("@/lib/services/property-duplicate");
  return findAddressMatch(
    (data ?? []).map((p) => ({
      id: p.id,
      reference: p.reference,
      address: p.address,
      title: p.title as { en?: string } | null,
      status: p.status,
    })),
    address,
  );
}

/**
 * DLS registration duplicate check (0077, DB-05) — the STRONGER signal, and
 * the only one that works for unaddressed land. Org-wide (a plot's number is
 * unique however the listing is districted), same warn-never-block doctrine,
 * same bounded scan (the partial index keeps the not-null set small and the
 * matcher pure and tested).
 */
export async function checkPropertyRegistrationDuplicate(
  registrationNo: string,
): Promise<PropertyDuplicateMatch | null> {
  if (registrationNo.trim().length < 3) return null;

  const supabase = await createClient();
  const { data } = await supabase
    .from("properties")
    .select("id, reference, registration_no, title, status")
    .not("registration_no", "is", null)
    .limit(500);

  const { findRegistrationMatch } = await import("@/lib/services/property-duplicate");
  return findRegistrationMatch(
    (data ?? []).map((p) => ({
      id: p.id,
      reference: p.reference,
      registration_no: p.registration_no,
      title: p.title as { en?: string } | null,
      status: p.status,
    })),
    registrationNo,
  );
}

export async function createProperty(
  _prev: PropertyActionState,
  formData: FormData,
): Promise<PropertyActionState> {
  const parsed = createPropertySchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const input = parsed.data;

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  if (!["admin", "listing_manager", "agent"].includes(profile.role)) {
    return { error: "Your role cannot create properties" };
  }

  /**
   * Project layout (2026-09-02). A container's units are generated in the same
   * submit — decided HERE, first, because this block is pure: it reads only
   * the parsed input and can refuse without having touched anything. The
   * first cut placed it after `generateReference`, so every refused submit
   * burned a district sequence number (review finding, same day) — the
   * counter is a committed RPC, not part of the insert. Everything that can
   * be refused is refused before the reference is minted; the generation
   * itself runs after the row exists (it needs the parent's id and
   * inheritable columns).
   *
   * Who may generate: the same people who manage units on the units page
   * (admin, listing manager). An agent's project lands on that page with
   * the units left for them — the wizard says so and posts no layout, and
   * this ignores one if it were posted anyway.
   */
  const isContainer = input.kind === "project";
  const canGenerate = profile.role === "admin" || profile.role === "listing_manager";
  const layout = isContainer && canGenerate ? input.gen_layout : undefined;
  // "touched" — any floor field typed — is what separates "later" (nothing
  // typed, an empty project by design) from "wrong" (a range that yields
  // nothing). The wizard draws the same line client-side.
  const floorsTouched =
    layout === "floors" &&
    (input.gen_floor_from !== undefined ||
      input.gen_floor_to !== undefined ||
      input.gen_per_floor !== undefined);
  const generated =
    layout === "villas" && input.gen_villa_count
      ? generateVillaUnits({
          prefix: input.gen_villa_prefix ?? null,
          count: input.gen_villa_count,
          bedrooms: input.gen_bedrooms ?? null,
          bathrooms: input.gen_bathrooms ?? null,
          coveredAreaSqm: input.gen_covered_area_sqm ?? null,
          plotAreaSqm: input.gen_plot_area_sqm ?? null,
          basePrice: input.gen_base_price ?? null,
          pricePerVilla: input.gen_price_step ?? null,
        })
      : layout === "floors" &&
          input.gen_floor_from !== undefined &&
          input.gen_floor_to !== undefined &&
          input.gen_per_floor !== undefined
        ? generateUnits({
            block: input.gen_block ?? null,
            floorFrom: input.gen_floor_from,
            floorTo: input.gen_floor_to,
            perFloor: input.gen_per_floor,
            bedrooms: input.gen_bedrooms ?? null,
            bathrooms: input.gen_bathrooms ?? null,
            coveredAreaSqm: input.gen_covered_area_sqm ?? null,
            basePrice: input.gen_base_price ?? null,
            pricePerFloor: input.gen_price_step ?? null,
          })
        : [];
  if (generated.length > MAX_GENERATED_UNITS) {
    return {
      error: `That would create more than ${MAX_GENERATED_UNITS} units — narrow the range, or add the rest from the units page.`,
    };
  }
  if (floorsTouched && generated.length === 0) {
    return { error: "That floor range produces no units — check floors from/to and units per floor." };
  }

  const { data: district, error: districtErr } = await supabase
    .from("districts")
    .select("code")
    .eq("id", input.district_id)
    .single();
  if (districtErr || !district) return { error: "District not found" };

  /**
   * The party's standard terms, RE-RESOLVED HERE (migration 0038).
   *
   * The wizard shows the same values before submit, but they are recomputed
   * server-side rather than accepted from the form: a client can post anything,
   * and these set a VAT treatment and a legal status on a record the desk will
   * quote from. The form's copy is for the human; this one is the one written.
   *
   * Only the party the SOURCE names is honoured. A form that posted both would
   * otherwise attach a developer to a private owner's villa.
   */
  const ownerId = input.source === "owner" ? (input.owner_contact_id ?? null) : null;
  const developerId = input.source === "developer" ? (input.developer_contact_id ?? null) : null;
  const partyId = ownerId ?? developerId;

  // typed from the generated Insert, not as loose strings: partyDefaultsSchema
  // already validates these against the same enums, and widening to `string`
  // here would throw that guarantee away at the last step
  type PropertyInsert = Database["public"]["Tables"]["properties"]["Insert"];
  let partyTerms: Pick<
    PropertyInsert,
    "vat_status" | "title_deed_status" | "permit_status"
  > = {};
  if (partyId) {
    const { getPartyDefaults } = await import("@/lib/actions/party-defaults");
    const { defaults } = await getPartyDefaults(partyId);
    partyTerms = {
      ...(defaults.vat_status ? { vat_status: defaults.vat_status } : {}),
      ...(defaults.title_deed_status
        ? { title_deed_status: defaults.title_deed_status }
        : {}),
      ...(defaults.permit_status ? { permit_status: defaults.permit_status } : {}),
    };
  }

  // Reference is generated here — at final submit, the LAST side effect
  // before the insert — so abandoned wizards and refused submits never burn
  // sequence numbers (DECISIONS.md, T1.2; T-wizard-project-layout).
  const reference = await generateReference(supabase, profile.orgId, district.code);

  const { data: created, error: insertErr } = await supabase
    .from("properties")
    .insert({
      org_id: profile.orgId,
      reference,
      kind: input.kind,
      property_type: input.property_type,
      transaction_type: input.transaction_type,
      district_id: input.district_id,
      area_id: input.area_id ?? null,
      title: input.title_en ? { en: input.title_en } : {},
      address: input.address ?? null,
      registration_no: input.registration_no ?? null,
      asking_price: input.asking_price ?? null,
      rent_price_month: input.rent_price_month ?? null,
      // a container's rooms and covered area belong to its UNITS (the score
      // and the gate grade it on units since 2026-09-02); the site's plot is
      // the one area measure a development legitimately has
      bedrooms: isContainer ? null : (input.bedrooms ?? null),
      bathrooms: isContainer ? null : (input.bathrooms ?? null),
      covered_area_sqm: isContainer ? null : (input.covered_area_sqm ?? null),
      plot_area_sqm: input.plot_area_sqm ?? null,
      internal_notes: input.internal_notes ?? null,
      owner_contact_id: ownerId,
      developer_contact_id: developerId,
      // the party's standard terms; absent keys leave the column's own default
      ...partyTerms,
      // agents are auto-assigned to themselves (RLS with-check enforces it)
      assigned_agent_id: profile.role === "agent" ? profile.id : null,
      created_by: profile.id,
    })
    .select("id")
    .single();
  if (insertErr || !created) {
    return { error: insertErr?.message ?? "Insert failed" };
  }

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "property",
    entityId: created.id,
    eventType: "created",
    payload: {
      reference,
      kind: input.kind,
      property_type: input.property_type,
      // what was written from the party's standard terms, so the timeline
      // explains values nobody typed
      ...(partyId
        ? {
            source: input.source,
            party: partyId,
            applied_defaults: Object.keys(partyTerms),
          }
        : {}),
    },
  });

  let unitsFailure: string | null = null;
  if (generated.length > 0) {
    // the freshly inserted row, with every inheritable column — units inherit
    // from the parent exactly as a hand-added unit does
    const { data: parent } = await supabase
      .from("properties")
      .select(UNIT_PARENT_SELECT)
      .eq("id", created.id)
      .single();
    // What a UNIT is, is decided by the layout, not by what the development
    // calls itself: a "building" or "mixed use" development's flats are
    // apartments, a villa complex's units are villas. Only when the
    // development is already named after its dwelling type does that type
    // carry (the units page's generator defaults the same way; 2026-09-02
    // review, critic pass).
    const DWELLING_TYPES = new Set(["apartment", "villa", "townhouse", "house"]);
    const unitPropertyType = DWELLING_TYPES.has(input.property_type)
      ? input.property_type
      : layout === "villas"
        ? ("villa" as const)
        : ("apartment" as const);
    const written = parent
      ? await writeGeneratedUnits(supabase, parent, generated, {
          propertyType: unitPropertyType,
          actorId: profile.id,
        })
      : { error: "could not re-read the new project" };
    if (written.error) {
      // The project EXISTS and its reference is burned; an error here would
      // send the operator back to a form whose resubmit makes a second one.
      // Land them on the units page WITH the reason (a console line is not
      // "loud" to the person at the desk — 2026-09-02 review, critic pass);
      // the page says what happened and the generator is right below it.
      console.error(`[createProperty] units did not land for ${reference}:`, written.error);
      unitsFailure = written.error;
    }
  }

  revalidatePath("/properties");
  // A project lands on its units matrix: that page IS what a project is made
  // of, and when the count was left blank it says so and offers the generator.
  // The stored score is what the list and the CSV read; nothing had written
  // it at creation, so every new property sat at 0 there until its first
  // save (2026-09-02 review). Computed once the units exist, since a
  // container's score is theirs.
  const { recomputeQualityScore } = await import("@/lib/services/quality-score");
  await recomputeQualityScore(supabase, created.id);

  redirect(
    isContainer
      ? `/properties/${created.id}/units` +
          (unitsFailure ? `?units=failed&reason=${encodeURIComponent(unitsFailure)}` : "")
      : `/properties/${created.id}`,
  );
}

export async function updatePropertySection(
  _prev: UpdateSectionState,
  formData: FormData,
): Promise<UpdateSectionState> {
  const propertyId = formData.get("property_id");
  const section = formData.get("section");
  if (typeof propertyId !== "string" || typeof section !== "string") {
    return { error: "Missing property or section", savedAt: null };
  }

  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const { data: current, error: fetchErr } = await supabase
    .from("properties")
    .select("*")
    .eq("id", propertyId)
    .maybeSingle();
  if (fetchErr || !current) return { error: "Property not found", savedAt: null };

  const raw = Object.fromEntries(formData.entries());
  let updates: Database["public"]["Tables"]["properties"]["Update"];
  // readable diff for the location point (raw EWKB hex vs EWKT is meaningless)
  let locationChange: { from: unknown; to: unknown } | null = null;
  // 0054: tracked separately because it moves INDEPENDENTLY of the point —
  // typing the same numbers over a centroid changes nothing but the claim.
  let approxChange: { from: unknown; to: unknown } | null = null;

  const { detailsSectionSchema, legalSectionSchema, marketingSectionSchema, isStatusRegression } =
    await import("@/lib/validators/properties");

  if (section === "details") {
    const parsed = detailsSectionSchema.safeParse({
      ...raw,
      features: formData.getAll("features").map(String),
    });
    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
    }
    const d = parsed.data;

    // DB-01: leaving sold/rented is a supported but ADMIN-ONLY move —
    // enforced here, not left to the UI (a form can post any status). The
    // override event below makes the regression separately auditable.
    if (isStatusRegression(current.status, d.status) && profile.role !== "admin") {
      return {
        error: "Only an admin can move a sold or rented listing back to market.",
        savedAt: null,
      };
    }

    updates = {
      status: d.status,
      visibility: d.visibility,
      transaction_type: d.transaction_type,
      area_id: d.area_id ?? null,
      address: d.address ?? null,
      postal_code: d.postal_code ?? null,
      sea_distance_m: d.sea_distance_m ?? null,
      amenities_notes: d.amenities_notes ?? null,
      asking_price: d.asking_price ?? null,
      min_acceptable_price: d.min_acceptable_price ?? null,
      owner_net_price: d.owner_net_price ?? null,
      rent_price_month: d.rent_price_month ?? null,
      vat_status: d.vat_status,
      covered_area_sqm: d.covered_area_sqm ?? null,
      plot_area_sqm: d.plot_area_sqm ?? null,
      veranda_sqm: d.veranda_sqm ?? null,
      roof_garden_sqm: d.roof_garden_sqm ?? null,
      basement_sqm: d.basement_sqm ?? null,
      bedrooms: d.bedrooms ?? null,
      bathrooms: d.bathrooms ?? null,
      wc: d.wc ?? null,
      parking_spaces: d.parking_spaces ?? null,
      has_storage: d.has_storage,
      floor_number: d.floor_number ?? null,
      total_floors: d.total_floors ?? null,
      year_built: d.year_built ?? null,
      energy_class: d.energy_class ?? null,
      features: d.features,
      construction_status: d.construction_status ?? null,
      delivery_date: d.delivery_date ?? null,
      internal_notes: d.internal_notes ?? null,
    };
    // the land panel isn't rendered for non-land properties, so its absent
    // checkboxes would read as `false` — only land rows take these columns
    if (current.property_type === "land") {
      Object.assign(updates, {
        planning_zone_code: d.planning_zone_code ?? null,
        building_density_pct: d.building_density_pct ?? null,
        coverage_ratio_pct: d.coverage_ratio_pct ?? null,
        max_floors: d.max_floors ?? null,
        max_height_m: d.max_height_m ?? null,
        road_frontage_m: d.road_frontage_m ?? null,
        water_available: d.water_available,
        electricity_available: d.electricity_available,
        constraints_notes: d.constraints_notes ?? null,
      });
    }

    // location is a PostGIS point: DB returns EWKB hex, we write EWKT. Compare
    // decoded coords (rounded) so an unchanged point is not re-written every save.
    const { locationChanged, parseLocationPoint, toLocationEWKT } = await import(
      "@/lib/utils/geo"
    );
    const prevPoint = parseLocationPoint((current as { location?: unknown }).location);
    const nextPoint =
      d.latitude !== undefined && d.longitude !== undefined
        ? { lat: d.latitude, lng: d.longitude }
        : null;
    if (locationChanged(prevPoint, nextPoint)) {
      updates.location = nextPoint ? toLocationEWKT(nextPoint.lat, nextPoint.lng) : null;
      locationChange = { from: prevPoint, to: nextPoint };
    }

    // 0054. Deliberately NOT nested inside the branch above: the flag can move
    // while the point does not (typing the same numbers over a centroid is the
    // user asserting them), and it must be forced false when the point is
    // cleared or the CHECK constraint refuses the row.
    const prevApprox = Boolean((current as { location_approx?: boolean }).location_approx);
    const nextApprox = nextPoint !== null && d.location_approx;
    if (nextApprox !== prevApprox) {
      updates.location_approx = nextApprox;
      approxChange = { from: prevApprox, to: nextApprox };
    }
  } else if (section === "legal") {
    const parsed = legalSectionSchema.safeParse(raw);
    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
    }
    const d = parsed.data;
    updates = {
      title_deed_status: d.title_deed_status,
      permit_status: d.permit_status,
      share_of_land: d.share_of_land ?? null,
      encumbrances_notes: d.encumbrances_notes ?? null,
      registration_no: d.registration_no ?? null,
      plot_no: d.plot_no ?? null,
      sheet_plan: d.sheet_plan ?? null,
      registry_municipality: d.registry_municipality ?? null,
    };
  } else if (section === "marketing") {
    const parsed = marketingSectionSchema.safeParse({
      title: { en: raw.title_en, el: raw.title_el, ru: raw.title_ru },
      short_description: {
        en: raw.short_description_en,
        el: raw.short_description_el,
        ru: raw.short_description_ru,
      },
      public_description: {
        en: raw.public_description_en,
        el: raw.public_description_el,
        ru: raw.public_description_ru,
      },
    });
    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
    }
    const strip = (o: Record<string, string | undefined>) =>
      Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ""));
    updates = {
      title: strip(parsed.data.title),
      short_description: strip(parsed.data.short_description),
      public_description: strip(parsed.data.public_description),
    };
  } else if (section === "parties") {
    // Admin + listing manager only, enforced HERE and not left to RLS. The
    // properties UPDATE policy also admits the ASSIGNED AGENT, and its
    // with-check tests org_id alone — so an agent could hand their own property
    // to someone else and lock themselves out of it. Hiding the control would
    // not be a guard; this is (same reasoning as archiveProperty below).
    if (profile.role !== "admin" && profile.role !== "listing_manager") {
      return {
        error: "Only admins and listing managers can change who a property belongs to.",
        savedAt: null,
      };
    }
    const { partiesSectionSchema, resolvePartyUpdates } = await import(
      "@/lib/validators/properties"
    );
    const parsed = partiesSectionSchema.safeParse(raw);
    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
    }
    // An agent id that isn't an active member grants edit rights to nobody and
    // fails the FK with an opaque message — check it while we can still explain.
    if (parsed.data.assigned_agent_id) {
      const { data: agent } = await supabase
        .from("profiles")
        .select("id")
        .eq("id", parsed.data.assigned_agent_id)
        .eq("is_active", true)
        .maybeSingle();
      if (!agent) {
        return { error: "That agent is not an active member of this office.", savedAt: null };
      }
    }
    updates = resolvePartyUpdates(parsed.data, { kind: current.kind });
  } else {
    return { error: `Unknown section: ${section}`, savedAt: null };
  }

  // Publish gate (doc 02 §A8): switching visibility to `public` requires
  // score ≥ PUBLISH_THRESHOLD, unless an admin overrides (logged event).
  // Scored over current + pending updates: the fields fixed in THIS save must
  // count, otherwise filling the gaps and publishing in one go is rejected.
  const goingPublic = updates.visibility === "public" && current.visibility !== "public";
  if (goingPublic) {
    const { computeQualityScore, PUBLISH_THRESHOLD } = await import(
      "@/lib/services/quality-score"
    );
    const [{ data: media }, { data: activeMandates }] = await Promise.all([
      // photos only (MEDIA-K) — the publish gate must agree with the score
      supabase
        .from("property_media")
        .select("id, is_cover")
        .eq("property_id", propertyId)
        .eq("kind", "photo"),
      // mandates_safe, not the base table — listing managers can't read the
      // base table and would lose the active-mandate points
      supabase
        .from("mandates_safe")
        .select("id")
        .eq("property_id", propertyId)
        .eq("status", "active"),
    ]);
    const merged = { ...(current as Record<string, unknown>), ...updates } as Record<
      string,
      unknown
    >;
    const isLand = merged.property_type === "land";
    const isContainer = current.kind === "project" || current.kind === "phase";
    // ONE definition of "a unit" — kind = unit, not archived, under the
    // container or any of its phases (container-units.ts). The first cut
    // counted every child row, so an empty PHASE satisfied this gate.
    const { countContainerUnits, EMPTY_CONTAINER_FACTS } = await import(
      "@/lib/services/container-units"
    );
    const units = isContainer
      ? await countContainerUnits(supabase, propertyId)
      : EMPTY_CONTAINER_FACTS;

    // An EMPTY container cannot be published, and this refusal is not
    // overridable (2026-09-02). The score override exists for a listing that
    // is thin but deliberate — a judgement call an admin is entitled to make.
    // An empty project is not thin, it is empty: units carry the prices, a
    // container cannot be reserved and never appears in buyer matching, so
    // publishing one puts a page in front of buyers that nothing can act on.
    // A real project reached the public feed this way, at 100/100, because
    // the score was measuring a dwelling that was not there.
    //
    // "Coming soon" is the honest state for a development whose units are not
    // defined yet, and it is already in the visibility list — so the refusal
    // names it rather than offering another override.
    if (isContainer && units.unitCount === 0) {
      return {
        error:
          `A ${current.kind} with no units cannot be published — buyers cannot be matched to it ` +
          `and it cannot be reserved.` +
          (units.phaseCount > 0 ? ` Its phases are empty too.` : ``) +
          ` Add its units first, or set visibility to "Coming soon".`,
        savedAt: null,
      };
    }
    const result = computeQualityScore({
      isLand,
      isContainer,
      unitCount: units.unitCount,
      pricedUnitCount: units.pricedUnitCount,
      hasCoverPhoto: (media ?? []).some((m) => m.is_cover),
      photoCount: (media ?? []).length,
      titleEn: (merged.title as { en?: string } | null)?.en,
      publicDescriptionEn: (merged.public_description as { en?: string } | null)?.en,
      hasPrice: merged.asking_price != null || merged.rent_price_month != null,
      hasArea: isLand ? merged.plot_area_sqm != null : merged.covered_area_sqm != null,
      hasBedroomsAndBathrooms: merged.bedrooms != null && merged.bathrooms != null,
      hasPlanningZoneAndDensity:
        merged.planning_zone_code != null && merged.building_density_pct != null,
      // 0054: a centroid stand-in is not an exact location. This mirrors
      // quality-score.ts exactly; the two must agree or a save and a recompute
      // produce different scores for the same row.
      hasCoords: merged.location != null && !merged.location_approx,
      titleDeedSet: merged.title_deed_status !== "unknown",
      permitSet: merged.permit_status !== "unknown",
      mandateActive: (activeMandates ?? []).length > 0,
      // from `merged`, like every other input here: a parties save in the same
      // submit must count toward the gate it is trying to clear
      hasAssignedAgent: merged.assigned_agent_id != null,
      hasOwnerOrDeveloper:
        merged.owner_contact_id != null || merged.developer_contact_id != null,
    });
    const score = result.score;
    if (score < PUBLISH_THRESHOLD) {
      const wantsOverride = formData.get("publish_override") === "on";
      if (profile.role !== "admin") {
        return {
          error: `Quality score ${score} is below ${PUBLISH_THRESHOLD} — publishing blocked. An admin can override.`,
          savedAt: null,
        };
      }
      if (!wantsOverride) {
        return {
          error: `Quality score ${score} is below ${PUBLISH_THRESHOLD}. Tick "Override publish gate" to publish anyway.`,
          savedAt: null,
        };
      }
      await logEvent(supabase, {
        orgId: profile.orgId,
        actorId: profile.id,
        entityType: "property",
        entityId: propertyId,
        eventType: "publish_override",
        payload: { score, threshold: PUBLISH_THRESHOLD },
      });
    }
    // DB-02 (0073): the public feed orders by published_at desc and nothing
    // ever wrote it. Stamped on every transition INTO public — a relisting
    // after months away is genuinely news again — and never cleared on
    // unpublish, so the column still answers "when was this last public".
    // Reaching this line means the gate passed or an admin overrode it, and
    // the diff logger below records the stamp in the update event for free.
    updates.published_at = new Date().toISOString();
  }

  // changed-field payload for the event (guardrail: updates must carry their diff)
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, next] of Object.entries(updates)) {
    if (key === "location") continue; // handled below with decoded coords
    const prev = (current as Record<string, unknown>)[key];
    if (changedValue(prev, next)) changed[key] = { from: prev ?? null, to: next ?? null };
  }
  if (locationChange) changed.location = locationChange;
  if (approxChange) changed.location_approx = approxChange;
  if (Object.keys(changed).length === 0) {
    return { error: null, savedAt: Date.now() }; // nothing to write, still "saved"
  }

  // A unit that has just had an inherited column edited now has an opinion of
  // its own, so that column stops following its project (0035). Only CHANGED
  // fields count: the details form posts twenty-odd columns on every save, and
  // dropping everything it touched would sever a unit's whole inheritance the
  // first time anybody opened the tab and pressed Save.
  if (current.kind === "unit") {
    const { fieldsClaimedByEdit } = await import("@/lib/services/unit-inheritance");
    const stillInherited = fieldsClaimedByEdit(current.inherited_fields, Object.keys(changed));
    if (stillInherited.length !== (current.inherited_fields ?? []).length) {
      updates.inherited_fields = stillInherited;
    }
  }

  // RLS filters a forbidden update to 0 rows without an error — the returned
  // ids are the proof a row actually changed. Without this, agents saving a
  // property that isn't theirs got a "Saved" toast plus a phantom event.
  const { data: updatedRows, error: updateErr } = await supabase
    .from("properties")
    .update(updates)
    .eq("id", propertyId)
    .select("id");
  if (updateErr) return { error: updateErr.message, savedAt: null };
  if (!updatedRows || updatedRows.length === 0) {
    return {
      error:
        "Nothing was saved — this property isn't assigned to you. Admins and listing managers can edit any property.",
      savedAt: null,
    };
  }

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "property",
    entityId: propertyId,
    eventType: "updated",
    payload: JSON.parse(JSON.stringify({ section, changed })),
  });

  // DB-01: the regression got past the admin gate above — mark it with its
  // own event (the publish_override idiom), so "who put a sold listing back
  // on the market" is one query, not a diff excavation.
  if (changed.status && isStatusRegression(String(changed.status.from), String(changed.status.to))) {
    await logEvent(supabase, {
      orgId: profile.orgId,
      actorId: profile.id,
      entityType: "property",
      entityId: propertyId,
      eventType: "status_regression_override",
      payload: { from: String(changed.status.from), to: String(changed.status.to) },
    });
  }

  // DB-01's other leg: the listing_status_check raised at deal-win completes
  // the moment the status it asked for is saved (review 2026-09-01 — it used
  // to stay open forever, and a prompt that survives being obeyed teaches
  // the desk to ignore prompts)
  if (changed.status) {
    const { completeListingStatusChecks } = await import("@/lib/services/followup-tasks");
    const closed = await completeListingStatusChecks(supabase, {
      propertyId,
      orgId: profile.orgId,
      actorId: profile.id,
      newStatus: String((changed.status as { to?: unknown }).to ?? ""),
    });
    if (closed > 0) {
      revalidatePath("/tasks");
      revalidatePath("/dashboard");
    }
  }

  // score is derived state — recompute on every save (doc 02 §A8); the save's
  // own property.updated event covers auditability, no separate score event
  const { recomputeQualityScore } = await import("@/lib/services/quality-score");
  await recomputeQualityScore(supabase, propertyId);

  // title deed status is a deal-health factor (doc 02 §C5) — refresh open deals
  if (section === "legal") {
    const { recomputeDealsFor } = await import("@/lib/services/health-score");
    await recomputeDealsFor(supabase, { propertyId });
  }

  // A price drop can put this property inside somebody's budget for the first
  // time. BEST EFFORT, and deliberately so: the save has already succeeded and
  // been evented, so an alert failure must never turn it into an error the user
  // sees — they would retry a save that already worked. It is also skipped for
  // containers, whose units carry the prices.
  const priceMoved = "asking_price" in changed || "rent_price_month" in changed;
  const statusMoved = "status" in changed;
  if (
    section === "details" &&
    current.kind !== "project" &&
    current.kind !== "phase" &&
    (priceMoved || statusMoved)
  ) {
    try {
      const { raisePriceDropAlert, raiseNewListingAlert } = await import(
        "@/lib/services/match-alerts"
      );
      const { data: fresh } = await supabase
        .from("properties")
        .select(
          "id, reference, assigned_agent_id, status, transaction_type, property_type, " +
            "district_id, area_id, asking_price, rent_price_month, bedrooms, bathrooms, " +
            "covered_area_sqm, plot_area_sqm, title_deed_status, vat_status, sea_distance_m, " +
            "delivery_date, features",
        )
        .eq("id", propertyId)
        .single();
      if (fresh) {
        const property = fresh as unknown as Parameters<
          typeof raisePriceDropAlert
        >[1]["property"];

        // A property arriving on the market is a bigger event than a price
        // move on one already there, so it is checked FIRST and the drop is
        // skipped when it fires — a single save that both publishes and
        // reprices should raise one alert, not two saying the same thing.
        let announced = false;
        if (statusMoved) {
          const res = await raiseNewListingAlert(supabase, {
            orgId: profile.orgId,
            actorId: profile.id,
            property,
            previousStatus: current.status as typeof property.status,
          });
          announced = res.newlyMatching > 0;
        }

        if (priceMoved && !announced) {
          await raisePriceDropAlert(supabase, {
            orgId: profile.orgId,
            actorId: profile.id,
            property,
            oldAskingPrice:
              current.asking_price === null ? null : Number(current.asking_price),
            oldRentPrice:
              current.rent_price_month === null ? null : Number(current.rent_price_month),
          });
        }
      }
    } catch (err) {
      // Best effort, but NOT silent. The first version swallowed without a
      // trace, and when the alert stopped firing there was nothing anywhere to
      // say so — the save succeeded, the event was written, and the feature was
      // simply absent. Sentry is wired (IMPROVEMENTS C1), so this reaches a
      // durable sink instead of nowhere.
      console.error("match alert failed", { propertyId, err });
    }
  }

  revalidatePath(`/properties/${propertyId}`);
  revalidatePath("/properties");
  return { error: null, savedAt: Date.now() };
}

/**
 * Archive = the properties "delete" (doc 04: DELETE ❌ — the retire path is
 * status `withdrawn` and/or visibility `archived`, and the list scope filter
 * treats either marker as retired).
 *
 * Deliberately touches `visibility` only. `status` is market truth — a villa
 * that SOLD must still read `sold` after archiving, or the outcome is lost
 * from reporting and from the timeline. Archiving answers "should this show
 * up", which is a visibility question.
 *
 * Admin-only, enforced HERE and not left to RLS: the properties UPDATE policy
 * also admits listing managers and the assigned agent, so hiding the button
 * alone would not be a control. Retiring a listing is an owner decision.
 */
export async function archiveProperty(propertyId: string): Promise<PropertyActionState> {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  if (profile.role !== "admin") return { error: "Admins only." };

  const { data: current } = await supabase
    .from("properties")
    .select("id, visibility, parent_id")
    .eq("id", propertyId)
    .maybeSingle();
  if (!current) return { error: "Property not found" };
  if (current.visibility === "archived") return { error: "Already archived" };

  const { data: rows, error } = await supabase
    .from("properties")
    .update({ visibility: "archived" })
    .eq("id", propertyId)
    .neq("visibility", "archived")
    .select("id");
  if (error) return { error: error.message };
  if (!rows || rows.length === 0) {
    return { error: "You don't have permission to archive this property." };
  }

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "property",
    entityId: propertyId,
    eventType: "archived",
    payload: { manual: true, visibility: { from: current.visibility, to: "archived" } },
  });

  // an archived unit no longer counts for the container above it — its
  // stored score (what the list reads) moves with it (2026-09-02 review)
  const { refreshContainerScores } = await import("@/lib/services/quality-score");
  await refreshContainerScores(supabase, current.parent_id);

  revalidatePath(`/properties/${propertyId}`);
  revalidatePath("/properties");
  return { error: null };
}

/**
 * Restore returns visibility to `private`, never to `public` — republishing a
 * listing is an explicit decision made on the Details tab (and gated by the
 * quality score), not a side effect of un-archiving.
 *
 * It also clears a `withdrawn` status back to `available`, because withdrawn
 * is the OTHER retire marker: leaving it set would drop the property straight
 * back into the Archived list and make Restore look broken. Every other status
 * (sold, rented, reserved, under_offer, draft) is market truth and survives.
 *
 * Admin-only, same as archiveProperty — see the note there.
 */
export async function restoreProperty(propertyId: string): Promise<PropertyActionState> {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);
  if (profile.role !== "admin") return { error: "Admins only." };

  const { data: current } = await supabase
    .from("properties")
    .select("id, status, visibility, parent_id")
    .eq("id", propertyId)
    .maybeSingle();
  if (!current) return { error: "Property not found" };
  const wasRetired = current.visibility === "archived" || current.status === "withdrawn";
  if (!wasRetired) return { error: "Not archived" };

  const { resolveRestoreUpdates } = await import("@/lib/validators/properties");
  const updates: Database["public"]["Tables"]["properties"]["Update"] =
    resolveRestoreUpdates(current);

  const { data: rows, error } = await supabase
    .from("properties")
    .update(updates)
    .eq("id", propertyId)
    .select("id");
  if (error) return { error: error.message };
  if (!rows || rows.length === 0) {
    return { error: "You don't have permission to restore this property." };
  }

  await logEvent(supabase, {
    orgId: profile.orgId,
    actorId: profile.id,
    entityType: "property",
    entityId: propertyId,
    eventType: "unarchived",
    payload: {
      manual: true,
      ...(updates.visibility
        ? { visibility: { from: current.visibility, to: updates.visibility } }
        : {}),
      ...(updates.status ? { status: { from: current.status, to: updates.status } } : {}),
    },
  });

  // visibility feeds the quality score / publish gate inputs — and a restored
  // unit counts for its container again (2026-09-02 review)
  const { recomputeQualityScore, refreshContainerScores } = await import(
    "@/lib/services/quality-score"
  );
  await recomputeQualityScore(supabase, propertyId);
  await refreshContainerScores(supabase, current.parent_id);

  revalidatePath(`/properties/${propertyId}`);
  revalidatePath("/properties");
  return { error: null };
}
