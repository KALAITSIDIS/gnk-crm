/**
 * Archive named property records, with their events.
 *
 * WHY THIS EXISTS. This app has no hard delete by design: a record is retired
 * by setting `visibility = 'archived'`, and Restore brings it back. The app's
 * own `archiveProperty` action does that one record at a time behind an admin
 * gate, which is right for a listing the desk retires in the normal course of
 * business. It is the wrong shape for cleaning up a batch that should never
 * have existed — seven rows, seven navigations, seven chances to archive the
 * wrong reference.
 *
 * It writes the EVENT as well as the update, because a visibility change that
 * leaves no trace is precisely the hole the 2026-09-03 guardrail-1 sweep went
 * looking for. The actor is null — the system did this, on instruction —
 * following `logImported`'s precedent rather than attributing a click to a
 * person who did not make one. The reason is required and lands in the
 * payload, so the timeline says why.
 *
 *   node --env-file=.env.local scripts/maintenance/archive-records.mts \
 *     --refs PAF0005,PAF0005-V01 --reason "fabricated test data" --dry-run
 *
 * Dry run is the DEFAULT here, unlike the importers: pass --apply to write.
 * Children are archived before their parents so a half-finished run never
 * leaves a live unit under an archived project.
 */
import { serviceClient, resolveOrg } from "../import/_shared.mts";

// parsed here, not via the importers' parseArgs: that one demands --file and
// exits without it, and three importers depend on its exact shape
const args: Record<string, string | boolean> = {};
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--apply") args.apply = true;
    else if (a === "--dry-run") args.apply = false;
    else if (a.startsWith("--") && argv[i + 1] && !argv[i + 1]!.startsWith("--")) {
      args[a.slice(2)] = argv[++i]!;
    } else if (a.includes("=")) {
      const [k, ...rest] = a.slice(2).split("=");
      args[k!] = rest.join("=");
    }
  }
}
const supabase = serviceClient();
const orgId = await resolveOrg(supabase, args.org as string | undefined);

const refs = String(args.refs ?? "")
  .split(",")
  .map((r) => r.trim())
  .filter(Boolean);
if (refs.length === 0) {
  console.error("--refs PAF0005,PAF0005-V01 is required");
  process.exit(1);
}
const reason = String(args.reason ?? "").trim();
if (!reason) {
  console.error('--reason "why these are being retired" is required — it goes into the event');
  process.exit(1);
}
const apply = args.apply === true;

const { data: rows, error } = await supabase
  .from("properties")
  .select("id, reference, kind, visibility, parent_id, title")
  .eq("org_id", orgId)
  .in("reference", refs);
if (error) throw new Error(`lookup failed: ${error.message}`);

const found = rows ?? [];
const missing = refs.filter((r) => !found.some((f) => f.reference === r));
if (missing.length > 0) {
  console.error(`NOT FOUND, refusing to run: ${missing.join(", ")}`);
  process.exit(1);
}

// deepest first: a unit sits under a phase sits under a project, so ordering by
// how many references it is built from retires children before parents
const depth = (r: string) => r.split("-").length;
found.sort((a, b) => depth(b.reference) - depth(a.reference));

console.log(`${apply ? "APPLY" : "DRY RUN"} — ${found.length} record(s), reason: "${reason}"\n`);
let archived = 0;
let skipped = 0;

for (const row of found) {
  const title = (row.title as { en?: string } | null)?.en ?? "(no title)";
  if (row.visibility === "archived") {
    console.log(`  skip    ${row.reference.padEnd(18)} ${row.kind.padEnd(10)} already archived`);
    skipped += 1;
    continue;
  }
  console.log(
    `  archive ${row.reference.padEnd(18)} ${row.kind.padEnd(10)} ${row.visibility} → archived   ${title.slice(0, 40)}`,
  );
  if (!apply) continue;

  const { data: updated, error: updErr } = await supabase
    .from("properties")
    .update({ visibility: "archived" })
    .eq("id", row.id)
    .neq("visibility", "archived")
    .select("id");
  if (updErr) throw new Error(`${row.reference}: update failed: ${updErr.message}`);
  if (!updated || updated.length === 0) {
    // someone archived it between the read and the write — not an error, but
    // do not write an event for a change this run did not make
    console.log(`          (already archived by someone else — no event written)`);
    skipped += 1;
    continue;
  }

  // the event goes immediately after the write it describes, so a failure
  // later in the loop can never leave an archived row with no record of why
  const { error: evErr } = await supabase.from("events").insert({
    org_id: orgId,
    actor_id: null,
    entity_type: "property",
    entity_id: row.id,
    event_type: "archived",
    payload: {
      manual: false,
      source: "maintenance_script",
      reason,
      reference: row.reference,
      visibility: { from: row.visibility, to: "archived" },
    },
  });
  if (evErr) throw new Error(`${row.reference}: event insert failed: ${evErr.message}`);
  archived += 1;
}

console.log(
  `\n${apply ? "archived" : "would archive"} ${apply ? archived : found.length - skipped}, skipped ${skipped}`,
);
if (!apply) console.log("nothing was written — pass --apply to commit");
