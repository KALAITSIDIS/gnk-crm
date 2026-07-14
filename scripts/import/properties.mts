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
  int,
  list,
  loadCsv,
  logImported,
  normalizePhone,
  num,
  parseArgs,
  resolveOrg,
  serviceClient,
  str,
} from "./_shared.mts";

const args = parseArgs(process.argv.slice(2));
const supabase = serviceClient();
const orgId = await resolveOrg(supabase, args.org);
const rows = loadCsv(args.file);
const report = new Report("properties", args.file, args.dryRun);

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
  await logImported(supabase, orgId, "contact", created.id, { name: name ?? phone, as: "owner" });
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

    const lat = num(r.latitude);
    const lng = num(r.longitude);

    const insertRow: Record<string, unknown> = {
      org_id: orgId,
      parent_id: parentId,
      kind,
      property_type: propertyType,
      transaction_type: str(r.transaction_type) ?? "sale",
      status: str(r.status) ?? "available",
      visibility: str(r.visibility) ?? "private",
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
      asking_price: num(r.asking_price),
      owner_net_price: num(r.owner_net_price),
      rent_price_month: num(r.rent_price_month),
      vat_status: str(r.vat_status) ?? "unknown",
      covered_area_sqm: num(r.covered_area_sqm),
      plot_area_sqm: num(r.plot_area_sqm),
      veranda_sqm: num(r.veranda_sqm),
      bedrooms: int(r.bedrooms),
      bathrooms: int(r.bathrooms),
      parking_spaces: int(r.parking_spaces),
      floor_number: int(r.floor_number),
      total_floors: int(r.total_floors),
      year_built: int(r.year_built),
      features: list(r.features),
      title_deed_status: str(r.title_deed_status) ?? "unknown",
      permit_status: str(r.permit_status) ?? "unknown",
      planning_zone_code: str(r.planning_zone_code),
      building_density_pct: num(r.building_density_pct),
      coverage_ratio_pct: num(r.coverage_ratio_pct),
      max_floors: int(r.max_floors),
      road_frontage_m: num(r.road_frontage_m),
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
    await logImported(supabase, orgId, "property", created.id, { reference });

    // optional mandate
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
          commission_pct: num(r.mandate_commission_pct),
          expiry_date: str(r.mandate_expiry),
        } as never)
        .select("id")
        .single();
      if (mErr) {
        notes.push(`mandate FAILED: ${mErr.message}`);
      } else {
        await logImported(supabase, orgId, "mandate", mandate.id, { property: reference });
        notes.push(`+${mandateType} mandate`);
      }
    }

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
