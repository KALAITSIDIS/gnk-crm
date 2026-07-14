/**
 * Contacts importer (T5.6, doc 09 contacts_import.csv). Dedup on normalized
 * phone then email; preferences packed into the jsonb column; unmatched
 * preference areas are flagged in the report, never silently dropped (rule 3).
 *
 *   node --env-file=.env.local scripts/import/contacts.mts --file docs/samples/contacts_import.csv --dry-run
 */
import {
  Report,
  bool,
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
const report = new Report("contacts", args.file, args.dryRun);

// area name (EN) → id, for preference resolution
const { data: areaRows } = await supabase
  .from("areas")
  .select("id, name")
  .eq("org_id", orgId);
const areaByName = new Map<string, string>(
  (areaRows ?? []).map((a) => [String((a.name as { en?: string })?.en ?? "").toLowerCase(), a.id]),
);

let line = 1; // header is line 1
for (const r of rows) {
  line++;
  try {
    const firstName = str(r.first_name);
    const lastName = str(r.last_name);
    const company = str(r.company_name);
    if (!firstName && !lastName && !company) {
      report.add({ row: line, outcome: "error", detail: "needs a first/last/company name" });
      continue;
    }

    const phoneE164 = normalizePhone(r.phone);
    if (r.phone && r.phone.trim() && !phoneE164) {
      report.add({ row: line, outcome: "error", detail: `unparseable phone "${r.phone}"` });
      continue;
    }
    const email = str(r.email)?.toLowerCase() ?? null;

    // dedup: phone first, then email
    if (phoneE164) {
      const { data: dup } = await supabase
        .from("contacts")
        .select("id")
        .eq("org_id", orgId)
        .eq("phone_e164", phoneE164)
        .eq("is_archived", false)
        .limit(1);
      if (dup && dup.length > 0) {
        report.add({ row: line, outcome: "skipped", detail: `duplicate phone ${phoneE164}` });
        continue;
      }
    }
    if (email) {
      const { data: dup } = await supabase
        .from("contacts")
        .select("id")
        .eq("org_id", orgId)
        .eq("email", email)
        .eq("is_archived", false)
        .limit(1);
      if (dup && dup.length > 0) {
        report.add({ row: line, outcome: "skipped", detail: `duplicate email ${email}` });
        continue;
      }
    }

    // preferences
    const prefAreaNames = list(r.pref_areas);
    const prefAreaIds: string[] = [];
    const unmatchedAreas: string[] = [];
    for (const name of prefAreaNames) {
      const id = areaByName.get(name.toLowerCase());
      if (id) prefAreaIds.push(id);
      else unmatchedAreas.push(name);
    }
    const preferences: Record<string, unknown> = {};
    if (prefAreaIds.length) preferences.areas = prefAreaIds;
    if (num(r.budget_min) !== null) preferences.budget_min = num(r.budget_min);
    if (num(r.budget_max) !== null) preferences.budget_max = num(r.budget_max);
    if (int(r.pref_bedrooms_min) !== null) preferences.bedrooms_min = int(r.pref_bedrooms_min);
    if (list(r.pref_property_types).length) preferences.property_types = list(r.pref_property_types);

    const consent = bool(r.consent_marketing);
    const insertRow = {
      org_id: orgId,
      contact_kind: company && !firstName && !lastName ? "company" : "person",
      first_name: firstName,
      last_name: lastName,
      company_name: company,
      phone_e164: phoneE164,
      phone_raw: str(r.phone),
      email,
      telegram_username: str(r.telegram_username)?.replace(/^@/, "") ?? null,
      has_whatsapp: bool(r.has_whatsapp),
      languages: list(r.languages).length ? list(r.languages) : ["en"],
      nationality: str(r.nationality),
      contact_types: list(r.contact_types),
      temperature: str(r.temperature) ?? "warm",
      source: str(r.source),
      psychology: str(r.psychology),
      preferences,
      consent_marketing: consent,
      consent_at: consent ? new Date().toISOString() : null,
      notes: str(r.notes),
    };

    const detail =
      `${insertRow.first_name ?? ""} ${insertRow.last_name ?? ""}`.trim() ||
      insertRow.company_name ||
      "contact";

    if (args.dryRun) {
      report.add({
        row: line,
        outcome: "created",
        detail: `would create ${detail}${unmatchedAreas.length ? ` · unmatched areas: ${unmatchedAreas.join(", ")}` : ""}`,
      });
      continue;
    }

    const { data: created, error } = await supabase
      .from("contacts")
      .insert(insertRow as never)
      .select("id")
      .single();
    if (error) {
      report.add({ row: line, outcome: "error", detail: error.message });
      continue;
    }
    await logImported(supabase, orgId, "contact", created.id, { name: detail });
    report.add({
      row: line,
      outcome: "created",
      detail: `${detail}${unmatchedAreas.length ? ` · unmatched areas: ${unmatchedAreas.join(", ")}` : ""}`,
    });
  } catch (e) {
    report.add({ row: line, outcome: "error", detail: (e as Error).message });
  }
}

report.finish();
