"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Database } from "@/lib/supabase/database.types";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import { generateReference } from "@/lib/services/reference";
import { createClient } from "@/lib/supabase/server";
import { changedValue } from "@/lib/utils/diff";
import { createPropertySchema } from "@/lib/validators/properties";

export type PropertyActionState = { error: string | null };

export type UpdateSectionState = {
  error: string | null;
  savedAt: number | null;
};

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

  const { data: district, error: districtErr } = await supabase
    .from("districts")
    .select("code")
    .eq("id", input.district_id)
    .single();
  if (districtErr || !district) return { error: "District not found" };

  // Reference is generated here — at final submit, atomically with the insert —
  // so abandoned wizards never burn sequence numbers (DECISIONS.md, T1.2).
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
      asking_price: input.asking_price ?? null,
      rent_price_month: input.rent_price_month ?? null,
      bedrooms: input.bedrooms ?? null,
      bathrooms: input.bathrooms ?? null,
      covered_area_sqm: input.covered_area_sqm ?? null,
      plot_area_sqm: input.plot_area_sqm ?? null,
      internal_notes: input.internal_notes ?? null,
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
    },
  });

  revalidatePath("/properties");
  redirect(`/properties/${created.id}`);
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

  const { detailsSectionSchema, legalSectionSchema, marketingSectionSchema } = await import(
    "@/lib/validators/properties"
  );

  if (section === "details") {
    const parsed = detailsSectionSchema.safeParse({
      ...raw,
      features: formData.getAll("features").map(String),
    });
    if (!parsed.success) {
      return { error: parsed.error.issues[0]?.message ?? "Invalid input", savedAt: null };
    }
    const d = parsed.data;
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
    const { parseLocationPoint, toLocationEWKT } = await import("@/lib/utils/geo");
    const prevPoint = parseLocationPoint((current as { location?: unknown }).location);
    const nextPoint =
      d.latitude !== undefined && d.longitude !== undefined
        ? { lat: d.latitude, lng: d.longitude }
        : null;
    const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
    const samePoint =
      prevPoint !== null &&
      nextPoint !== null &&
      r6(prevPoint.lat) === r6(nextPoint.lat) &&
      r6(prevPoint.lng) === r6(nextPoint.lng);
    if ((prevPoint === null) !== (nextPoint === null) || !samePoint) {
      updates.location = nextPoint ? toLocationEWKT(nextPoint.lat, nextPoint.lng) : null;
      locationChange = { from: prevPoint, to: nextPoint };
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
      supabase.from("property_media").select("id, is_cover").eq("property_id", propertyId),
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
    const result = computeQualityScore({
      isLand,
      hasCoverPhoto: (media ?? []).some((m) => m.is_cover),
      photoCount: (media ?? []).length,
      titleEn: (merged.title as { en?: string } | null)?.en,
      publicDescriptionEn: (merged.public_description as { en?: string } | null)?.en,
      hasPrice: merged.asking_price != null || merged.rent_price_month != null,
      hasArea: isLand ? merged.plot_area_sqm != null : merged.covered_area_sqm != null,
      hasBedroomsAndBathrooms: merged.bedrooms != null && merged.bathrooms != null,
      hasPlanningZoneAndDensity:
        merged.planning_zone_code != null && merged.building_density_pct != null,
      hasCoords: merged.location != null,
      titleDeedSet: merged.title_deed_status !== "unknown",
      permitSet: merged.permit_status !== "unknown",
      mandateActive: (activeMandates ?? []).length > 0,
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
  }

  // changed-field payload for the event (guardrail: updates must carry their diff)
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, next] of Object.entries(updates)) {
    if (key === "location") continue; // handled below with decoded coords
    const prev = (current as Record<string, unknown>)[key];
    if (changedValue(prev, next)) changed[key] = { from: prev ?? null, to: next ?? null };
  }
  if (locationChange) changed.location = locationChange;
  if (Object.keys(changed).length === 0) {
    return { error: null, savedAt: Date.now() }; // nothing to write, still "saved"
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

  // score is derived state — recompute on every save (doc 02 §A8); the save's
  // own property.updated event covers auditability, no separate score event
  const { recomputeQualityScore } = await import("@/lib/services/quality-score");
  await recomputeQualityScore(supabase, propertyId);

  // title deed status is a deal-health factor (doc 02 §C5) — refresh open deals
  if (section === "legal") {
    const { recomputeDealsFor } = await import("@/lib/services/health-score");
    await recomputeDealsFor(supabase, { propertyId });
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
    .select("id, visibility")
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
    .select("id, status, visibility")
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

  // visibility feeds the quality score / publish gate inputs
  const { recomputeQualityScore } = await import("@/lib/services/quality-score");
  await recomputeQualityScore(supabase, propertyId);

  revalidatePath(`/properties/${propertyId}`);
  revalidatePath("/properties");
  return { error: null };
}
