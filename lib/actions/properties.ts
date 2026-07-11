"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Database } from "@/lib/supabase/database.types";
import { getCurrentProfile } from "@/lib/services/auth";
import { logEvent } from "@/lib/services/events";
import { generateReference } from "@/lib/services/reference";
import { createClient } from "@/lib/supabase/server";
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

/** Compare loosely across DB string/number representations. */
function changedValue(oldVal: unknown, newVal: unknown): boolean {
  const norm = (v: unknown) =>
    v === undefined || v === null || v === "" ? null : typeof v === "object" ? JSON.stringify(v) : String(v);
  return norm(oldVal) !== norm(newVal);
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
      has_storage: d.has_storage ?? null,
      floor_number: d.floor_number ?? null,
      total_floors: d.total_floors ?? null,
      year_built: d.year_built ?? null,
      energy_class: d.energy_class ?? null,
      features: d.features,
      internal_notes: d.internal_notes ?? null,
      planning_zone_code: d.planning_zone_code ?? null,
      building_density_pct: d.building_density_pct ?? null,
      coverage_ratio_pct: d.coverage_ratio_pct ?? null,
      max_floors: d.max_floors ?? null,
      max_height_m: d.max_height_m ?? null,
      road_frontage_m: d.road_frontage_m ?? null,
      water_available: d.water_available ?? null,
      electricity_available: d.electricity_available ?? null,
      constraints_notes: d.constraints_notes ?? null,
    };
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
  const goingPublic = updates.visibility === "public" && current.visibility !== "public";
  if (goingPublic) {
    const { recomputeQualityScore, PUBLISH_THRESHOLD } = await import(
      "@/lib/services/quality-score"
    );
    const result = await recomputeQualityScore(supabase, propertyId);
    const score = result?.score ?? 0;
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
    const prev = (current as Record<string, unknown>)[key];
    if (changedValue(prev, next)) changed[key] = { from: prev ?? null, to: next ?? null };
  }
  if (Object.keys(changed).length === 0) {
    return { error: null, savedAt: Date.now() }; // nothing to write, still "saved"
  }

  const { error: updateErr } = await supabase
    .from("properties")
    .update(updates)
    .eq("id", propertyId);
  if (updateErr) return { error: updateErr.message, savedAt: null };

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
