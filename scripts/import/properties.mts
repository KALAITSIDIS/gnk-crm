/**
 * Properties importer (T5.6, doc 09 properties_import.csv). Import contacts
 * FIRST (owner linking). Generates references via next_reference() on live
 * runs, creates missing areas, links/creates owner contacts by phone dedup,
 * and creates active mandates when mandate_type is set.
 *
 *   node --env-file=.env.local scripts/import/properties.mts --file docs/samples/properties_import.csv --dry-run
 */
import {
  Report,
  list,
  loadCsv,
  logImported,
  normalizePhone,
  parseArgs,
  resolveOrg,
  serviceClient,
  str,
} from "./_shared.mts";
import {
  KNOWN_PROPERTY_COLUMNS,
  PROPERTY_NUMBER_COLUMNS,
  insertVisibilityFor,
  measurementRefusal,
  parseNumberColumns,
  publishDecision,
} from "./_rules.mts";
// Relative and WITH the extension: plain Node resolves neither the alias nor
// an extensionless path (tests/unit/scripts-run-under-node.test.ts).
import { PUBLISH_THRESHOLD, recomputeQualityScore } from "../../lib/services/quality-score.ts";

const args = parseArgs(process.argv.slice(2));
const supabase = serviceClient();
const orgId = await resolveOrg(supabase, args.org);
const rows = loadCsv(args.file, KNOWN_PROPERTY_COLUMNS, args.allowExtra);
const report = new Report("properties", args.file, args.dryRun, args.batch);

const { data: districtRows } = await supabase
  .from("districts")
  .select("id, code")
  .eq("org_id", orgId);
const districtByCode = new Map<string, string>(
  (districtRows ?? []).map((d) => [d.code.toUpperCase(), d.id]),
);

// area cache keyed `${districtId}::${nameLower}`; refreshed as we create
const { data: areaRows } = await supabase
  .from("areas")
  .select("id, district_id, name")
  .eq("org_id", orgId);
const areaKey = (districtId: string, name: string) => `${districtId}::${name.toLowerCase()}`;
const areaCache = new Map<string, string>(
  (areaRows ?? []).map((a) => [
    areaKey(a.district_id, String((a.name as { en?: string })?.en ?? "")),
    a.id,
  ]),
);

function multilang(en?: string | null, el?: string | null, ru?: string | null) {
  const o: Record<string, string> = {};
  if (en) o.en = en;
  if (el) o.el = el;
  if (ru) o.ru = ru;
  return o;
}

async function ensureOwnerContact(
  phoneRaw: string | undefined,
  name: string | null,
): Promise<{ id: string | null; note: string }> {
  const phone = normalizePhone(phoneRaw);
  if (!phone) return { id: null, note: "" };
  const { data: dup } = await supabase
    .from("contacts")
    .select("id")
    .eq("org_id", orgId)
    .eq("phone_e164", phone)
    .eq("is_archived", false)
    .limit(1);
  if (dup && dup.length > 0) return { id: dup[0].id, note: `owner linked (${phone})` };
  if (args.dryRun) return { id: null, note: `would create owner ${name ?? phone}` };
  const { data: created, error } = await supabase
    .from("contacts")
    .insert({
      org_id: orgId,
      first_name: name,
      phone_e164: phone,
      phone_raw: phoneRaw?.trim() ?? null,
      contact_types: ["owner"],
    } as never)
    .select("id")
    .single();
  if (error) throw new Error(`owner contact: ${error.message}`);
  // No `name` — nor the phone it fell back to: the row holds them, and the
  // chain is beyond erasure and correction (T-imported-identity-shape). `as`
  // says which role created it; the report note below stays local.
  await logImported(supabase, orgId, "contact", created.id, {
    as: "owner",
    batch: report.batch,
  });
  return { id: created.id, note: `owner created ${name ?? phone}` };
}

let line = 1;
for (const r of rows) {
  line++;
  try {
    const propertyType = str(r.property_type);
    if (!propertyType) {
      report.add({ row: line, outcome: "error", detail: "property_type is required" });
      continue;
    }
    const code = (str(r.district_code) ?? "").toUpperCase();
    const districtId = districtByCode.get(code);
    if (!districtId) {
      report.add({ row: line, outcome: "error", detail: `unknown district_code "${r.district_code}"` });
      continue;
    }

    // reference / dedup
    let reference = str(r.reference);
    if (reference) {
      const { data: existing } = await supabase
        .from("properties")
        .select("id")
        .eq("org_id", orgId)
        .eq("reference", reference)
        .limit(1);
      if (existing && existing.length > 0) {
        report.add({ row: line, outcome: "skipped", detail: `reference ${reference} already exists` });
        continue;
      }
    }

    // parent (units/phases)
    const kind = str(r.kind) ?? "standalone";
    let parentId: string | null = null;
    if (kind === "unit" || kind === "phase") {
      const parentRef = str(r.parent_reference);
      if (!parentRef) {
        report.add({ row: line, outcome: "error", detail: `${kind} needs parent_reference` });
        continue;
      }
      const { data: parent } = await supabase
        .from("properties")
        .select("id")
        .eq("org_id", orgId)
        .eq("reference", parentRef)
        .limit(1);
      if (!parent || parent.length === 0) {
        report.add({ row: line, outcome: "error", detail: `parent ${parentRef} not found` });
        continue;
      }
      parentId = parent[0].id;
    }

    // Every number in the row, read the way Cyprus writes it (85,5 or 85.5;
    // 1.200 or 1,200) — and every cell that cannot be read is refused with
    // its column named, never guessed, never blanked (2026-09-23). Then the
    // areas and floors (LST-07). Both BEFORE the first side effect below (an
    // area, an owner contact), so a refused row creates nothing, and before
    // the dry-run branch, so the rehearsal refuses it too.
    const numbers = parseNumberColumns(r, PROPERTY_NUMBER_COLUMNS);
    if (numbers.errors.length > 0) {
      report.add({ row: line, outcome: "error", detail: numbers.errors.join("; ") });
      continue;
    }
    const n = numbers.values;
    const measurementError = measurementRefusal({
      covered_area_sqm: n.covered_area_sqm,
      plot_area_sqm: n.plot_area_sqm,
      floor_number: n.floor_number,
      total_floors: n.total_floors,
    });
    if (measurementError) {
      report.add({ row: line, outcome: "error", detail: measurementError });
      continue;
    }

    // area (create if missing)
    let areaId: string | null = null;
    const areaName = str(r.area);
    const notes: string[] = [];
    if (areaName) {
      const key = areaKey(districtId, areaName);
      areaId = areaCache.get(key) ?? null;
      if (!areaId) {
        if (args.dryRun) {
          notes.push(`would create area "${areaName}"`);
        } else {
          const { data: newArea, error } = await supabase
            .from("areas")
            .insert({ org_id: orgId, district_id: districtId, name: { en: areaName } } as never)
            .select("id")
            .single();
          if (error) throw new Error(`area "${areaName}": ${error.message}`);
          areaId = newArea.id;
          areaCache.set(key, areaId);
          notes.push(`area created "${areaName}"`);
        }
      }
    }

    // owner
    const owner = await ensureOwnerContact(r.owner_phone, str(r.owner_name));
    if (owner.note) notes.push(owner.note);

    const lat = n.latitude;
    const lng = n.longitude;

    // Audit 2026-09-15 (LST-02): this importer used to write `visibility`
    // straight from the file, so a standalone row could go public with no
    // score, no gate and no publish stamp — the one path that skipped all
    // three. A row requested public is now INSERTED private, scored once it
    // and its mandate exist, and published below only if it clears the
    // threshold. A container still imports as coming_soon at most (the
    // empty-container refusal, 2026-09-02): publish it from the app once its
    // units exist.
    const requestedVisibility = str(r.visibility) ?? "private";
    const visibility = insertVisibilityFor(requestedVisibility, kind);
    const publishPending = requestedVisibility === "public" && visibility === "private";
    if (requestedVisibility === "public" && visibility === "coming_soon") {
      notes.push(
        "a " + kind + " cannot be imported public — set to coming_soon; publish it from the app once its units exist",
      );
    }
    if (args.dryRun && publishPending) {
      notes.push(`public requested — scored once the row lands; published only at ${PUBLISH_THRESHOLD}+`);
    }

    const insertRow: Record<string, unknown> = {
      org_id: orgId,
      parent_id: parentId,
      kind,
      property_type: propertyType,
      transaction_type: str(r.transaction_type) ?? "sale",
      status: str(r.status) ?? "available",
      visibility,
      district_id: districtId,
      area_id: areaId,
      address: str(r.address),
      location: lat !== null && lng !== null ? `SRID=4326;POINT(${lng} ${lat})` : null,
      title: multilang(str(r.title_en), str(r.title_el), str(r.title_ru)),
      public_description: multilang(
        str(r.description_en),
        str(r.description_el),
        str(r.description_ru),
      ),
      asking_price: n.asking_price,
      owner_net_price: n.owner_net_price,
      rent_price_month: n.rent_price_month,
      vat_status: str(r.vat_status) ?? "unknown",
      covered_area_sqm: n.covered_area_sqm,
      plot_area_sqm: n.plot_area_sqm,
      veranda_sqm: n.veranda_sqm,
      bedrooms: n.bedrooms,
      bathrooms: n.bathrooms,
      parking_spaces: n.parking_spaces,
      floor_number: n.floor_number,
      total_floors: n.total_floors,
      year_built: n.year_built,
      features: list(r.features),
      title_deed_status: str(r.title_deed_status) ?? "unknown",
      permit_status: str(r.permit_status) ?? "unknown",
      // DLS identity (0077, DB-05) — the registration number is the
      // duplicate signal, so bulk onboarding should carry it when known
      registration_no: str(r.registration_no),
      plot_no: str(r.plot_no),
      sheet_plan: str(r.sheet_plan),
      registry_municipality: str(r.registry_municipality),
      planning_zone_code: str(r.planning_zone_code),
      building_density_pct: n.building_density_pct,
      coverage_ratio_pct: n.coverage_ratio_pct,
      max_floors: n.max_floors,
      road_frontage_m: n.road_frontage_m,
      internal_notes: str(r.internal_notes),
      owner_contact_id: owner.id,
    };

    if (args.dryRun) {
      const shownRef = reference ?? `GNK-${code}-#### (auto)`;
      const mandate = str(r.mandate_type) ? ` · +${r.mandate_type} mandate` : "";
      report.add({
        row: line,
        outcome: "created",
        ref: shownRef,
        detail: `would create ${shownRef}${notes.length ? ` · ${notes.join("; ")}` : ""}${mandate}`,
      });
      continue;
    }

    if (!reference) {
      const { data: gen, error: refErr } = await supabase.rpc("next_reference", {
        p_org: orgId,
        p_district_code: code,
      });
      if (refErr) throw new Error(`next_reference: ${refErr.message}`);
      reference = gen as string;
    }
    insertRow.reference = reference;

    const { data: created, error } = await supabase
      .from("properties")
      .insert(insertRow as never)
      .select("id")
      .single();
    if (error) {
      report.add({ row: line, outcome: "error", detail: error.message });
      continue;
    }
    // optional mandate — BEFORE the score, so an active mandate counts
    const mandateType = str(r.mandate_type);
    if (mandateType) {
      const { data: mandate, error: mErr } = await supabase
        .from("mandates")
        .insert({
          org_id: orgId,
          property_id: created.id,
          owner_contact_id: owner.id,
          type: mandateType,
          status: "active",
          commission_pct: n.mandate_commission_pct,
          expiry_date: str(r.mandate_expiry),
        } as never)
        .select("id")
        .single();
      if (mErr) {
        notes.push(`mandate FAILED: ${mErr.message}`);
      } else {
        await logImported(supabase, orgId, "mandate", mandate.id, {
          property: reference,
          batch: report.batch,
        });
        notes.push(`+${mandateType} mandate`);
      }
    }

    // Score now that the row and its mandate exist — the stored column used
    // to stay at its default 0 for every imported row (audit 2026-09-15).
    // `mandateSource: "base"`: this runs as service_role, for which the
    // mandates_safe view returns nothing (see recompute-scores.mts). A
    // scoring failure is a note, never a lost `imported` event.
    let score = 0;
    try {
      const scored = await recomputeQualityScore(
        supabase as Parameters<typeof recomputeQualityScore>[0],
        created.id,
        { mandateSource: "base" },
      );
      score = scored?.score ?? 0;
    } catch (e) {
      notes.push(`score FAILED: ${(e as Error).message}`);
    }
    let finalVisibility = visibility;
    let publishedAt: string | null = null;
    if (publishPending) {
      const decision = publishDecision({
        requested: requestedVisibility,
        kind,
        score,
        threshold: PUBLISH_THRESHOLD,
      });
      if (decision.publish) {
        // The app stamps published_at on every transition into public (0073);
        // a row that arrives without it sorts last in the feed for ever.
        const stamp = new Date().toISOString();
        const { error: pubErr } = await supabase
          .from("properties")
          .update({ visibility: "public", published_at: stamp })
          .eq("id", created.id);
        if (pubErr) {
          notes.push(`score ${score}; publish FAILED: ${pubErr.message} — left private`);
        } else {
          finalVisibility = "public";
          publishedAt = stamp;
          notes.push(`score ${score} — published`);
        }
      } else if (decision.note) {
        notes.push(decision.note); // carries the score and the threshold
      }
    } else {
      notes.push(`score ${score}`);
    }
    await logImported(supabase, orgId, "property", created.id, {
      reference,
      batch: report.batch,
      visibility: finalVisibility,
      score,
      ...(publishedAt ? { published_at: publishedAt } : {}),
    });

    report.add({
      row: line,
      outcome: "created",
      ref: reference,
      detail: `${reference}${notes.length ? ` · ${notes.join("; ")}` : ""}`,
    });
  } catch (e) {
    report.add({ row: line, outcome: "error", detail: (e as Error).message });
  }
}

report.finish();
