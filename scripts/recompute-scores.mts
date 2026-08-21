/**
 * Recompute every property's stored quality_score.
 *
 *   node --env-file=.env.local scripts/recompute-scores.mts [--dry-run]
 *
 * WHY THIS EXISTS. `quality_score` is a stored column, refreshed by
 * `recomputeQualityScore` whenever a property, its media or its mandates
 * change. The DETAIL page ignores the column and computes fresh on render; the
 * LIST and the CSV export read it. So the moment a weight changes — as it did
 * for BACKLOG audit finding 15 — every stored score is stale, and the list
 * disagrees with the detail page until somebody happens to re-save each row.
 *
 * The scoring lives in application code, deliberately (one implementation, doc
 * 02 §A8). Recomputing it in SQL would be a SECOND implementation that could
 * drift from the first, which is worse than a stale number. So this script
 * calls the same function every save calls.
 *
 * Prints what changed and by how much. `--dry-run` passes `persist: false`
 * straight through, so it genuinely does not write — which is how you check a
 * weight change did what you meant before it touches any data.
 */
import { createClient } from "@supabase/supabase-js";
import { recomputeQualityScore } from "../lib/services/quality-score.ts";

const dryRun = process.argv.includes("--dry-run");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error(
    "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set — run with --env-file=.env.local",
  );
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: properties, error } = await supabase
  .from("properties")
  .select("id, reference, quality_score")
  .order("reference");
if (error) {
  console.error(`could not read properties: ${error.message}`);
  process.exit(1);
}

console.log(
  `${dryRun ? "DRY RUN — " : ""}recomputing ${properties?.length ?? 0} propert${
    (properties?.length ?? 0) === 1 ? "y" : "ies"
  }\n`,
);

let changed = 0;
let unchanged = 0;
const moves: { reference: string; from: number; to: number }[] = [];

for (const p of properties ?? []) {
  const before = p.quality_score ?? 0;

  // `mandateSource: "base"` is NOT optional here. This runs as service_role,
  // and mandates_safe filters on current_org_id()/current_role_gnk(), which are
  // null outside a user session — so the view returns nothing and every
  // mandated property would be written 10 points light.
  const result = await recomputeQualityScore(supabase, p.id, {
    persist: !dryRun,
    mandateSource: "base",
  });
  const after = result?.score ?? before;
  if (after !== before) {
    moves.push({ reference: p.reference, from: before, to: after });
    changed++;
  } else {
    unchanged++;
  }
}

for (const m of moves) {
  const delta = m.to - m.from;
  console.log(`  ${m.reference.padEnd(20)} ${m.from} → ${m.to}  (${delta > 0 ? "+" : ""}${delta})`);
}

console.log(
  `\n${dryRun ? "would change" : "changed"} ${changed}, unchanged ${unchanged}` +
    (dryRun ? " — nothing was written" : ""),
);
